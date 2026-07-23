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
  const BUCKET = "media-intake";   // interim Supabase Storage bucket (reused; no extra setup)

  const safe = (s) => String(s || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120);
  function pathFor(category, clientId, name) {
    const cat = String(category || "misc").replace(/[^\w-]+/g, "") || "misc";
    const cid = String(clientId || "shared").replace(/[^\w-]+/g, "_") || "shared";
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${cat}/${cid}/${Date.now()}-${rnd}-${safe(name)}`;
  }

  // THE swap point: change this one function to move to a different backend (Drive, etc.).
  async function put(path, blob, contentType) {
    if (!(window.SUPA && window.SUPA.client)) throw new Error("storage-not-configured");
    const client = window.SUPA.client;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, { upsert: false, contentType: contentType || blob.type || undefined });
    if (error) throw error;
    const { data } = client.storage.from(BUCKET).getPublicUrl(path);
    return data && data.publicUrl;
  }

  async function upload(file, opts = {}) {
    const path = pathFor(opts.category, opts.clientId, opts.name || file.name);
    const url = await put(path, file, file.type || opts.contentType);
    return { url, path, name: file.name || safe(opts.name), size: file.size || 0, type: file.type || "" };
  }

  // Present Docs proofs are canvas-generated JPEG data URLs — turn one into a Blob and store it.
  async function uploadDataUrl(dataUrl, opts = {}) {
    const blob = await (await fetch(dataUrl)).blob();
    const path = pathFor(opts.category, opts.clientId, opts.name || "file.jpg");
    const url = await put(path, blob, blob.type || "image/jpeg");
    return { url, path, name: opts.name || "file", size: blob.size || 0, type: blob.type || "" };
  }

  return { upload, uploadDataUrl, bucket: BUCKET, enabled: () => !!(window.SUPA && window.SUPA.client) };
})();
