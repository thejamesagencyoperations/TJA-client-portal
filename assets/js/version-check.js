/* ============================================================
   STALE-CODE AUTO-RELOAD
   Tabs left open keep running whatever JS they loaded — across
   deploys, for days. On 2026-07-17 a pre-v2.41 tab kept syncing
   old-shaped data hourly after the fix had shipped. This polls
   version.json every few minutes and reloads the tab when a new
   release lands, so old code can never run for long.

   RELEASE RITUAL (in addition to the ?v=NN cache-buster sed):
   bump the number in /version.json to match the new NN. This
   script learns ITS OWN version from its script tag's ?v= param,
   so the sed that bumps the tags updates both sides at once —
   only version.json needs its own bump.

   Reload rules — never interrupt someone mid-work:
   • hidden tab → reload immediately;
   • visible tab → only when no input/textarea/select/contenteditable
     has focus (an edit in progress waits for the next check);
   • once per target version per tab (sessionStorage) — GitHub
     Pages caches HTML up to ~10 min, so a too-early reload could
     land on the old page and must not loop.
   ============================================================ */
(function () {
  "use strict";
  const src = (document.currentScript && document.currentScript.src) || "";
  const MINE = +(new URLSearchParams(src.split("?")[1] || "").get("v")) || 0;
  if (!MINE) return;                         // loaded without a version tag — nothing to compare
  const EVERY = 4 * 60 * 1000;               // 4 minutes
  const KEY = "tja_vreload_target";

  function busyEditing() {
    const a = document.activeElement;
    if (!a) return false;
    return /^(input|textarea|select)$/i.test(a.tagName || "") || a.isContentEditable;
  }

  async function check() {
    try {
      const r = await fetch("version.json?ts=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const j = await r.json();
      const target = +j.v || 0;
      if (target <= MINE) return;
      if (!document.hidden && busyEditing()) return;                 // don't yank the page mid-edit
      if (sessionStorage.getItem(KEY) === String(target)) return;    // already tried for this version
      try { sessionStorage.setItem(KEY, String(target)); } catch (e) {}
      location.reload();
    } catch (e) { /* offline / blocked — try again next tick */ }
  }

  setInterval(check, EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  window.TJA_VCHECK = check;   // manual trigger for debugging
})();
