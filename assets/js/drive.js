/* ============================================================
   TJA_DRIVE — pushes Files-tab uploads to the client's Google
   Drive folder via the drive-upload Edge Function. Fails SOFT
   everywhere: any problem (function not deployed, folder not
   configured, no real session, network) just means the file row
   stays metadata-only, exactly as before this existed.

   The target folder is derived SERVER-SIDE from the caller's JWT
   (clients can never route to another client's folder); the
   clientId sent here matters only for staff uploads.
   ============================================================ */
window.TJA_DRIVE = (function () {
  const DRIVE_ENABLED = true;   // flip false to hard-disable without redeploying

  function fnBase() {
    const cfg = window.SUPABASE_CONFIG || {};
    return cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
  }
  function enabled() { return DRIVE_ENABLED && !!fnBase() && !!(window.SUPA && window.SUPA.enabled); }

  async function accessToken() {
    try {
      const { data } = await window.SUPA.client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch (e) { return null; }
  }

  // returns { ok, driveLink?, driveId?, skipped? }
  async function upload(file, clientId) {
    if (!enabled()) return { ok: false, skipped: true };
    const token = await accessToken();
    if (!token) return { ok: false, skipped: true };   // sandbox login — no cloud session
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("clientId", clientId || "");   // ignored server-side for client callers
      const r = await fetch(fnBase() + "/drive-upload", {
        method: "POST",
        headers: { Authorization: "Bearer " + token },   // NO Content-Type — the browser sets the multipart boundary
        body: form,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) return { ok: true, driveLink: j.driveLink, driveId: j.driveId };
      // 409 = no folder configured, 503 = function not set up — both are quiet no-ops
      return { ok: false, skipped: r.status === 409 || r.status === 503, error: j.error || r.status };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  return { enabled, upload };
})();
