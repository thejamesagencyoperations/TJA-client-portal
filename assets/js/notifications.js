/* ============================================================
   NOTIFICATIONS — admin Message Center
   ------------------------------------------------------------
   A client's Present Docs actions (review submitted, revisions
   requested, comments left) are recorded to a per-client
   "notifications" feed (localStorage + Supabase scope). The TJA
   admin sees them all — grouped by client — in a bell/panel in
   the top bar, cross-device.

   • Client side:  TJA_NOTIFY.record(event)  → appends to their feed
   • Admin side:   TJA_NOTIFY.initBell(el)   → renders bell + panel
                   TJA_NOTIFY.adminFeed()    → every client's events
                   TJA_NOTIFY.markRead(...)  → clears the unread flag

   Slack push (to the client's channel, with the PDF export) is a
   dormant hook here — it activates once the workspace Slack app is
   approved and each client is mapped to a channel (PROXY_URL below).
   ============================================================ */
window.TJA_NOTIFY = (function () {
  const PROXY_URL = "";   // Slack proxy /exec — blank = external push disabled (in-portal still works)

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sess = () => (typeof getSession === "function" && getSession()) || {};
  const curClient = () => sess().client || "demo";
  const key = (id) => "tja_notifications_" + (id || curClient());
  const nid = () => "n_" + Math.random().toString(36).slice(2, 9);
  const now = () => { try { return Date.now(); } catch (e) { return 0; } };
  function when(ts) {
    if (!ts) return "";
    const d = new Date(ts), diff = (now() - ts) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  const STATUS_LABEL = { approved: "approved", changes: "approved with changes", revisions: "requested revisions" };
  function eventLine(ev) {
    if (ev.type === "review") {
      const verb = STATUS_LABEL[ev.status] || "submitted a review";
      const cmt = ev.comments ? ` · ${ev.comments} comment${ev.comments === 1 ? "" : "s"}` : "";
      return `${verb} on <b>${esc(ev.docName)}</b> ${esc(ev.versionLabel || "")}${cmt}`;
    }
    if (ev.type === "comment") return `left a comment on <b>${esc(ev.docName)}</b> ${esc(ev.versionLabel || "")}`;
    return esc(ev.docName || "activity");
  }

  /* ---------- feed storage ---------- */
  function loadFeed(id) { try { return JSON.parse(localStorage.getItem(key(id))) || []; } catch (e) { return []; } }
  function saveFeed(id, feed) {
    try { localStorage.setItem(key(id), JSON.stringify(feed)); } catch (e) {}
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(id, "notifications", feed);
  }

  /* ---------- CLIENT side: record an event ---------- */
  function record(ev) {
    const id = curClient();
    const feed = loadFeed(id);
    feed.unshift(Object.assign({ id: nid(), ts: now(), read: false }, ev));
    if (feed.length > 200) feed.length = 200;
    saveFeed(id, feed);
    try { sendExternal(id, ev); } catch (e) {}
  }

  /* ---------- ADMIN side ---------- */
  async function adminFeed() {
    const roster = (window.TJA_STORE && window.TJA_STORE.list && window.TJA_STORE.list()) || [];
    const nameById = {}; roster.forEach(c => nameById[c.id] = c.name);
    const byClient = {};   // client_id -> events[]
    // cloud (cross-device)
    if (window.SUPA && window.SUPA.enabled && window.SUPA.pullAllScope) {
      (await window.SUPA.pullAllScope("notifications")).forEach(r => { byClient[r.client_id] = Array.isArray(r.data) ? r.data.slice() : []; });
    }
    // merge any local feeds (same browser) — union by event id, so it works before schema-v5 too
    Object.keys(localStorage).filter(k => k.indexOf("tja_notifications_") === 0).forEach(k => {
      const cid = k.replace("tja_notifications_", "");
      const existing = byClient[cid] || (byClient[cid] = []);
      const ids = new Set(existing.map(e => e.id));
      loadFeed(cid).forEach(e => { if (!ids.has(e.id)) existing.push(e); });
    });
    const out = [];
    Object.keys(byClient).forEach(cid => byClient[cid].forEach(ev =>
      out.push(Object.assign({ clientId: cid, clientName: nameById[cid] || cid }, ev))));
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out;
  }

  async function markClientRead(clientId) {
    let feed = null;
    if (window.SUPA && window.SUPA.enabled && window.SUPA.pullScope) feed = await window.SUPA.pullScope(clientId, "notifications");
    if (!Array.isArray(feed)) feed = loadFeed(clientId);
    let changed = false;
    feed.forEach(e => { if (!e.read) { e.read = true; changed = true; } });
    if (changed) saveFeed(clientId, feed);
    return changed;
  }

  /* ---------- Slack (dormant) ---------- */
  function sendExternal(clientId, ev) {
    if (!PROXY_URL) return;   // no channel configured yet
    // future: POST { clientId, event, pdf } to the client's Slack channel via the proxy
  }

  /* ---------- bell + panel UI (admin) ---------- */
  function openClientDocs(clientId) {
    try {
      const s = JSON.parse(sessionStorage.getItem("tja_portal_session") || "{}");
      s.client = clientId; sessionStorage.setItem("tja_portal_session", JSON.stringify(s));
      sessionStorage.setItem("tja_open_page", "docs");
    } catch (e) {}
    window.location.href = "dashboard.html";
  }

  function initBell(host) {
    if (!host || host.dataset.notifyReady) return;
    host.dataset.notifyReady = "1";
    host.innerHTML =
      `<button class="notif-bell" id="notifBell" title="Client activity" aria-label="Notifications">
         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>
         <span class="notif-dot" id="notifDot" style="display:none"></span>
       </button>
       <div class="notif-panel" id="notifPanel" style="display:none"></div>`;
    const bell = host.querySelector("#notifBell");
    const panel = host.querySelector("#notifPanel");

    let cache = [];
    async function refresh() {
      cache = await adminFeed();
      const unread = cache.filter(e => !e.read).length;
      const dot = host.querySelector("#notifDot");
      dot.style.display = unread ? "" : "none";
      dot.textContent = unread > 9 ? "9+" : String(unread);
      if (panel.style.display !== "none") renderPanel();
    }
    const centerLink = `<a class="notif-center-link" href="notification-center.html">Open Notification Center →</a>`;
    function renderPanel() {
      if (!cache.length) { panel.innerHTML = `<div class="notif-empty">No client activity yet.</div>${centerLink}`; return; }
      // group by client, newest client first
      const groups = new Map();
      cache.forEach(e => { if (!groups.has(e.clientId)) groups.set(e.clientId, { name: e.clientName, events: [] }); groups.get(e.clientId).events.push(e); });
      let html = `<div class="notif-head"><span>Client activity</span><button class="notif-allread" id="notifAllRead">Mark all read</button></div><div class="notif-list">`;
      groups.forEach((g, cid) => {
        const unread = g.events.filter(e => !e.read).length;
        html += `<div class="notif-group">
            <div class="notif-group-head" data-open="${esc(cid)}"><span class="notif-cname">${esc(g.name)}</span>${unread ? `<span class="notif-badge">${unread}</span>` : ""}</div>`;
        g.events.slice(0, 6).forEach(e => {
          html += `<button class="notif-item ${e.read ? "" : "unread"}" data-open="${esc(cid)}">
              <span class="notif-line">${eventLine(e)}</span>
              <span class="notif-meta">${esc(e.by || "Client")} · ${when(e.ts)}</span>
            </button>`;
        });
        html += `</div>`;
      });
      html += `</div>` + centerLink;
      panel.innerHTML = html;
    }
    function toggle(show) {
      const open = show == null ? panel.style.display === "none" : show;
      panel.style.display = open ? "" : "none";
      if (open) renderPanel();
    }
    bell.addEventListener("click", async (e) => {
      e.stopPropagation();
      const opening = panel.style.display === "none";
      if (opening) await refresh();   // always show the latest when opened
      toggle(opening);
    });
    document.addEventListener("click", (e) => { if (!host.contains(e.target)) toggle(false); });
    window.addEventListener("focus", refresh);   // returning to the admin tab pulls fresh activity
    panel.addEventListener("click", async (e) => {
      const allread = e.target.closest("#notifAllRead");
      if (allread) {
        e.stopPropagation();
        const ids = [...new Set(cache.filter(x => !x.read).map(x => x.clientId))];
        for (const cid of ids) await markClientRead(cid);
        await refresh();
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) { markClientRead(open.dataset.open); openClientDocs(open.dataset.open); }
    });

    refresh();
    setInterval(refresh, 45000);   // light poll so a teammate's session stays current
  }

  // doc-only line (no status verb) — for views that show a separate status badge
  function docLine(ev) {
    const cmt = ev.comments ? ` · ${ev.comments} comment${ev.comments === 1 ? "" : "s"}` : "";
    return `<b>${esc(ev.docName)}</b> ${esc(ev.versionLabel || "")}${cmt}`;
  }
  const STATUS_BADGE = { approved: "Approved", changes: "Changes", revisions: "Revisions" };

  return {
    record, adminFeed, markClientRead, initBell, enabled: () => true,
    // shared formatters so the bell and the Notification Center render identically
    format: {
      line: eventLine, docLine, when,
      statusLabel: (s) => STATUS_LABEL[s] || "reviewed",
      statusBadge: (s) => STATUS_BADGE[s] || "Reviewed",
    },
    openClientDocs,
  };
})();
