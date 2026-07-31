/* ============================================================
   DRIVE-FILE — the authenticated read proxy for everything stored in Drive.

   Files in "TJA Client Portal Storage" are left RESTRICTED (never link-shared): clients sign in
   to the PORTAL, not to Google, so a Drive link would have to be made public for their browser to
   load it — and these folders hold MSA/SOW contracts and unreleased creative. Cameron chose the
   proxy for exactly that reason (2026-07-31). So: the browser asks US, we check the caller, then
   we stream the bytes with the service account's credentials.

   THE ENTITLEMENT RULE — a caller may only read a file that lives under the Drive folder of a
   client they're allowed to see:
     • client  → their OWN workspace only (from the JWT, never the query string)
     • staff   → any client (they already read every client under RLS)
   Enforced by walking the file's Drive parents up to the client's recorded folder id, so a
   guessed/copied file id from another client is refused even though the service account could
   technically read it.

   WHY A PROXY AND NOT A REDIRECT: handing the browser a Drive URL with the SA's access token
   would grant it everything the service account can see. Never do that.

   Also sets CORS + long-lived cache headers, which matters beyond privacy: the Present Docs
   review canvas draws proofs and exportPDF calls toDataURL(), so the image host MUST send
   Access-Control-Allow-Origin or the canvas taints and the PDF export throws. Drive's own media
   endpoints don't reliably send it; ours does.

   GET /drive-file?id=<driveFileId>&client=<clientId>
   Deploy: supabase functions deploy drive-file --use-api
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";
import { driveAccessToken } from "../_shared/google.ts";

const DRIVE = "https://www.googleapis.com/drive/v3";
// Proofs/documents are immutable — a new version is a new Drive file — so let browsers keep them.
// `private` because the response is entitlement-checked: shared caches must not reuse it.
const CACHE = "private, max-age=31536000, immutable";

type Meta = { id: string; name?: string; mimeType?: string; parents?: string[]; size?: string };

async function fileMeta(token: string, id: string): Promise<Meta | null> {
  const u = new URL(`${DRIVE}/files/${encodeURIComponent(id)}`);
  u.searchParams.set("fields", "id,name,mimeType,parents,size");
  u.searchParams.set("supportsAllDrives", "true");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`drive meta ${r.status}`);
  return await r.json();
}

/* Is `fileId` inside `folderId` (at any depth)? Drive gives us parents one hop at a time, so walk
   up. Bounded to 6 hops — our tree is root/client/asset-type/file, so anything deeper than that
   isn't ours. Memoised per request to keep a shared parent from being fetched twice. */
async function isUnder(token: string, meta: Meta, folderId: string): Promise<boolean> {
  const seen = new Set<string>();
  let level = meta.parents ?? [];
  for (let hop = 0; hop < 6 && level.length; hop++) {
    if (level.includes(folderId)) return true;
    const next: string[] = [];
    for (const p of level) {
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const pm = await fileMeta(token, p);
        if (pm?.parents) next.push(...pm.parents);
      } catch { /* unreadable parent — treat as a dead end */ }
    }
    level = next;
  }
  return false;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "GET" && req.method !== "HEAD") return json(req, 405, { error: "GET only" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "drive not configured" });

  const url = new URL(req.url);
  const fileId = (url.searchParams.get("id") || "").trim();
  if (!fileId) return json(req, 400, { error: "id required" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });

  // A client is pinned to their own workspace; staff may name one. Never trust the query string
  // for a client caller — that's the whole boundary.
  const clientId = caller.role === "client"
    ? caller.clientId
    : (url.searchParams.get("client") || "").trim();
  if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "no target client" });

  const entry = await registryEntry(clientId);
  const clientFolder = entry?.integrations?.driveFolderId;
  if (!clientFolder) return json(req, 409, { error: "drive not provisioned for this client" });

  try {
    const token = await driveAccessToken();
    const meta = await fileMeta(token, fileId);
    if (!meta) return json(req, 404, { error: "not found" });
    // The check that makes a copied file id useless outside its own client.
    if (!(await isUnder(token, meta, clientFolder)))
      return json(req, 403, { error: "file does not belong to this client" });

    const media = new URL(`${DRIVE}/files/${encodeURIComponent(fileId)}`);
    media.searchParams.set("alt", "media");
    media.searchParams.set("supportsAllDrives", "true");
    const r = await fetch(media, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return json(req, 502, { error: `drive read ${r.status}` });

    const h = new Headers();
    h.set("Content-Type", meta.mimeType || "application/octet-stream");
    h.set("Cache-Control", CACHE);
    // Inline so <img>/<iframe> render it; the filename is still right if the user saves it.
    h.set("Content-Disposition", `inline; filename="${(meta.name || "file").replace(/"/g, "")}"`);
    // Canvas markup + PDF export depend on this being permissive.
    h.set("Access-Control-Allow-Origin", req.headers.get("origin") || "*");
    h.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (meta.size) h.set("Content-Length", meta.size);
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: h });
    return new Response(r.body, { status: 200, headers: h });   // streamed, not buffered
  } catch (e) {
    console.error("drive-file", fileId, e);
    return json(req, 502, { error: "drive read failed" });
  }
});
