/* ============================================================
   REVIEW-LOCK — one client reviewer at a time per deliverable.

   Why: a Present Doc is ONE record. Two client logins marking up the same proof at the
   same moment is the only situation where one person's drawing can overwrite another's,
   so a proof is opened for REVIEW by a single client login at a time. Everyone else who
   tries gets "<Name> is currently reviewing — please try again later". Staff are never
   locked (they don't review) and never take the lock.

   Storage: one app_state row (client_id "_review_locks", scope "clients"), written ONLY
   here with the service role — clients can't read or write it directly (RLS), so the lock
   can't be forged or cleared from the browser. Every write is compare-and-set on
   updated_at, so two people pressing Open at the same instant can't both win.

   A lock lives while its browser tab heartbeats (every 20s). A closed tab, crashed laptop
   or dropped connection frees it within LOCK_TTL_MS (2.5 min) without anyone doing anything.

   Actions (POST JSON, client JWT):
     { action: "acquire",   docId, sessionId }  → { ok:true } | { ok:false, holder:{name,email}, sameUser }
     { action: "heartbeat", docId, sessionId }  → same shape (ok:false = the lock was lost)
     { action: "release",   docId, sessionId }  → { ok:true }

   Deploy: supabase functions deploy review-lock --use-api --project-ref sliutkbdpuimxxmvsbek
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const LOCK_CLIENT = "_review_locks";
const LOCK_SCOPE = "clients";
const LOCK_TTL_MS = 150_000;         // ~7 missed beats (background tabs are throttled) → the lock is free

type Lock = { email: string; name: string; sessionId: string; at: number };
type Locks = Record<string, Record<string, Lock>>;   // clientId → docId → lock

const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function displayName(userId: string, email: string): Promise<string> {
  try {
    const { data } = await svc().auth.admin.getUserById(userId);
    const n = String(data?.user?.user_metadata?.name || "").trim();
    if (n) return n;
  } catch (_e) { /* fall through */ }
  return email.split("@")[0] || "Another reviewer";
}

/* Read → mutate → compare-and-set, retried on a lost race. `mutate` returns the result to
   hand back, or throws. The row is tiny, so a retry costs nothing. */
async function withLocks<T>(mutate: (locks: Locks) => { result: T; changed: boolean }): Promise<T> {
  const db = svc();
  for (let attempt = 0; attempt < 8; attempt++) {
    const { data: row, error } = await db.from("app_state").select("data,updated_at")
      .eq("client_id", LOCK_CLIENT).eq("scope", LOCK_SCOPE).maybeSingle();
    if (error) throw new Error("lock read failed: " + error.message);
    const locks: Locks = (row?.data && typeof row.data === "object" && !Array.isArray(row.data)) ? row.data as Locks : {};
    // prune anything stale while we're here, so the row can't grow without bound
    const now = Date.now();
    for (const c of Object.keys(locks)) {
      for (const d of Object.keys(locks[c] || {})) if (now - (locks[c][d]?.at || 0) > LOCK_TTL_MS) delete locks[c][d];
      if (!Object.keys(locks[c] || {}).length) delete locks[c];
    }
    const { result, changed } = mutate(locks);
    if (!changed) return result;
    const stamp = new Date().toISOString();
    if (!row) {
      const ins = await db.from("app_state").insert({ client_id: LOCK_CLIENT, scope: LOCK_SCOPE, data: locks, updated_at: stamp });
      if (!ins.error) return result;
    } else {
      const up = await db.from("app_state").update({ data: locks, updated_at: stamp })
        .eq("client_id", LOCK_CLIENT).eq("scope", LOCK_SCOPE).eq("updated_at", row.updated_at).select("updated_at");
      if (!up.error && up.data && up.data.length) return result;
    }
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));   // lost the race — re-read
  }
  throw new Error("lock busy — please try again");
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  // Only CLIENT logins review, so only they take locks. Staff get a no-op success so a
  // preview-as-client or an admin opening the proof is never blocked.
  if (caller.role !== "client" || !caller.clientId || caller.clientId.startsWith("_")) return json(req, 200, { ok: true, staff: true });

  let body: { action?: string; docId?: string; sessionId?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const docId = String(body.docId || "").trim().slice(0, 200);
  const sessionId = String(body.sessionId || "").trim().slice(0, 200);
  if (!docId || !sessionId) return json(req, 400, { error: "docId and sessionId required" });
  const clientId = caller.clientId;                 // from the profile — never the body
  const email = String(caller.email || "").toLowerCase();

  try {
    if (action === "release") {
      await withLocks((locks) => {
        const cur = locks[clientId]?.[docId];
        if (!cur || cur.sessionId !== sessionId) return { result: null, changed: false };
        delete locks[clientId][docId];
        return { result: null, changed: true };
      });
      return json(req, 200, { ok: true });
    }
    if (action !== "acquire" && action !== "heartbeat") return json(req, 400, { error: "unknown action" });

    const name = action === "acquire" ? await displayName(caller.userId, email) : "";
    const out = await withLocks((locks) => {
      const cur = locks[clientId]?.[docId];
      if (cur && cur.sessionId !== sessionId) {
        // held by someone else (or by this same person in another tab/window)
        return { result: { ok: false, holder: { name: cur.name, email: cur.email }, sameUser: cur.email === email }, changed: false };
      }
      locks[clientId] = locks[clientId] || {};
      locks[clientId][docId] = { email, name: (cur && cur.name) || name || email, sessionId, at: Date.now() };
      return { result: { ok: true }, changed: true };
    });
    return json(req, 200, out);
  } catch (e) {
    console.error("review-lock", e);
    return json(req, 503, { error: String((e as Error).message || e).slice(0, 200) });
  }
});
