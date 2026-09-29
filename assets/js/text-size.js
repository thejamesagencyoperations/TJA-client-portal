/* ============================================================
   TEXT SIZE — a per-person reading-size preference (Cameron 2026-09-29).

   The A− / A / A+ control on the Executive Summary changes the portal's base text size for
   THIS PERSON ONLY: the choice lives in this browser's localStorage, is never synced, and
   never changes what anyone else sees. Default (100%) is exactly the portal's normal size.

   It works by scaling the root font size (styles.css `html { font-size: 18px }`) — nearly
   every size in the portal is rem, so one value scales the whole type scale in proportion.
   Loaded in <head> on every page so the saved size applies before first paint (no flash).
   ============================================================ */
(function () {
  const KEY = "tja_text_scale";
  const BASE_PX = 18;                                   // must match styles.css html { font-size }
  const STEPS = [0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5];   // 1 = the normal size
  function read() {
    try { const v = parseFloat(localStorage.getItem(KEY)); return STEPS.indexOf(v) > -1 ? v : 1; }
    catch (e) { return 1; }
  }
  function apply(v) {
    // 100% clears the override entirely, so the stylesheet's own value is what applies
    document.documentElement.style.fontSize = v === 1 ? "" : (BASE_PX * v) + "px";
    document.documentElement.dataset.textScale = String(v);
  }
  function set(v) {
    v = STEPS.indexOf(v) > -1 ? v : 1;
    try { if (v === 1) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(v)); } catch (e) {}
    apply(v);
    // layouts that measure text (the Exec Summary canvas) re-fit on resize
    try { window.dispatchEvent(new Event("resize")); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent("tja-textscale", { detail: v })); } catch (e) {}
    return v;
  }
  function step(dir) {
    const cur = read(); const i = STEPS.indexOf(cur);
    return set(STEPS[Math.max(0, Math.min(STEPS.length - 1, (i < 0 ? 2 : i) + dir))]);
  }
  apply(read());
  window.TJA_TEXTSIZE = { get: read, set, step, STEPS,
    atMin: () => read() === STEPS[0], atMax: () => read() === STEPS[STEPS.length - 1] };
})();
