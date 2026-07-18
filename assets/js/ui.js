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

  /* ============================================================
     IN-APP DIALOGS — branded replacements for window.alert /
     confirm / prompt (Cameron, 2026-07-17: "chrome popups" broke
     the product feel). Promise-based:

       await TJA_UI.alert("Saved.")                        → undefined
       await TJA_UI.confirm("Delete?", {danger:true})      → true | false
       await TJA_UI.prompt("Sheet link:", {value:"..."})   → string | null

     Esc / backdrop-click = cancel (false / null). Enter submits a
     prompt. Focus lands on the input (prompt) or the primary
     button. One dialog at a time — a second call queues behind
     the first via the returned promise chain.
     ============================================================ */
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function openDialog(kind, msg, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const old = document.getElementById("tjaDialog"); if (old) old.remove();
      const ov = document.createElement("div");
      ov.id = "tjaDialog"; ov.className = "tja-dlg-overlay";
      const okText = esc(opts.okText || (kind === "confirm" ? "OK" : kind === "prompt" ? "OK" : "OK"));
      const cancelBtn = kind === "alert" ? "" : `<button type="button" class="btn btn-ghost" data-dlg-cancel>${esc(opts.cancelText || "Cancel")}</button>`;
      // message: plain text, but honour newlines from the old native-dialog copy
      const msgHtml = esc(msg).replace(/\n/g, "<br>");
      ov.innerHTML = `<div class="tja-dlg" role="${kind === "alert" ? "alertdialog" : "dialog"}" aria-modal="true">
        ${opts.title ? `<div class="tja-dlg-title">${esc(opts.title)}</div>` : ""}
        <div class="tja-dlg-msg">${msgHtml}</div>
        ${kind === "prompt" ? `<input type="text" class="tja-dlg-input" value="${esc(opts.value || "")}" placeholder="${esc(opts.placeholder || "")}">` : ""}
        <div class="tja-dlg-actions">${cancelBtn}<button type="button" class="btn btn-primary${opts.danger ? " tja-dlg-danger" : ""}" data-dlg-ok>${okText}</button></div>
      </div>`;
      document.body.appendChild(ov);
      const input = ov.querySelector(".tja-dlg-input");
      const done = (val) => { ov.remove(); resolve(val); };
      const cancelVal = kind === "confirm" ? false : null;
      const okVal = () => kind === "confirm" ? true : kind === "prompt" ? (input ? input.value : "") : undefined;
      ov.querySelector("[data-dlg-ok]").addEventListener("click", () => done(okVal()));
      const c = ov.querySelector("[data-dlg-cancel]"); if (c) c.addEventListener("click", () => done(cancelVal));
      // Enter submits a prompt from its input; Esc/backdrop cancel via backdropClose.
      if (input) input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(okVal()); } });
      backdropClose(ov, () => done(kind === "alert" ? undefined : cancelVal));
      setTimeout(() => { (input || ov.querySelector("[data-dlg-ok]")).focus(); if (input) input.select(); }, 30);
    });
  }

  window.TJA_UI = {
    backdropClose,
    alert: (msg, opts) => openDialog("alert", msg, opts),
    confirm: (msg, opts) => openDialog("confirm", msg, opts),
    prompt: (msg, opts) => openDialog("prompt", msg, opts),
  };
})();
