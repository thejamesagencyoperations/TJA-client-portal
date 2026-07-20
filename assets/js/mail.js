/* ============================================================
   TJA_MAIL — client emails via the send-deliverable-email
   Edge Function. Fired from the Present Docs SEND action (never
   upload). Fails soft: the deliverable is already released when
   this runs, so an email failure must never roll that back —
   it just surfaces a toast.

   Requires: the Edge Function deployed + RESEND_API_KEY secret set.
   Until then every call short-circuits (enabled() false) and Send
   behaves exactly as before.
   ============================================================ */
window.TJA_MAIL = (function () {
  // Flip to false to hard-disable client emails without redeploying anything.
  const EMAIL_ENABLED = true;

  function fnBase() {
    const cfg = window.SUPABASE_CONFIG || {};
    return cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
  }
  function enabled() {
    return EMAIL_ENABLED && !!fnBase() && !!(window.SUPA && window.SUPA.enabled);
  }

  async function accessToken() {
    try {
      const { data } = await window.SUPA.client.auth.getSession();
      return data && data.session ? data.session.access_token : null;
    } catch (e) { return null; }
  }

  function toast(msg) {
    let t = document.getElementById("tjaMailToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "tjaMailToast";
      t.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:12000;" +
        "background:#1c1c1c;color:#fff;font:600 .78rem Inter,sans-serif;padding:10px 18px;border-radius:9px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:80vw;text-align:center";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = "";
    clearTimeout(t._hide);
    t._hide = setTimeout(() => { t.style.display = "none"; }, 5000);
  }

  // payload: { clientId, docName, versionLabel, subject, message, dueDate }
  async function sendDeliverable(payload) {
    if (!enabled()) return { ok: false, skipped: true };
    const token = await accessToken();
    if (!token) return { ok: false, skipped: true };   // no real Supabase session (sandbox login)
    try {
      const r = await fetch(fnBase() + "/send-deliverable-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { toast("📧 Emailed the client (" + (j.recipients || 1) + " recipient" + (j.recipients === 1 ? "" : "s") + ")"); return { ok: true }; }
      if (r.status === 409) { toast("Sent to the portal — no notification email set for this client (add one in the client's Integrations)."); return { ok: false, noRecipients: true }; }
      if (r.status === 503) return { ok: false, skipped: true };   // email not configured yet — stay quiet
      toast("Sent to the portal, but the email failed — you may want to notify the client directly.");
      return { ok: false, error: j.error || r.status };
    } catch (e) {
      toast("Sent to the portal, but the email failed — you may want to notify the client directly.");
      return { ok: false, error: String(e) };
    }
  }

  // Fires when a CLIENT submits their review — emails the TJA team's distribution
  // address for that client. The function derives the client + recipients server-side,
  // so the payload is just the deliverable context. Fails soft (never blocks the review).
  // payload: { docName, versionLabel, status, comments }
  async function sendReviewResponse(payload) {
    if (!enabled()) return { ok: false, skipped: true };
    const token = await accessToken();
    if (!token) return { ok: false, skipped: true };
    try {
      const r = await fetch(fnBase() + "/send-review-notification", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload),
      });
      return r.ok ? { ok: true } : { ok: false, error: r.status };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  return { enabled, sendDeliverable, sendReviewResponse };
})();
