/* ============================================================
   GOOGLE SERVICE-ACCOUNT AUTH + DRIVE READ
   Shared by drive-upload (write) and plan-fetch (read). One
   service account, one JSON key (base64 in GOOGLE_SA_KEY), signed
   into a short-lived access token with WebCrypto — no googleapis
   SDK needed in Deno.

   Setup (one-time, same key unlocks BOTH features):
     1. Google Cloud → enable the Drive API → create a service
        account → create a JSON key (downloads sa-key.json).
     2. Share the target Drive folder(s)/file(s) with the service
        account's email (Viewer to read plans; Content manager to
        upload). Folder-level share cascades to everything inside.
     3. supabase secrets set GOOGLE_SA_KEY="$(base64 -i sa-key.json)"
   ============================================================ */

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
const b64url = (data: string | Uint8Array) => {
  const bin = typeof data === "string" ? data : String.fromCharCode(...data);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Access token for the given scope. Default is full Drive; readers pass the
// read-only scope. Returns the bearer string.
export async function driveAccessToken(
  scope = "https://www.googleapis.com/auth/drive",
): Promise<string> {
  const raw = Deno.env.get("GOOGLE_SA_KEY");
  if (!raw) throw new Error("GOOGLE_SA_KEY not set");
  const sa = JSON.parse(atob(raw.trim()));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope, aud: sa.token_uri, iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(`${header}.${claims}`)));
  const jwt = `${header}.${claims}.${b64url(sig)}`;
  const r = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!r.ok) throw new Error(`token ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

// Pull a Drive file ID out of whatever an admin pasted (…/d/<id>/…, ?id=<id>,
// /file/d/<id>/view, or a bare id). Returns null if nothing id-shaped is found.
export function parseDriveFileId(raw: string): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  const m = /\/d\/([a-zA-Z0-9_-]{20,})/.exec(s)
    || /[?&]id=([a-zA-Z0-9_-]{20,})/.exec(s)
    || /^([a-zA-Z0-9_-]{20,})$/.exec(s);
  return m ? m[1] : null;
}

// The tab (gid) a Sheets URL points at — "#gid=123" or "?gid=123". Null when absent.
export function parseSheetGid(raw: string): string | null {
  const m = /[?#&]gid=(\d+)/.exec(String(raw || ""));
  return m ? m[1] : null;
}

/* gid → tab title. The xlsx export loses gids, so resolving WHICH tab a stored URL means
   requires one Sheets-metadata call. Null on any failure — callers fall back to the
   name heuristic, so a revoked Sheets scope can never break plan fetching. */
export async function sheetsTitleByGid(fileId: string, gid: string): Promise<string | null> {
  try {
    const token = await driveAccessToken("https://www.googleapis.com/auth/spreadsheets.readonly");
    const u = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}` +
      `?fields=sheets(properties(sheetId,title))`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = await r.json();
    const hit = (j.sheets || []).find((sh: any) => String(sh?.properties?.sheetId) === String(gid));
    return hit?.properties?.title || null;
  } catch (_e) { return null; }
}

// File metadata (name + mimeType) — used to choose export (native Google Sheet)
// vs raw download (uploaded .xlsx).
export async function driveGetMeta(token: string, fileId: string): Promise<{ name: string; mimeType: string; modifiedTime?: string }> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType,modifiedTime&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`drive meta ${r.status}: ${await r.text()}`);
  return await r.json();
}

// Download an uploaded file's raw bytes (works for .xlsx). NOT for native Google
// files — those must be exported (see driveExportCsv). supportsAllDrives covers
// shared drives.
export async function driveDownloadBytes(token: string, fileId: string): Promise<Uint8Array> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`drive download ${r.status}: ${await r.text()}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Export a NATIVE Google file to the given format, as bytes. For a native Sheet we
// export the WHOLE workbook as .xlsx (CSV export only ever yields the first tab —
// useless for multi-tab plan workbooks) and let the caller pick the right sheet.
export async function driveExportBytes(token: string, fileId: string, mimeType: string): Promise<Uint8Array> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`drive export ${r.status}: ${await r.text()}`);
  return new Uint8Array(await r.arrayBuffer());
}

/* ---- Drive write helpers (shared by drive-upload + history-snapshot) ---- */

// Multipart upload of raw bytes into a folder. One request: JSON metadata + media.
export async function driveUploadBytes(
  token: string, folderId: string, name: string, bytes: Uint8Array, mimeType = "application/octet-stream",
): Promise<{ id: string; webViewLink?: string }> {
  const boundary = "tja_" + crypto.randomUUID();
  const meta = JSON.stringify({ name, parents: [folderId] });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = new Blob([head, bytes, tail]);
  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink",
    { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body },
  );
  if (!r.ok) throw new Error(`drive upload ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

// Find a sub-folder by name under `parentId`, creating it if absent. Returns its id.
// Used to lay out history/<snapshots|audit-archive>/<client>/… without pre-made folders.
export async function driveEnsureFolder(token: string, parentId: string, name: string): Promise<string> {
  const q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and ` +
    `mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const u = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
    `&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (r.ok) {
    const j = await r.json();
    if (j.files && j.files.length) return j.files[0].id;
  }
  const c = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!c.ok) throw new Error(`drive mkdir ${c.status}: ${(await c.text()).slice(0, 200)}`);
  return (await c.json()).id;
}

// gzip in-memory (Deno/edge runtime has CompressionStream) — snapshots compress ~10×.
export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([input]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Rows the user HID in a NATIVE Google Sheet, as a Set of 0-based row indices. The .xlsx
// export drops row-visibility entirely (SheetJS sees no '!rows'), so for native Sheets we
// ask the Sheets API directly for rowMetadata.hiddenByUser / hiddenByFilter. Fails SOFT to an
// empty set (Sheets API disabled, not shared, or an .xlsx upload) so plan reads never break.
export async function sheetsHiddenRowSet(fileId: string, sheetTitle: string): Promise<Set<number>> {
  const out = new Set<number>();
  try {
    const token = await driveAccessToken("https://www.googleapis.com/auth/spreadsheets.readonly");
    const u = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(fileId)}` +
      `?ranges=${encodeURIComponent(sheetTitle)}&fields=sheets(properties(title),data(rowMetadata(hiddenByUser,hiddenByFilter)))`;
    const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return out;
    const j = await r.json();
    const sheets = j.sheets || [];
    const sheet = sheets.find((s: any) => s?.properties?.title === sheetTitle) || sheets[0];
    const meta = sheet?.data?.[0]?.rowMetadata || [];
    meta.forEach((m: any, i: number) => { if (m && (m.hiddenByUser || m.hiddenByFilter)) out.add(i); });
  } catch (_e) { /* Sheets API off / not shared → no filtering */ }
  return out;
}
