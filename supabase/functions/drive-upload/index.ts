/* ============================================================
   DRIVE-UPLOAD — pushes a client's Files-tab upload into that
   client's Google Drive folder, so Drive (not the portal) is the
   store of record. The portal keeps metadata + the Drive link.

   THE SECURITY RULE: a CLIENT caller's target folder is derived
   from their JWT-bound client_id — any clientId form field they
   send is IGNORED, so no client can ever write into another
   client's folder. Staff (admin/creative) may pass clientId since
   they upload on any client's behalf.

   Setup (one-time):
     1. Google Cloud → service account (no domain-wide delegation
        needed). Download its JSON key.
     2. Share each client's Drive folder with the SA's email as
        Content manager (or share one parent folder).
     3. supabase secrets set GOOGLE_SA_KEY="$(base64 -i sa-key.json)"
     4. supabase functions deploy drive-upload --use-api
        (--use-api is NOT optional: the default path bundles via Docker
         and fails on this Mac with "failed to open eszip: ENOENT" — the
         edge-runtime image pulls and runs but emits no bundle.)
     5. Paste each folder's URL into the client's Integrations in
        the portal (clients.html → Edit → Integrations).

   Body: multipart/form-data — file (required), clientId (staff only).
   Limits: 10 MB (client-side cap matches). Larger files → Drive
   resumable sessions, noted as the follow-up if ever needed.
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken } from "../_shared/google.ts";
import { ensureClientFolders, folderForCategory } from "../_shared/drive-tree.ts";

const MAX_BYTES = 10 * 1024 * 1024;

/* ---- Drive multipart upload (metadata + media in one request) ---- */
async function uploadToDrive(token: string, folderId: string, file: File): Promise<{ id: string; webViewLink: string }> {
  const boundary = "tja_" + crypto.randomUUID();
  const meta = JSON.stringify({ name: file.name, parents: [folderId] });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${file.type || "application/octet-stream"}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, await file.arrayBuffer(), tail]);
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body },
  );
  if (!r.ok) throw new Error(`drive ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "drive not configured (GOOGLE_SA_KEY missing)" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  // 'team' is a VIEW-ONLY staff tier — uploading is a write, and this runs as the Drive
  // service account (nothing else would stop it). They read files like everyone else.
  if (caller.role === "team") return json(req, 403, { error: "view-only account" });

  let form: FormData;
  try { form = await req.formData(); } catch { return json(req, 400, { error: "multipart form-data required" }); }
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) return json(req, 400, { error: "file required" });
  if (file.size > MAX_BYTES) return json(req, 413, { error: "file over 10 MB" });

  // THE rule: clients upload to their own folder, full stop.
  const clientId = (caller.role === "client")
    ? caller.clientId
    : String(form.get("clientId") ?? "").trim() || caller.clientId;
  if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "no target client" });

  const rootId = Deno.env.get("DRIVE_ROOT_FOLDER_ID");
  if (!rootId) return json(req, 428, { error: "DRIVE_ROOT_FOLDER_ID not set" });

  // Which asset folder this belongs in — "present-docs" → Present Docs, "files" → Files, etc.
  // Anything unrecognised lands in Misc. rather than loose in the client's root.
  const category = String(form.get("category") ?? "").trim();
  const folderName = folderForCategory(category);

  try {
    const token = await driveAccessToken();
    // Provision on demand: a brand-new client's first upload shouldn't fail waiting for the
    // nightly provision run.
    const tree = await ensureClientFolders(token, rootId, clientId);
    if (!tree) return json(req, 404, { error: "unknown client" });
    const folderId = tree.folders[folderName] || tree.folderId;

    const up = await uploadToDrive(token, folderId, file);
    // The portal must NOT use webViewLink to display the file — these files are restricted, so a
    // browser can't fetch them directly. Hand back the authenticated proxy path instead; the
    // caller stores that. webViewLink is returned too, for staff opening it natively in Drive.
    const proxyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/drive-file` +
      `?id=${encodeURIComponent(up.id)}&client=${encodeURIComponent(clientId)}`;
    return json(req, 200, {
      ok: true, driveId: up.id, driveLink: up.webViewLink, url: proxyUrl,
      folder: folderName,
    });
  } catch (e) {
    console.error("drive upload failed", e);
    return json(req, 502, { error: "drive upload failed: " + String((e as Error).message || e).slice(0, 160) });
  }
});
