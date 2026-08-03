/* ============================================================
   PLAN-REFRESH — re-pulls every connected project plan from Drive
   (via the service account) and writes the updated plan back, so
   the portal auto-updates when a plan sheet is edited.

   Google Sheets can't PUSH edits, so this POLLS: a GitHub Actions
   cron hits it every ~15 min. It only WRITES a client's row when
   that plan actually changed (JSON compare), so it's cheap and
   doesn't spuriously repaint open dashboards.

   Gate: the shared SNAPSHOT_SECRET (same as snapshot-months), NOT a
   JWT — deploy with --no-verify-jwt.
     supabase functions deploy plan-refresh --use-api --no-verify-jwt
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { driveAccessToken, driveGetMeta, parseDriveFileId, parseSheetGid } from "../_shared/google.ts";
import { audit } from "../_shared/audit.ts";
import { fetchPlanFromDrive as fetchPlan, stable } from "../_shared/planfetch.ts";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "GOOGLE_SA_KEY missing" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let token: string;
  try { token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly"); }
  catch (e) { return json(req, 502, { error: "sa token: " + String((e as Error).message || e) }); }

  const { data: rows } = await svc.from("app_state").select("client_id,data,updated_at").eq("scope", "dashboard");

  /* WHY THE STAMPS: this function used to download + parse EVERY connected workbook (a full
     .xlsx each, some with 25-week Gantt grids) on every 15-minute run. That total crossed the
     Edge Function compute ceiling — HTTP 546 WORKER_RESOURCE_LIMIT — killing the run partway
     and leaving every client after the crash point stale (2026-08-03). Now each file costs one
     Drive metadata call, and the download + XLSX parse happens ONLY when the file's
     modifiedTime moved since the last successful parse. A quiet fleet is near-zero work. */
  const STAMP_ID = "_plan_refresh";
  const { data: srow } = await svc.from("app_state").select("data")
    .eq("client_id", STAMP_ID).eq("scope", "state").maybeSingle();
  const stamps: Record<string, string> = (srow && srow.data && typeof srow.data === "object" && !Array.isArray(srow.data))
    ? { ...(srow.data as Record<string, string>) } : {};
  let stampsDirty = false;

  // Soft deadline: end cleanly with work remaining rather than being killed mid-write. The
  // cron re-runs in 15 minutes and the stamps make the next pass cheap, so it converges.
  const DEADLINE = Date.now() + 60_000;
  const cache: Record<string, unknown> = {};   // fileId → parsed plan (dedupe shared files)
  let checked = 0, changed = 0, failed = 0, skipped = 0, unchanged = 0, deferred = 0;

  for (const row of (rows || [])) {
    if (String(row.client_id).startsWith("_")) continue;
    const data = row.data as { engagements?: { projects?: Array<{ projectPlanSheetUrl?: string; projectPlanSheet?: unknown }> } };
    const projs = data?.engagements?.projects;
    if (!Array.isArray(projs)) continue;
    let dirty = false;
    for (const p of projs) {
      const fileId = parseDriveFileId(p.projectPlanSheetUrl || "");
      if (!fileId) continue;
      if (Date.now() > DEADLINE) { deferred++; continue; }
      checked++;
      try {
        if (!(fileId in cache)) {
          // 1 metadata call decides whether the heavy fetch+parse runs at all. Skip only when
          // the stored plan is real — a failed prior parse must retry even if the file is quiet.
          const meta = await driveGetMeta(token, fileId);
          const stored = p.projectPlanSheet as { groups?: unknown[] } | null;
          if (meta.modifiedTime && stamps[fileId] === meta.modifiedTime
            && stored && Array.isArray(stored.groups) && stored.groups.length) {
            unchanged++; checked--; continue;
          }
          cache[fileId] = await fetchPlan(token, fileId, parseSheetGid(p.projectPlanSheetUrl || ""));
          if (meta.modifiedTime) { stamps[fileId] = meta.modifiedTime; stampsDirty = true; }
        }
        const plan = cache[fileId] as { groups?: unknown[] } | null;
        if (plan && Array.isArray(plan.groups) && plan.groups.length
          && stable(plan) !== stable(p.projectPlanSheet)) {
          p.projectPlanSheet = plan; dirty = true; changed++;
        }
      } catch (_e) { failed++; }
    }
    if (dirty) {
      // GUARDED write: only land if the row still carries the stamp we read. A human may have
      // edited this dashboard (e.g. toggled a plan item's client-visibility) between our read
      // and now — writing our copy blind would resurrect what they just hid. If the stamp moved,
      // skip this client; the plan still differs from stored, so the next run re-pulls it. We
      // touch ONLY projectPlanSheet, so planInternal (the hidden-item flags) is carried through
      // untouched either way. bump updated_at so open dashboards pick it up via auto-refresh.
      const { data: upd } = await svc.from("app_state")
        .update({ data, updated_at: new Date().toISOString() })
        .eq("client_id", row.client_id).eq("scope", "dashboard").eq("updated_at", row.updated_at)
        .select("client_id");
      if (!upd || !upd.length) { skipped++; changed--; }   // lost the race — leave the human edit intact
      else audit({ clientId: row.client_id, scope: "dashboard", action: "plan.refreshed", summary: "project plan re-pulled from the connected sheet" });
    }
  }
  if (stampsDirty) {
    await svc.from("app_state").upsert(
      { client_id: STAMP_ID, scope: "state", data: stamps, updated_at: new Date().toISOString() },
      { onConflict: "client_id,scope" },
    );
  }
  return json(req, 200, { ok: true, checked, changed, failed, skipped, unchanged, deferred });
});
