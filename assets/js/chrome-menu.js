/* ============================================================
   CHROME MENU — one shared "⋯" utility menu in the topbar, on
   every page. Consolidates the navigation destinations + Sign Out
   that used to be scattered one-off buttons (per Cameron 2026-07-20).

   Role-aware (uses the REAL session role, so an admin previewing as a
   client keeps their menu):
     • admin   → All clients · Admin Center · Backup & Sync · Sign out
     • manager → All clients · Sign out
     • creative→ All clients · Sign out
     • client  → Sign out only
   The current page's own destination is skipped. The theme toggle and
   the notification bell stay as their own icons (Cameron's call).

   Chrome is global: this runs on every page that has a .topbar-right,
   and REMOVES the standalone Sign Out / Admin Center / All clients
   buttons so there's exactly one place for them.
   ============================================================ */
(function () {
  function role() {
    try { const s = (typeof getSession === "function") && getSession(); return (s && s.role) || "client"; }
    catch (e) { return "client"; }
  }
  function build() {
    const bar = document.querySelector(".topbar-right");
    if (!bar || document.getElementById("chromeMenu")) return;

    // retire the scattered one-offs — they move into the menu
    bar.querySelectorAll('[onclick*="logout"], #adminCenterLink, a.btn[href="clients.html"]').forEach((el) => el.remove());

    const r = role();
    const staff = r === "admin" || r === "manager" || r === "creative" || r === "media";
    const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    const items = [];
    if (staff) items.push({ label: "All Clients", href: "clients.html" });
    if (r === "admin") items.push({ label: "Admin Center", href: "admin-center.html" });
    if (r === "admin") items.push({ label: "Backup & Sync", href: "backup.html" });
    const links = items
      .filter((it) => it.href.toLowerCase() !== here)
      .map((it) => `<a role="menuitem" class="chrome-menu-item" href="${esc(it.href)}">${esc(it.label)}</a>`)
      .join("");

    const wrap = document.createElement("div");
    wrap.className = "chrome-menu";
    wrap.id = "chromeMenu";
    wrap.innerHTML =
      `<button class="icon-btn chrome-menu-btn" aria-label="Menu" aria-haspopup="true" aria-expanded="false" title="Menu">` +
        `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>` +
      `</button>` +
      `<div class="chrome-menu-pop" role="menu">` +
        links +
        (links ? `<div class="chrome-menu-sep"></div>` : "") +
        `<button type="button" role="menuitem" class="chrome-menu-item chrome-menu-signout">Sign out</button>` +
      `</div>`;
    bar.appendChild(wrap);

    const btn = wrap.querySelector(".chrome-menu-btn");
    const pop = wrap.querySelector(".chrome-menu-pop");
    const open = (on) => { wrap.classList.toggle("open", on); btn.setAttribute("aria-expanded", on ? "true" : "false"); };
    btn.addEventListener("click", (e) => { e.stopPropagation(); open(!wrap.classList.contains("open")); });
    document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) open(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });
    pop.querySelector(".chrome-menu-signout").addEventListener("click", () => {
      if (typeof logout === "function") logout(); else window.location.href = "index.html";
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
