/* ============================================================
   TJA_FILES — the ONE place every portal upload goes through.

   Present Docs proofs, Media Creative Asset Request files, the Files tab —
   all call TJA_FILES.upload()/uploadDataUrl() so there is a single, swappable
   storage backend. Today the backend is Supabase Storage (the "media-intake"
   bucket that already exists); when the final home is decided (e.g. a Drive
   folder per client), swap ONLY the `put()` implementation below and every
   caller is migrated at once. Files are namespaced by category + client so the
   store stays organised regardless of backend.

   window.TJA_FILES.upload(file, {category, clientId, name})       → {url, path, name, size, type}
   window.TJA_FILES.uploadDataUrl(dataUrl, {category, clientId, name})  (for canvas JPEGs, e.g. proofs)
   ============================================================ */
window.TJA_FILES = (function () {
  /* LIVE as of 2026-07-31 — the backend is Google Drive ("TJA Client Portal Storage"), one
     folder per client, one subfolder per asset type. Uploads go through the drive-upload Edge
     Function (which holds the service-account credentials and provisions folders on demand);
     the URL we store and render is the drive-file PROXY, never a Drive link.

     WHY THE PROXY: these folders hold MSA/SOW contracts and unreleased creative, so files stay
     RESTRICTED in Drive. A client signs in to the PORTAL, not to Google, so a raw Drive URL
     would have to be made public for their browser to load it. The proxy checks the portal
     session + that the file belongs to that client, then streams it with correct CORS (which
     the Present Docs canvas and PDF export both require). */
  const STORAGE_ENABLED = true;

  const safe = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  function fnBase() {
    const cfg = window.SUPABASE_CONFIG || {};
    return cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
  }
  async function token() {
    try {
      const { data } = await window.SUPA.client.auth.getSession();
      if (data && data.session) return data.session.access_token;
      if (window.SUPA.refreshSession) {          // ghost session — try once before failing
        await window.SUPA.refreshSession();
        const r = await window.SUPA.client.auth.getSession();
        if (r.data && r.data.session) return r.data.session.access_token;
      }
    } catch (e) {}
    return null;
  }

  /* THE swap point. Uploads a Blob/File to the client's Drive asset folder and returns the
     proxy URL to store. `category` picks the subfolder (present-docs → Present Docs, files →
     Files, media-intake → Media Requests, …; anything unmapped → Misc.). */
  /* items: [{ blob, name }] — one request per call. `subfolder` groups them inside the asset
     folder (a multi-page PDF's pages belong together under the deliverable's name, not scattered
     across Present Docs). Batching matters for speed too: one invocation, one folder lookup. */
  async function putMany(items, { category, clientId, subfolder, folderId } = {}) {
    if (!fnBase() || !(window.SUPA && window.SUPA.client)) throw new Error("storage-not-configured");
    const t = await token();
    if (!t) throw new Error("session-stale");   // surfaces as an upload error, never a silent skip
    const fd = new FormData();
    items.forEach((it) => fd.append("file", it.blob, safe(it.name || (it.blob && it.blob.name) || "file")));
    if (category) fd.append("category", String(category));
    if (clientId) fd.append("clientId", String(clientId));   // ignored server-side for clients
    if (subfolder) fd.append("subfolder", String(subfolder));
    // Aim straight at a known folder — later rounds of a deliverable must join V1, not start a
    // new folder (and must survive the folder being renamed to the doc's subject).
    if (folderId) fd.append("folderId", String(folderId));
    const r = await fetch(fnBase() + "/drive-upload", {
      method: "POST", headers: { Authorization: "Bearer " + t }, body: fd,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(j.results) || !j.results.length) throw new Error(j.error || `drive-upload ${r.status}`);
    j.results.forEach((x) => { x.folderId = j.folderId; });   // where it landed, for the next round
    return j.results;                            // [{ url (proxy), driveId, driveLink, name, folderId }]
  }
  async function put(blob, opts = {}) {
    const res = await putMany([{ blob, name: opts.name }], opts);
    return res[0];
  }

  async function upload(file, opts = {}) {
    const res = await put(file, { ...opts, name: opts.name || file.name, contentType: file.type });
    return { url: res.url, driveId: res.driveId, driveLink: res.driveLink, folder: res.folder, folderId: res.folderId, folderId: res.folderId,
             name: file.name || safe(opts.name), size: file.size || 0, type: file.type || "" };
  }

  // Present Docs proofs (and generated keyword slides) are canvas JPEG data URLs.
  async function uploadDataUrl(dataUrl, opts = {}) {
    const blob = await (await fetch(dataUrl)).blob();
    const res = await put(blob, { ...opts, name: (opts.name || "proof") + ".jpg", contentType: blob.type || "image/jpeg" });
    return { url: res.url, driveId: res.driveId, driveLink: res.driveLink, folder: res.folder,
             name: opts.name || "file", size: blob.size || 0, type: blob.type || "image/jpeg" };
  }

  /* ---------- READING a stored file ----------
     The proxy requires an Authorization header, and <img src> cannot send one — so a stored
     proxy URL is NOT directly renderable. We fetch it with the session token and hand back a
     blob: URL instead. Two wins beyond auth:
       • blob: is SAME-ORIGIN, so the Present Docs canvas is never tainted and toDataURL()
         (the proof PDF) keeps working — no reliance on CORS headers at all;
       • nothing bearer-ish is ever put in a URL that gets stored or shared.
     Cached per URL for the page's lifetime: the same proof appears in the gallery, the modal
     and the PDF export, and should be fetched once. */
  const blobCache = new Map();
  const isProxy = (u) => typeof u === "string" && u.indexOf("/functions/v1/drive-file") > -1;
  async function blobUrl(url) {
    if (!url) return url;
    if (!isProxy(url)) return url;                 // inline dataUrl or legacy public URL
    if (blobCache.has(url)) return blobCache.get(url);
    const p = (async () => {
      const t = await token();
      if (!t) throw new Error("session-stale");
      const r = await fetch(url, { headers: { Authorization: "Bearer " + t } });
      if (!r.ok) throw new Error("drive-file " + r.status);
      return URL.createObjectURL(await r.blob());
    })().catch((e) => { blobCache.delete(url); throw e; });
    blobCache.set(url, p);
    return p;
  }
  /* Hydrate markup rendered as innerHTML: gallery cards can't await, so they emit
     data-tja-src="<proxy url>" and this fills in .src afterwards. Safe to call repeatedly. */
  async function hydrate(root) {
    const els = (root || document).querySelectorAll("[data-tja-src]");
    await Promise.all([...els].map(async (el) => {
      const u = el.getAttribute("data-tja-src");
      el.removeAttribute("data-tja-src");
      try { el.src = await blobUrl(u); } catch (e) { el.alt = "couldn't load"; }
    }));
  }

  /* Upload MANY canvas data URLs in one go (PDF pages). Chunked so a single request can't get
     huge — 6 × ~250KB pages per request keeps well inside the function's body limit while cutting
     a 20-page deck from 20 round trips to 4. onProgress(done, total) drives the veil. */
  async function uploadDataUrls(dataUrls, opts = {}, onProgress) {
    const CHUNK = 6;
    const out = [];
    for (let i = 0; i < dataUrls.length; i += CHUNK) {
      const slice = dataUrls.slice(i, i + CHUNK);
      const items = await Promise.all(slice.map(async (du, n) => ({
        blob: await (await fetch(du)).blob(),
        name: `${opts.name || "page"}-p${i + n + 1}.jpg`,
      })));
      const res = await putMany(items, opts);
      out.push(...res);
      if (onProgress) onProgress(Math.min(i + CHUNK, dataUrls.length), dataUrls.length);
    }
    return out;
  }

  /* Rename a deliverable's Drive folder once its real subject is known — the folder is created
     at file-select time (named after the file), before the brief dialog has been filled in. */
  async function renameFolder(folderId, name, clientId) {
    if (!fnBase() || !folderId || !name) return false;
    const t = await token(); if (!t) return false;
    const r = await fetch(fnBase() + "/drive-upload", {
      method: "POST",
      headers: { Authorization: "Bearer " + t, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename-folder", folderId, name, clientId }),
    });
    return r.ok;
  }

  /* Store a generated PDF (approved export, client's marked-up proof) beside the deliverable. */
  async function uploadPdfBase64(b64, name, opts = {}) {
    const bin = atob(String(b64).replace(/^data:[^,]*,/, ""));
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: "application/pdf" });
    const res = await put(blob, { ...opts, name });
    return { url: res.url, driveId: res.driveId, driveLink: res.driveLink, folderId: res.folderId, name };
  }

  return { upload, uploadDataUrl, uploadDataUrls, uploadPdfBase64, renameFolder, blobUrl, hydrate, isProxy,
           enabled: () => STORAGE_ENABLED && !!fnBase() && !!(window.SUPA && window.SUPA.client) };
})();
