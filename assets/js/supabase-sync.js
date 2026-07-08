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
    try {
      const { data } = await client.from("profiles").select("role,client_id").eq("id", userId).single();
      return data || { role: "client", client_id: "celtic-elevator" };
    } catch { return { role: "client", client_id: "celtic-elevator" }; }
  }
  async function currentSession() {
    if (!client) return null;
    try {
      const { data: { user } } = await client.auth.getUser();
      if (!user) return null;
      return { user, profile: await fetchProfile(user.id) };
    } catch { return null; }
  }

  async function pullScope(clientId, scope) {
    if (!client) return null;
    try {
      const { data, error } = await client.from("app_state")
        .select("data").eq("client_id", clientId).eq("scope", scope).maybeSingle();
      if (error) { console.warn("SUPA pull", scope, error.message); return null; }
      return data ? data.data : null;
    } catch (e) { console.warn("SUPA pull", scope, e); return null; }
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

  // delete every scope row for a client (used when an admin removes a workspace)
  async function removeClient(clientId) {
    if (!client) return;
    try {
      const { error } = await client.from("app_state").delete().eq("client_id", clientId);
      if (error) console.warn("SUPA removeClient", error.message);
    } catch (e) { console.warn("SUPA removeClient", e); }
  }

  return { enabled, client, signIn, signOut, currentSession, pullScope, pushScope, removeClient };
})();
