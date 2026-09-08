/* ============================================================
   SEED-DEMO-CLIENT — create (or refresh) a hand-authored PITCH workspace.

   New business needs to show a prospect what their portal would look like. That means a
   workspace with real-looking structure but no Workamajig counterpart, which the portal has
   no other way to produce: the Clients page can create an EMPTY workspace, and everything
   else in the portal is fed from WMJ.

   The payload is a file in the repo (demo/<name>.json), not an argument baked into this
   function, so the next pitch is a new JSON and a re-run rather than a code change.

   TWO SAFETY PROPERTIES, both deliberate:
   • The state it writes carries `demo: true`, which snapshot-months skips. Without it the
     hourly snapshot would find no WMJ actuals for the prospect, blank its service lines and
     roll the burn to 0 — quietly emptying the mock before the pitch.
   • It will NOT overwrite a workspace that isn't already a demo. A prospect that later
     becomes a real client must never be flattened by a stale seed file, so the guard is on
     the STORED state, not on what the payload claims.

   Deploy:  supabase functions deploy seed-demo-client --use-api
   ============================================================ */
import { json, handleOptions } from "../_shared/cors.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (req.headers.get("x-snapshot-secret") !== Deno.env.get("SNAPSHOT_SECRET"))
    return json(req, 401, { error: "bad secret" });

  let body: { registry?: Record<string, unknown>; state?: Record<string, unknown> };
  try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const reg = body.registry, state = body.state;
  if (!reg || !state || !reg.id) return json(req, 400, { error: "payload needs { registry: { id, … }, state: { … } }" });
  if (state.demo !== true) return json(req, 400, { error: "refusing: state.demo must be true — this endpoint only writes demo workspaces" });

  const id = String(reg.id);
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- never flatten a real client
  const { data: existing } = await svc.from("app_state").select("data")
    .eq("client_id", id).eq("scope", "dashboard").maybeSingle();
  if (existing && existing.data && existing.data.demo !== true)
    return json(req, 409, { error: `"${id}" already exists and is NOT a demo workspace — refusing to overwrite it` });

  // ---- registry: replace this id's entry, leave every other client alone
  const { data: regRow } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: Record<string, unknown>[] = Array.isArray(regRow?.data) ? regRow!.data : [];
  const next = roster.filter((c) => String((c as { id?: unknown }).id) !== id).concat([reg]);
  const { error: rerr } = await svc.from("app_state")
    .upsert({ client_id: "_registry", scope: "clients", data: next }, { onConflict: "client_id,scope" });
  if (rerr) return json(req, 500, { error: "registry write failed: " + rerr.message });

  const { error: derr } = await svc.from("app_state")
    .upsert({ client_id: id, scope: "dashboard", data: state }, { onConflict: "client_id,scope" });
  if (derr) return json(req, 500, { error: "dashboard write failed: " + derr.message });

  return json(req, 200, {
    ok: true, id, created: !existing, rosterSize: next.length,
    projects: ((state.engagements as { projects?: unknown[] })?.projects || []).length,
  });
});
