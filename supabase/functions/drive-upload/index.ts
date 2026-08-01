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
import { ensureClientFolders, folderForCategory, ensureFolder } from "../_shared/drive-tree.ts";

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

/* A folderId reaches us from the deliverable record, which lives in the client's own app_state —
   so it is CALLER-INFLUENCED and must never be trusted as a write target on its own. Walk its
   parents up to the client's root; anything that doesn't lead there is refused. Bounded hops so a
   cycle or a deep graph can't spin. */
async function isUnder(token: string, folderId: string, rootId: string): Promise<boolean> {
  let cur = folderId;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur === rootId) return true;
    const u = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(cur)}`);
    u.searchParams.set("fields", "id,parents,trashed");
    u.searchParams.set("supportsAllDrives", "true");
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return false;
    const j = await r.json();
    if (j.trashed) return false;
    cur = j.parents?.[0];
    if (cur === rootId) return true;
  }
  return false;
}

async function renameFolder(token: string, folderId: string, name: string) {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,name`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name }) });
  if (!r.ok) throw new Error(`drive rename ${r.status}: ${(await r.text()).slice(0, 200)}`);
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

  const rootId0 = Deno.env.get("DRIVE_ROOT_FOLDER_ID");
  if (!rootId0) return json(req, 428, { error: "DRIVE_ROOT_FOLDER_ID not set" });

  /* RENAME branch (JSON, not multipart). A deliverable's folder is created at file-select time,
     before the brief dialog exists, so it is first named after the FILE. Once the subject is
     typed we rename it — that is what makes the folder match the Present Doc's title, which is
     what was actually asked for. */
  if ((req.headers.get("content-type") || "").includes("application/json")) {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { return json(req, 400, { error: "bad json" }); }
    if (String(body.action || "") !== "rename-folder") return json(req, 400, { error: "unknown action" });
    const cid = (caller.role === "client") ? caller.clientId : (String(body.clientId || "").trim() || caller.clientId);
    const fid = String(body.folderId || "").trim();
    const nm = String(body.name || "").trim().replace(/[\\/'"\r\n]+/g, " ").slice(0, 120);
    if (!cid || !fid || !nm) return json(req, 400, { error: "clientId, folderId and name required" });
    try {
      const token = await driveAccessToken();
      const tree = await ensureClientFolders(token, rootId0, cid);
      if (!tree) return json(req, 404, { error: "unknown client" });
      if (!(await isUnder(token, fid, tree.folderId))) return json(req, 403, { error: "folder is not this client's" });
      await renameFolder(token, fid, nm);
      return json(req, 200, { ok: true, folderId: fid, name: nm });
    } catch (e) {
      console.error("drive rename failed", e);
      return json(req, 502, { error: "drive rename failed: " + String((e as Error).message || e).slice(0, 160) });
    }
  }

  let form: FormData;
  try { form = await req.formData(); } catch { return json(req, 400, { error: "multipart form-data required" }); }
  // One request may carry SEVERAL files ("file" repeated). A 20-page PDF used to mean 20 separate
  // invocations — 20 cold starts, 20 registry reads and 20 folder lookups — which is most of why
  // it took ~30s. Batching also means the subfolder is resolved once per request.
  const files = form.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return json(req, 400, { error: "file required" });
  const over = files.find((f) => f.size > MAX_BYTES);
  if (over) return json(req, 413, { error: `"${over.name}" is over 10 MB` });

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

    // Optional subfolder INSIDE the asset folder — used so a multi-page PDF's page images live
    // together under the deliverable's own name instead of scattering across Present Docs
    // (Cameron 2026-07-31). Sanitised: Drive has no path semantics, but a name with slashes or
    // quotes would break the lookup query.
    // An explicit folderId wins: later rounds of a deliverable (V2, the client's marked-up
    // proof, the approved export) must land in the SAME folder as V1 even after it was renamed,
    // and a name lookup would miss it. Verified against this client's tree before we write.
    const want = String(form.get("folderId") ?? "").trim();
    const sub = String(form.get("subfolder") ?? "").trim().replace(/[\\/'"\r\n]+/g, " ").slice(0, 120);
    let targetId = folderId;
    if (want && await isUnder(token, want, tree.folderId)) targetId = want;
    else if (sub) targetId = await ensureFolder(token, folderId, sub);

    const base = Deno.env.get("SUPABASE_URL");
    const results = [];
    for (const f of files) {
      const up = await uploadToDrive(token, targetId, f);
      // Never hand back webViewLink for DISPLAY — the file is restricted, so a browser can't
      // fetch it. The authenticated proxy path is what the portal stores and renders.
      results.push({
        name: f.name,
        driveId: up.id,
        driveLink: up.webViewLink,
        url: `${base}/functions/v1/drive-file?id=${encodeURIComponent(up.id)}&client=${encodeURIComponent(clientId)}`,
      });
    }
    const first = results[0];
    return json(req, 200, {
      ok: true, folder: folderName, subfolder: sub || null,
      // the folder everything actually landed in — stored on the deliverable so every later
      // artefact (V2, markup, approved PDF) can be aimed straight at it
      folderId: targetId, results,
      // single-file callers keep the original flat shape
      driveId: first.driveId, driveLink: first.driveLink, url: first.url,
    });
  } catch (e) {
    console.error("drive upload failed", e);
    return json(req, 502, { error: "drive upload failed: " + String((e as Error).message || e).slice(0, 160) });
  }
});
