/* ============================================================
   PRESENT DOCS — interactive creative review (v1.3)

   Each TILE = a deliverable holding VERSIONS (V1, V2, V3 …).
   Per version: a fit-to-screen image (object-fit contain — the
   whole image always shows), a DRAW tool, a COMMENT tool (click
   to drop numbered pins), a status, and overall notes.

   UNDO is unified: it reverts the most recent action whether that
   was a pen stroke, a Clear, a pin you added, or a pin you deleted.

   Front-end only: images downscaled + stored in localStorage.
   ============================================================ */

window.PresentDocs = (function () {
  const sess = (typeof getSession === "function" && getSession()) || { client: "demo" };
  const KEY = "tja_deliverables_" + sess.client;
  const OLD_KEY = "tja_creatives_" + sess.client;

  const STATUS = {
    approved:  { label: "Approved as Shown",   badge: "complete" },
    changes:   { label: "Approved w/ Changes", badge: "on-hold" },
    revisions: { label: "Revisions Needed",    badge: "blocked" },
  };

  let items = [];
  let curId = null;
  let tool = "draw";
  let color = "#ef5350";
  let ctx = null, cv = null, drawing = false, lastPt = null, dpr = 1;
  let history = [];        // unified action stack: {type:'draw',img} | {type:'pinAdd',id} | {type:'pinDel',pin,index}
  let seq = 0;
  let zoom = 1, panX = 0, panY = 0, spaceDown = false, justPanned = false;   // image zoom/pan

  /* ---------- storage ---------- */
  function load() {
    try { items = JSON.parse(localStorage.getItem(KEY)) || []; }
    catch { items = []; }
    if (!items.length) migrateOld();
  }
  function migrateOld() {
    let old = [];
    try { old = JSON.parse(localStorage.getItem(OLD_KEY)) || []; } catch { old = []; }
    if (!old.length) return;
    items = old.map(c => ({
      id: c.id || uid(), name: c.name || "Creative", active: 0,
      versions: [{ label: "V1", dataUrl: c.dataUrl, annotation: c.annotation || null,
        pins: [], status: c.status || null, comments: c.comments || "", uploaded: c.uploaded || "" }],
    }));
    save();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(items)); }
    catch (e) { console.warn("Portal sandbox: storage full — keeping deliverables in memory only.", e); }
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(sess.client, "deliverables", items);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const uid = () => "d_" + Date.now() + "_" + (seq++);
  const deliv = (id) => items.find(d => d.id === id);
  const active = (d) => d && d.versions[d.active];
  const $ = (id) => document.getElementById(id);

  /* ---------- page shell ---------- */
  function render() {
    return `
    <div class="page-head">
      <div class="page-title">Present Docs</div>
      <div class="page-desc">Upload creative deliverables for client review — versions, markup, pinned comments &amp; approvals.</div>
    </div>

    <div class="pd-toolbar admin-only">
      <button class="btn btn-upload" id="pdUploadBtn">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
        Upload Deliverable
      </button>
      <input type="file" id="pdFile" accept="image/*" multiple hidden>
      <input type="file" id="pdVerFile" accept="image/*" hidden>
      <span class="pd-hint">PNG / JPG · logos, banners, ad sets, messaging — anything you design</span>
    </div>

    <div class="pd-gallery" id="pdGallery"></div>

    <div class="pd-modal" id="pdModal">
      <div class="pd-modal-backdrop" id="pdBackdrop"></div>
      <div class="pd-modal-card">
        <div class="pd-modal-head">
          <div style="display:flex;align-items:center;gap:8px;min-width:0">
            <div class="pd-modal-title" id="pdTitle">Deliverable</div>
            <button class="pd-pencil admin-only" id="pdRename" title="Rename">✎</button>
          </div>
          <button class="pd-x" id="pdClose">✕</button>
        </div>
        <div class="pd-modal-body">
          <div class="pd-stage">
            <div class="pd-canvas-wrap" id="pdWrap" title="Scroll to zoom · Space-drag (or middle-drag) to pan">
              <div class="pd-zoom" id="pdZoom">
                <img id="pdImg" alt="creative">
                <canvas id="pdCanvas"></canvas>
                <div class="pd-pins" id="pdPins"></div>
              </div>
              <div class="pd-pin-popup" id="pdPopup" style="display:none">
                <button class="pd-popup-close" id="pdPopupClose" title="Close">✕</button>
                <textarea data-popuptext placeholder="Add a note for this pin…"></textarea>
              </div>
              <div class="pd-zoom-controls">
                <button class="pd-zbtn" id="pdZoomOut" title="Zoom out">−</button>
                <span id="pdZoomLevel">100%</span>
                <button class="pd-zbtn" id="pdZoomIn" title="Zoom in">＋</button>
                <button class="pd-zbtn pd-zfit" id="pdZoomReset" title="Fit to screen">Fit</button>
              </div>
            </div>
            <div class="pd-draw-tools">
              <div class="pd-seg">
                <button class="pd-seg-btn active" data-tool="draw" id="pdToolDraw">✎ Draw</button>
                <button class="pd-seg-btn" data-tool="comment" id="pdToolComment">💬 Comment</button>
              </div>
              <button class="pd-tool-btn" id="pdUndo">↶ Undo</button>
              <div class="pd-draw-only" id="pdDrawOnly">
                <button class="pd-swatch active" data-color="#ef5350" style="background:#ef5350" title="Red"></button>
                <button class="pd-swatch" data-color="#f5b342" style="background:#f5b342" title="Amber"></button>
                <button class="pd-swatch" data-color="#36c275" style="background:#36c275" title="Green"></button>
                <button class="pd-swatch" data-color="#ffffff" style="background:#ffffff" title="White"></button>
                <button class="pd-tool-btn" id="pdClear">Clear</button>
              </div>
              <div class="pd-spacer"></div>
              <span class="pd-hint" id="pdToolHint">Draw to circle / highlight areas</span>
            </div>
          </div>

          <div class="pd-review">
            <div class="pd-ver-row">
              <span class="pd-review-label">Versions</span>
              <div class="pd-ver-chips" id="pdVers"></div>
              <button class="pd-tool-btn admin-only" id="pdResubmit">＋ New Version</button>
            </div>

            <div class="pd-review-label">Status</div>
            <div class="pd-status-opts" id="pdStatus">
              <div class="pd-status-opt approved"  data-val="approved"><span class="tick">✓</span> Approve</div>
              <div class="pd-status-opt changes"   data-val="changes"><span class="tick">✓</span> Approve with changes</div>
              <div class="pd-status-opt revisions" data-val="revisions"><span class="tick">✓</span> Revisions needed</div>
            </div>

            <div class="pd-comments-head">
              <span class="pd-review-label" id="pdCommentsCount">Comments</span>
              <button class="pd-tool-btn" id="pdClearComments" style="display:none">Clear all</button>
            </div>
            <div class="pd-pinlist" id="pdPinList"></div>

            <div class="pd-review-label">Client Notes <span class="pd-notes-tag client">Client</span></div>
            <textarea id="pdClientNotes" placeholder="Client feedback for this version…"></textarea>
            <div class="pd-review-label">Agency Notes <span class="pd-notes-tag tja">TJA</span></div>
            <textarea id="pdAgencyNotes" placeholder="Internal / agency notes for this version…"></textarea>

            <button class="btn btn-primary" id="pdSubmit">Submit Review</button>
            <div class="pd-saved" id="pdSaved">✓ Review saved</div>
            <div class="pd-meta-line" id="pdMeta"></div>
          </div>
        </div>
      </div>
    </div>`;
  }

  /* ---------- gallery ---------- */
  function badge(status) {
    if (!status) return `<span class="badge pending">Pending Review</span>`;
    const s = STATUS[status];
    return `<span class="badge ${s.badge}">${esc(s.label)}</span>`;
  }
  function renderGallery() {
    const g = $("pdGallery"); if (!g) return;
    if (!items.length) {
      const adminView = (typeof canEdit === "function") ? canEdit() : true;
      g.innerHTML = `<div class="pd-empty" style="grid-column:1/-1">
        <div class="big">＋</div>
        ${adminView
          ? `No deliverables yet. Click <b>Upload Deliverable</b> to add your first proof.`
          : `No creative deliverables to review yet — your team will post them here.`}</div>`;
      return;
    }
    g.innerHTML = items.map(d => {
      const v = active(d);
      return `<div class="pd-card" data-id="${d.id}">
        <button class="pd-del admin-only" data-del="${d.id}" title="Remove">✕</button>
        <span class="pd-enlarge-cue">Click to review</span>
        <div class="pd-thumb"><img src="${v.dataUrl}" alt="${esc(d.name)}"></div>
        <div class="pd-card-foot">
          <div class="pd-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
          <span class="pd-ver-tag">${esc(v.label)}</span>
          ${badge(v.status)}
        </div>
      </div>`;
    }).join("");
  }

  /* ---------- image processing ---------- */
  function processFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const max = 1600;
          let { width, height } = img;
          if (width > max) { height = Math.round(height * max / width); width = max; }
          const c = document.createElement("canvas");
          c.width = width; c.height = height;
          c.getContext("2d").drawImage(img, 0, 0, width, height);
          resolve({ dataUrl: c.toDataURL("image/jpeg", 0.85), name: file.name.replace(/\.[^.]+$/, "") });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }
  function newVersion(dataUrl, label) {
    return { label, dataUrl, annotation: null, pins: [], status: null, clientNotes: "", agencyNotes: "",
      uploaded: new Date().toLocaleDateString() };
  }
  async function handleNewDeliverables(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith("image/"));
    for (const f of files) {
      const p = await processFile(f);
      items.unshift({ id: uid(), name: p.name, active: 0, versions: [newVersion(p.dataUrl, "V1")] });
    }
    save(); renderGallery();
  }
  async function handleResubmit(file) {
    const d = deliv(curId); if (!d || !file) return;
    persistCanvas();
    const p = await processFile(file);
    d.versions.push(newVersion(p.dataUrl, "V" + (d.versions.length + 1)));
    d.active = d.versions.length - 1;
    save(); loadVersionIntoModal(); renderGallery();
  }

  /* ---------- overlay geometry (object-fit contain → exact picture rect) ---------- */
  function sizeOverlay() {
    const img = $("pdImg"); cv = $("pdCanvas"); const pins = $("pdPins");
    const nW = img.naturalWidth, nH = img.naturalHeight;
    if (!nW || !img.clientWidth) return;
    const elW = img.clientWidth, elH = img.clientHeight;
    const scale = Math.min(elW / nW, elH / nH);          // contain
    const dispW = Math.round(nW * scale), dispH = Math.round(nH * scale);
    const offX = img.offsetLeft + (elW - dispW) / 2;
    const offY = img.offsetTop + (elH - dispH) / 2;
    [cv, pins].forEach(e => {
      e.style.width = dispW + "px"; e.style.height = dispH + "px";
      e.style.left = offX + "px"; e.style.top = offY + "px";
    });
    dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(dispW * dpr); cv.height = Math.round(dispH * dpr);
    ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr); ctx.lineCap = "round"; ctx.lineJoin = "round";
  }
  function dispSize() { return { w: parseFloat(cv.style.width) || 0, h: parseFloat(cv.style.height) || 0 }; }

  /* ---------- zoom + pan (transforms the image/canvas/pins together) ---------- */
  function applyZoom() {
    const z = $("pdZoom"); if (z) z.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
    const lvl = $("pdZoomLevel"); if (lvl) lvl.textContent = Math.round(zoom * 100) + "%";
    const wrap = $("pdWrap"); if (wrap) wrap.classList.toggle("zoomed", zoom > 1);
  }
  function clampPan() {
    if (zoom <= 1) { panX = 0; panY = 0; return; }
    const wrap = $("pdWrap"); if (!wrap) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    panX = Math.min(0, Math.max(W - W * zoom, panX));
    panY = Math.min(0, Math.max(H - H * zoom, panY));
  }
  function setZoom(nz, cx, cy) {
    nz = Math.max(1, Math.min(5, nz));
    const wrap = $("pdWrap"); if (!wrap) return;
    if (cx == null) { cx = wrap.clientWidth / 2; cy = wrap.clientHeight / 2; }
    const contentX = (cx - panX) / zoom, contentY = (cy - panY) / zoom;   // keep this point under the cursor
    zoom = nz;
    panX = cx - contentX * zoom; panY = cy - contentY * zoom;
    clampPan(); applyZoom(); hidePopup();
  }
  function resetZoom() { zoom = 1; panX = 0; panY = 0; applyZoom(); }
  const panKey = (e) => spaceDown || e.button === 1;
  function startPan(e) {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, x0 = panX, y0 = panY, wrap = $("pdWrap");
    if (wrap) wrap.classList.add("panning");
    hidePopup();
    let moved = false;
    const mv = (m) => { moved = true; panX = x0 + (m.clientX - sx); panY = y0 + (m.clientY - sy); clampPan(); applyZoom(); };
    const up = () => {
      document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up);
      if (wrap) wrap.classList.remove("panning");
      if (moved) { justPanned = true; setTimeout(() => { justPanned = false; }, 60); }
    };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  }
  function drawSaved(annotation, cb) {
    if (!annotation || !ctx) { cb && cb(); return; }
    const a = new Image();
    a.onload = () => { const { w, h } = dispSize(); ctx.drawImage(a, 0, 0, w, h); cb && cb(); };
    a.src = annotation;
  }
  function persistCanvas() {
    const d = deliv(curId); if (!d || !ctx || !cv) return;
    active(d).annotation = isBlank(cv) ? null : cv.toDataURL("image/png");
  }
  function isBlank(c) {
    const b = document.createElement("canvas"); b.width = c.width; b.height = c.height;
    return c.toDataURL() === b.toDataURL();
  }

  /* ---------- pins ---------- */
  function renderPins() {
    const v = active(deliv(curId)); const layer = $("pdPins");
    layer.innerHTML = v.pins.map((p, i) =>
      `<button class="pd-pin ${p.resolved ? "resolved" : ""}" data-pin="${p.id}" style="left:${p.x * 100}%;top:${p.y * 100}%">${i + 1}</button>`).join("");
  }
  function renderPinList() {
    const v = active(deliv(curId)); const box = $("pdPinList");
    const n = v.pins.length;
    const cc = $("pdCommentsCount"); if (cc) cc.textContent = n ? `Comments (${n})` : "Comments";
    const clr = $("pdClearComments"); if (clr) clr.style.display = n ? "" : "none";
    if (!n) { box.innerHTML = `<div class="pd-pinlist-empty">Switch to the Comment tool and click the image to pin a note.</div>`; return; }
    box.innerHTML = v.pins.map((p, i) => `
      <div class="pd-comment ${p.resolved ? "resolved" : ""}" data-row="${p.id}">
        <div class="pd-comment-top">
          <span class="pd-pinnum">${i + 1}</span>
          <div class="pd-comment-actions">
            <button class="pd-cbtn ok" data-resolve="${p.id}" title="${p.resolved ? "Reopen" : "Mark resolved"}">${p.resolved ? "↩" : "✓"}</button>
            <button class="pd-cbtn danger" data-pindel="${p.id}" title="Delete">✕</button>
          </div>
        </div>
        <textarea data-pintext="${p.id}" placeholder="Add a note for pin ${i + 1}…">${esc(p.text)}</textarea>
      </div>`).join("");
  }
  function addPin(xFrac, yFrac) {
    const v = active(deliv(curId));
    const p = { id: "p_" + Date.now() + "_" + (seq++), x: xFrac, y: yFrac, text: "", resolved: false };
    v.pins.push(p);
    history.push({ type: "pinAdd", id: p.id });
    save(); renderPins(); renderPinList();
    const ta = document.querySelector(`[data-pintext="${p.id}"]`);
    if (ta) ta.focus();
  }
  function deletePin(id) {
    const v = active(deliv(curId));
    const index = v.pins.findIndex(x => x.id === id);
    if (index < 0) return;
    const [pin] = v.pins.splice(index, 1);
    history.push({ type: "pinDel", pin, index });
    const pop = $("pdPopup"); if (pop && pop.dataset.pin === id) hidePopup();
    save(); renderPins(); renderPinList();
  }
  function clearComments() {
    const v = active(deliv(curId)); if (!v.pins.length) return;
    history.push({ type: "pinClear", pins: v.pins.slice() });
    v.pins = [];
    hidePopup(); save(); renderPins(); renderPinList();
  }
  function toggleResolve(id) {
    const v = active(deliv(curId)); const p = v.pins.find(x => x.id === id); if (!p) return;
    p.resolved = !p.resolved; save(); renderPins(); renderPinList();
  }
  function selectPin(id) {
    document.querySelectorAll(".pd-pin").forEach(m => m.classList.toggle("sel", m.dataset.pin === id));
    document.querySelectorAll(".pd-comment").forEach(c => c.classList.toggle("sel", c.dataset.row === id));
    const m = document.querySelector(`.pd-pin[data-pin="${id}"]`);
    if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 700); }
    const v = active(deliv(curId)); const p = v && v.pins.find(x => x.id === id);
    if (p) showPopup(p);   // bring the note up on the image, anchored to the pin
  }

  /* ---------- in-image comment popup (anchored to the pin) ---------- */
  function showPopup(p) {
    const wrap = $("pdWrap"), pins = $("pdPins"), pop = $("pdPopup");
    if (!wrap || !pins || !pop) return;
    const ox = parseFloat(pins.style.left) || 0, oy = parseFloat(pins.style.top) || 0;
    const pw = parseFloat(pins.style.width) || 0, ph = parseFloat(pins.style.height) || 0;
    const px = panX + (ox + p.x * pw) * zoom, py = panY + (oy + p.y * ph) * zoom;   // account for zoom/pan
    pop.dataset.pin = p.id;
    const ta = pop.querySelector("[data-popuptext]");
    ta.value = p.text || "";
    pop.style.display = "block";
    const popW = pop.offsetWidth || 230, popH = pop.offsetHeight || 110;
    let left = px + 18, top = py - 12;
    if (left + popW > wrap.clientWidth - 4) left = px - popW - 18;
    if (left < 4) left = 4;
    top = Math.max(4, Math.min(top, wrap.clientHeight - popH - 4));
    pop.style.left = left + "px"; pop.style.top = top + "px";
    ta.focus();
  }
  function hidePopup() { const pop = $("pdPopup"); if (pop) { pop.style.display = "none"; pop.dataset.pin = ""; } }
  function syncPopup(p) { const pop = $("pdPopup"); if (pop && pop.dataset.pin === p.id) { const ta = pop.querySelector("[data-popuptext]"); if (ta && ta.value !== p.text) ta.value = p.text; } }

  /* ---------- unified undo ---------- */
  function undo() {
    const a = history.pop();
    if (!a) return;
    if (a.type === "draw") {
      if (ctx && a.img) ctx.putImageData(a.img, 0, 0);
    } else if (a.type === "pinAdd") {
      const v = active(deliv(curId));
      v.pins = v.pins.filter(p => p.id !== a.id);
      save(); renderPins(); renderPinList();
    } else if (a.type === "pinDel") {
      const v = active(deliv(curId));
      v.pins.splice(Math.min(a.index, v.pins.length), 0, a.pin);
      save(); renderPins(); renderPinList();
    } else if (a.type === "pinClear") {
      const v = active(deliv(curId));
      v.pins = a.pins;
      save(); renderPins(); renderPinList();
    }
  }

  /* ---------- versions ---------- */
  function renderVersions() {
    const d = deliv(curId);
    $("pdVers").innerHTML = d.versions.map((v, i) =>
      `<button class="pd-ver-chip ${i === d.active ? "active" : ""}" data-ver="${i}">${esc(v.label)}</button>`).join("");
  }
  function switchVersion(i) {
    const d = deliv(curId); if (i === d.active) return;
    persistCanvas(); save();
    d.active = i;
    loadVersionIntoModal();
  }

  /* ---------- modal ---------- */
  function loadVersionIntoModal() {
    const d = deliv(curId); const v = active(d);
    history = []; hidePopup(); resetZoom();
    $("pdTitle").textContent = d.name;
    $("pdClientNotes").value = (v.clientNotes != null ? v.clientNotes : (v.comments || ""));   // migrate old single notes → client
    $("pdAgencyNotes").value = v.agencyNotes || "";
    $("pdMeta").textContent = `${v.label} · uploaded ${v.uploaded || "—"} · ${d.versions.length} version(s)`;
    document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === v.status));
    renderVersions();
    const img = $("pdImg");
    // Robust paint: wait (up to ~20 frames) until the image is decoded AND laid
    // out (clientWidth > 0) before sizing the canvas/pin overlay. Fixes markup +
    // comment pins silently failing when the modal opens or an image is cached.
    const paint = (tries) => {
      tries = tries || 0;
      if ((!img.clientWidth || !img.naturalWidth) && tries < 20) { requestAnimationFrame(() => paint(tries + 1)); return; }
      sizeOverlay();
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      drawSaved(v.annotation);
      renderPins(); renderPinList();
    };
    img.onload = () => paint(0);
    img.src = v.dataUrl;
    if (img.complete && img.naturalWidth) paint(0);   // already-loaded / cached / same-src
  }
  function openModal(id) {
    if (!deliv(id)) return;
    curId = id; setTool("draw");
    $("pdModal").classList.add("open");
    $("pdSaved").classList.remove("show");
    loadVersionIntoModal();
  }
  function closeModal() { persistCanvas(); save(); renderGallery(); hidePopup(); resetZoom(); $("pdModal").classList.remove("open"); curId = null; }

  function setTool(t) {
    tool = t;
    $("pdToolDraw").classList.toggle("active", t === "draw");
    $("pdToolComment").classList.toggle("active", t === "comment");
    $("pdDrawOnly").classList.toggle("hide", t !== "draw");
    $("pdToolHint").textContent = t === "draw" ? "Draw to circle / highlight areas" : "Click the image to drop a comment pin";
    const pins = $("pdPins");
    pins.classList.toggle("comment-mode", t === "comment");
    if (cv) cv.style.pointerEvents = (t === "draw") ? "auto" : "none";
    pins.style.pointerEvents = (t === "comment") ? "auto" : "none";
  }

  function submitReview() {
    const d = deliv(curId); if (!d) return;
    const av = active(d); av.clientNotes = $("pdClientNotes").value; av.agencyNotes = $("pdAgencyNotes").value;
    persistCanvas();
    save(); renderGallery();
    const s = $("pdSaved"); s.classList.add("show");
    setTimeout(() => s.classList.remove("show"), 2200);
  }

  /* ---------- rename ---------- */
  function renameInline(titleEl, d) {
    const input = document.createElement("input");
    input.className = "pd-rename-input"; input.value = d.name;
    titleEl.replaceWith(input); input.focus(); input.select();
    const commit = () => {
      d.name = input.value.trim() || d.name; save();
      input.replaceWith(titleEl); titleEl.textContent = d.name; renderGallery();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); if (e.key === "Escape") { input.value = d.name; input.blur(); } });
  }

  /* ---------- drawing ---------- */
  function pos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; }
  function snapshot() { if (!ctx) return; try { history.push({ type: "draw", img: ctx.getImageData(0, 0, cv.width, cv.height) }); if (history.length > 60) history.shift(); } catch {} }

  /* ---------- wiring ---------- */
  // The Present Docs page DOM is rebuilt every time its tab repaints, so the
  // element listeners must re-attach each time; document/window listeners attach once.
  let wiredGlobal = false;
  function init() {
    load(); renderGallery();
    wireElements();
    if (wiredGlobal) return;
    wiredGlobal = true;
    document.addEventListener("keydown", e => {
      const m = $("pdModal"); if (!m || !m.classList.contains("open")) return;
      const typing = /INPUT|TEXTAREA/.test(e.target.tagName || "") || e.target.isContentEditable;
      if (e.code === "Space" && !typing) { spaceDown = true; const w = $("pdWrap"); if (w) w.classList.add("space-pan"); e.preventDefault(); return; }
      if (e.key === "Escape") closeModal();
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    });
    document.addEventListener("keyup", e => {
      if (e.code === "Space") { spaceDown = false; const w = $("pdWrap"); if (w) w.classList.remove("space-pan"); }
    });
    window.addEventListener("resize", () => {
      const m = $("pdModal"); if (!m || !m.classList.contains("open")) return;
      const v = active(deliv(curId));
      persistCanvas(); sizeOverlay(); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); drawSaved(v && v.annotation); renderPins(); hidePopup(); clampPan(); applyZoom();
    });
  }

  function wireElements() {
    $("pdUploadBtn").addEventListener("click", () => $("pdFile").click());
    $("pdFile").addEventListener("change", e => { handleNewDeliverables(e.target.files); e.target.value = ""; });
    $("pdResubmit").addEventListener("click", () => $("pdVerFile").click());
    $("pdVerFile").addEventListener("change", e => { handleResubmit(e.target.files[0]); e.target.value = ""; });

    $("pdGallery").addEventListener("click", e => {
      const del = e.target.closest("[data-del]");
      if (del) { e.stopPropagation(); items = items.filter(x => x.id !== del.dataset.del); save(); renderGallery(); return; }
      const card = e.target.closest(".pd-card");
      if (card) openModal(card.dataset.id);
    });

    $("pdClose").addEventListener("click", closeModal);
    $("pdBackdrop").addEventListener("click", closeModal);
    $("pdRename").addEventListener("click", () => { const d = deliv(curId); if (d) renameInline($("pdTitle"), d); });
    $("pdToolDraw").addEventListener("click", () => setTool("draw"));
    $("pdToolComment").addEventListener("click", () => setTool("comment"));

    document.querySelectorAll(".pd-swatch").forEach(sw => sw.addEventListener("click", () => {
      color = sw.dataset.color;
      document.querySelectorAll(".pd-swatch").forEach(s => s.classList.toggle("active", s === sw));
    }));

    $("pdUndo").addEventListener("click", undo);
    $("pdClear").addEventListener("click", () => { snapshot(); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); });
    $("pdVers").addEventListener("click", e => { const c = e.target.closest("[data-ver]"); if (c) switchVersion(+c.dataset.ver); });

    $("pdStatus").addEventListener("click", e => {
      const opt = e.target.closest(".pd-status-opt"); if (!opt) return;
      const v = active(deliv(curId)); if (!v) return;
      v.status = (v.status === opt.dataset.val) ? null : opt.dataset.val;
      document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === v.status));
      save();
    });

    $("pdPinList").addEventListener("input", e => {
      const ta = e.target.closest("[data-pintext]"); if (!ta) return;
      const v = active(deliv(curId)); const p = v.pins.find(x => x.id === ta.dataset.pintext);
      if (p) { p.text = ta.value; save(); syncPopup(p); }
    });
    $("pdPinList").addEventListener("click", e => {
      const res = e.target.closest("[data-resolve]"); if (res) { toggleResolve(res.dataset.resolve); return; }
      const del = e.target.closest("[data-pindel]"); if (del) { deletePin(del.dataset.pindel); return; }
      const card = e.target.closest(".pd-comment");
      if (card && e.target.tagName !== "TEXTAREA") selectPin(card.dataset.row);  // highlight pin + open its in-image note
    });
    $("pdClearComments").addEventListener("click", clearComments);

    $("pdPins").addEventListener("click", e => {
      if (tool !== "comment" || justPanned || spaceDown) return;
      const marker = e.target.closest(".pd-pin");
      if (marker) { selectPin(marker.dataset.pin); return; }
      const layer = $("pdPins"); const r = layer.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      addPin(x, y);
    });

    const pop = $("pdPopup");
    if (pop) {
      pop.querySelector("[data-popuptext]").addEventListener("input", e => {
        const id = pop.dataset.pin; if (!id) return;
        const v = active(deliv(curId)); const p = v && v.pins.find(x => x.id === id);
        if (p) { p.text = e.target.value; save(); const ta = document.querySelector(`[data-pintext="${id}"]`); if (ta) ta.value = p.text; }
      });
      $("pdPopupClose").addEventListener("click", hidePopup);
    }

    // zoom controls + wheel-to-zoom + pan
    $("pdWrap").addEventListener("wheel", e => {
      e.preventDefault();
      const r = $("pdWrap").getBoundingClientRect();
      setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    $("pdZoomIn").addEventListener("click", () => setZoom(zoom * 1.25));
    $("pdZoomOut").addEventListener("click", () => setZoom(zoom / 1.25));
    $("pdZoomReset").addEventListener("click", resetZoom);
    $("pdPins").addEventListener("pointerdown", e => { if (panKey(e)) startPan(e); });

    cv = $("pdCanvas");
    cv.addEventListener("pointerdown", e => {
      if (panKey(e)) { startPan(e); return; }                      // space/middle-drag → pan
      if (tool !== "draw" || !ctx) return; hidePopup(); snapshot(); drawing = true; lastPt = pos(e); cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointermove", e => {
      if (!drawing || !ctx) return;
      const p = pos(e);
      ctx.strokeStyle = color; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(lastPt.x, lastPt.y); ctx.lineTo(p.x, p.y); ctx.stroke();
      lastPt = p;
    });
    cv.addEventListener("pointerup", () => { drawing = false; });
    cv.addEventListener("pointerleave", () => { drawing = false; });

    $("pdClientNotes").addEventListener("input", e => { const v = active(deliv(curId)); if (v) { v.clientNotes = e.target.value; save(); } });
    $("pdAgencyNotes").addEventListener("input", e => { const v = active(deliv(curId)); if (v) { v.agencyNotes = e.target.value; save(); } });

    $("pdSubmit").addEventListener("click", submitReview);
  }

  return { render, init };
})();
