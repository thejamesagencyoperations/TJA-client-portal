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

  // The project migrated its JWT signing keys HS256 → ES256. A token minted before that and
  // still sitting in this browser's storage is UNVERIFIABLE by the server now ("unrecognized
  // JWT kid <nil> for algorithm ES256"), so the first request after a cold load fails until a
  // manual refresh — the exact "it works when I reload" error. Proactively swap the stored
  // token for a freshly ES256-signed one on boot, and gate data calls on it so nothing races
  // ahead with the stale token. Non-fatal: no session / offline just resolves.
  let ready = client
    ? client.auth.refreshSession().then(() => {}).catch(() => {})
    : Promise.resolve();
  async function refreshSession() { if (!client) return; try { await client.auth.refreshSession(); } catch (e) {} }

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
    await ready;   // ensure the token is freshly ES256-signed before any query
    try {
      const q = client.from("app_state").select("data").eq("client_id", clientId).eq("scope", scope).maybeSingle();
      const r = await withTimeout(q, 3500, scope);
      if (r && r.__timeout) { console.warn("SUPA pull timeout", scope); return null; }
      const { data, error } = r;
      if (error) { console.warn("SUPA pull", scope, error.message); return null; }
      return data ? data.data : null;
    } catch (e) { console.warn("SUPA pull", scope, e); return null; }
  }

  // pullScope + the row's updated_at stamp — seeds the guarded-write baseline below.
  async function pullScopeFull(clientId, scope) {
    if (!client) return null;
    await ready;
    try {
      const q = client.from("app_state").select("data,updated_at").eq("client_id", clientId).eq("scope", scope).maybeSingle();
      const r = await withTimeout(q, 3500, scope);
      if (r && r.__timeout) { console.warn("SUPA pullFull timeout", scope); return null; }
      const { data, error } = r;
      if (error) { console.warn("SUPA pullFull", scope, error.message); return null; }
      if (!data) return null;
      lastKnown[clientId + "::" + scope] = data.updated_at;
      baseData[clientId + "::" + scope] = cloneJSON(data.data);   // ancestor for the 3-way merge
      return { data: data.data, updated_at: data.updated_at };
    } catch (e) { console.warn("SUPA pullFull", scope, e); return null; }
  }

  // Auto-refresh poll: is the server's copy of this scope newer than the version WE last
  // saw (lastKnown, seeded by pullScopeFull + advanced by every guarded write)? Returns
  // { changed, data, updated_at } WITHOUT touching lastKnown — the caller decides whether to
  // adopt (and then calls markScopeSeen). This is how open tabs stop going stale: poll every
  // few seconds, and when someone else writes, pull + repaint. changed is false until the
  // first pullScopeFull has run (no baseline = nothing to compare against).
  async function pollScope(clientId, scope) {
    if (!client) return { changed: false };
    await ready;
    const key = clientId + "::" + scope;
    try {
      const q = client.from("app_state").select("data,updated_at").eq("client_id", clientId).eq("scope", scope).maybeSingle();
      const r = await withTimeout(q, 3500, scope);
      if (r && r.__timeout) return { changed: false };
      const { data, error } = r;
      if (error || !data) return { changed: false };
      const changed = !!lastKnown[key] && data.updated_at !== lastKnown[key];
      return { changed, data: data.data, updated_at: data.updated_at };
    } catch (e) { return { changed: false }; }
  }
  // The optional `data` keeps the merge ancestor in step when the app ADOPTS a remote version
  // (auto-refresh). Without it, base would lag behind lastKnown and the next merge would treat
  // fields the user actually adopted from a teammate as their own edits (false conflicts).
  function markScopeSeen(clientId, scope, updatedAt, data) {
    const key = clientId + "::" + scope;
    if (updatedAt) lastKnown[key] = updatedAt;
    if (data !== undefined) baseData[key] = cloneJSON(data);
  }

  // Instant push: subscribe to this client's app_state changes over the Realtime websocket
  // (requires the app_state table in the supabase_realtime publication). RLS applies — you
  // only receive rows you could SELECT. Filter is one column (client_id); the callback gets
  // the payload and can check payload.new.scope. Returns the channel so the caller can
  // removeChannel() on teardown. onChange just says "something changed" — the caller re-pulls
  // via pollScope, so we never depend on the payload carrying the full (possibly large) row.
  function subscribeScope(clientId, onChange) {
    if (!client) return null;
    try {
      const ch = client.channel("rt-" + clientId)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "app_state", filter: `client_id=eq.${clientId}` },
          (payload) => { try { onChange(payload); } catch (e) {} })
        .subscribe();
      return ch;
    } catch (e) { console.warn("SUPA subscribe", e); return null; }
  }

  // Read EVERY client's row for a scope in one query (admin-only in practice — the RLS
  // returns just your own rows for a client). Used by the admin Message Center.
  async function pullAllScope(scope) {
    if (!client) return [];
    await ready;
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
  // pending[key] is true from the moment a write is queued until its HTTP round-trip
  // completes. The auto-refresh MUST NOT adopt remote state while our own write is
  // pending: adoption advances lastKnown, which would let the queued guarded write
  // CAS-succeed on the freshly-seen stamp and silently clobber the other person's
  // change — the exact thing the guard exists to catch. Deferring adoption instead
  // lets the CAS fail against the old stamp and fire the conflict banner.
  const pending = {};
  function hasPendingWrite(clientId, scope) { return !!pending[clientId + "::" + scope]; }
  function pushScope(clientId, scope, value) {
    if (!client) return;
    const key = clientId + "::" + scope;
    latest[key] = value;
    clearTimeout(timers[key]);
    pending[key] = true;
    timers[key] = setTimeout(async () => {
      try {
        const { error } = await client.from("app_state").upsert(
          { client_id: clientId, scope, data: latest[key], updated_at: new Date().toISOString() },
          { onConflict: "client_id,scope" }
        );
        if (error) console.warn("SUPA push", scope, error.message);
      } catch (e) { console.warn("SUPA push", scope, e); }
      finally { pending[key] = false; }
    }, 600);
  }

  /* ---- GUARDED writes (compare-and-set on updated_at) ----
     For scopes where two humans may edit the same client at once (today: 'dashboard').
     The write only lands if the row still carries the stamp we last saw; otherwise
     someone else wrote in between and onConflict(remoteData, remoteStamp) fires so the
     caller can re-pull + warn instead of silently clobbering. NOT used for machine
     writes (WMJ sync, registry) — those re-derive every poll and CAS would warn-spam. */
  const lastKnown = {};   // clientId::scope -> updated_at we last saw
  const baseData = {};    // clientId::scope -> the DATA at lastKnown: the common ancestor for a 3-way merge
  const cloneJSON = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  // Order-INSENSITIVE deep-equal. jsonb does not preserve object key order, so a value read back
  // from the server has identical content but a different key order than the local copy — a plain
  // JSON.stringify would report a false difference (the same trap that made plan-refresh rewrite
  // every run). Sort keys before comparing.
  function stableStr(v) {
    if (Array.isArray(v)) return "[" + v.map(stableStr).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stableStr(v[k])).join(",") + "}";
    return JSON.stringify(v === undefined ? null : v);
  }
  const sameVal = (a, b) => stableStr(a) === stableStr(b);
  // 3-WAY MERGE. base = common ancestor, mine = my edits, theirs = the server's current version.
  // A field only I changed keeps MY value; a field only they changed takes THEIRS; a field we
  // BOTH changed takes theirs (last-write-wins) but is pushed onto `conflicts` so the UI can hand
  // the user their own value back. Recurses into objects, and into arrays when every length
  // matches (a structural array change — a row added/removed — is treated as one leaf conflict).
  function merge3(base, mine, theirs, path, conflicts) {
    if (sameVal(mine, theirs)) return mine;   // we agree (also covers both-undefined)
    if (sameVal(mine, base)) return theirs;   // only they touched it
    if (sameVal(theirs, base)) return mine;   // only I touched it
    const po = (x) => x && typeof x === "object" && !Array.isArray(x);
    if (po(mine) && po(theirs)) {
      const b = po(base) ? base : {}, out = {};
      new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)]).forEach((k) => {
        const r = merge3(b[k], mine[k], theirs[k], path ? path + "." + k : k, conflicts);
        if (r !== undefined) out[k] = r;
      });
      return out;
    }
    if (Array.isArray(mine) && Array.isArray(theirs) && Array.isArray(base) && mine.length === base.length && theirs.length === base.length) {
      const out = [];
      for (let i = 0; i < mine.length; i++) out[i] = merge3(base[i], mine[i], theirs[i], path + "." + i, conflicts);
      return out;
    }
    conflicts.push({ path, mine, theirs });   // both changed the same leaf → theirs wins, recorded
    return theirs;
  }
  function pushScopeGuarded(clientId, scope, value, onConflict) {
    if (!client) return;
    const key = clientId + "::" + scope;
    latest[key] = value;
    clearTimeout(timers[key]);
    pending[key] = true;
    timers[key] = setTimeout(async () => {
      try {
        const nowIso = new Date().toISOString();
        if (!lastKnown[key]) {
          // never seen the row (fresh client) — plain upsert, then remember its stamp
          const { data, error } = await client.from("app_state")
            .upsert({ client_id: clientId, scope, data: latest[key], updated_at: nowIso }, { onConflict: "client_id,scope" })
            .select("updated_at");
          if (error) { console.warn("SUPA pushGuarded", scope, error.message); return; }
          if (data && data[0]) { lastKnown[key] = data[0].updated_at; baseData[key] = cloneJSON(latest[key]); }
          return;
        }
        const { data, error } = await client.from("app_state")
          .update({ data: latest[key], updated_at: nowIso })
          .eq("client_id", clientId).eq("scope", scope).eq("updated_at", lastKnown[key])
          .select("updated_at");
        if (error) { console.warn("SUPA pushGuarded", scope, error.message); return; }
        if (data && data.length) { lastKnown[key] = data[0].updated_at; baseData[key] = cloneJSON(latest[key]); return; }   // CAS won
        // 0 rows: either the row vanished or someone else wrote. Look.
        const cur = await client.from("app_state").select("data,updated_at")
          .eq("client_id", clientId).eq("scope", scope).maybeSingle();
        if (!cur.data) {
          const ins = await client.from("app_state")
            .upsert({ client_id: clientId, scope, data: latest[key], updated_at: nowIso }, { onConflict: "client_id,scope" })
            .select("updated_at");
          if (ins.data && ins.data[0]) { lastKnown[key] = ins.data[0].updated_at; baseData[key] = cloneJSON(latest[key]); }
          return;
        }
        // CONFLICT — someone else wrote in between. 3-WAY MERGE so edits to DIFFERENT fields all
        // survive: base = our last-synced ancestor, mine = latest[key], theirs = the server copy.
        const base = baseData[key];
        if (base === undefined) {
          // no ancestor to merge against (shouldn't happen once a row's been seen) — safest
          // fallback is the old behaviour: adopt theirs and report a plain (lossy) conflict.
          lastKnown[key] = cur.data.updated_at; baseData[key] = cloneJSON(cur.data.data);
          if (typeof onConflict === "function") { try { onConflict(cur.data.data, null); } catch (e) {} }
          return;
        }
        let theirs = cur.data.data, theirsStamp = cur.data.updated_at, landed = false, conflicts = [];
        for (let attempt = 0; attempt < 3 && !landed; attempt++) {
          conflicts = [];
          const merged = merge3(base, latest[key], theirs, "", conflicts);
          const up = await client.from("app_state")
            .update({ data: merged, updated_at: new Date().toISOString() })
            .eq("client_id", clientId).eq("scope", scope).eq("updated_at", theirsStamp)
            .select("updated_at");
          if (up.error) { console.warn("SUPA merge", scope, up.error.message); break; }
          if (up.data && up.data.length) {                      // merged landed
            lastKnown[key] = up.data[0].updated_at; baseData[key] = cloneJSON(merged); latest[key] = cloneJSON(merged);
            if (typeof onConflict === "function") { try { onConflict(merged, conflicts); } catch (e) {} }
            landed = true;
          } else {                                              // a THIRD writer raced in — re-pull + retry
            const again = await client.from("app_state").select("data,updated_at")
              .eq("client_id", clientId).eq("scope", scope).maybeSingle();
            if (!again.data) break;
            theirs = again.data.data; theirsStamp = again.data.updated_at;
          }
        }
        if (!landed) {   // repeated races / error — adopt the newest remote so we never spin, report lossy
          lastKnown[key] = theirsStamp; baseData[key] = cloneJSON(theirs);
          if (typeof onConflict === "function") { try { onConflict(theirs, null); } catch (e) {} }
        }
      } catch (e) { console.warn("SUPA pushGuarded", scope, e); }
      finally { pending[key] = false; }
    }, 600);
  }

  // IMMEDIATE push (no debounce) that the caller can await — used for ordered writes
  // like the waiting-room draft→sent move, where the sequencing matters. It MUST also
  // clear any queued debounced write for the same key (timer AND its pending value):
  // otherwise a pushScope() fired just before Send would re-run 600ms later and
  // resurrect data this call just replaced.
  async function pushScopeNow(clientId, scope, value) {
    if (!client) return { ok: false, error: "supabase-not-configured" };
    await ready;
    const key = clientId + "::" + scope;
    clearTimeout(timers[key]); delete timers[key]; delete latest[key];
    pending[key] = true;
    try {
      const { error } = await client.from("app_state").upsert(
        { client_id: clientId, scope, data: value, updated_at: new Date().toISOString() },
        { onConflict: "client_id,scope" }
      );
      if (error) { console.warn("SUPA pushNow", scope, error.message); return { ok: false, error: error.message }; }
      return { ok: true };
    } catch (e) { console.warn("SUPA pushNow", scope, e); return { ok: false, error: String(e) }; }
    finally { pending[key] = false; }
  }

  // delete every scope row for a client (used when an admin removes a workspace)
  async function removeClient(clientId) {
    if (!client) return;
    try {
      const { error } = await client.from("app_state").delete().eq("client_id", clientId);
      if (error) console.warn("SUPA removeClient", error.message);
    } catch (e) { console.warn("SUPA removeClient", e); }
  }

  return { enabled, client, ready, refreshSession, signIn, signOut, currentSession, pullScope, pullScopeFull, pollScope, markScopeSeen, subscribeScope, hasPendingWrite, pullAllScope, pushScope, pushScopeNow, pushScopeGuarded, removeClient };
})();
