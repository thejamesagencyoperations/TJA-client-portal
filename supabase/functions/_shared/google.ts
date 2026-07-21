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

// File metadata (name + mimeType) — used to choose export (native Google Sheet)
// vs raw download (uploaded .xlsx).
export async function driveGetMeta(token: string, fileId: string): Promise<{ name: string; mimeType: string }> {
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=name,mimeType&supportsAllDrives=true`,
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
