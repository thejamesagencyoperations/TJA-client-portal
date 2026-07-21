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
import { registryEntry } from "../_shared/registry.ts";
import { driveAccessToken } from "../_shared/google.ts";

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

  const entry = await registryEntry(clientId);
  const folderId = entry?.integrations?.driveFolderId;
  if (!folderId) return json(req, 409, { error: "drive not configured for this client" });

  try {
    const token = await driveAccessToken();
    const up = await uploadToDrive(token, folderId, file);
    return json(req, 200, { ok: true, driveId: up.id, driveLink: up.webViewLink });
  } catch (e) {
    console.error("drive upload failed", e);
    return json(req, 502, { error: "drive upload failed" });
  }
});
