/* ============================================================
   SHARED DIALOG BEHAVIOUR
   One helper, because every modal in the portal had the same bug.

   THE BUG: `overlay.addEventListener("click", e => { if (e.target === overlay) close(); })`
   looks correct and is the pattern everyone writes. It closes the dialog WHILE YOU TYPE.
   Drag-select text in a field and overshoot its edge: mousedown lands on the input,
   mouseup lands on the backdrop, so the browser fires `click` on their common ancestor
   — the overlay. `e.target === overlay` is true, and the form disappears mid-selection.
   Reported by Cameron as "sometimes when I go to type it escapes the page".

   THE FIX: only close when the press STARTED on the backdrop as well as ending there.
   Plus Esc, which every dialog should honour anyway.
   ============================================================ */
(function () {
  /**
   * Wire backdrop-click + Esc to close an overlay.
   * @param {HTMLElement} overlay  the full-screen backdrop (the dialog card is inside it)
   * @param {Function} close       your close function
   * @param {Function} [isOpen]    optional; defaults to reading the overlay's display
   */
  function backdropClose(overlay, close, isOpen) {
    if (!overlay || typeof close !== "function") return;
    const open = isOpen || (() => getComputedStyle(overlay).display !== "none");

    let startedOnBackdrop = false;
    overlay.addEventListener("mousedown", (e) => { startedOnBackdrop = (e.target === overlay); });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && startedOnBackdrop) close();
      startedOnBackdrop = false;
    });

    // Esc. The listener is on `document` (an overlay only receives keys if something
    // inside it has focus), so it must clean itself up: some overlays here are built
    // fresh on open and .remove()d on close. Without the isConnected guard, every open
    // would leave another listener behind holding a detached node — and getComputedStyle
    // on a detached node returns "" (not "none"), so a stale one would read as OPEN and
    // fire close() on a dead popup.
    const onKey = (e) => {
      if (!overlay.isConnected) { document.removeEventListener("keydown", onKey); return; }
      if (e.key === "Escape" && open()) close();
    };
    document.addEventListener("keydown", onKey);
  }

  window.TJA_UI = { backdropClose };
})();
