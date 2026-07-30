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
      if (data && data.session) return data.session.access_token;
      // Ghost session: the UI looks signed in but the Supabase token has expired — this used
      // to silently skip every notification (no Slack, no email, no reviewer stamp, no toast;
      // bit us live 2026-07-28). Try one refresh before giving up.
      if (window.SUPA.refreshSession) {
        try { await window.SUPA.refreshSession(); } catch (e) {}
        const r2 = await window.SUPA.client.auth.getSession();
        if (r2.data && r2.data.session) return r2.data.session.access_token;
      }
      return null;
    } catch (e) { return null; }
  }
  // The no-token skip must never be silent for the person doing the send.
  function staleSessionToast() {
    toast("⚠ Notifications NOT sent — your login session has gone stale. Sign out and back in, then resend.");
  }
  /* Slack outcome, spelled out on EVERY send (Cameron 2026-07-29). There is deliberately no
     SLACK_DEFAULT_CHANNEL fallback any more, so "this client has no channel mapped" is a real
     thing the sender needs to see — it used to be swallowed. Plain English, not error codes. */
  function slackNote(j) {
    if (j.slacked) return " · 💬 posted to Slack";
    const why = String(j.slackError || "");
    if (!why) return " · ⚠ not posted to Slack";
    if (why === "not-configured-or-no-channel")
      return " · ⚠ NOT posted to Slack — no channel mapped for this client (set it in Clients → Edit → Integrations)";
    if (/not_in_channel/.test(why))
      return " · ⚠ NOT posted to Slack — the bot isn't in that channel (/invite @tja_client_dashboard_)";
    if (/channel_not_found/.test(why))
      return " · ⚠ NOT posted to Slack — that channel doesn't exist (check the name in Integrations)";
    return " · ⚠ NOT posted to Slack (" + why + ")";
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
  // When email is OFF (or there's no recipient), nothing should be silent — surface the
  // deliverable's link with a Copy button so the sender can pass it along themselves.
  async function copyLinkPrompt(msg, url) {
    let auto = false;
    try { await navigator.clipboard.writeText(url); auto = true; } catch (e) {}
    let t = document.getElementById("tjaLinkToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "tjaLinkToast";
      t.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:12001;" +
        "background:#1c1c1c;color:#fff;font:600 .78rem Inter,sans-serif;padding:12px 16px;border-radius:11px;" +
        "box-shadow:0 8px 28px rgba(0,0,0,.4);max-width:90vw;display:flex;align-items:center;gap:12px";
      document.body.appendChild(t);
    }
    t.innerHTML = `<span style="max-width:60vw">${msg}${auto ? " — copied ✓" : ""}</span>`;
    const btn = document.createElement("button");
    btn.textContent = auto ? "Copy again" : "Copy link";
    btn.style.cssText = "background:#FF7800;border:none;color:#111;font:700 .74rem Inter,sans-serif;padding:7px 13px;border-radius:8px;cursor:pointer;white-space:nowrap";
    btn.onclick = async () => { try { await navigator.clipboard.writeText(url); btn.textContent = "Copied ✓"; } catch (e) { btn.textContent = "Select manually"; } };
    t.appendChild(btn);
    const x = document.createElement("button");
    x.textContent = "✕";
    x.style.cssText = "background:transparent;border:none;color:#aaa;cursor:pointer;font-size:.9rem";
    x.onclick = () => { t.style.display = "none"; };
    t.appendChild(x);
    t.style.display = "flex";
    clearTimeout(t._hide);
    t._hide = setTimeout(() => { t.style.display = "none"; }, 30000);   // stays long enough to act on
  }

  // payload: { clientId, docName, versionLabel, subject, message, dueDate }
  async function sendDeliverable(payload) {
    if (!enabled()) return { ok: false, skipped: true };
    const token = await accessToken();
    if (!token) { staleSessionToast(); return { ok: false, skipped: true, staleSession: true }; }
    try {
      const r = await fetch(fnBase() + "/send-deliverable-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        if (j.emailed) {
          // ALWAYS say whether Slack posted (Cameron 2026-07-29: there is no fallback channel —
          // if it didn't reach Slack the sender must be told at send time, every time). The
          // no-channel case is the most important one to surface, not the one to hide.
          toast("📧 Emailed the client (" + (j.recipients || 1) + " recipient" + (j.recipients === 1 ? "" : "s") + ")" + slackNote(j));
        } else if (j.link) {
          // Email is toggled off — hand over the copyable link so nothing is silent.
          copyLinkPrompt("Email is off — send this deliverable link to the client." + slackNote(j), j.link);
        } else {
          toast("Sent to the portal.");
        }
        // Hand the whole response back — announceSend stamps version.expectedReviewers from
        // j.reviewers (the client-role logins at send time) to drive multi-reviewer tracking.
        return Object.assign({ ok: true }, j);
      }
      if (r.status === 409) {
        if (j.link) copyLinkPrompt("No client email on file — copy the deliverable link to send it yourself." + slackNote(j), j.link);
        else toast("Sent to the portal, but NO client email address is on file (add one in the client's Integrations)." + slackNote(j));
        return Object.assign({ ok: false, noRecipients: true }, j);
      }
      if (r.status === 503) return { ok: false, skipped: true };   // email not configured yet — stay quiet
      // Show the REAL reason (the function passes Resend's message through) — "email failed"
      // with no cause made this undiagnosable from the UI.
      toast("Sent to the portal, but the email failed — " + (j.error || ("HTTP " + r.status)));
      // spread j so reviewers still reaches announceSend — a failed email must not disable
      // multi-reviewer tracking for the round
      return Object.assign({ ok: false, error: j.error || r.status }, j);
    } catch (e) {
      toast("Sent to the portal, but the email failed (network) — you may want to notify the client directly.");
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
