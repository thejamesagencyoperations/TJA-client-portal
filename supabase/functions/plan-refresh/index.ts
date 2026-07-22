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
import * as XLSX from "npm:xlsx@0.18.5";
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { driveAccessToken, driveDownloadBytes, driveExportBytes, driveGetMeta, parseDriveFileId } from "../_shared/google.ts";
import { parseProjectPlanRows } from "../_shared/plan.ts";

function pickSheetName(names: string[]): string {
  return names.find((n) => /plan/i.test(n)) || names[names.length - 1] || names[0];
}
// Order-INSENSITIVE serialization for the change check. Postgres jsonb does NOT preserve
// object key order, so the stored plan comes back with keys in a different order than a
// fresh parse — plain JSON.stringify would then report a "change" on every run. Sorting
// keys makes the comparison reflect real content changes only.
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}
async function fetchPlan(token: string, fileId: string) {
  const meta = await driveGetMeta(token, fileId);
  const bytes = (meta.mimeType === "application/vnd.google-apps.spreadsheet")
    ? await driveExportBytes(token, fileId, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    : await driveDownloadBytes(token, fileId);
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const names: string[] = wb.SheetNames || [];
  if (!names.length) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[pickSheetName(names)], { header: 1, raw: false, dateNF: "m/d/yyyy", defval: "" }) as unknown[][];
  return parseProjectPlanRows(rows);
}

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

  const { data: rows } = await svc.from("app_state").select("client_id,data").eq("scope", "dashboard");
  const cache: Record<string, unknown> = {};   // fileId → parsed plan (dedupe shared files)
  let checked = 0, changed = 0, failed = 0;

  for (const row of (rows || [])) {
    if (String(row.client_id).startsWith("_")) continue;
    const data = row.data as { engagements?: { projects?: Array<{ projectPlanSheetUrl?: string; projectPlanSheet?: unknown }> } };
    const projs = data?.engagements?.projects;
    if (!Array.isArray(projs)) continue;
    let dirty = false;
    for (const p of projs) {
      const fileId = parseDriveFileId(p.projectPlanSheetUrl || "");
      if (!fileId) continue;
      checked++;
      try {
        if (!(fileId in cache)) cache[fileId] = await fetchPlan(token, fileId);
        const plan = cache[fileId] as { groups?: unknown[] } | null;
        if (plan && Array.isArray(plan.groups) && plan.groups.length
          && stable(plan) !== stable(p.projectPlanSheet)) {
          p.projectPlanSheet = plan; dirty = true; changed++;
        }
      } catch (_e) { failed++; }
    }
    if (dirty) {
      // bump updated_at so open dashboards pick it up via the live auto-refresh
      await svc.from("app_state").update({ data, updated_at: new Date().toISOString() })
        .eq("client_id", row.client_id).eq("scope", "dashboard");
    }
  }
  return json(req, 200, { ok: true, checked, changed, failed });
});
