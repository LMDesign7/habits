/* ============================================================
   cloud-store — persistance unifiée pour les apps web de Lucas

   Principe : LOCAL-FIRST.
   `localStorage` reste la source de lecture, donc l'app démarre
   instantanément et fonctionne hors ligne. Supabase est la copie durable,
   jamais sur le chemin critique : si le réseau tombe, l'app marche.

   Deux façons de perdre ses données, deux réponses :
   - téléphone perdu ou changé  -> copie distante
   - corruption des données     -> historique versionné (30 versions)
   Une sync automatique sans historique propage une corruption en secondes.

   Dépendance unique : @supabase/supabase-js
   Aucun framework. Utilisable en React, Vue, ou vanilla.
   ============================================================ */

import { createClient } from '@supabase/supabase-js';

const DEFAULT_DEBOUNCE = 2000;   // ms avant push distant
const RETRY_DELAYS = [2000, 6000, 15000, 45000];

/**
 * @param {object}  opts
 * @param {string}  opts.appId            identifiant de l'app ('mon-budget', 'dally'…)
 * @param {string}  opts.supabaseUrl
 * @param {string}  opts.supabaseAnonKey  publique par conception : la RLS protège les données
 * @param {string} [opts.storageKey]      clé localStorage (défaut: cloud-store:<appId>)
 * @param {function} [opts.isEmpty]       (data) => bool — refuse de pousser du vide
 * @param {function} [opts.normalize]     (data) => data — migration/validation à la lecture
 * @param {number}  [opts.debounceMs]
 */
