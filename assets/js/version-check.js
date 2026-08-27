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
  const RETRY_AFTER = 11 * 60 * 1000;        // just past Pages' 10-minute HTML cache

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

      /* ONE RETRY, NOT ONE ATTEMPT (2026-08-27).
         GitHub Pages serves the HTML with `cache-control: max-age=600`, so a reload fired
         soon after a deploy can come back with the OLD page. The original guard recorded
         "tried version N" and never revisited it, which left that tab stuck on stale code
         for the rest of the session — the failure mode Cameron hit: told to hard-refresh
         for a fix the page should have picked up by itself.
         The attempt is now stamped, and a second one is allowed once the 10-minute cache
         window has certainly passed. Two attempts 11 minutes apart cannot become a loop,
         and by the second the CDN can no longer be serving the old document. */
      let prev = null;
      try { prev = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) {}
      // tolerate the old format, which stored the bare version number as a string
      if (prev && typeof prev !== "object") prev = { v: +prev, at: 0 };
      if (prev && prev.v === target && (Date.now() - (prev.at || 0)) < RETRY_AFTER) return;
      try { sessionStorage.setItem(KEY, JSON.stringify({ v: target, at: Date.now() })); } catch (e) {}
      location.reload();
    } catch (e) { /* offline / blocked — try again next tick */ }
  }

  setInterval(check, EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
  window.TJA_VCHECK = check;   // manual trigger for debugging
})();
