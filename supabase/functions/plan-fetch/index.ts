/* ============================================================
   PLAN-FETCH — reads a PRIVATE TJA project-plan file straight from
   Google Drive (via the service account) and returns it parsed.

   Why this exists: project plans are private .xlsx Gantt files, so
   the client-side "paste a public Sheet link" path (PR Coverage /
   Status Report) can't reach them. Here the portal's backend reads
   the file with the service account it's been shared with — no
   public sharing, no converting the .xlsx to a native Sheet.

   Caller: staff only (admin / manager / creative). Clients never
   fetch plans. Body (JSON): { clientId, fileUrl | fileId }.
   NOTE: clientId is advisory/logging only — it does NOT scope access.
   Any staff caller can read any file the service account was shared
   on (staff see all clients by design; there is no per-client plan
   registry to validate against). Do not mistake it for a gate.
   Returns: { ok, plan } where plan = { meta, groups } (see
   _shared/plan.ts), or a soft error. The admin UI stores the
   result into eng.projectPlanSheet via the normal guarded write.

   Setup + deploy: see _shared/google.ts for the GOOGLE_SA_KEY
   setup. Deploy with:
     supabase functions deploy plan-fetch --use-api
   (--use-api is mandatory on this Mac — the Docker bundler fails
   with "failed to open eszip: ENOENT".)
   ============================================================ */
import * as XLSX from "npm:xlsx@0.18.5";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken, driveDownloadBytes, driveExportBytes, driveGetMeta, parseDriveFileId } from "../_shared/google.ts";
import { parseProjectPlanRows } from "../_shared/plan.ts";

// Pick the plan tab: prefer a sheet named like "…plan…", else the last sheet
// (the CEL workbook is [Team, Project Plan]), else the first.
function pickSheetName(names: string[]): string {
  return names.find((n) => /plan/i.test(n)) || names[names.length - 1] || names[0];
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "drive not configured (GOOGLE_SA_KEY missing)" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (caller.role === "client") return json(req, 403, { error: "staff only" });

  let body: { fileUrl?: string; fileId?: string; clientId?: string; sheet?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }

  const fileId = parseDriveFileId(body.fileId || body.fileUrl || "");
  if (!fileId) return json(req, 400, { error: "a Google Drive file link or id is required" });

  try {
    const token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");
    const meta = await driveGetMeta(token, fileId);

    // ONE parse path for everything: a NATIVE Google Sheet is exported as a full .xlsx
    // workbook (CSV export only yields the FIRST tab — wrong for [Team, Project Plan]
    // shaped workbooks); uploaded files (.xlsx, .ods, …) download raw. SheetJS reads
    // both, and pickSheetName finds the plan tab either way.
    const bytes = (meta.mimeType === "application/vnd.google-apps.spreadsheet")
      ? await driveExportBytes(token, fileId, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      : await driveDownloadBytes(token, fileId);
    const wb = XLSX.read(bytes, { type: "array", cellDates: true });
    const sheetNames: string[] = wb.SheetNames || [];
    if (!sheetNames.length) return json(req, 422, { error: "workbook has no sheets" });
    const sheetName = (body.sheet && sheetNames.includes(body.sheet)) ? body.sheet : pickSheetName(sheetNames);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, dateNF: "m/d/yyyy", defval: "" }) as unknown[][];

    const plan = parseProjectPlanRows(rows);
    if (!plan) return json(req, 422, { error: "couldn't read a project plan from that file — expected the #, Task, Who, Dependency, Start, End, % Done, Notes columns" });
    return json(req, 200, { ok: true, fileId, name: meta.name, sheet: sheetName, sheetNames, plan });
  } catch (e) {
    console.error("plan-fetch failed", e);
    const msg = String(e && (e as Error).message || e);
    // A 404 from Drive almost always means "not shared with the service account".
    if (/download 404|File not found|notFound/i.test(msg)) {
      return json(req, 404, { error: "file not found — is it shared with the service account's email (Viewer)?" });
    }
    return json(req, 502, { error: "couldn't read the plan file from Drive" });
  }
});
