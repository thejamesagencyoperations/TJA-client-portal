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
  // WAITING ROOM: creative uploads land here (scope 'deliverables_draft' — a row RLS
  // never lets the client read). An admin's Send moves the item into KEY/'deliverables'.
  const DRAFT_KEY = "tja_deliverables_draft_" + sess.client;

  const STATUS = {
    approved:  { label: "Approved as Shown",   badge: "complete" },
    changes:   { label: "Approved w/ Changes", badge: "on-hold" },
    revisions: { label: "Revisions Needed",    badge: "blocked" },
  };

  let items = [];
  let draftItems = [];   // waiting-room deliverables (staff-only; clients can't even pull the scope)
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
    // Creatives can't write the deliverables scope (RLS) — their only write is the
    // draft scope via saveDrafts(). Skipping the push avoids guaranteed-rejected calls.
    if (window.SUPA && window.SUPA.enabled && !(typeof isCreative === "function" && isCreative()))
      window.SUPA.pushScope(sess.client, "deliverables", items);
  }
  const isStaffFn = () => (typeof isStaff === "function" ? isStaff() : true);
  function loadDrafts() {
    if (!isStaffFn()) { draftItems = []; return; }   // clients never even look locally
    try { draftItems = JSON.parse(localStorage.getItem(DRAFT_KEY)) || []; }
    catch { draftItems = []; }
    dedupeDrafts();
  }
  function saveDrafts() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); }
    catch (e) { console.warn("Portal sandbox: storage full — keeping drafts in memory only.", e); }
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(sess.client, "deliverables_draft", draftItems);
  }
  // Self-heal for a crash between the two Send pushes (sent write landed, draft removal
  // didn't): any draft whose version already exists in `items` is a stale duplicate.
  function dedupeDrafts() {
    const sentVids = new Set();
    items.forEach(d => (d.versions || []).forEach(v => { if (v.vid) sentVids.add(v.vid); }));
    const before = draftItems.length;
    draftItems = draftItems.filter(d => !(d.versions || []).some(v => v.vid && sentVids.has(v.vid)));
    if (draftItems.length !== before) saveDrafts();
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const uid = () => "d_" + Date.now() + "_" + (seq++);
  const deliv = (id) => items.find(d => d.id === id) || draftItems.find(d => d.id === id);
  const isDraft = (d) => !!(d && d.versions && d.versions.some(v => v.state === "pending_approval"));
  // Modal edits (pins, notes, annotations, rename) hit whichever store the OPEN item
  // lives in — a draft being marked up before release must persist to the draft scope.
  function saveCur() { if (isDraft(deliv(curId))) saveDrafts(); else save(); }
  const active = (d) => d && d.versions[d.active];
  const $ = (id) => document.getElementById(id);

  /* ---------- page shell ---------- */
  function render() {
    return `
    <div class="page-head">
      <div class="page-title">Present Docs</div>
      <div class="page-desc">Upload creative deliverables for client review — versions, markup, pinned comments &amp; approvals.</div>
    </div>

    <!-- Upload is a STAFF capability, not admin-only: creatives keep the toolbar (their
         uploads route to the waiting room), so the admin-only class is applied only when
         the current viewer can't upload (clients + anyone previewing as a client). -->
    <div class="pd-toolbar${(typeof canUploadDocs === "function" && canUploadDocs()) ? "" : " admin-only"}">
      <button class="btn btn-upload" id="pdUploadBtn">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
        Upload Deliverable
      </button>
      <input type="file" id="pdFile" accept="image/*" multiple hidden>
      <input type="file" id="pdVerFile" accept="image/*" hidden>
      <span class="pd-hint">${(typeof isCreative === "function" && isCreative())
        ? "PNG / JPG · your upload goes to the account manager for release — the client sees it after they hit Send"
        : "PNG / JPG · logos, banners, ad sets, messaging — anything you design"}</span>
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
              <button class="pd-tool-btn${(typeof canUploadDocs === "function" && canUploadDocs()) ? "" : " admin-only"}" id="pdResubmit">＋ New Version</button>
            </div>

            <div class="pd-brief" id="pdBrief" style="display:none">
              <div class="pd-brief-subject" id="pdBriefSubject"></div>
              <div class="pd-brief-msg" id="pdBriefMsg"></div>
            </div>

            <div class="pd-review-label">Status</div>
            <div class="pd-status-opts" id="pdStatus">
              <div class="pd-status-opt approved"  data-val="approved"><span class="tick">✓</span> Approve</div>
              <div class="pd-status-opt changes"   data-val="changes"><span class="tick">✓</span> Approve with changes</div>
              <div class="pd-status-opt revisions" data-val="revisions"><span class="tick">✓</span> Revisions needed</div>
            </div>

            <div class="pd-revdue-row">
              <label class="pd-review-label" for="pdRevDue">Feedback due</label>
              <input type="date" id="pdRevDue" class="pd-revdue">
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
            <div class="pd-sign-status" id="pdSignStatus"></div>
            <button class="pd-tool-btn pd-export-btn" id="pdExport">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>
              Export PDF
            </button>
            <div class="pd-meta-line" id="pdMeta"></div>
          </div>
        </div>

        <div class="pd-sign-overlay" id="pdSignOverlay" style="display:none">
          <div class="pd-sign-card">
            <div class="pd-sign-title">Sign to approve</div>
            <div class="pd-sign-sub" id="pdSignSub">Type or draw your signature to approve this version.</div>
            <div class="pd-sign-tabs">
              <button class="pd-sign-tab" data-sigmode="type" id="pdSigTypeTab">⌨ Type</button>
              <button class="pd-sign-tab" data-sigmode="draw" id="pdSigDrawTab">✎ Draw</button>
            </div>
            <canvas id="pdSignPad" class="pd-sign-pad"></canvas>
            <div class="pd-sign-preview" id="pdSignPreview"></div>
            <div class="pd-sign-row">
              <input type="text" id="pdSignName" class="pd-sign-name" placeholder="Type your full name">
              <button class="pd-tool-btn" id="pdSignClear">Clear</button>
            </div>
            <div class="pd-sign-actions">
              <button class="pd-tool-btn" id="pdSignCancel">Cancel</button>
              <button class="btn btn-primary" id="pdSignConfirm">Confirm &amp; Submit</button>
            </div>
          </div>
        </div>
      </div>

    </div>

    <!-- Upload brief — a SIBLING of #pdModal, never a child: the modal is display:none until a
         deliverable is opened, and this dialog is raised from the gallery, before one exists. -->
    <div class="pd-up-overlay" id="pdUpOverlay" style="display:none">
      <div class="pd-up-card">
        <div class="pd-sign-title">Send deliverable</div>
        <div class="pd-sign-sub" id="pdUpSub"></div>
        <label class="pd-review-label" for="pdUpSubject">Subject</label>
        <input type="text" id="pdUpSubject" class="pd-up-subject" placeholder="e.g. Logo concepts — round 1">
        <label class="pd-review-label" for="pdUpMsg">Message to client</label>
        <textarea id="pdUpMsg" class="pd-up-msg" placeholder="Context for this round — what you'd like feedback on…"></textarea>
        <div class="pd-revdue-row">
          <label class="pd-review-label" for="pdUpDue">Feedback due</label>
          <input type="date" id="pdUpDue" class="pd-revdue">
        </div>
        <div class="pd-sign-actions">
          <button class="pd-tool-btn" id="pdUpCancel">Cancel</button>
          <button class="btn btn-primary" id="pdUpSend">Add deliverable</button>
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
  // "2026-07-20" → "Jul 20". Parsed as local parts, never Date("...") — that reads ISO as UTC
  // and lands a day early for anyone west of Greenwich.
  function fmtDue(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return "";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  function isOverdue(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return false;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return new Date(+m[1], +m[2] - 1, +m[3]) < t;
  }
  // Feedback-due strip on a gallery card. Settled versions have nothing outstanding, so it hides.
  function dueLine(v) {
    if (!v || !v.revisionsDue || v.status === "approved") return "";
    const over = isOverdue(v.revisionsDue);
    return `<div class="pd-card-due ${over ? "overdue" : ""}">${over ? "Feedback overdue" : "Feedback due"} ${esc(fmtDue(v.revisionsDue))}</div>`;
  }
  // What this viewer gets to see: clients + anyone PREVIEWING as a client see only the
  // sent items; staff also see the waiting room. (RLS already keeps drafts out of a real
  // client's browser — this is the same rule applied to preview mode.)
  function visibleDrafts() {
    const clientEyes = (typeof effectiveRole === "function") ? effectiveRole() === "client" : false;
    return clientEyes ? [] : draftItems;
  }
  function draftStrip(d) {
    const v = d.versions[d.versions.length - 1];
    const who = v.uploadedBy ? ` · ${esc(v.uploadedBy)}` : "";
    return `<div class="pd-card-pending">⏳ Awaiting release — not visible to client${who}</div>`;
  }
  function renderGallery() {
    const g = $("pdGallery"); if (!g) return;
    const drafts = visibleDrafts();
    if (!items.length && !drafts.length) {
      const canUp = (typeof canUploadDocs === "function") ? canUploadDocs() : true;
      g.innerHTML = `<div class="pd-empty" style="grid-column:1/-1">
        <div class="big">＋</div>
        ${canUp
          ? `No deliverables yet. Click <b>Upload Deliverable</b> to add your first proof.`
          : `No creative deliverables to review yet — your team will post them here.`}</div>`;
      return;
    }
    const canSend = (typeof canSendDocs === "function") ? canSendDocs() : true;
    const draftCards = drafts.map(d => {
      const v = active(d);
      return `<div class="pd-card pd-card-draft" data-id="${d.id}">
        <button class="pd-del admin-only" data-del="${d.id}" title="Remove">✕</button>
        <span class="pd-enlarge-cue">Click to review</span>
        <div class="pd-thumb"><img src="${v.dataUrl}" alt="${esc(d.name)}"></div>
        ${canSend ? `<button class="btn btn-primary pd-send-btn" data-send="${d.id}">📤 Send to client</button>` : ""}
        <div class="pd-card-foot">
          <div class="pd-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
          <span class="pd-ver-tag">${esc(v.label)}</span>
          <span class="badge pending">Awaiting release</span>
        </div>
        ${draftStrip(d)}
      </div>`;
    }).join("");
    const sentCards = items.map(d => {
      const v = active(d);
      // The due date always comes from the LATEST round, not the version being viewed — once V2
      // is up, the card shows V2's date even if someone left the viewer parked on V1.
      const last = d.versions[d.versions.length - 1] || v;
      return `<div class="pd-card" data-id="${d.id}">
        <button class="pd-del admin-only" data-del="${d.id}" title="Remove">✕</button>
        <button class="pd-card-export" data-export="${d.id}" title="Export PDF">⬇</button>
        <span class="pd-enlarge-cue">Click to review</span>
        <div class="pd-thumb"><img src="${v.dataUrl}" alt="${esc(d.name)}"></div>
        <div class="pd-card-foot">
          <div class="pd-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
          <span class="pd-ver-tag">${esc(v.label)}</span>
          ${badge(v.status)}
        </div>
        ${dueLine(last)}
      </div>`;
    }).join("");
    g.innerHTML = draftCards + sentCards;   // waiting room first — it's the actionable pile
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
  // date + time stamp, e.g. "Jun 25, 2026 · 3:45 PM"
  function stamp() {
    try {
      const d = new Date();
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    } catch (e) { return new Date().toLocaleString(); }
  }
  function newVersion(dataUrl, label) {
    // `state` is ROUTING (pending_approval | sent; ABSENT = sent, so every pre-existing
    // version needs no migration). `status` stays the client's review verdict — the two
    // look similar and must never be merged. `vid` is a per-version id (versions had
    // none) used by dedupeDrafts to self-heal a crashed Send.
    return { label, dataUrl, annotation: null, pins: [], status: null, clientNotes: "", agencyNotes: "",
      uploaded: stamp(), revisionsDue: "", subject: "", message: "",
      state: "sent", vid: uid() + "_v", uploadedBy: sess.name || sess.email || "" };
  }

  /* ---------- upload brief (V1) ----------
     Files are processed first, then held here until the admin writes the subject + message that
     go out with them. Cancelling drops them — nothing is added to the gallery until Send. */
  let pendingUpload = null;
  async function handleNewDeliverables(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith("image/"));
    if (!files.length) return;
    const processed = [];
    for (const f of files) processed.push(await processFile(f));
    pendingUpload = processed;
    const ov = $("pdUpOverlay");
    if (!ov) { commitUpload(); return; }   // no dialog in the DOM → don't strand the files
    $("pdUpSub").textContent = processed.length === 1
      ? `${processed[0].name} · V1`
      : `${processed.length} files · V1 each`;
    $("pdUpSubject").value = ""; $("pdUpMsg").value = ""; $("pdUpDue").value = "";
    ov.style.display = "flex";
    setTimeout(() => $("pdUpSubject").focus(), 0);
  }
  function closeUploadDialog() {
    const ov = $("pdUpOverlay"); if (ov) ov.style.display = "none";
    pendingUpload = null;
  }
  // Upload routing: an ADMIN'S upload goes straight to the client (today's behavior,
  // still no notification — Send is what notifies, and admin uploads ARE the send).
  // A CREATIVE'S upload lands in the waiting room until an admin releases it.
  const uploadsToDraft = () => (typeof isCreative === "function" && isCreative());
  function commitUpload() {
    const subject = $("pdUpSubject") ? $("pdUpSubject").value.trim() : "";
    const message = $("pdUpMsg") ? $("pdUpMsg").value.trim() : "";
    const due = $("pdUpDue") ? $("pdUpDue").value : "";
    const toDraft = uploadsToDraft();
    const multi = (pendingUpload || []).length > 1;
    // The card is named by the SUBJECT you typed, not the raw filename — that's what the
    // client reads in the gallery. Falls back to the filename if the subject is left blank.
    // When several files share one subject, the filename is appended so the cards stay
    // tellable apart (they'd otherwise all carry the same name).
    const nameFor = (p) => !subject ? p.name : (multi ? subject + " — " + p.name : subject);
    (pendingUpload || []).forEach(p => {
      const v = newVersion(p.dataUrl, "V1");
      v.subject = subject; v.message = message; v.revisionsDue = due;
      const name = nameFor(p);
      if (toDraft) {
        v.state = "pending_approval";
        draftItems.unshift({ id: uid(), name: name, active: 0, versions: [v] });
      } else {
        items.unshift({ id: uid(), name: name, active: 0, versions: [v] });
      }
      if (toDraft && window.TJA_NOTIFY) {
        // admin-bell discovery of pending work (the client-facing notification fires at Send)
        try { window.TJA_NOTIFY.record({ type: "upload", docId: v.vid, docName: name, versionLabel: "V1", by: sess.name || "Creative" }); } catch (e) {}
      }
    });
    closeUploadDialog();
    if (toDraft) saveDrafts(); else save();
    renderGallery();
  }
  async function handleResubmit(file) {
    const d = deliv(curId); if (!d || !file) return;
    persistCanvas();
    const p = await processFile(file);
    if (uploadsToDraft() && !isDraft(d)) {
      // Creative adds a round to an already-SENT deliverable: the new version becomes a
      // standalone waiting-room card carrying parentId; Send merges it onto the parent
      // and recomputes the V-label then (an admin may add V2 in the meantime).
      const v = newVersion(p.dataUrl, "V" + (d.versions.length + 1) + " (proposed)");
      v.state = "pending_approval";
      draftItems.unshift({ id: uid(), name: d.name, active: 0, versions: [v], parentId: d.id });
      if (window.TJA_NOTIFY) { try { window.TJA_NOTIFY.record({ type: "upload", docId: v.vid, docName: d.name, versionLabel: v.label, by: sess.name || "Creative" }); } catch (e) {} }
      saveDrafts(); renderGallery();
      return;
    }
    const v = newVersion(p.dataUrl, "V" + (d.versions.length + 1));
    if (isDraft(d)) v.state = "pending_approval";   // extra round on a not-yet-sent draft stays a draft
    d.versions.push(v);
    d.active = d.versions.length - 1;
    if (isDraft(d)) saveDrafts(); else save();
    loadVersionIntoModal(); renderGallery();
  }

  /* ---------- Send (admin releases a waiting-room draft to the client) ----------
     Ordering is deliberate: write the SENT copy first, remove the draft second. If we
     crash in between, the deliverable exists in both stores (dedupeDrafts cleans that
     on next staff load) — the failure mode duplicates, it never loses. */
  async function sendDraft(draftId) {
    if (!(typeof canSendDocs === "function" ? canSendDocs() : true)) return;
    const idx = draftItems.findIndex(d => d.id === draftId); if (idx < 0) return;
    const draft = draftItems[idx];
    const sentStamp = stamp();
    const sentBy = sess.name || sess.email || "TJA";
    let revert;
    const parent = draft.parentId ? items.find(x => x.id === draft.parentId) : null;
    if (parent) {
      const v = draft.versions[draft.versions.length - 1];
      v.state = "sent"; v.sentAt = sentStamp; v.sentBy = sentBy;
      v.label = "V" + (parent.versions.length + 1);   // recompute — parent may have grown
      parent.versions.push(v);
      parent.active = parent.versions.length - 1;
      revert = () => { parent.versions.pop(); parent.active = Math.min(parent.active, parent.versions.length - 1); v.state = "pending_approval"; };
    } else {
      draft.versions.forEach(v => { v.state = "sent"; v.sentAt = sentStamp; v.sentBy = sentBy; });
      items.unshift(draft);
      revert = () => { items.shift(); draft.versions.forEach(v => { v.state = "pending_approval"; }); };
    }
    // 1. the client-visible write — this is the one that must not fail silently
    if (window.SUPA && window.SUPA.enabled) {
      const r = await window.SUPA.pushScopeNow(sess.client, "deliverables", items);
      if (!r.ok) {
        revert();
        alert("Send failed (" + (r.error || "network") + ") — the deliverable is still in the waiting room.");
        renderGallery();
        return;
      }
    }
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    // 2. drop the draft (failure here is safe — dedupeDrafts self-heals on next load)
    draftItems.splice(idx, 1);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {}
    if (window.SUPA && window.SUPA.enabled) await window.SUPA.pushScopeNow(sess.client, "deliverables_draft", draftItems);
    // 3. notify — THE client-facing moment (upload never notifies)
    const sentV = parent ? parent.versions[parent.versions.length - 1] : draft.versions[draft.versions.length - 1];
    const sentName = parent ? parent.name : draft.name;
    if (window.TJA_NOTIFY) { try { window.TJA_NOTIFY.record({ type: "sent", docId: (parent || draft).id, docName: sentName, versionLabel: sentV.label, by: sentBy }); } catch (e) {} }
    // 4. email hook — no-op until the mail module ships (Phase 6)
    if (window.TJA_MAIL && window.TJA_MAIL.sendDeliverable) {
      try {
        window.TJA_MAIL.sendDeliverable({ clientId: sess.client, docName: sentName,
          versionLabel: sentV.label, subject: sentV.subject, message: sentV.message, dueDate: sentV.revisionsDue });
      } catch (e) { console.warn("deliverable email failed", e); }
    }
    renderGallery();
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
    saveCur(); renderPins(); renderPinList();
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
    saveCur(); renderPins(); renderPinList();
  }
  function clearComments() {
    const v = active(deliv(curId)); if (!v.pins.length) return;
    history.push({ type: "pinClear", pins: v.pins.slice() });
    v.pins = [];
    hidePopup(); saveCur(); renderPins(); renderPinList();
  }
  function toggleResolve(id) {
    const v = active(deliv(curId)); const p = v.pins.find(x => x.id === id); if (!p) return;
    p.resolved = !p.resolved; saveCur(); renderPins(); renderPinList();
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
      saveCur(); renderPins(); renderPinList();
    } else if (a.type === "pinDel") {
      const v = active(deliv(curId));
      v.pins.splice(Math.min(a.index, v.pins.length), 0, a.pin);
      saveCur(); renderPins(); renderPinList();
    } else if (a.type === "pinClear") {
      const v = active(deliv(curId));
      v.pins = a.pins;
      saveCur(); renderPins(); renderPinList();
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
    persistCanvas(); saveCur();
    d.active = i;
    loadVersionIntoModal();
  }

  /* ---------- modal ---------- */
  function loadVersionIntoModal() {
    const d = deliv(curId); const v = active(d);
    history = []; hidePopup(); resetZoom(); closeSignaturePad(); updateSignStatus();
    $("pdTitle").textContent = d.name;
    $("pdClientNotes").value = (v.clientNotes != null ? v.clientNotes : (v.comments || ""));   // migrate old single notes → client
    $("pdAgencyNotes").value = v.agencyNotes || "";
    $("pdRevDue").value = v.revisionsDue || "";
    const brief = $("pdBrief");
    if (brief) {
      brief.style.display = (v.subject || v.message) ? "" : "none";
      $("pdBriefSubject").textContent = v.subject || "";
      $("pdBriefMsg").textContent = v.message || "";
    }
    updateMeta();
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
    const d = deliv(id); if (!d) return;
    curId = id; setTool("draw");
    const m = $("pdModal");
    m.classList.add("open");
    // Creatives review nothing — the status/notes/submit rail is the CLIENT's (and the
    // admin's) tool. Their modal is look-and-annotate-your-own-draft only.
    m.classList.toggle("pd-ro", typeof isCreative === "function" && isCreative() && !isDraft(d));
    $("pdSaved").classList.remove("show");
    loadVersionIntoModal();
  }
  function closeModal() {
    persistCanvas();
    // Draft annotations live in draftItems — persist whichever store the open item is in.
    if (isDraft(deliv(curId))) saveDrafts(); else save();
    renderGallery(); hidePopup(); resetZoom(); closeSignaturePad(); $("pdModal").classList.remove("open"); curId = null;
  }

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
    // an approval needs a signature first
    if ((av.status === "approved" || av.status === "changes") && !av.signature) { openSignaturePad(); return; }
    finishSubmit();
  }
  const STATUS_WORD = { approved: "Approved", changes: "Approved w/ changes", revisions: "Revisions needed" };
  function updateMeta() {
    const d = deliv(curId); if (!d) return; const v = active(d);
    const rev = v.reviewedAt ? ` · reviewed ${v.reviewedAt}${v.reviewedStatus ? " (" + (STATUS_WORD[v.reviewedStatus] || v.reviewedStatus) + ")" : ""}` : "";
    $("pdMeta").textContent = `${v.label} · uploaded ${v.uploaded || "—"}${rev} · ${d.versions.length} version(s)`;
  }
  function finishSubmit() {
    const d = deliv(curId);
    const v = active(d);
    if (v) { v.reviewedAt = stamp(); v.reviewedStatus = v.status || null; }   // stamp date+time of this review submit
    // Notify the TJA team when a CLIENT submits a review (not when an admin does).
    if (v && d && window.TJA_NOTIFY && getSession && getSession() && getSession().role === "client") {
      window.TJA_NOTIFY.record({
        type: "review", docId: d.id, docName: d.name, versionLabel: v.label,
        status: v.status || null, comments: (v.pins || []).length,
        by: getSession().name || "Client",
      });
    }
    saveCur(); renderGallery(); updateSignStatus(); updateMeta();
    const s = $("pdSaved"); s.classList.add("show");
    setTimeout(() => s.classList.remove("show"), 2200);
  }
  function updateSignStatus() {
    const el = $("pdSignStatus"); if (!el) return;
    const v = active(deliv(curId));
    el.innerHTML = (v && v.signature)
      ? `<span class="pd-signed">✓ Approved &amp; signed${v.signedBy ? " by " + esc(v.signedBy) : ""}${v.signedDate ? " · " + esc(v.signedDate) : ""}</span>`
      : "";
  }

  /* ---------- approval signature ---------- */
  let sigCtx = null, sigDrawing = false, sigLast = null, sigDirty = false, sigMode = "type";
  function setSigMode(m) {
    sigMode = m;
    $("pdSigTypeTab").classList.toggle("active", m === "type");
    $("pdSigDrawTab").classList.toggle("active", m === "draw");
    $("pdSignPad").style.display = m === "draw" ? "block" : "none";
    $("pdSignPreview").style.display = m === "type" ? "flex" : "none";
    $("pdSignClear").style.display = m === "draw" ? "" : "none";
    if (m === "draw") sizeSigPad(); else updateSigPreview();
  }
  function sizeSigPad() {
    const cv2 = $("pdSignPad"); if (!cv2) return;
    requestAnimationFrame(() => {
      const r = cv2.getBoundingClientRect(); if (!r.width) return; const dp = window.devicePixelRatio || 1;
      cv2.width = Math.round(r.width * dp); cv2.height = Math.round(r.height * dp);
      sigCtx = cv2.getContext("2d"); sigCtx.scale(dp, dp);
      sigCtx.lineCap = "round"; sigCtx.lineJoin = "round"; sigCtx.lineWidth = 2.4; sigCtx.strokeStyle = "#111";
      sigDirty = false;
    });
  }
  function updateSigPreview() {
    const pv = $("pdSignPreview"); if (!pv) return;
    const name = $("pdSignName").value.trim();
    pv.textContent = name || "Your signature";
    pv.classList.toggle("placeholder", !name);
  }
  function openSignaturePad() {
    const ov = $("pdSignOverlay"); if (!ov) return;
    const d = deliv(curId);
    $("pdSignSub").textContent = `Sign to approve “${d.name}” (${active(d).label}).`;
    $("pdSignName").value = (typeof getSession === "function" && getSession() && getSession().name) || "";
    ov.style.display = "flex";
    setSigMode("type");   // default to the typed cursive signature
  }
  function closeSignaturePad() { const ov = $("pdSignOverlay"); if (ov) ov.style.display = "none"; }
  function sigPos(e) { const r = $("pdSignPad").getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function clearSig() { const cv2 = $("pdSignPad"); if (sigCtx && cv2) sigCtx.clearRect(0, 0, cv2.width, cv2.height); sigDirty = false; }
  async function typedSignature(name) {
    try { await document.fonts.load("52px 'Great Vibes'"); } catch (e) {}
    const c = document.createElement("canvas"); c.width = 640; c.height = 150; const x = c.getContext("2d");
    x.fillStyle = "#111"; x.textBaseline = "middle"; x.textAlign = "left"; x.font = "52px 'Great Vibes', cursive";
    x.fillText(name, 18, 84); return c.toDataURL("image/png");
  }
  async function confirmSign() {
    const v = active(deliv(curId)); const name = $("pdSignName").value.trim();
    if (sigMode === "type") {
      if (!name) { $("pdSignSub").textContent = "Type your name to create a signature."; return; }
      v.signature = await typedSignature(name);
    } else {
      if (!sigDirty) { $("pdSignSub").textContent = "Draw your signature, or switch to Type."; return; }
      v.signature = $("pdSignPad").toDataURL("image/png");
    }
    v.signedBy = name || ((typeof getSession === "function" && getSession() && getSession().name) || "Client");
    v.signedDate = new Date().toLocaleDateString();
    closeSignaturePad(); finishSubmit();
  }

  /* ---------- PDF export (image + drawings + numbered comments + sign-off) ---------- */
  function loadJsPDF() {
    return new Promise((resolve, reject) => {
      if (window.jspdf && window.jspdf.jsPDF) return resolve(window.jspdf.jsPDF);
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      s.onload = () => resolve(window.jspdf && window.jspdf.jsPDF);
      s.onerror = () => reject(new Error("pdf lib failed"));
      document.head.appendChild(s);
    });
  }
  function buildComposite(v) {     // base image + saved drawing + numbered pins, at full resolution
    return new Promise((resolve) => {
      const base = new Image();
      base.onload = () => {
        const W = base.naturalWidth, H = base.naturalHeight;
        const c = document.createElement("canvas"); c.width = W; c.height = H; const x = c.getContext("2d");
        x.drawImage(base, 0, 0, W, H);
        const pins = () => {
          (v.pins || []).forEach((p, i) => {
            const px = p.x * W, py = p.y * H, r = Math.max(13, W * 0.014);
            x.beginPath(); x.arc(px, py, r, 0, Math.PI * 2);
            x.fillStyle = p.resolved ? "#36c275" : "#F68E21"; x.fill();
            x.lineWidth = Math.max(2, r * 0.16); x.strokeStyle = "#fff"; x.stroke();
            x.fillStyle = "#111"; x.font = `bold ${Math.round(r * 1.15)}px Arial,sans-serif`; x.textAlign = "center"; x.textBaseline = "middle";
            x.fillText(String(i + 1), px, py);
          });
          resolve(c.toDataURL("image/jpeg", 0.92));
        };
        if (v.annotation) { const a = new Image(); a.onload = () => { x.drawImage(a, 0, 0, W, H); pins(); }; a.onerror = pins; a.src = v.annotation; }
        else pins();
      };
      base.onerror = () => resolve(null);
      base.src = v.dataUrl;
    });
  }
  async function exportPDF(d) {
    if (!d) return;
    const btn = $("pdExport"); const old = btn ? btn.innerHTML : "";
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
      const jsPDF = await loadJsPDF(); if (!jsPDF) throw new Error("no jsPDF");
      const v = active(d), composite = await buildComposite(v);
      const pdf = new jsPDF({ unit: "pt", format: "letter" });
      const pageW = pdf.internal.pageSize.getWidth(), pageH = pdf.internal.pageSize.getHeight(), M = 42;
      let y = M;
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(17); pdf.setTextColor(20); pdf.text(d.name, M, y); y += 22;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(110);
      const dir = v.status ? STATUS[v.status].label : "Pending Review";
      pdf.text(`Version ${v.label}    ·    Direction: ${dir}    ·    Exported ${new Date().toLocaleDateString()}`, M, y);
      y += 9; pdf.setDrawColor(225); pdf.line(M, y, pageW - M, y); y += 16; pdf.setTextColor(20);
      if (composite) {
        const props = pdf.getImageProperties(composite), maxW = pageW - M * 2, ratio = props.height / props.width;
        let w = maxW, h = maxW * ratio; const maxH = pageH * 0.46; if (h > maxH) { h = maxH; w = h / ratio; }
        pdf.addImage(composite, "JPEG", M + (maxW - w) / 2, y, w, h); y += h + 18;
      }
      const pins = v.pins || [];
      pdf.setFont("helvetica", "bold"); pdf.setFontSize(12); pdf.text(`Comments (${pins.length})`, M, y); y += 15;
      pdf.setFont("helvetica", "normal"); pdf.setFontSize(10); pdf.setTextColor(40);
      if (!pins.length) { pdf.setTextColor(140); pdf.text("No pinned comments.", M, y); y += 14; pdf.setTextColor(40); }
      pins.forEach((p, i) => {
        const lines = pdf.splitTextToSize(`${i + 1}.  ${p.text || "(no note)"}${p.resolved ? "   [resolved]" : ""}`, pageW - M * 2);
        if (y + lines.length * 13 > pageH - M) { pdf.addPage(); y = M; }
        pdf.text(lines, M, y); y += lines.length * 13 + 4;
      });
      y += 10;
      const notes = (label, txt) => {
        if (!txt) return;
        if (y + 34 > pageH - M) { pdf.addPage(); y = M; }
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.text(label, M, y); y += 14;
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(10);
        const lines = pdf.splitTextToSize(txt, pageW - M * 2); pdf.text(lines, M, y); y += lines.length * 13 + 10;
      };
      notes("Client Notes", v.clientNotes); notes("Agency Notes", v.agencyNotes);
      if (v.signature) {
        if (y + 100 > pageH - M) { pdf.addPage(); y = M; }
        pdf.setFont("helvetica", "bold"); pdf.setFontSize(11); pdf.setTextColor(20); pdf.text("Client Approval", M, y); y += 8;
        try { pdf.addImage(v.signature, "PNG", M, y, 170, 56); } catch (e) {}
        pdf.setDrawColor(200); pdf.line(M, y + 60, M + 220, y + 60);
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(9); pdf.setTextColor(110);
        pdf.text(`${v.signedBy || "Client"}${v.signedDate ? "    ·    " + v.signedDate : ""}`, M, y + 72);
      }
      pdf.save(`${(d.name || "deliverable").replace(/[^\w-]+/g, "_")}-${v.label}.pdf`);
    } catch (e) {
      console.warn("PDF export failed", e);
      alert("Sorry — couldn't generate the PDF (the PDF library may have failed to load). Check your connection and try again.");
    } finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
  }

  /* ---------- rename ---------- */
  function renameInline(titleEl, d) {
    const input = document.createElement("input");
    input.className = "pd-rename-input"; input.value = d.name;
    titleEl.replaceWith(input); input.focus(); input.select();
    const commit = () => {
      d.name = input.value.trim() || d.name; saveCur();
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
    load(); loadDrafts(); renderGallery();
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
    $("pdUpCancel").addEventListener("click", closeUploadDialog);
    $("pdUpSend").addEventListener("click", commitUpload);
    // Shared helper — a bare click listener closed this dialog while you were typing the
    // subject/message (drag-select out of a field fires click on the overlay).
    window.TJA_UI.backdropClose($("pdUpOverlay"), closeUploadDialog);
    $("pdResubmit").addEventListener("click", () => $("pdVerFile").click());
    $("pdVerFile").addEventListener("change", e => { handleResubmit(e.target.files[0]); e.target.value = ""; });

    $("pdGallery").addEventListener("click", e => {
      const exp = e.target.closest("[data-export]");
      if (exp) { e.stopPropagation(); exportPDF(deliv(exp.dataset.export)); return; }
      const snd = e.target.closest("[data-send]");
      if (snd) { e.stopPropagation(); snd.disabled = true; sendDraft(snd.dataset.send); return; }
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const id = del.dataset.del;
        if (draftItems.some(x => x.id === id)) { draftItems = draftItems.filter(x => x.id !== id); saveDrafts(); }
        else { items = items.filter(x => x.id !== id); save(); }
        renderGallery(); return;
      }
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
      saveCur();
    });

    $("pdPinList").addEventListener("input", e => {
      const ta = e.target.closest("[data-pintext]"); if (!ta) return;
      const v = active(deliv(curId)); const p = v.pins.find(x => x.id === ta.dataset.pintext);
      if (p) { p.text = ta.value; saveCur(); syncPopup(p); }
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
        if (p) { p.text = e.target.value; saveCur(); const ta = document.querySelector(`[data-pintext="${id}"]`); if (ta) ta.value = p.text; }
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

    $("pdClientNotes").addEventListener("input", e => { const v = active(deliv(curId)); if (v) { v.clientNotes = e.target.value; saveCur(); } });
    $("pdAgencyNotes").addEventListener("input", e => { const v = active(deliv(curId)); if (v) { v.agencyNotes = e.target.value; saveCur(); } });
    $("pdRevDue").addEventListener("change", e => { const v = active(deliv(curId)); if (v) { v.revisionsDue = e.target.value; saveCur(); } });

    $("pdSubmit").addEventListener("click", submitReview);
    $("pdExport").addEventListener("click", () => exportPDF(deliv(curId)));

    // signature pad
    const pad = $("pdSignPad");
    if (pad) {
      pad.addEventListener("pointerdown", e => { if (!sigCtx) return; e.preventDefault(); sigDrawing = true; sigDirty = true; sigLast = sigPos(e); try { pad.setPointerCapture(e.pointerId); } catch {} });
      pad.addEventListener("pointermove", e => { if (!sigDrawing || !sigCtx) return; const p = sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(sigLast.x, sigLast.y); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); sigLast = p; });
      pad.addEventListener("pointerup", () => { sigDrawing = false; });
      pad.addEventListener("pointerleave", () => { sigDrawing = false; });
      $("pdSignClear").addEventListener("click", clearSig);
      $("pdSignCancel").addEventListener("click", closeSignaturePad);
      $("pdSignConfirm").addEventListener("click", confirmSign);
      $("pdSigTypeTab").addEventListener("click", () => setSigMode("type"));
      $("pdSigDrawTab").addEventListener("click", () => setSigMode("draw"));
      $("pdSignName").addEventListener("input", () => { if (sigMode === "type") updateSigPreview(); });
    }
  }

  return { render, init };
})();
