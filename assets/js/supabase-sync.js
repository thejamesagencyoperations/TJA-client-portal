/* ============================================================
   SUPABASE SYNC ADAPTER
   Exposes window.SUPA. When configured (supabase-config.js filled
   in + the supabase-js library loaded), it provides real auth and
   reads/writes the three data scopes (dashboard / files /
   deliverables) to the `app_state` table. When NOT configured,
   SUPA.enabled is false and the app falls back to localStorage.
   ============================================================ */
window.SUPA = (function () {
  const cfg = window.SUPABASE_CONFIG || {};
  const hasLib = !!(window.supabase && window.supabase.createClient);
  const enabled = !!(cfg.url && cfg.anonKey && hasLib);
  let client = null;
  if (enabled) {
    try { client = window.supabase.createClient(cfg.url, cfg.anonKey); }
    catch (e) { console.warn("Supabase init failed:", e); }
  }

  async function signIn(email, password) {
    if (!client) return { ok: false, error: "supabase-not-configured" };
    const { data, error } = await client.auth.signInWithPassword({ email: (email || "").trim(), password });
    if (error) return { ok: false, error: error.message };
    const prof = await fetchProfile(data.user.id);
    return { ok: true, user: data.user, profile: prof };
  }
  async function signOut() { try { if (client) await client.auth.signOut(); } catch {} }

  async function fetchProfile(userId) {
    // Missing row → null. NEVER fabricate a fallback profile here: the old hard-coded
    // { client_id: "celtic-elevator" } default sent every client to Celtic's workspace.
    try {
      const { data } = await client.from("profiles").select("role,client_id").eq("id", userId).single();
      return data || null;
    } catch { return null; }
  }
  async function currentSession() {
    if (!client) return null;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return null;
      return { user, profile: await fetchProfile(user.id) };
    } catch { return null; }
  }

  // race any Supabase call against a timeout so a slow/failing backend can never
  // hang the UI (boot awaits these) — on timeout we return null and use localStorage.
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise(res => setTimeout(() => res({ __timeout: true, label }), ms)),
    ]);
  }

  async function pullScope(clientId, scope) {
    if (!client) return null;
    try {
      const q = client.from("app_state").select("data").eq("client_id", clientId).eq("scope", scope).maybeSingle();
      const r = await withTimeout(q, 3500, scope);
      if (r && r.__timeout) { console.warn("SUPA pull timeout", scope); return null; }
      const { data, error } = r;
      if (error) { console.warn("SUPA pull", scope, error.message); return null; }
      return data ? data.data : null;
    } catch (e) { console.warn("SUPA pull", scope, e); return null; }
  }

  // Read EVERY client's row for a scope in one query (admin-only in practice — the RLS
  // returns just your own rows for a client). Used by the admin Message Center.
  async function pullAllScope(scope) {
    if (!client) return [];
    try {
      const q = client.from("app_state").select("client_id,data").eq("scope", scope);
      const r = await withTimeout(q, 4000, scope + "-all");
      if (r && r.__timeout) { console.warn("SUPA pullAll timeout", scope); return []; }
      const { data, error } = r;
      if (error) { console.warn("SUPA pullAll", scope, error.message); return []; }
      return data || [];
    } catch (e) { console.warn("SUPA pullAll", scope, e); return []; }
  }

  // debounced upsert per (client, scope) so rapid edits coalesce into one write.
  // MUST be keyed by clientId too — a bulk sync pushes every client under the same
  // scope ("dashboard") in quick succession; keying by scope alone let each call
  // clear the previous client's timer, so only the last client was ever written.
  const timers = {}, latest = {};
  function pushScope(clientId, scope, value) {
    if (!client) return;
    const key = clientId + "::" + scope;
    latest[key] = value;
    clearTimeout(timers[key]);
    timers[key] = setTimeout(async () => {
      try {
        const { error } = await client.from("app_state").upsert(
          { client_id: clientId, scope, data: latest[key], updated_at: new Date().toISOString() },
          { onConflict: "client_id,scope" }
        );
        if (error) console.warn("SUPA push", scope, error.message);
      } catch (e) { console.warn("SUPA push", scope, e); }
    }, 600);
  }

  // IMMEDIATE push (no debounce) that the caller can await — used for ordered writes
  // like the waiting-room draft→sent move, where the sequencing matters. It MUST also
  // clear any queued debounced write for the same key (timer AND its pending value):
  // otherwise a pushScope() fired just before Send would re-run 600ms later and
  // resurrect data this call just replaced.
  async function pushScopeNow(clientId, scope, value) {
    if (!client) return { ok: false, error: "supabase-not-configured" };
    const key = clientId + "::" + scope;
    clearTimeout(timers[key]); delete timers[key]; delete latest[key];
    try {
      const { error } = await client.from("app_state").upsert(
        { client_id: clientId, scope, data: value, updated_at: new Date().toISOString() },
        { onConflict: "client_id,scope" }
      );
      if (error) { console.warn("SUPA pushNow", scope, error.message); return { ok: false, error: error.message }; }
      return { ok: true };
    } catch (e) { console.warn("SUPA pushNow", scope, e); return { ok: false, error: String(e) }; }
  }

  // delete every scope row for a client (used when an admin removes a workspace)
  async function removeClient(clientId) {
    if (!client) return;
    try {
      const { error } = await client.from("app_state").delete().eq("client_id", clientId);
      if (error) console.warn("SUPA removeClient", error.message);
    } catch (e) { console.warn("SUPA removeClient", e); }
  }

  return { enabled, client, signIn, signOut, currentSession, pullScope, pullAllScope, pushScope, pushScopeNow, removeClient };
})();
