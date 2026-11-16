/* ============================================================
   CLIENT-DASHBOARD — a client login's ONLY way to read its dashboard (2026-11-16, launch audit).

   Why: RLS is row-level, so when clients read app_state.dashboard directly they received the
   WHOLE row — including everything the UI merely hides from them: CRF dollars, internal
   (team-only) project-plan phases/tasks, internal dependencies, team-only tiles' contents and
   archived projects. One devtools query exposed it all. schema-v18 removes the client's
   SELECT on the dashboard scope; this function serves the same row with the staff-only parts
   stripped (the `budget` function's publicView pattern).

   Staff never call this — they keep reading the full row directly (RLS allows it).

   POST {stampOnly?: boolean}  (the client id always comes from the caller's profile)
     → { ok, updated_at, data? }   data omitted when stampOnly (the cheap "changed?" poll)

   Deploy: supabase functions deploy client-dashboard --use-api --no-verify-jwt   (does its own auth)
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";

const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

import { clientSafe } from "../_shared/client-safe.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  // deno-lint-ignore no-explicit-any
  let body: any = {}; try { body = await req.json(); } catch { /* empty body is fine */ }
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (!caller.clientId || caller.clientId === "unassigned") return json(req, 403, { error: "no workspace" });

  const cols = body && body.stampOnly ? "updated_at" : "data,updated_at";
  const { data: row, error } = await svc().from("app_state").select(cols)
    .eq("client_id", caller.clientId).eq("scope", "dashboard").maybeSingle();
  if (error) return json(req, 500, { error: error.message });
  if (!row) return json(req, 200, { ok: true, updated_at: null, data: null });
  // deno-lint-ignore no-explicit-any
  const r = row as any;
  if (body && body.stampOnly) return json(req, 200, { ok: true, updated_at: r.updated_at });
  // staff get the full row (they can read it directly anyway); everyone else gets the safe copy
  const staff = ["admin", "manager", "creative", "media", "team"].includes(caller.role);
  return json(req, 200, { ok: true, updated_at: r.updated_at, data: staff ? r.data : clientSafe(r.data) });
});