export function createStore(opts) {
  const {
    appId,
    supabaseUrl,
    supabaseAnonKey,
    storageKey = `cloud-store:${appId}`,
    isEmpty = (d) => !d || Object.keys(d).length === 0,
    normalize = (d) => d,
    debounceMs = DEFAULT_DEBOUNCE,
  } = opts;

  if (!appId) throw new Error('cloud-store: appId requis');

  const sb = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const listeners = new Set();
  let state = {
    status: 'idle',      // idle | syncing | synced | offline | conflict | error
    lastSyncedAt: null,
    error: null,
    user: null,
  };
  let baseVersion = null;   // version distante sur laquelle on travaille
  let pushTimer = null;
  let retryIdx = 0;
  let pending = null;       // dernières données en attente de push

  const emit = (patch) => {
    state = { ...state, ...patch };
    listeners.forEach(fn => { try { fn(state); } catch {} });
  };

  /* ---------- Couche locale (synchrone, toujours disponible) ---------- */

  function readLocal() {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) {
      console.error('cloud-store: lecture locale impossible', e);
      return null;
    }
  }

  function writeLocal(data) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(data));
      return true;
    } catch (e) {
      // Quota dépassé ou stockage bloqué : on n'échoue pas silencieusement.
      console.error('cloud-store: écriture locale impossible', e);
      emit({ status: 'error', error: 'Stockage local indisponible' });
      return false;
    }
  }

  /* ---------- Auth ---------- */

  async function signInWithGoogle(redirectTo = window.location.origin) {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
    if (error) throw error;
  }

  async function signOut() {
    await sb.auth.signOut();
    emit({ user: null, status: 'idle' });
  }

  async function currentUser() {
    const { data } = await sb.auth.getUser();
    return data?.user || null;
  }

  /* ---------- Couche distante ---------- */

  async function fetchRemote() {
    const { data, error } = await sb
      .from('app_state')
      .select('data, version, updated_at')
      .eq('app_id', appId)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  async function pushRemote(data, { force = false } = {}) {
    const { data: row, error } = await sb.rpc('app_state_put', {
      p_app_id: appId,
      p_data: data,
      p_base_version: force ? null : baseVersion,
    });
    if (error) throw error;
    const r = Array.isArray(row) ? row[0] : row;
    baseVersion = r?.version ?? baseVersion;
    return r;
  }

  /* ---------- Chargement ----------
     Renvoie le local immédiatement. Le distant arrive ensuite via onChange :
     l'app ne doit jamais attendre le réseau pour s'afficher.              */

  function load() {
    return readLocal();
  }

  /**
   * Réconcilie local et distant après connexion.
   * @returns {Promise<{applied: 'remote'|'local'|'none', data: any, conflict?: object}>}
   */
  async function hydrate() {
    const user = await currentUser();
    if (!user) { emit({ status: 'offline', user: null }); return { applied: 'none', data: readLocal() }; }
    emit({ status: 'syncing', user });

    try {
      const remote = await fetchRemote();
      const local = readLocal();

      // Rien à distance : on pousse le local s'il vaut la peine.
      if (!remote) {
        baseVersion = null;
        if (local && !isEmpty(local)) { await pushRemote(local); }
        emit({ status: 'synced', lastSyncedAt: Date.now(), error: null });
        return { applied: 'local', data: local };
      }

      baseVersion = remote.version;
      const remoteData = normalize(remote.data);

      // Pas de local (nouveau téléphone, cache vidé) : le distant fait foi.
      // C'est le scénario central de tout ce système.
      if (!local || isEmpty(local)) {
        writeLocal(remoteData);
        emit({ status: 'synced', lastSyncedAt: Date.now(), error: null });
        return { applied: 'remote', data: remoteData };
      }

      // Les deux existent et diffèrent : on ne tranche PAS tout seul.
      // Écraser silencieusement, c'est exactement comme ça qu'on perd des données.
      if (JSON.stringify(local) !== JSON.stringify(remoteData)) {
        emit({ status: 'conflict' });
        return {
          applied: 'none',
          data: local,
          conflict: { local, remote: remoteData, remoteUpdatedAt: remote.updated_at },
        };
      }

      emit({ status: 'synced', lastSyncedAt: Date.now(), error: null });
      return { applied: 'none', data: local };
    } catch (e) {
      console.error('cloud-store: hydratation échouée', e);
      emit({ status: 'offline', error: e.message });
      return { applied: 'none', data: readLocal() };
    }
  }

  /** Résout un conflit signalé par hydrate(). */
  async function resolveConflict(choice, data) {
    if (choice === 'remote') {
      writeLocal(data);
      emit({ status: 'synced', lastSyncedAt: Date.now() });
      return data;
    }
    await pushRemote(data, { force: true });   // le local gagne
    writeLocal(data);
    emit({ status: 'synced', lastSyncedAt: Date.now() });
    return data;
  }

  /* ---------- Sauvegarde ----------
     Écriture locale immédiate (jamais perdue), push distant débouncé.      */

  function save(data) {
    writeLocal(data);
    pending = data;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(flush, debounceMs);
  }

  async function flush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (pending == null) return;

    // Ne jamais pousser du vide par-dessus une sauvegarde réelle.
    // Le serveur refuse aussi, mais autant ne pas envoyer la requête.
    if (isEmpty(pending)) { pending = null; return; }

    const user = await currentUser();
    if (!user) { emit({ status: 'offline' }); return; }

    const payload = pending;
    emit({ status: 'syncing' });
    try {
      await pushRemote(payload);
      pending = null;
      retryIdx = 0;
      emit({ status: 'synced', lastSyncedAt: Date.now(), error: null });
    } catch (e) {
      if (e?.code === '40001') {          // conflit de version
        emit({ status: 'conflict', error: 'Modifié sur un autre appareil' });
        return;
      }
      // Réseau : on garde `pending` et on retente en backoff.
      const delay = RETRY_DELAYS[Math.min(retryIdx++, RETRY_DELAYS.length - 1)];
      emit({ status: 'offline', error: e.message });
      pushTimer = setTimeout(flush, delay);
    }
  }

  /* ---------- Historique ---------- */

  async function history(limit = 30) {
    const { data, error } = await sb
      .from('app_state_history')
      .select('id, version, created_at')
      .eq('app_id', appId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  }

  async function restore(historyId) {
    const { data, error } = await sb.rpc('app_state_restore', { p_history_id: historyId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const restored = normalize(row.data);
    baseVersion = row.version;
    writeLocal(restored);
    emit({ status: 'synced', lastSyncedAt: Date.now() });
    return restored;
  }

  /* ---------- Divers ---------- */

  function subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  }

  // Dernier filet : pousser avant que l'onglet ne disparaisse.
  if (typeof window !== 'undefined') {
    window.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && pending) flush();
    });
  }

  return {
    supabase: sb,
    load, hydrate, save, flush,
    resolveConflict,
    history, restore,
    signInWithGoogle, signOut, currentUser,
    subscribe,
    getState: () => state,
  };
}
