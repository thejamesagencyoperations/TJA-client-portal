/* ============================================================
   DRIVE-PROVISION — builds and maintains the Drive folder tree that backs the portal.

     TJA Client Portal Storage/            <- DRIVE_ROOT_FOLDER_ID (a Shared Drive folder)
       <Client Name>/
         Present Docs/  Reporting/  Monthly Snapshots/  Files/
         Media Requests/  History/  Misc./

   IDEMPOTENT BY DESIGN (Cameron 2026-07-31: "if we add future features make sure to remember we
   will need to update the folders for all clients existing and future"). Every run ensures the
   FULL set exists for EVERY client, creating only what's missing. So adding an 8th asset type is
   a one-line change to ASSET_FOLDERS plus a re-run, and all 50 existing clients get back-filled
   automatically. New clients are provisioned the first time anything needs their folder.

   Folder ids are recorded on the client's registry entry as integrations.driveFolders
   { "Present Docs": "<id>", … } plus integrations.driveFolderId (the client's own folder), so
   every other function resolves a destination from the registry — never from a request body.

   Files are left RESTRICTED in Drive. Nothing is link-shared: the portal serves them through
   drive-file (the authenticated proxy), because clients sign in to the PORTAL, not to Google, and
   MSA/SOW documents must never be publicly reachable.

   Gate: SNAPSHOT_SECRET header (cron/admin), or an admin/manager JWT.
   Deploy: supabase functions deploy drive-provision --use-api
   Secrets: GOOGLE_SA_KEY, DRIVE_ROOT_FOLDER_ID, SNAPSHOT_SECRET
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken } from "../_shared/google.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { updateRegistry } from "../_shared/registry.ts";
// The folder list + tree helpers live in _shared so drive-upload can provision on demand with
// exactly the same definition. Add a folder type THERE and re-run this to back-fill everyone.
import { ASSET_FOLDERS, ensureClientTree } from "../_shared/drive-tree.ts";

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  // cron secret OR a staff JWT (admin/manager) — this creates Drive structure, not client data
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  const viaSecret = !!secret && req.headers.get("x-snapshot-secret") === secret;
  if (!viaSecret) {
    const caller = await getCaller(req);
    if (!caller) return json(req, 401, { error: "not signed in" });
    if (!["admin", "manager"].includes(caller.role)) return json(req, 403, { error: "staff only" });
  }
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "GOOGLE_SA_KEY missing" });
  const rootId = Deno.env.get("DRIVE_ROOT_FOLDER_ID");
  if (!rootId) return json(req, 428, { error: "DRIVE_ROOT_FOLDER_ID not set — point it at the 'TJA Client Portal Storage' folder." });

  let body: { clientId?: string; force?: boolean } = {};
  try { body = await req.json(); } catch { /* no body = provision everything */ }

  const db = svc();
  const { data: row } = await db.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: Array<Record<string, unknown>> = Array.isArray(row?.data) ? row!.data : [];
  if (!roster.length) return json(req, 409, { error: "client registry is empty" });

  const only = String(body.clientId || "").trim();
  const targets = roster.filter((c) => {
    const id = String(c.id || "");
    if (!id || id.startsWith("_")) return false;                 // sentinels aren't clients
    if (/\b\d{1,2}(:\d{2})?\s*(a|p)m\b/i.test(String(c.name || ""))) return false;  // junk WMJ row
    return only ? id === only : true;
  });
  if (only && !targets.length) return json(req, 404, { error: "unknown client" });

  const token = await driveAccessToken();
  const createdAll: string[] = [];
  const failed: Array<{ client: string; error: string }> = [];
  let touched = 0, skipped = 0, remaining = 0;

  // Each folder costs a Drive round-trip (~0.7s), so ~14 calls per fresh client. Provisioning 50
  // clients in one invocation would run for minutes and hit the function's wall clock. Instead:
  // skip clients already fully recorded (zero Drive calls), and stop on a time budget reporting
  // `remaining` so the caller can loop. Registry state makes the whole thing resumable.
  const BUDGET_MS = 95_000;
  const startedAt = Date.now();

  for (const c of targets) {
    const id = String(c.id), name = String(c.name || id);
    const integ = (c.integrations && typeof c.integrations === "object" ? c.integrations : {}) as Record<string, unknown>;
    const known = (body.force ? {} : (integ.driveFolders as Record<string, string>)) || {};
    // Fully provisioned already? Nothing to do — and crucially, no Drive traffic.
    const complete = !body.force && !!integ.driveFolderId && ASSET_FOLDERS.every((n) => known[n]);
    if (complete) { skipped++; continue; }
    if (Date.now() - startedAt > BUDGET_MS) { remaining++; continue; }
    try {
      const tree = await ensureClientTree(token, rootId, name, known);
      integ.driveFolderId = tree.folderId;
      integ.driveFolders = tree.folders;
      c.integrations = integ;
      createdAll.push(...tree.created);
      touched++;
    } catch (e) {
      failed.push({ client: name, error: String((e as Error).message || e).slice(0, 160) });
    }
  }

  // ONE write of the registry at the end (service role, so it bypasses RLS). Writing per-client
  // would multiply the chance of racing a browser's roster push.
  // Apply ONLY the folder ids we provisioned onto a fresh copy (compare-and-set) — a blind
  // whole-row write here could undo a manager/toggle change made while we were provisioning.
  const folderIds = new Map(roster.filter((c: any) => c?.integrations?.driveFolderId).map((c: any) => [String(c.id), c.integrations]));
  const w = await updateRegistry((fresh) => {
    for (const fc of fresh) {
      const ig: any = folderIds.get(String(fc.id)); if (!ig) continue;
      fc.integrations = Object.assign({}, fc.integrations, { driveFolderId: ig.driveFolderId, driveFolders: ig.driveFolders });
    }
  });
  if (!w.ok) return json(req, 500, { error: "registry write failed: " + w.error, created: createdAll, failed });

  return json(req, 200, {
    ok: true, clients: targets.length, provisioned: touched, alreadyDone: skipped,
    remaining,                                   // >0 → call again to continue (state is durable)
    foldersCreated: createdAll.length, created: createdAll.slice(0, 60),
    failed,
  });
});
