/* ============================================================
   PRESENCE — "who else is editing this client right now"
   ------------------------------------------------------------
   One row per client (scope 'presence'):
     data = { editors: { [email]: { name, ts } } }
   Every ADMIN with the client open heartbeats its own entry every
   20s and prunes entries older than 45s — so a closed tab drops off
   within ~45s with no unload handler (supabase-js can't sendBeacon).
   Two admins racing the whole-blob write self-heal within one tick:
   each rewrites its own entry on the next beat.

   Only real admins heartbeat (creatives can't write the scope and
   don't edit; clients can't even read it — RLS). The banner shows
   OTHER fresh editors, mid-preview included: you're still editing
   state even while looking at the client view.
   ============================================================ */
(function () {
  const BEAT_MS = 20000;   // heartbeat cadence
  const FRESH_MS = 45000;  // entries older than this are gone/stale

  function ready() {
    return window.SUPA && window.SUPA.enabled && window.SUPA.pushScopeNow
      && typeof getSession === "function" && typeof isAdminOrManager === "function" && isAdminOrManager();
  }
  function me() { return getSession() || {}; }
  function clientIdNow() {
    const c = me().client || "";
    return (c && c.charAt(0) !== "_") ? c : null;   // sentinels aren't clients
  }

  let bannerEl = null;
  function showOthers(others) {
    if (!others.length) { if (bannerEl) bannerEl.style.display = "none"; return; }
    if (!bannerEl) {
      bannerEl = document.createElement("div");
      bannerEl.className = "presence-banner";
      const anchor = document.getElementById("previewBanner");
      if (!anchor) return;
      anchor.parentNode.insertBefore(bannerEl, anchor);
    }
    const names = others.map(o => o.name || o.email).join(", ");
    bannerEl.innerHTML = `⚠ <b>${names}</b> ${others.length === 1 ? "is" : "are"} also editing this client — the last save wins, so coordinate before big changes.`;
    bannerEl.style.display = "";
  }

  async function beat() {
    if (!ready()) return;
    const cid = clientIdNow(); if (!cid) return;
    const email = (me().email || "").toLowerCase(); if (!email) return;
    try {
      const cur = (await window.SUPA.pullScope(cid, "presence")) || {};
      const editors = cur.editors || {};
      const now = Date.now();
      Object.keys(editors).forEach(k => { if (!editors[k] || now - (+editors[k].ts || 0) > FRESH_MS) delete editors[k]; });
      editors[email] = { name: me().name || email, ts: now };
      await window.SUPA.pushScopeNow(cid, "presence", { editors });
      const others = Object.keys(editors).filter(k => k !== email).map(k => ({ email: k, name: editors[k].name }));
      showOthers(others);
    } catch (e) { /* presence is best-effort — never let it interfere */ }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!ready() || !clientIdNow()) return;
      beat();
      setInterval(beat, BEAT_MS);
    });
  }
})();
