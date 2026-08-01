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
    if (!(window.SUPA && window.SUPA.enabled) || (typeof isCreative === "function" && isCreative())) return;
    // A CLIENT's edits (pins, notes, status) must never blind-push the whole document — a tab
    // holding a pre-V2 copy doing that is exactly what wiped a just-sent V2 + a teammate's
    // review on 2026-07-28. Clients go through the merged push; staff keep the direct path.
    if (getSession && getSession() && getSession().role === "client") { scheduleClientMergedPush(); return; }
    // STAFF: also never blind-push. A stale staff tab used to revert a client's just-submitted
    // review (and any version it hadn't seen) wholesale — the same wipe from the other side.
    scheduleStaffMergedPush();
  }
  /* ---------- merge-on-write for client edits ----------
     Graft THIS person's work onto the freshest server copy, then push the result:
       • versions/cards follow the SERVER (a stale tab can no longer delete a V2 it never saw);
       • my pins (authored by me, or legacy unauthored ones only I hold) win — add/edit/delete;
       • teammates' pins survive untouched;
       • my review entry rides along; the shared verdict re-aggregates;
       • legacy single-reviewer versions keep local-wins on their review fields (old behavior).
     Drawings (annotation) are one shared canvas, so the last writer wins there — that's the
     one thing that can't be merged. */
  /* Graft MY markup from one surface onto another. A "surface" is a PAGE for a multi-page PDF,
     or the version itself for a single image — which is exactly the distinction the merge used
     to miss: it only ever looked at version-level pins, so a multi-page proof's markup was
     dropped on every merge and the client's comments vanished the moment they submitted
     (2026-07-31). Author-keyed, so a teammate's pins are never touched. */
  function mergeSurfaceMine(lsf, fsf, me) {
    if (!lsf || !fsf) return;
    const mineOwned = (pn) => !pn.byEmail || pn.byEmail === me;
    const byId = new Map((fsf.pins || []).map(pn => [pn.id, pn]));
    (lsf.pins || []).forEach(pn => { if (mineOwned(pn)) byId.set(pn.id, pn); });
    (fsf.pins || []).forEach(pn => { if (mineOwned(pn) && !(lsf.pins || []).some(x => x.id === pn.id)) byId.delete(pn.id); });
    fsf.pins = [...byId.values()];
    if (lsf.annotation !== undefined) fsf.annotation = lsf.annotation;
  }
  // Apply across EVERY surface of a version — each page when paged, else the version itself.
  function mergeVersionSurfaces(lv, fv, me) {
    const lp = pagesOf(lv), fp = pagesOf(fv);
    if (lp && fp) {
      const n = Math.min(lp.length, fp.length);
      for (let i = 0; i < n; i++) mergeSurfaceMine(lp[i], fp[i], me);
    } else {
      mergeSurfaceMine(lv, fv, me);
    }
  }

  function mergeMineInto(fresh, local) {
    const me = myEmail();
    const freshById = new Map(fresh.map(x => [x.id, x]));
    local.forEach(ld => {
      const fd = freshById.get(ld.id);
      if (!fd) return;   // card the server doesn't have (deleted elsewhere) — server wins
      (ld.versions || []).forEach(lv => {
        if (!lv.vid) return;
        const fv = (fd.versions || []).find(x => x.vid === lv.vid);
        if (!fv) return;   // version the server doesn't have — server wins
        mergeVersionSurfaces(lv, fv, me);        // pins + drawings, per page when paged
        if (lv.reviews && lv.reviews[me]) fv.reviews = Object.assign({}, fv.reviews, { [me]: lv.reviews[me] });
        if (lv.signature && !fv.signature) { fv.signature = lv.signature; fv.signedBy = lv.signedBy; fv.signedDate = lv.signedDate; }
        if (expectedOf(fv).length) {
          fv.status = aggregateStatus(fv);
        } else {
          ["status", "clientNotes", "agencyNotes", "reviewedAt", "reviewedStatus"].forEach(k => {
            if (lv[k] !== undefined) fv[k] = lv[k];
          });
        }
      });
    });
    return fresh;
  }
  /* ---------- STAFF writes: 3-way merge against a base snapshot ----------
     Staff can't use the client's "graft mine onto the server" merge, because staff legitimately
     change STRUCTURE — they add cards (upload), add versions (send V2), and DELETE cards. A
     server-wins-on-structure merge would silently undo those. So staff writes do a real 3-way
     merge with a common ancestor (`baseItems` = the server state we last saw), the same shape as
     the dashboard scope's merge in supabase-sync.js:
       • cards keyed by d.id, versions by v.vid, pins by p.id — adds and deletes are detected per
         side against the base, so a staff delete sticks and a remote V2 survives;
       • fields: if I changed it since base → mine wins, else theirs. A genuine same-field clash
         resolves to THEIRS for client-owned review fields — losing a client's review is
         catastrophic, losing a re-typed label is trivial.
     With no base yet (page just opened, nothing pulled) we fall back to CONSERVATIVE mode:
     union everything, honor no deletions, never drop a review. */
  const CLIENT_OWNED = ["reviews", "status", "reviewedAt", "reviewedStatus", "clientNotes",
    "signature", "signedBy", "signedDate", "annotation"];
  // jsonb does NOT preserve object key order, so a plain JSON.stringify reports false changes on
  // anything round-tripped through the server. Sort keys before comparing. (Same trap that made
  // plan-refresh rewrite every run — see supabase-sync.js stableStr.)
  function stableStr(v) {
    const walk = (x) => {
      if (x === null || typeof x !== "object") return x;
      if (Array.isArray(x)) return x.map(walk);
      return Object.keys(x).sort().reduce((o, k) => { o[k] = walk(x[k]); return o; }, {});
    };
    try { return JSON.stringify(walk(v)); } catch (e) { return String(v); }
  }
  const same = (a, b) => stableStr(a) === stableStr(b);
  const cloneJ = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  let baseItems = null;                                  // server state we last saw (merge ancestor)
  const setBase = (v) => { baseItems = cloneJ(v) || null; };

  // Merge one keyed collection (cards / versions / pins), honoring adds + deletes on both sides.
  function mergeById(base, mine, theirs, key, mergeOne) {
    const idx = (arr) => new Map((arr || []).map(x => [x[key], x]));
    const B = idx(base), M = idx(mine), T = idx(theirs);
    const out = [];
    const seen = new Set();
    // Walk THEIRS first so remote ordering is the spine, then append anything I added.
    (theirs || []).forEach(t => {
      const id = t[key]; seen.add(id);
      if (B.has(id) && !M.has(id)) return;               // I deleted it → stays deleted
      const m = M.get(id);
      out.push(m ? mergeOne(B.get(id), m, t) : t);
    });
    (mine || []).forEach(m => {
      const id = m[key];
      if (seen.has(id)) return;
      if (B.has(id)) return;                             // they deleted it → respect that
      out.push(m);                                       // I added it → keep
    });
    return out;
  }
  function mergeVersion(base, mine, theirs) {
    const b = base || {}, out = Object.assign({}, theirs);
    const keys = new Set([...Object.keys(mine || {}), ...Object.keys(theirs || {})]);
    keys.forEach(k => {
      if (k === "pins" || k === "reviews") return;       // handled below
      const iChanged = !same(mine[k], b[k]);
      const theyChanged = !same(theirs[k], b[k]);
      if (iChanged && theyChanged) { if (!CLIENT_OWNED.includes(k)) out[k] = mine[k]; return; }
      if (iChanged) out[k] = mine[k];
    });
    // reviews: an email-keyed map, each entry written only by its owner → union, server wins ties
    out.reviews = Object.assign({}, mine.reviews, theirs.reviews);
    if (!Object.keys(out.reviews).length) delete out.reviews;
    out.pins = mergeById(b.pins, mine.pins, theirs.pins, "id",
      (pb, pm, pt) => (same(pm, pb) ? pt : pm));
    // PAGES: a whole-array win would throw away one side's markup, so merge each page's pins
    // (id-keyed 3-way) and take a changed drawing from whoever changed it.
    const bp = pagesOf(b), mp = pagesOf(mine), tp = pagesOf(theirs);
    if (mp && tp) {
      out.pages = tp.map((tpg, i) => {
        const mpg = mp[i]; if (!mpg) return tpg;
        const bpg = (bp && bp[i]) || {};
        const merged = Object.assign({}, tpg);
        merged.pins = mergeById(bpg.pins, mpg.pins, tpg.pins, "id", (pb, pm2, pt) => (same(pm2, pb) ? pt : pm2));
        if (!same(mpg.annotation, bpg.annotation)) merged.annotation = mpg.annotation;
        return merged;
      });
    }
    return out;
  }
  function mergeCard(base, mine, theirs) {
    const b = base || {}, out = Object.assign({}, theirs);
    Object.keys(mine || {}).forEach(k => {
      if (k === "versions") return;
      if (!same(mine[k], b[k]) && same(theirs[k], b[k])) out[k] = mine[k];   // only I changed it
      else if (!same(mine[k], b[k]) && !same(theirs[k], b[k])) out[k] = mine[k];  // clash → staff field
    });
    out.versions = mergeById(b.versions, mine.versions, theirs.versions, "vid", mergeVersion);
    return out;
  }
  function mergeStaff(base, mine, theirs) {
    if (!base) {
      // CONSERVATIVE: no ancestor, so we cannot tell a delete from a never-seen item. Union by
      // id and keep every review — better to resurrect one card than to lose a client's work.
      const T = new Map((theirs || []).map(d => [d.id, d]));
      const out = (theirs || []).map(t => {
        const m = (mine || []).find(x => x.id === t.id);
        return m ? mergeCard(t, m, t) : t;               // base:=theirs → mine wins only where it differs
      });
      (mine || []).forEach(m => { if (!T.has(m.id)) out.push(m); });
      return out;
    }
    return mergeById(base, mine, theirs, "id", mergeCard);
  }
  // Pull fresh → merge → push. Used for every staff write to the deliverables scope.
  async function staffMergedPush() {
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pushScopeNow)) return { ok: false };
    let merged = items;
    try {
      const fresh = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      if (Array.isArray(fresh)) {
        merged = mergeStaff(baseItems, items, fresh);
        items = merged;
        try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
      }
    } catch (e) { /* pull failed — push what we have rather than lose the edit */ }
    guardLive();
    let r = { ok: false };
    try { r = await window.SUPA.pushScopeNow(sess.client, "deliverables", items); } catch (e) {}
    if (r && r.ok) setBase(items);                       // this is now the known server state
    return r;
  }
  let staffPushTimer = null;
  function scheduleStaffMergedPush() {
    clearTimeout(staffPushTimer);
    staffPushTimer = setTimeout(() => { staffMergedPush().then(() => renderGallery()); }, 900);
  }

  let clientPushTimer = null;
  function scheduleClientMergedPush() {
    clearTimeout(clientPushTimer);
    clientPushTimer = setTimeout(mergedClientPush, 900);   // coalesce typing bursts
  }
  async function mergedClientPush() {
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pushScopeNow)) return;
    try {
      const fresh = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      if (Array.isArray(fresh) && fresh.length) {
        items = mergeMineInto(fresh, items);
        try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
      }
    } catch (e) { /* pull failed — push local (previous behavior) rather than lose the edit */ }
    guardLive();
    try { await window.SUPA.pushScopeNow(sess.client, "deliverables", items); } catch (e) {}
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
  // Live-refresh suppression window: for a few seconds after a local mutation (delete, send,
  // stage a version), don't let liveRefresh re-pull — otherwise a pull that lands before our
  // write does re-adds what we just removed (the "it deletes, pops back, then deletes" bug).
  let suppressLiveUntil = 0;
  const guardLive = () => { suppressLiveUntil = nowMs() + 4000; };
  function nowMs() { try { return Date.now(); } catch (e) { return 0; } }
  // Immediate (awaited) writes — used for mutations that must hit the server before any pull,
  // so the change can't bounce back. Fall back to the debounced save if pushScopeNow is absent.
  // Awaited immediate write (delete, send, waive — anything whose ordering matters). Goes through
  // the SAME 3-way merge as the debounced path, so an ordered write can't clobber either.
  async function saveNow() {
    guardLive();
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    if (!(window.SUPA && window.SUPA.enabled) || (typeof isCreative === "function" && isCreative())) return { ok: true };
    clearTimeout(staffPushTimer);                        // fold any queued debounce into this write
    return await staffMergedPush();
  }
  async function saveDraftsNow() {
    guardLive();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {}
    if (window.SUPA && window.SUPA.enabled) {
      if (window.SUPA.pushScopeNow) { try { await window.SUPA.pushScopeNow(sess.client, "deliverables_draft", draftItems); return; } catch (e) {} }
      window.SUPA.pushScope(sess.client, "deliverables_draft", draftItems);
    }
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
  /* A stored Drive file is served by the authenticated proxy, which <img src> can't call (no
     Authorization header). So gallery markup emits data-tja-src and TJA_FILES.hydrate() swaps in
     a blob: URL after render. Inline dataUrls still go straight into src. */
  function imgSrcAttr(v) {
    const u = (v && (v.url || v.dataUrl)) || "";
    const proxied = window.TJA_FILES && window.TJA_FILES.isProxy && window.TJA_FILES.isProxy(u);
    return proxied ? `data-tja-src="${esc(u)}"` : `src="${esc(u)}"`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const uid = () => "d_" + Date.now() + "_" + (seq++);
  const deliv = (id) => items.find(d => d.id === id) || draftItems.find(d => d.id === id);
  const isDraft = (d) => !!(d && d.versions && d.versions.some(v => v.state === "pending_approval"));
  // A generated Brand Keywords deliverable (kind:"keywords"). Its artwork is rendered from
  // v.keywords, so a new round edits words rather than asking for a file.
  const isKeywordDoc = (d) => !!(d && (d.kind === "keywords" || (d.versions || []).some(v => v && v.keywords)));
  // Modal edits (pins, notes, annotations, rename) hit whichever store the OPEN item
  // lives in — a draft being marked up before release must persist to the draft scope.
  function saveCur() { if (isDraft(deliv(curId))) saveDrafts(); else save(); }
  const active = (d) => d && d.versions[d.active];
  /* ---------- multi-page surfaces (PDF proofs) ----------
     A version normally has ONE markup surface: its image, v.pins and v.annotation. A multi-page
     PDF instead carries v.pages = [{url|dataUrl, pins, annotation}] and every markup function
     goes through surface() rather than touching the version directly. A version with no pages
     array returns the version itself, so single images and every deliverable created before this
     existed behave exactly as before — no migration. */
  let curPage = 0;
  const pagesOf = (v) => (v && Array.isArray(v.pages) && v.pages.length) ? v.pages : null;
  function surface(v) {
    const ps = pagesOf(v);
    if (!ps) return v || {};
    const pg = ps[Math.min(Math.max(0, curPage), ps.length - 1)] || {};
    if (!Array.isArray(pg.pins)) pg.pins = [];      // lazily normalise so callers can push
    return pg;
  }
  const curSurface = () => surface(active(deliv(curId)));
  const srcOf = (o) => (o && (o.url || o.dataUrl)) || "";
  // Pins ACROSS every page — the comment count in notifications/PDF must not be page-1 only.
  function allPins(v) {
    const ps = pagesOf(v);
    if (!ps) return (v && v.pins) || [];
    return ps.reduce((acc, pg) => acc.concat((pg && pg.pins) || []), []);
  }
  const $ = (id) => document.getElementById(id);

  /* ---------- multi-reviewer support ----------
     A version sent while the client has MULTIPLE logins carries:
       v.expectedReviewers = [emails]   — stamped at send time (the client-role logins then;
                                          a login invited mid-round isn't retroactively required)
       v.reviews = { email: {name, email, status, notes, reviewedAt} } — each person's review
     The round is COMPLETE (v.reviewedAt stamped, card settles, next round unblocks, the team
     gets its ONE Slack/email ping) only when every expected reviewer has submitted. The shared
     v.status always holds the WORST-WINS aggregate (revisions > changes > approved) so the
     badge/PDF read correctly mid-round. Versions without expectedReviewers behave exactly as
     before — first review completes them — so nothing old changes behavior. Only ONE signature
     is required per round (Cameron 2026-07-28): the first approver signs, teammates just submit. */
  const myEmail = () => String(sess.email || "").toLowerCase();
  const myName = () => sess.name || sess.email || "Client";
  const reviewsOf = (v) => (v && v.reviews) || {};
  const expectedOf = (v) => (v && Array.isArray(v.expectedReviewers))
    ? v.expectedReviewers.map(e => String(e).toLowerCase()) : [];
  const myReviewOf = (v) => reviewsOf(v)[myEmail()] || null;
  function reviewComplete(v) {
    const exp = expectedOf(v);
    if (exp.length) return exp.every(e => !!reviewsOf(v)[e]);
    return !!(v && v.reviewedAt);
  }
  function aggregateStatus(v) {
    const st = Object.values(reviewsOf(v)).map(r => r.status).filter(Boolean);
    if (!st.length) return (v && v.status) || null;
    if (st.indexOf("revisions") > -1) return "revisions";
    if (st.indexOf("changes") > -1) return "changes";
    return "approved";
  }
  // My not-yet-submitted verdict per version (vid-keyed). Deliberately NOT persisted/synced —
  // in multi-reviewer mode a selection only becomes shared state on Submit, so teammates
  // browsing the same proof don't see each other's half-made choices.
  const pendingSel = {};

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
      <input type="file" id="pdFile" accept="image/*,application/pdf,.pdf" multiple hidden>
      <input type="file" id="pdVerFile" accept="image/*,application/pdf,.pdf" hidden>
      <!-- Keyword exercise: a deliverable built from DATA, not an uploaded file. The three
           columns are painted onto the agency's Brand Keywords slide (keyword-slide.js) and the
           resulting image IS the proof — so review, markup, approval + the proof PDF all work
           exactly as they do for an uploaded creative. -->
      <button class="btn btn-upload btn-kw${(typeof canUploadDocs === "function" && canUploadDocs()) ? "" : " admin-only"}" id="pdKwBtn" title="Build a Brand Keywords deliverable from the three keyword lists">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M4 5h16M4 12h10M4 19h7"/></svg>
        Keyword exercise
      </button>
      <span class="pd-hint">${(typeof isCreative === "function" && isCreative())
        ? "PNG / JPG / PDF · your upload goes to the account manager for release — the client sees it after they hit Send"
        : "PNG / JPG / PDF · logos, banners, ad sets, messaging — anything you design"}</span>
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
              <!-- page nav for multi-page PDFs: overlaid on the image so it costs no vertical
                   space (the strip below made the toolbar cramped — Cameron 2026-07-31) -->
              <button class="pd-page-arrow prev" id="pdPagePrev" style="display:none" title="Previous page (←)">‹</button>
              <button class="pd-page-arrow next" id="pdPageNext" style="display:none" title="Next page (→)">›</button>
              <div class="pd-page-badge" id="pdPageBadge" style="display:none"></div>
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

            <div class="pd-specs-line" id="pdSpecsLine" style="display:none"></div>

            <div class="pd-review-label" id="pdStatusLabel">Status</div>
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

            <div class="pd-review-foot">
              <div class="pd-sign-status" id="pdSignStatus"></div>
              <button class="pd-tool-btn pd-export-btn staff-only" id="pdExport" title="Internal proof PDF for your records — the client reviews in-portal">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12M7 11l5 5 5-5"/><path d="M5 20h14"/></svg>
                Export PDF
              </button>
              <div class="pd-meta-line" id="pdMeta"></div>
            </div>
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

    <!-- Work-in-progress veil. Rendering + uploading a multi-page PDF takes seconds, and it used
         to happen with NO feedback at all before the brief dialog opened, so people assumed the
         upload had failed and clicked again (Cameron 2026-07-31). -->
    <div class="pd-busy" id="pdBusy" style="display:none">
      <div class="pd-busy-card">
        <div class="pd-spinner" aria-hidden="true"></div>
        <div class="pd-busy-msg" id="pdBusyMsg">Working…</div>
        <div class="pd-busy-sub" id="pdBusySub"></div>
      </div>
    </div>

    <!-- Keyword-exercise builder. Sibling of #pdModal for the same reason as the brief dialog. -->
    <div class="pd-up-overlay" id="pdKwOverlay" style="display:none">
      <div class="pd-up-card pd-kw-card">
        <div class="pd-sign-title" id="pdKwTitle">Brand Keywords</div>
        <div class="pd-sign-sub">Type the keywords for each column — one per line. They're set onto the Brand Keywords slide, which becomes the proof the client reviews and signs.</div>
        <!-- Column order is LOOK → TONE → AUDIENCE, matching the template artwork exactly. -->
        <div class="pd-kw-cols">
          <label class="pd-kw-col"><span class="pd-review-label">LOOK <span class="pd-kw-n" id="pdKwLookN"></span></span>
            <textarea id="pdKwLook" class="pd-kw-ta" placeholder="Tasteful&#10;Fresh&#10;Bold"></textarea></label>
          <label class="pd-kw-col"><span class="pd-review-label">TONE <span class="pd-kw-n" id="pdKwToneN"></span></span>
            <textarea id="pdKwTone" class="pd-kw-ta" placeholder="Playful&#10;Punchy&#10;Memorable"></textarea></label>
          <label class="pd-kw-col"><span class="pd-review-label">AUDIENCE <span class="pd-kw-n" id="pdKwAudN"></span></span>
            <textarea id="pdKwAud" class="pd-kw-ta" placeholder="Foodie&#10;Adventurous&#10;Trendy"></textarea></label>
        </div>
        <div class="pd-kw-hint">Type or paste one keyword per line — pasted lists (commas, bullets, numbering, spreadsheet columns) are cleaned up automatically.</div>
        <div class="pd-kw-preview" id="pdKwPreview"><span class="pd-kw-phint">A live preview appears here</span></div>
        <label class="pd-review-label" for="pdKwSubject">Subject <span class="pd-up-hint">— required</span></label>
        <input type="text" id="pdKwSubject" class="pd-up-subject" placeholder="e.g. Brand Keywords — round 1">
        <label class="pd-review-label" for="pdKwMsg">Message to client <span class="pd-up-hint">— optional</span></label>
        <textarea id="pdKwMsg" class="pd-up-msg" placeholder="Context for this round — what you'd like feedback on…"></textarea>
        <div class="pd-revdue-row">
          <label class="pd-review-label" for="pdKwDue">Feedback due <span class="pd-up-hint" id="pdKwDueHint"></span></label>
          <input type="date" id="pdKwDue" class="pd-revdue">
        </div>
        <div class="pd-up-err" id="pdKwErr" style="display:none"></div>
        <div class="pd-sign-actions">
          <button class="pd-tool-btn" id="pdKwCancel">Cancel</button>
          <button class="btn btn-primary" id="pdKwSend">📤 Send to client</button>
        </div>
      </div>
    </div>

    <!-- Upload brief — a SIBLING of #pdModal, never a child: the modal is display:none until a
         deliverable is opened, and this dialog is raised from the gallery, before one exists. -->
    <div class="pd-up-overlay" id="pdUpOverlay" style="display:none">
      <div class="pd-up-card">
        <div class="pd-sign-title" id="pdUpTitle">Send deliverable</div>
        <div class="pd-sign-sub" id="pdUpSub"></div>
        <label class="pd-review-label" for="pdUpSubject">Subject <span class="pd-up-hint" id="pdUpSubjectHint"></span></label>
        <input type="text" id="pdUpSubject" class="pd-up-subject" placeholder="e.g. Logo concepts — round 1">
        <label class="pd-review-label" for="pdUpMsg">Message to client <span class="pd-up-hint">— optional</span></label>
        <textarea id="pdUpMsg" class="pd-up-msg" placeholder="Context for this round — what you'd like feedback on…"></textarea>
        <label class="pd-review-label" for="pdUpSpecs">Specifications <span class="pd-up-hint" id="pdUpSpecsHint"></span></label>
        <input type="text" id="pdUpSpecs" class="pd-up-subject" placeholder='e.g. 8.5" X 11" // Print Document // CMYK // 4/4 Process Color'>
        <div class="pd-revdue-row">
          <label class="pd-review-label" for="pdUpDue">Feedback due <span class="pd-up-hint" id="pdUpDueHint"></span></label>
          <input type="date" id="pdUpDue" class="pd-revdue">
        </div>
        <div class="pd-up-err" id="pdUpErr" style="display:none"></div>
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
  // Named reviewer checklist on a gallery card (multi-reviewer versions): "✓ Phoebe · ⏳ Cam" —
  // the at-a-glance answer to "is this round ready?", for staff AND for teammates. First names
  // from the submitted review (else the email's local part). Hidden for single-reviewer cards.
  function reviewerStrip(v) {
    const exp = expectedOf(v);
    if (exp.length < 2) return "";
    const revs = reviewsOf(v);
    const nm = (e) => { const r = revs[e]; return esc((((r && r.name) || e.split("@")[0]).trim().split(/\s+/)[0]) || e); };
    const chips = exp.map(e => revs[e]
      ? `<span class="pd-rev-chip done" title="${esc(e)} — ${esc(STATUS_WORD[revs[e].status] || revs[e].status || "responded")}">✓ ${nm(e)}</span>`
      : `<span class="pd-rev-chip wait" title="${esc(e)} — hasn't reviewed yet">⏳ ${nm(e)}</span>`).join("");
    const allIn = reviewComplete(v);
    return `<div class="pd-card-reviewers${allIn ? " allin" : ""}">${chips}${allIn ? `<span class="pd-rev-chip all">All reviews in</span>` : ""}</div>`;
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
        <div class="pd-thumb"><img ${imgSrcAttr(v)} alt="${esc(d.name)}"></div>
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
        <button class="pd-card-export staff-only" data-copylink="${d.id}" title="Copy a shareable link to this deliverable">🔗</button>
        <button class="pd-card-export staff-only" data-export="${d.id}" title="Export proof PDF (internal record)" style="right:76px">⬇</button>
        <span class="pd-enlarge-cue">Click to review</span>
        <div class="pd-thumb"><img ${imgSrcAttr(v)} alt="${esc(d.name)}"></div>
        <div class="pd-card-foot">
          <div class="pd-card-name" title="${esc(d.name)}">${esc(d.name)}</div>
          <span class="pd-ver-tag">${esc(v.label)}</span>
          ${badge(v.status)}
          ${v.sentAt ? `<span class="pd-sent-pill" title="Sent to the client${v.sentBy ? " by " + esc(v.sentBy) : ""}${v.sentAt ? " · " + esc(v.sentAt) : ""}">✓ Sent to client</span>` : ""}
        </div>
        ${reviewerStrip(v)}
        ${dueLine(last)}
      </div>`;
    }).join("");
    g.innerHTML = draftCards + sentCards;   // waiting room first — it's the actionable pile
    // Proofs stored in Drive come back through the authenticated proxy, which <img src> can't
    // call — swap in blob: URLs now that the cards are in the DOM.
    if (window.TJA_FILES && window.TJA_FILES.hydrate) window.TJA_FILES.hydrate(g);
  }

  // Shareable deep link to a deliverable — same shape the email/Slack use
  // (<portal>/?open=docs&doc=<id>), resolved against the current portal URL.
  function deliverableLink(id) {
    // carries the client too, so a STAFF colleague opening the link lands on this client's
    // dashboard rather than the picker (a client login ignores the param)
    const q = "./?open=docs&doc=" + encodeURIComponent(id) + "&client=" + encodeURIComponent(sess.client);
    try { return new URL(q, location.href).href; }
    catch (e) { return location.origin + "/" + q.replace("./", ""); }
  }
  // small transient toast (shared by copy-link + version-staged confirmations)
  function flashDocsToast(msg, ms) {
    let t = document.getElementById("pdLinkToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "pdLinkToast";
      t.style.cssText = "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:12000;" +
        "background:#1c1c1c;color:#fff;font:600 .78rem Inter,sans-serif;padding:10px 16px;border-radius:9px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:80vw;text-align:center";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.display = ""; clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = "none"; }, ms || 4500);
  }
  async function copyDeliverableLink(id) {
    const url = deliverableLink(id);
    let ok = false;
    try { await navigator.clipboard.writeText(url); ok = true; } catch (e) {}
    flashDocsToast(ok ? "🔗 Deliverable link copied to clipboard" : "Couldn't copy — link: " + url, 4000);
  }

  /* ---------- image processing ---------- */
  /* ---------- work-in-progress veil ----------
     Rendering + uploading a PDF's pages takes seconds. It used to run with no feedback before the
     brief dialog appeared, which read as a failed upload. */
  function showBusy(msg, sub) {
    const b = $("pdBusy"); if (!b) return;
    if ($("pdBusyMsg")) $("pdBusyMsg").textContent = msg || "Working…";
    if ($("pdBusySub")) $("pdBusySub").textContent = sub || "";
    b.style.display = "flex";
  }
  function busySub(sub) { if ($("pdBusySub")) $("pdBusySub").textContent = sub || ""; }
  function hideBusy() { const b = $("pdBusy"); if (b) b.style.display = "none"; }

  /* ---------- PDF proofs ----------
     A PDF can't be drawn from an <img>, so pdf.js rasterises page 1 at proof resolution and the
     rest of the pipeline is unchanged. The ORIGINAL pdf is uploaded alongside it, so a
     multi-page document is never lost — the review screen links to the full file.
     NOTE (bookmarked): per-page markup for multi-page PDFs is the follow-up; today page 1 is the
     markup surface and the full document sits beside it. */
  const isPdfFile = (f) => !!f && (f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""));
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = () => {
        try {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        } catch (e) {}
        resolve(window.pdfjsLib);
      };
      s.onerror = () => reject(new Error("pdf.js failed to load"));
      document.head.appendChild(s);
    });
  }
  // Rasterise up to MAX_PDF_PAGES pages at proof resolution. 20 is Cameron's cap (2026-07-31):
  // most proofs are 1 page, some are heftier, and rendering + storing an unbounded deck would be
  // slow on upload and heavy in the export.
  const MAX_PDF_PAGES = 20;
  async function pdfPageDataUrls(file, onProgress) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    const total = doc.numPages;
    const take = Math.min(total, MAX_PDF_PAGES);
    const out = [];
    for (let n = 1; n <= take; n++) {
      if (onProgress) onProgress(n, take);
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 1600 / base.width) });
      const c = document.createElement("canvas");
      c.width = Math.round(viewport.width); c.height = Math.round(viewport.height);
      const x = c.getContext("2d");
      // White behind the page — a PDF's background is transparent and would render black.
      x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: x, viewport }).promise;
      out.push(c.toDataURL("image/jpeg", 0.9));
      c.width = c.height = 0;                       // release the bitmap; a 20-page deck adds up
    }
    return { dataUrls: out, pages: total, rendered: take };
  }

  /* Turn a PDF into a proof: page 1 becomes the markup image; the original file is uploaded too
     so the reviewer can open the whole document. Falls back to inline (like the image path) if
     storage is off or an upload fails, so a send is never blocked. */
  async function processPdf(file, opts) {
    const name = file.name.replace(/\.[^.]+$/, "");
    const { dataUrls, pages, rendered } = await pdfPageDataUrls(file,
      (n, total) => busySub(total > 1 ? `Reading page ${n} of ${total}…` : ""));
    const store = window.TJA_FILES && window.TJA_FILES.enabled();
    const multi = dataUrls.length > 1;
    /* EVERY deliverable gets its own folder inside Present Docs — not just multi-page PDFs.
       One folder now holds V1, V2, the page images, the original PDFs, the client's marked-up
       proof and the approved export, instead of those scattering across the client's Present
       Docs (Cameron 2026-07-31). A later round passes the parent's folderId so it joins V1's
       folder rather than starting a new one. */
    const subfolder = (opts && opts.subfolder) || name;
    const folderId = (opts && opts.folderId) || "";
    const built = dataUrls.map(() => ({ pins: [], annotation: null }));
    const out0 = {};                     // carries driveFolderId back out of the upload block

    if (store) {
      busySub(multi ? `Uploading ${dataUrls.length} pages…` : "");
      try {
        // batched: 6 pages per request rather than one request per page
        const res = await window.TJA_FILES.uploadDataUrls(dataUrls,
          { category: "present-docs", clientId: sess.client, name, subfolder, folderId },
          (done, total) => busySub(total > 1 ? `Uploaded ${done} of ${total} pages…` : ""));
        res.forEach((r, i) => { if (r && r.url && built[i]) built[i].url = r.url; });
        if (res[0] && res[0].folderId) out0.driveFolderId = res[0].folderId;
      } catch (e) { console.warn("pdf page upload — keeping inline", e); }
    }
    dataUrls.forEach((du, i) => { if (!built[i].url) built[i].dataUrl = du; });

    const out = Object.assign({ name, pdfPages: pages, pdfRendered: rendered }, out0);
    // Page 1 doubles as the version's own image so the gallery thumbnail and anything predating
    // pages keeps working with no special case.
    if (built[0].url) out.url = built[0].url; else out.dataUrl = built[0].dataUrl;
    if (multi) out.pages = built;
    // Keep the ORIGINAL pdf beside its pages — the reviewer can open the real document, and it
    // matters when a deck runs past the render cap.
    if (store) {
      busySub("Saving the original PDF…");
      try {
        const src = await window.TJA_FILES.upload(file, { category: "present-docs", clientId: sess.client, name: file.name, subfolder, folderId: folderId || out.driveFolderId });
        if (src && src.url) { out.sourceUrl = src.url; out.sourceName = file.name; }
        if (src && src.folderId && !out.driveFolderId) out.driveFolderId = src.folderId;
      } catch (e) { console.warn("original pdf upload failed — page images still stand", e); }
    }
    return out;
  }

  async function processFile(file, opts) {
    if (isPdfFile(file)) return await processPdf(file, opts);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = async () => {
          const max = 1600;
          let { width, height } = img;
          if (width > max) { height = Math.round(height * max / width); width = max; }
          const c = document.createElement("canvas");
          c.width = width; c.height = height;
          c.getContext("2d").drawImage(img, 0, 0, width, height);
          const dataUrl = c.toDataURL("image/jpeg", 0.85);
          const name = file.name.replace(/\.[^.]+$/, "");
          // Upload the resized proof to shared storage (keeps the DB small — no base64 blob).
          // If storage is off or the upload fails, fall back to storing it inline so uploads
          // NEVER break. Old deliverables keep their inline dataUrl (rendered via v.url||v.dataUrl).
          if (window.TJA_FILES && window.TJA_FILES.enabled()) {
            try {
              const r = await window.TJA_FILES.uploadDataUrl(dataUrl, { category: "present-docs", clientId: sess.client, name,
                subfolder: (opts && opts.subfolder) || name, folderId: (opts && opts.folderId) || "" });
              if (r && r.url) { resolve({ url: r.url, name, driveFolderId: r.folderId }); return; }
            } catch (e) { console.warn("proof upload — keeping inline", e); }
          }
          resolve({ dataUrl, name });
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
  function newVersion(img, label) {
    // `img` is the processed proof: {url} (stored in shared storage) or {dataUrl} (inline
    // fallback), or a legacy raw dataUrl string. Store whichever we have; the UI reads url||dataUrl.
    // `state` is ROUTING (pending_approval | sent; ABSENT = sent, so every pre-existing version
    // needs no migration). `status` stays the client's review verdict — never merge the two.
    const v = { label, annotation: null, pins: [], status: null, clientNotes: "", agencyNotes: "",
      uploaded: stamp(), revisionsDue: "", subject: "", message: "",
      state: "sent", vid: uid() + "_v", uploadedBy: sess.name || sess.email || "" };
    if (typeof img === "string") v.dataUrl = img;
    else if (img && img.url) v.url = img.url;
    else if (img && img.dataUrl) v.dataUrl = img.dataUrl;
    // PDF proof: keep the link to the full document + its page count alongside the page-1 image
    if (img && img.sourceUrl) { v.sourceUrl = img.sourceUrl; v.sourceName = img.sourceName || "document.pdf"; }
    if (img && img.pdfPages) v.pdfPages = img.pdfPages;
    if (img && img.pdfRendered) v.pdfRendered = img.pdfRendered;
    // per-page markup surfaces for a multi-page PDF (absent for a single image)
    if (img && Array.isArray(img.pages) && img.pages.length > 1) v.pages = img.pages;
    return v;
  }

  /* ---------- keyword exercise ----------
     A deliverable whose artwork is GENERATED from three keyword lists rather than uploaded.
     The rendered slide is stored as the version's image (so the gallery, modal, markup and proof
     PDF need no special-casing at all), and the source lists ride along in v.keywords so a later
     round can be pre-filled and re-rendered instead of retyped. Columns are fixed LOOK / TONE /
     AUDIENCE (Cameron 2026-07-30). Client-side this is an APPROVE-ONLY deliverable, identical to
     every other proof. */
  /* Parse one column's textarea into keywords. Deliberately forgiving about PASTE: the team
     copies these lists out of Docs / Word / Slides / a spreadsheet, so accept newlines, tabs,
     semicolons AND commas as separators, and strip bullet glyphs or "1." numbering that come
     along for the ride. Keywords are single words or short phrases in the template, so treating
     a comma as a separator is the right trade-off for paste-ability. */
  function kwLines(id) {
    const raw = $(id) ? $(id).value : "";
    return raw
      .split(/[\n\r\t;,]+/)
      .map(s => s.replace(/^\s*(?:[-–—•*·▪]|\d+[.)])\s*/, "").trim())
      .filter(Boolean);
  }
  // live "n / max" per column so the cap is visible before it bites
  function kwCounts() {
    const cap = (window.TJA_KEYWORD_SLIDE && window.TJA_KEYWORD_SLIDE.MAX_ITEMS) || 7;
    [["pdKwLook", "pdKwLookN"], ["pdKwTone", "pdKwToneN"], ["pdKwAud", "pdKwAudN"]].forEach(([ta, out]) => {
      const el = $(out); if (!el) return;
      const n = kwLines(ta).length;
      el.textContent = n ? `${n} / ${cap}` : "";
      el.classList.toggle("over", n > cap);
    });
  }
  const kwData = () => ({ look: kwLines("pdKwLook"), tone: kwLines("pdKwTone"), audience: kwLines("pdKwAud") });
  let kwEditParentId = null;      // set when building a NEW ROUND of an existing keyword deliverable
  let kwPreviewTimer = null;

  function openKeywordDialog(parent) {
    const ov = $("pdKwOverlay"); if (!ov || !window.TJA_KEYWORD_SLIDE) return;
    kwEditParentId = parent ? parent.id : null;
    // A new round starts from the CURRENT round's words — nobody should retype a list to change
    // two of them.
    const prev = parent ? (active(parent) || {}).keywords : null;
    $("pdKwLook").value = (prev && prev.look || []).join("\n");
    $("pdKwTone").value = (prev && prev.tone || []).join("\n");
    $("pdKwAud").value = (prev && prev.audience || []).join("\n");
    // Default subject: "<Client> - Selected Keywords" (Cameron 2026-07-30). A NEW ROUND keeps the
    // parent's name so V1/V2 of the same exercise stay named consistently.
    $("pdKwSubject").value = parent ? (parent.name || defaultKwSubject()) : defaultKwSubject();
    $("pdKwMsg").value = "";
    $("pdKwDue").value = "";
    if ($("pdKwErr")) $("pdKwErr").style.display = "none";
    // an AM/PM owns the client timeline → due date required, same rule as an upload
    const r = uploadRules();
    if ($("pdKwDueHint")) { $("pdKwDueHint").textContent = r.due ? "— required" : "— optional"; $("pdKwDueHint").classList.toggle("req", r.due); }
    if ($("pdKwTitle")) $("pdKwTitle").textContent = parent ? "Brand Keywords — new round" : "Brand Keywords";
    if ($("pdKwSend")) $("pdKwSend").textContent = uploadsToDraft() ? "Add to waiting room" : "📤 Send to client";
    ov.style.display = "flex";
    kwCounts(); kwPreview();
    setTimeout(() => $("pdKwLook").focus(), 0);
  }
  function closeKeywordDialog() { const ov = $("pdKwOverlay"); if (ov) ov.style.display = "none"; kwEditParentId = null; }
  // Debounced live preview so the sender sees the actual slide before it goes out.
  function kwPreview() {
    clearTimeout(kwPreviewTimer);
    kwPreviewTimer = setTimeout(async () => {
      const box = $("pdKwPreview"); if (!box || !window.TJA_KEYWORD_SLIDE) return;
      try {
        const url = await window.TJA_KEYWORD_SLIDE.render(Object.assign(kwData(), { clientName: clientDisplayName() }));
        box.innerHTML = `<img src="${url}" alt="Brand Keywords preview">`;
      } catch (e) { /* preview is a nicety — never block the send */ }
    }, 250);
  }
  function clientDisplayName() {
    try { const c = window.TJA_STORE && window.TJA_STORE.get(sess.client); return (c && c.name) || ""; } catch (e) { return ""; }
  }
  const defaultKwSubject = () => {
    const n = clientDisplayName();
    return (n ? n + " - " : "") + "Selected Keywords";
  };
  async function commitKeywords() {
    const data = kwData();
    const subject = $("pdKwSubject").value.trim();
    const due = $("pdKwDue").value;
    const message = $("pdKwMsg").value.trim();
    const err = $("pdKwErr");
    const missing = [];
    if (!data.look.length && !data.tone.length && !data.audience.length) missing.push("at least one keyword");
    if (!subject) missing.push("Subject");
    if (uploadRules().due && !due) missing.push("Feedback due");
    if (missing.length) { err.textContent = "Please add: " + missing.join(", ") + "."; err.style.display = ""; return; }
    const over = window.TJA_KEYWORD_SLIDE.MAX_ITEMS;
    if ([data.look, data.tone, data.audience].some(a => a.length > over)) {
      err.textContent = `A column can hold at most ${over} keywords — the slide would clip beyond that.`;
      err.style.display = ""; return;
    }
    const btn = $("pdKwSend"); const label = btn.textContent;
    btn.disabled = true; btn.textContent = "Building…";
    showBusy("Building the Brand Keywords slide…");
    let dataUrl = "";
    try { dataUrl = await window.TJA_KEYWORD_SLIDE.render(Object.assign({}, data, { clientName: clientDisplayName() })); }
    catch (e) { hideBusy(); btn.disabled = false; btn.textContent = label; err.textContent = "Couldn't build the slide — try again."; err.style.display = ""; return; }
    // Store the rendered slide in Drive like any other proof so it doesn't sit inline in the row
    // (~190KB each is exactly what made the deliverables pulls slow). Inline is the fallback.
    let img = { dataUrl };
    if (window.TJA_FILES && window.TJA_FILES.enabled()) {
      try {
        // a new keyword ROUND belongs in the existing deliverable's folder, not a new one
        const kwParent = kwEditParentId ? items.find(x => x.id === kwEditParentId) : null;
        const up = await window.TJA_FILES.uploadDataUrl(dataUrl, { category: "present-docs", clientId: sess.client,
          name: subject || "keywords", subfolder: (kwParent && kwParent.name) || subject || "keywords",
          folderId: (kwParent && kwParent.driveFolderId) || "" });
        if (up && up.url) img = { url: up.url, driveFolderId: up.folderId };
      } catch (e) { console.warn("keyword slide upload — keeping inline", e); }
    }
    hideBusy();
    btn.disabled = false; btn.textContent = label;

    const parent = kwEditParentId ? items.find(x => x.id === kwEditParentId) : null;
    // Re-use the SAME staging rules as an image upload: a creative's work waits in the room, an
    // admin/AM-PM's goes straight out, and a new round on a sent deliverable is always staged.
    const toDraft = uploadsToDraft() || !!parent;
    const label2 = parent ? "V" + (parent.versions.length + 1) + (toDraft ? " (proposed)" : "") : "V1";
    const v = newVersion(img, label2);
    v.keywords = data;                       // the source of truth for the next round
    v.subject = subject; v.message = message; v.revisionsDue = due;
    closeKeywordDialog();
    if (toDraft) {
      v.state = "pending_approval";
      const card = { id: uid(), name: subject, active: 0, versions: [v], kind: "keywords",
                     driveFolderId: (parent && parent.driveFolderId) || img.driveFolderId || null };
      if (parent) card.parentId = parent.id;
      draftItems.unshift(card);
      if (window.TJA_NOTIFY) { try { window.TJA_NOTIFY.record({ type: "upload", docId: card.id, docName: subject, versionLabel: v.label, by: sess.name || "Staff" }); } catch (e) {} }
      await saveDraftsNow();
      renderGallery();
      flashDocsToast(`${subject} staged — click “📤 Send to client” to submit it for review.`);
      return;
    }
    v.sentAt = stamp(); v.sentBy = sess.name || sess.email || "TJA";
    const item = { id: uid(), name: subject, active: 0, versions: [v], kind: "keywords", driveFolderId: img.driveFolderId || null };
    items.unshift(item);
    await saveNow();
    renderGallery();
    announceSend({ id: item.id, name: subject, version: v });
  }

  /* ---------- upload brief (V1) ----------
     Files are processed first, then held here until the admin writes the subject + message that
     go out with them. Cancelling drops them — nothing is added to the gallery until Send. */
  let pendingUpload = null;
  // When set, the upload brief dialog is in SEND mode for an already-staged draft/proposed
  // round (not a fresh V1 upload) — the confirm button runs commitSend() instead of
  // commitUpload(). This is what gives V2/V3 the same notes + feedback-due popup V1 gets.
  let pendingSendDraftId = null;
  async function handleNewDeliverables(fileList) {
    // Images AND PDFs. A PDF's first page is rasterised by processFile so it flows through the
    // SAME canvas pipeline as an image — markup, pins and the proof PDF need no special case.
    const files = Array.from(fileList).filter(f => f.type.startsWith("image/") || isPdfFile(f));
    if (!files.length) return;
    const processed = [];
    // veil up for the whole render+upload, so a multi-page PDF never looks like a dead click
    showBusy(files.length > 1 ? `Preparing ${files.length} files…` : "Preparing your deliverable…");
    try {
      for (let i = 0; i < files.length; i++) {
        if (files.length > 1) showBusy(`Preparing file ${i + 1} of ${files.length}…`);
        processed.push(await processFile(files[i]));
      }
    } catch (e) {
      hideBusy();
      window.TJA_UI.alert("Couldn't prepare that file — " + (e && e.message ? e.message : "please try again") + ".");
      return;
    }
    hideBusy();
    pendingUpload = processed;
    const ov = $("pdUpOverlay");
    if (!ov) { commitUpload(); return; }   // no dialog in the DOM → don't strand the files
    $("pdUpSub").textContent = processed.length === 1
      ? `${processed[0].name} · V1`
      : `${processed.length} files · V1 each`;
    // Make the confirm button say what actually happens: an AM/PM (or admin) upload goes
    // STRAIGHT to the client, so it's a send; a creative's lands in the waiting room.
    const toClient = !uploadsToDraft();
    if ($("pdUpSend")) $("pdUpSend").textContent = toClient ? "📤 Send to client" : "Add to waiting room";
    if ($("pdUpTitle")) $("pdUpTitle").textContent = toClient ? "Send to client" : "Add deliverable for approval";
    $("pdUpSubject").value = ""; $("pdUpMsg").value = ""; $("pdUpDue").value = "";
    if ($("pdUpSpecs")) $("pdUpSpecs").value = "";
    if ($("pdUpErr")) $("pdUpErr").style.display = "none";
    applyUploadRequirements();
    ov.style.display = "flex";
    setTimeout(() => $("pdUpSubject").focus(), 0);
  }
  /* Required fields differ by who's uploading (Cameron 2026-07-20):
       CREATIVE  → Subject + Specifications required; Message + Feedback-due optional
                   (they know the artwork's specs; the AM/PM sets the client deadline on release)
       AM/PM     → Subject + Feedback-due required; Message + Specifications optional
                   (they own the client timeline; may not know the print specs)
     Subject is always required; Message is always optional. */
  function uploadRules() {
    const creative = uploadsToDraft();
    return { specs: creative, due: !creative };   // subject always required; message never
  }
  function applyUploadRequirements() {
    const r = uploadRules();
    const set = (id, req) => { const el = $(id); if (el) { el.textContent = req ? "— required" : "— optional"; el.classList.toggle("req", req); } };
    set("pdUpSubjectHint", true);
    set("pdUpSpecsHint", r.specs);
    set("pdUpDueHint", r.due);
  }
  function closeUploadDialog() {
    const ov = $("pdUpOverlay"); if (ov) ov.style.display = "none";
    pendingUpload = null;
    pendingSendDraftId = null;
  }

  /* ---------- send brief (V2, V3 … — releasing a staged/proposed round) ----------
     A staged round (creative draft, or an admin/AM-PM "＋ New Version" proposal) is SENT from
     its gallery card. Instead of firing straight out with an empty subject/message and no
     feedback-due (the old behaviour — that's why V2 sends carried no deadline), we open the
     same brief dialog V1 uses, pre-filled, so the sender adds notes + a feedback-due date,
     then commitSend() writes them onto the version and completes the send. */
  function openSendDialog(draftId) {
    const d = draftItems.find(x => x.id === draftId);
    if (!d) { sendDraft(draftId); return; }                  // nothing to brief on → old direct path
    // Gate a proposed next round early (before the dialog) — same rule as sendDraft.
    const parent = d.parentId ? items.find(x => x.id === d.parentId) : null;
    if (parent && blockIfAwaitingReview(parent)) return;
    const ov = $("pdUpOverlay");
    if (!ov) { sendDraft(draftId); return; }                 // no dialog in the DOM → don't strand the send
    pendingSendDraftId = draftId;
    pendingUpload = null;
    const v = d.versions[d.versions.length - 1];
    const label = (v.label || "").replace(" (proposed)", "");
    $("pdUpSub").textContent = `${d.name} · ${label}`;
    if ($("pdUpTitle")) $("pdUpTitle").textContent = "Send to client";
    if ($("pdUpSend")) $("pdUpSend").textContent = "📤 Send to client";
    $("pdUpSubject").value = v.subject || d.name || "";
    $("pdUpMsg").value = v.message || "";
    if ($("pdUpSpecs")) $("pdUpSpecs").value = (parent && parent.specs) || d.specs || "";
    $("pdUpDue").value = v.revisionsDue || "";
    if ($("pdUpErr")) $("pdUpErr").style.display = "none";
    applyUploadRequirements();
    ov.style.display = "flex";
    setTimeout(() => $("pdUpSubject").focus(), 0);
  }
  async function commitSend() {
    const draftId = pendingSendDraftId;
    const d = draftItems.find(x => x.id === draftId);
    if (!d) { closeUploadDialog(); return; }
    const subject = $("pdUpSubject") ? $("pdUpSubject").value.trim() : "";
    const message = $("pdUpMsg") ? $("pdUpMsg").value.trim() : "";
    const due = $("pdUpDue") ? $("pdUpDue").value : "";
    const specsVal = $("pdUpSpecs") ? $("pdUpSpecs").value.trim() : "";
    if ($("pdUpErr")) {
      const r = uploadRules();
      const missing = [];
      if (!subject) missing.push("Subject");
      if (r.specs && !specsVal) missing.push("Specifications");
      if (r.due && !due) missing.push("Feedback due");
      if (missing.length) {
        const err = $("pdUpErr");
        err.textContent = "Please fill in: " + missing.join(", ") + ".";
        err.style.display = "";
        return;
      }
    }
    const v = d.versions[d.versions.length - 1];
    v.subject = subject; v.message = message; v.revisionsDue = due;
    // Specs live on the DELIVERABLE (parent for a proposed round, else the draft card itself).
    const parent = d.parentId ? items.find(x => x.id === d.parentId) : null;
    if (specsVal) { if (parent) parent.specs = specsVal; else d.specs = specsVal; }
    pendingSendDraftId = null;
    closeUploadDialog();
    await sendDraft(draftId);
  }
  // Upload routing: an admin/AM-PM upload goes STRAIGHT to the client — so it is itself
  // a send, and announces (notification + email) via announceSend. A CREATIVE'S upload
  // lands in the waiting room and stays silent to the client until an AM/PM releases it.
  const uploadsToDraft = () => (typeof isCreative === "function" && isCreative());
  function commitUpload() {
    const subject = $("pdUpSubject") ? $("pdUpSubject").value.trim() : "";
    const message = $("pdUpMsg") ? $("pdUpMsg").value.trim() : "";
    const due = $("pdUpDue") ? $("pdUpDue").value : "";
    // validate required fields (only when the dialog is actually present)
    if ($("pdUpOverlay") && $("pdUpErr")) {
      const r = uploadRules();
      const specsVal = $("pdUpSpecs") ? $("pdUpSpecs").value.trim() : "";
      const missing = [];
      if (!subject) missing.push("Subject");
      if (r.specs && !specsVal) missing.push("Specifications");
      if (r.due && !due) missing.push("Feedback due");
      if (missing.length) {
        const err = $("pdUpErr");
        err.textContent = "Please fill in: " + missing.join(", ") + ".";
        err.style.display = "";
        return;
      }
    }
    // Specifications: OPTIONAL (an AM/PM uploading may not know them — Cameron 2026-07-20).
    // Lives on the DELIVERABLE (set at V1, carried by every later version) — it describes
    // the artwork, not the round. Shown small on the review screen + in the PDF header.
    const specs = $("pdUpSpecs") ? $("pdUpSpecs").value.trim() : "";
    const toDraft = uploadsToDraft();
    const multi = (pendingUpload || []).length > 1;
    // The card is named by the SUBJECT you typed, not the raw filename — that's what the
    // client reads in the gallery. Falls back to the filename if the subject is left blank.
    // When several files share one subject, the filename is appended so the cards stay
    // tellable apart (they'd otherwise all carry the same name).
    const nameFor = (p) => !subject ? p.name : (multi ? subject + " — " + p.name : subject);
    /* The Drive folder was created at file-select time and named after the FILE — the subject
       didn't exist yet. Now it does, so rename it to match the Present Doc's title, which is
       what the folder is supposed to be called. Fire-and-forget: a rename failing must never
       block a send, and the folderId (not the name) is what later rounds aim at. */
    if (subject && window.TJA_FILES && window.TJA_FILES.renameFolder) {
      const seen = new Set();
      (pendingUpload || []).forEach(p => {
        if (!p.driveFolderId || seen.has(p.driveFolderId)) return;
        seen.add(p.driveFolderId);
        window.TJA_FILES.renameFolder(p.driveFolderId, nameFor(p), sess.client)
          .catch(e => console.warn("drive folder rename failed", e));
      });
    }
    (pendingUpload || []).forEach(p => {
      const v = newVersion(p, "V1");
      v.subject = subject; v.message = message; v.revisionsDue = due;
      const name = nameFor(p);
      if (toDraft) {
        v.state = "pending_approval";
        // record the draft CARD's id (not v.vid) — it's what openModal/openDoc resolve,
        // so a notification click can land straight on this waiting-room card.
        const draftCard = { id: uid(), name: name, active: 0, versions: [v], specs: specs, driveFolderId: p.driveFolderId || null };
        draftItems.unshift(draftCard);
        if (window.TJA_NOTIFY) {
          // admin-bell discovery of pending work (the CLIENT hears nothing until release)
          try { window.TJA_NOTIFY.record({ type: "upload", docId: draftCard.id, docName: name, versionLabel: "V1", by: sess.name || "Creative" }); } catch (e) {}
        }
      } else {
        // Straight to the client — so this IS the send, and must tell them exactly as
        // releasing a draft does. It previously did neither: an AM/PM uploading directly
        // (the common path — not everything goes via a creative) silently notified nobody.
        v.sentAt = stamp(); v.sentBy = sess.name || sess.email || "TJA";
        // capture the DELIVERABLE id (not v.vid) — it's what openModal / the email
        // deep-link (?open=docs&doc=<id>) resolve against.
        const item = { id: uid(), name: name, active: 0, versions: [v], specs: specs, driveFolderId: p.driveFolderId || null };
        items.unshift(item);
        announceSend({ id: item.id, name: name, version: v });
      }
    });
    closeUploadDialog();
    if (toDraft) saveDrafts(); else save();
    renderGallery();
  }

  /* The client-facing moment, shared by BOTH routes to the client: an admin/AM-PM
     uploading straight to them, and an AM/PM releasing a creative's draft. Anything
     that reaches the client goes through here, so the two can't drift apart. */
  function announceSend({ id, name, version }) {
    if (window.TJA_NOTIFY) {
      try {
        window.TJA_NOTIFY.record({ type: "sent", docId: id, docName: name,
          versionLabel: version.label, by: version.sentBy || sess.name || "TJA" });
      } catch (e) {}
    }
    // on the record: a named event reads better in History than a raw deliverables diff
    try {
      if (window.SUPA && window.SUPA.auditEvent)
        window.SUPA.auditEvent(sess.client, "deliverable.sent",
          `sent ${name}${version && version.label ? " " + version.label : ""} to the client`, { scope: "deliverables" });
    } catch (e) {}
    if (window.TJA_MAIL && window.TJA_MAIL.sendDeliverable) {
      try {
        window.TJA_MAIL.sendDeliverable({ clientId: sess.client, docId: id, docName: name,
          versionLabel: version.label, subject: version.subject, message: version.message,
          dueDate: version.revisionsDue }).then((res) => {
          // Stamp WHO must review this round — the client-role logins at send time (returned
          // by send-deliverable-email regardless of whether the email itself went out). This
          // switches the version to multi-reviewer tracking: complete only when everyone's in.
          // No list back (offline, email disabled, old function) → legacy single-review behavior.
          if (res && Array.isArray(res.reviewers) && res.reviewers.length) {
            version.expectedReviewers = res.reviewers.map(e => String(e).toLowerCase());
            version.reviews = version.reviews || {};
            save(); renderGallery();
          }
        }).catch(() => {});
      } catch (e) { console.warn("deliverable email failed", e); }
    }
  }
  // Is there already a proposed next round staged (waiting to be sent) for this deliverable?
  function proposalPendingFor(d) { return d ? draftItems.find(x => x.parentId === d.id) : null; }
  // Gate a NEW round on an already-sent deliverable: can't stage/send another while one is
  // already staged, and can't start one until the client has reviewed the current sent round.
  function blockNewRound(d) {
    const pending = proposalPendingFor(d);
    if (pending) {
      const pv = pending.versions[pending.versions.length - 1] || {};
      if (window.TJA_UI) window.TJA_UI.alert(
        `${(pv.label || "A new version").replace(" (proposed)", "")} is already staged and waiting to be sent. Send it to the client (or remove it) before adding another round.`,
        { title: "A round is already staged" });
      return true;
    }
    return blockIfAwaitingReview(d);
  }
  async function handleResubmit(file) {
    const d = deliv(curId); if (!d || !file) return;
    // A new round on an already-sent deliverable is gated FIRST (before we even process the
    // file): one round at a time, and not until the client has reviewed the current one.
    if (!isDraft(d) && blockNewRound(d)) return;
    persistCanvas();
    showBusy("Preparing the new version…");
    let p;
    // V2 must land in V1's folder, not a new one named after the new file — that was why the
    // resubmitted file went missing from the deliverable's folder (Cameron 2026-07-31).
    try { p = await processFile(file, { folderId: d.driveFolderId || "", subfolder: d.name || "" }); }
    catch (e) { hideBusy(); window.TJA_UI.alert("Couldn't prepare that file — please try again."); return; }
    hideBusy();
    if (!isDraft(d)) {
      // ALREADY-SENT deliverable → the new round is STAGED in the waiting room as a proposed
      // version that must be explicitly SENT ("Send to client"). This is now the flow for ALL
      // staff (was creative-only) so a version never silently auto-sends — the review button
      // always appears, and the next round is gated on this one. Send merges it onto the
      // parent + recomputes the V-label then.
      const v = newVersion(p, "V" + (d.versions.length + 1) + " (proposed)");
      v.state = "pending_approval";
      const proposedCard = { id: uid(), name: d.name, active: 0, versions: [v], parentId: d.id,
                             driveFolderId: d.driveFolderId || p.driveFolderId || null };
      draftItems.unshift(proposedCard);
      if (window.TJA_NOTIFY) { try { window.TJA_NOTIFY.record({ type: "upload", docId: proposedCard.id, docName: d.name, versionLabel: v.label, by: sess.name || "Staff" }); } catch (e) {} }
      await saveDraftsNow();
      closeModal();                 // drop back to the gallery so the staged card + Send button are front-and-centre
      flashDocsToast(`${v.label.replace(" (proposed)", "")} staged — click “📤 Send to client” to submit it for review.`);
      return;
    }
    // Adding a round to a not-yet-sent DRAFT deliverable → stays a draft (extra pre-send round).
    const v = newVersion(p, "V" + (d.versions.length + 1));
    v.state = "pending_approval";
    if (!d.driveFolderId && p.driveFolderId) d.driveFolderId = p.driveFolderId;
    d.versions.push(v);
    d.active = d.versions.length - 1;
    await saveDraftsNow();
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
    // Releasing a proposed next round onto a parent whose current version the client
    // hasn't reviewed yet — hold it until they respond.
    if (parent && blockIfAwaitingReview(parent)) return;
    if (parent) {
      const v = draft.versions[draft.versions.length - 1];
      v.state = "sent"; v.sentAt = sentStamp; v.sentBy = sentBy;
      v.label = "V" + (parent.versions.length + 1);   // recompute — parent may have grown
      // carry the Drive folder up: everything for this deliverable lives in ONE folder
      if (!parent.driveFolderId && draft.driveFolderId) parent.driveFolderId = draft.driveFolderId;
      parent.versions.push(v);
      parent.active = parent.versions.length - 1;
      revert = () => { parent.versions.pop(); parent.active = Math.min(parent.active, parent.versions.length - 1); v.state = "pending_approval"; };
    } else {
      draft.versions.forEach(v => { v.state = "sent"; v.sentAt = sentStamp; v.sentBy = sentBy; });
      items.unshift(draft);
      revert = () => { items.shift(); draft.versions.forEach(v => { v.state = "pending_approval"; }); };
    }
    // 1. the client-visible write — this is the one that must not fail silently. Merged, not
    // blind: releasing a draft must not revert a review a client filed while it sat staged.
    guardLive();
    if (window.SUPA && window.SUPA.enabled) {
      const r = await staffMergedPush();
      if (!r.ok) {
        revert();
        window.TJA_UI.alert("Send failed (" + (r.error || "network") + ") — the deliverable is still in the waiting room.");
        renderGallery();
        return;
      }
    }
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    // 2. drop the draft (failure here is safe — dedupeDrafts self-heals on next load)
    draftItems.splice(idx, 1);
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {}
    if (window.SUPA && window.SUPA.enabled) await window.SUPA.pushScopeNow(sess.client, "deliverables_draft", draftItems);
    // 3. tell the client — the same announcement a direct upload makes
    const sentV = parent ? parent.versions[parent.versions.length - 1] : draft.versions[draft.versions.length - 1];
    const sentName = parent ? parent.name : draft.name;
    announceSend({ id: (parent || draft).id, name: sentName, version: sentV });
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
    surface(active(d)).annotation = isBlank(cv) ? null : cv.toDataURL("image/png");
  }
  function isBlank(c) {
    const b = document.createElement("canvas"); b.width = c.width; b.height = c.height;
    return c.toDataURL() === b.toDataURL();
  }

  /* ---------- pins ---------- */
  function renderPins() {
    const v = curSurface(); const layer = $("pdPins");
    layer.innerHTML = v.pins.map((p, i) =>
      `<button class="pd-pin ${p.resolved ? "resolved" : ""}" data-pin="${p.id}" style="left:${p.x * 100}%;top:${p.y * 100}%">${i + 1}</button>`).join("");
  }
  function renderPinList() {
    const v = curSurface(); const box = $("pdPinList");
    const n = v.pins.length;
    const cc = $("pdCommentsCount"); if (cc) cc.textContent = n ? `Comments (${n})` : "Comments";
    const clr = $("pdClearComments"); if (clr) clr.style.display = n ? "" : "none";
    if (!n) { box.innerHTML = `<div class="pd-pinlist-empty">Switch to the Comment tool and click the image to pin a note.</div>`; return; }
    box.innerHTML = v.pins.map((p, i) => `
      <div class="pd-comment ${p.resolved ? "resolved" : ""}" data-row="${p.id}">
        <div class="pd-comment-top">
          <span class="pd-pinnum">${i + 1}</span>
          ${p.by ? `<span class="pd-pin-by" title="${esc(p.byEmail || "")}">${esc(p.by)}</span>` : ""}
          <div class="pd-comment-actions">
            <button class="pd-cbtn ok" data-resolve="${p.id}" title="${p.resolved ? "Reopen" : "Mark resolved"}">${p.resolved ? "↩" : "✓"}</button>
            <button class="pd-cbtn danger" data-pindel="${p.id}" title="Delete">✕</button>
          </div>
        </div>
        <textarea data-pintext="${p.id}" placeholder="Add a note for pin ${i + 1}…">${esc(p.text)}</textarea>
      </div>`).join("");
  }
  function addPin(xFrac, yFrac) {
    const v = curSurface();
    // author-stamped so a multi-login client's comments are tellable apart
    const p = { id: "p_" + Date.now() + "_" + (seq++), x: xFrac, y: yFrac, text: "", resolved: false,
      by: myName(), byEmail: myEmail() };
    v.pins.push(p);
    history.push({ type: "pinAdd", id: p.id });
    saveCur(); renderPins(); renderPinList();
    const ta = document.querySelector(`[data-pintext="${p.id}"]`);
    if (ta) ta.focus();
  }
  function deletePin(id) {
    const v = curSurface();
    const index = v.pins.findIndex(x => x.id === id);
    if (index < 0) return;
    const [pin] = v.pins.splice(index, 1);
    history.push({ type: "pinDel", pin, index });
    const pop = $("pdPopup"); if (pop && pop.dataset.pin === id) hidePopup();
    saveCur(); renderPins(); renderPinList();
  }
  function clearComments() {
    const v = curSurface(); if (!v.pins.length) return;
    history.push({ type: "pinClear", pins: v.pins.slice() });
    v.pins = [];
    hidePopup(); saveCur(); renderPins(); renderPinList();
  }
  function toggleResolve(id) {
    const v = curSurface(); const p = v.pins.find(x => x.id === id); if (!p) return;
    p.resolved = !p.resolved; saveCur(); renderPins(); renderPinList();
  }
  function selectPin(id) {
    document.querySelectorAll(".pd-pin").forEach(m => m.classList.toggle("sel", m.dataset.pin === id));
    document.querySelectorAll(".pd-comment").forEach(c => c.classList.toggle("sel", c.dataset.row === id));
    const m = document.querySelector(`.pd-pin[data-pin="${id}"]`);
    if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 700); }
    const v = curSurface(); const p = v && v.pins.find(x => x.id === id);
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
      const v = curSurface();
      v.pins = v.pins.filter(p => p.id !== a.id);
      saveCur(); renderPins(); renderPinList();
    } else if (a.type === "pinDel") {
      const v = curSurface();
      v.pins.splice(Math.min(a.index, v.pins.length), 0, a.pin);
      saveCur(); renderPins(); renderPinList();
    } else if (a.type === "pinClear") {
      const v = curSurface();
      v.pins = a.pins;
      saveCur(); renderPins(); renderPinList();
    }
  }

  /* ---------- pages (multi-page PDF proofs) ----------
     Same interaction as the version chips, one level down. Hidden entirely for single-surface
     deliverables, so an image proof looks exactly as it always has. */
  function renderPages() {
    const prev = $("pdPagePrev"), next = $("pdPageNext"), badge = $("pdPageBadge");
    if (!prev || !next || !badge) return;
    const v = active(deliv(curId));
    const ps = pagesOf(v);
    if (!ps || ps.length < 2) {                       // single surface: no page chrome at all
      prev.style.display = next.style.display = badge.style.display = "none";
      return;
    }
    const idx = Math.min(curPage, ps.length - 1);
    const marked = (pg) => !!((pg.pins && pg.pins.length) || pg.annotation);
    prev.style.display = next.style.display = "";
    prev.disabled = idx === 0;
    next.disabled = idx === ps.length - 1;
    // Compact readout: "3 / 5", plus a dot per page so it's still obvious which pages already
    // carry markup — the chunky numbered chips are gone but that information isn't.
    badge.innerHTML = `<span class="pd-page-num">${idx + 1} / ${ps.length}</span>` +
      `<span class="pd-page-dots">` +
      ps.map((pg, i) => `<button class="pd-page-dot ${i === idx ? "active" : ""}${marked(pg) ? " marked" : ""}" ` +
        `data-page="${i}" title="Page ${i + 1}${marked(pg) ? " — has markup" : ""}"></button>`).join("") +
      `</span>`;
    badge.style.display = "";
  }
  function switchPage(i) {
    const v = active(deliv(curId)); const ps = pagesOf(v); if (!ps) return;
    const next = Math.min(Math.max(0, i), ps.length - 1);
    if (next === curPage) return;
    persistCanvas(); saveCur();        // bank this page's drawing before leaving it
    curPage = next;
    loadVersionIntoModal();
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
    curPage = 0;                      // a new round starts at its first page
    loadVersionIntoModal();
    maybeShowDisclaimer();   // each version is its own proof — first view gets the disclaimer
  }

  /* ---------- modal ---------- */
  function loadVersionIntoModal() {
    const d = deliv(curId); const v = active(d);
    history = []; hidePopup(); resetZoom(); closeSignaturePad(); updateSignStatus();
    $("pdTitle").textContent = d.name;
    const _clientView = typeof effectiveRole === "function" && effectiveRole() === "client";
    // Multi-reviewer client: the notes box is MINE (my review entry), teammates' notes render
    // read-only in the peer panel below. Everyone else keeps the legacy shared field.
    $("pdClientNotes").value = (_clientView && expectedOf(v).length)
      ? ((myReviewOf(v) || {}).notes || "")
      : (v.clientNotes != null ? v.clientNotes : (v.comments || ""));   // migrate old single notes → client
    $("pdAgencyNotes").value = v.agencyNotes || "";
    $("pdRevDue").value = v.revisionsDue || "";
    // The feedback deadline is set by the AGENCY (at upload). A client sees it but must
    // not be able to change their own due date — lock the field for the client view.
    $("pdRevDue").disabled = (typeof effectiveRole === "function" && effectiveRole() === "client");
    const brief = $("pdBrief");
    if (brief) {
      brief.style.display = (v.subject || v.message) ? "" : "none";
      $("pdBriefSubject").textContent = v.subject || "";
      $("pdBriefMsg").textContent = v.message || "";
    }
    updateMeta();
    renderPeerReviews(v);
    // Which verdict lights up: my private/submitted one in multi-reviewer mode, else the shared.
    const shownStatus = (_clientView && expectedOf(v).length)
      ? (pendingSel[v.vid] != null ? pendingSel[v.vid] : ((myReviewOf(v) || {}).status || null))
      : v.status;
    document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === shownStatus));
    renderVersions();
    renderPages();
    applyReviewLock();   // lock Agency Notes for clients + freeze the rail if this version is already reviewed
    const img = $("pdImg");
    // Robust paint: wait (up to ~20 frames) until the image is decoded AND laid
    // out (clientWidth > 0) before sizing the canvas/pin overlay. Fixes markup +
    // comment pins silently failing when the modal opens or an image is cached.
    const paint = (tries) => {
      tries = tries || 0;
      if ((!img.clientWidth || !img.naturalWidth) && tries < 20) { requestAnimationFrame(() => paint(tries + 1)); return; }
      sizeOverlay();
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      drawSaved(surface(v).annotation);
      renderPins(); renderPinList();
    };
    img.onload = () => paint(0);
    if (v.url) img.crossOrigin = "anonymous";   // stored proof (cross-origin) — allow canvas use
    // resolve through the proxy when stored in Drive (blob: keeps the canvas untainted).
    // For a multi-page PDF this is the CURRENT PAGE's image, not the version's.
    (async () => {
      const sf = surface(v);
      try { img.src = await window.TJA_FILES.blobUrl(srcOf(sf)); }
      catch (e) { img.src = sf.dataUrl || ""; }
    })();
    if (img.complete && img.naturalWidth) paint(0);   // already-loaded / cached / same-src
  }
  function openModal(id) {
    const d = deliv(id); if (!d) return;
    curId = id; curPage = 0; setTool("draw");
    const m = $("pdModal");
    m.classList.add("open");
    // Creatives review nothing — their modal is look-and-annotate-your-own-draft only.
    m.classList.toggle("pd-ro", typeof isCreative === "function" && isCreative() && !isDraft(d));
    // Submitting a review (status + signature + Submit) is CLIENT-ONLY (Cameron 2026-07-20:
    // clients are the only reviewers in the portal). Staff still SEE the client's status,
    // comments, pins and notes — they just can't file a review as if they were the client.
    // Preview-as-client (effectiveRole()==="client") correctly keeps the controls for parity.
    const viewerRole = (typeof effectiveRole === "function") ? effectiveRole() : "client";
    m.classList.toggle("pd-noreview", viewerRole !== "client");
    $("pdSaved").classList.remove("show");
    loadVersionIntoModal();
    maybeShowDisclaimer();
  }

  /* Lock the review rail for the client view: Agency Notes are always read-only to the
     client, and once THIS version has been submitted the whole rail is frozen (Submit
     hidden, status/notes/markup locked) with the confirmation pinned. Re-runs on every
     version switch — each version carries its own submitted state. */
  function applyReviewLock() {
    const m = $("pdModal"); if (!m) return;
    const clientView = (typeof effectiveRole === "function") ? effectiveRole() === "client" : true;
    m.classList.toggle("pd-clientview", clientView);
    const an = $("pdAgencyNotes"); if (an) an.readOnly = clientView;      // internal TJA notes — never client-authored
    const d = deliv(curId); const v = d ? active(d) : null;
    // Locking is PER PERSON in multi-reviewer mode: MY submit freezes MY controls, teammates
    // keep reviewing. Legacy versions (no expectedReviewers) lock on the single review as before.
    const mineDone = !!(v && (expectedOf(v).length ? myReviewOf(v) : v.reviewedAt));
    const reviewed = !!(clientView && mineDone);                          // this viewer already filed their review
    m.classList.toggle("pd-reviewed", reviewed);
    const cn = $("pdClientNotes"); if (cn) cn.readOnly = reviewed;
    if (reviewed) { const rd = $("pdRevDue"); if (rd) rd.disabled = true; }
    const saved = $("pdSaved");
    if (saved) {
      if (reviewed) { saved.textContent = "✓ Review submitted — thank you"; saved.classList.add("show"); }
      else { saved.textContent = "✓ Review saved"; saved.classList.remove("show"); }
    }
  }

  // A new round must not reach the client until they've reviewed the current one. Returns
  // the blocking version (the latest ALREADY-SENT version with no client review yet) or
  // null when it's fine to add/send a new version (nothing sent yet, or it's been reviewed).
  function unreviewedSentVersion(d) {
    if (!d || !d.versions) return null;
    for (let i = d.versions.length - 1; i >= 0; i--) {
      const v = d.versions[i];
      if (v.state === "pending_approval") continue;   // still in the waiting room — hasn't reached the client
      return v.reviewedAt ? null : v;                 // the latest sent one gates the next round
    }
    return null;                                      // nothing sent yet
  }
  function blockIfAwaitingReview(d) {
    const v = unreviewedSentVersion(d);
    if (!v) return false;
    if (window.TJA_UI) window.TJA_UI.alert(
      `The client hasn't submitted their review of ${v.label} yet. You can send the next version once they've responded.`,
      { title: "Awaiting client review" });
    return true;
  }

  /* ---------- proof disclaimer (client-facing, Cameron 2026-07-20) ----------
     The template's "Mistakes Cost Money" text, shown ONCE per version the first
     time a client opens it (tracked per browser — reshowing on a new device is
     harmless and arguably right). Also re-fires on version switch, since each
     version is its own proof. */
  const DISC_SEEN_KEY = "tja_pd_disclaimer_" + ((typeof getSession === "function" && getSession() && getSession().client) || "demo");
  function maybeShowDisclaimer() {
    try {
      if (typeof effectiveRole !== "function" || effectiveRole() !== "client") return;
      const d = deliv(curId); if (!d || isDraft(d)) return;
      const v = active(d); if (!v) return;
      const key = d.id + "::" + (v.label || "");
      const seen = JSON.parse(localStorage.getItem(DISC_SEEN_KEY) || "{}");
      if (seen[key]) return;
      seen[key] = Date.now();
      localStorage.setItem(DISC_SEEN_KEY, JSON.stringify(seen));
      if (window.TJA_UI) window.TJA_UI.alert(PDF_DISCLAIMER, { title: "Before you review " + (v.label || "this proof"), okText: "Got it" });
    } catch (e) {}
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
    // Reviews are client-only — the button is hidden for staff, but guard the action too.
    if (typeof effectiveRole === "function" && effectiveRole() !== "client") return;
    const d = deliv(curId); if (!d) return;
    const av = active(d);
    const multi = !!expectedOf(av).length;
    // My verdict: private pendingSel in multi-reviewer mode, the shared field otherwise.
    const sel = multi
      ? (pendingSel[av.vid] != null ? pendingSel[av.vid] : ((myReviewOf(av) || {}).status || null))
      : av.status;
    // A review must carry a verdict — otherwise the card would sit on "Pending Review"
    // forever even though they submitted. Require one of the three responses.
    if (!sel) {
      if (window.TJA_UI) window.TJA_UI.alert(
        "Please choose a response — Approve, Approve with changes, or Revisions needed — before submitting your review.",
        { title: "Choose a response" });
      return;
    }
    if (multi) {
      // My notes live in MY review entry (written in finishSubmit) — the shared clientNotes
      // stays untouched so one teammate can't overwrite another's feedback.
    } else {
      av.clientNotes = $("pdClientNotes").value; av.agencyNotes = $("pdAgencyNotes").value;
    }
    persistCanvas();
    // an approval needs a signature — ONE per round: the first approver signs, teammates don't
    if ((sel === "approved" || sel === "changes") && !av.signature) { openSignaturePad(); return; }
    finishSubmit();
  }
  const STATUS_WORD = { approved: "Approved", changes: "Approved w/ changes", revisions: "Revisions needed" };
  /* Who's reviewed / who's outstanding — rendered under the notes for BOTH sides: teammates
     see each other's verdicts + notes; staff see exactly who they're still waiting on. Hidden
     entirely for legacy single-reviewer versions. */
  function renderPeerReviews(v) {
    let box = $("pdPeerReviews");
    if (!box) {
      const anchor = $("pdClientNotes"); if (!anchor) return;
      box = document.createElement("div"); box.id = "pdPeerReviews"; box.className = "pd-peer-reviews";
      anchor.parentNode.insertBefore(box, anchor.nextSibling);
    }
    const exp = expectedOf(v), revs = reviewsOf(v);
    if (!exp.length) { box.style.display = "none"; box.innerHTML = ""; return; }
    const me = myEmail();
    // Staff who can edit this client may WAIVE an outstanding reviewer — the escape hatch for
    // a login that was removed or is never going to respond, so a round can't stick forever.
    const canWaive = (typeof effectiveRole === "function" && effectiveRole() !== "client")
      && (typeof canEdit === "function" ? canEdit() : false);
    const rows = exp.map(e => {
      const r = revs[e];
      const who = (r && (r.name || r.email)) || e;
      const you = e === me ? " (you)" : "";
      if (!r) return `<div class="pd-peer-row waiting">⏳ <b>${esc(who)}${you}</b> — hasn't reviewed yet${canWaive ? `<button class="pd-tool-btn pd-waive" data-waive="${esc(e)}" title="Complete this round without their review">Waive</button>` : ""}</div>`;
      return `<div class="pd-peer-row done">✓ <b>${esc(who)}${you}</b> — ${esc(STATUS_WORD[r.status] || r.status || "Responded")}${r.reviewedAt ? ` · ${esc(r.reviewedAt)}` : ""}${r.notes ? `<div class="pd-peer-notes">${esc(r.notes)}</div>` : ""}</div>`;
    }).join("");
    // Optional reviewers (toggled off in the Admin Center) who reviewed anyway — their
    // feedback shows, it just never gates the round.
    const extras = Object.keys(revs).filter(e => exp.indexOf(e) === -1).map(e => {
      const r = revs[e];
      return `<div class="pd-peer-row done">✓ <b>${esc(r.name || e)}${e === me ? " (you)" : ""}</b> <em style="font-style:normal;color:var(--text-faint)">(optional)</em> — ${esc(STATUS_WORD[r.status] || r.status || "Responded")}${r.notes ? `<div class="pd-peer-notes">${esc(r.notes)}</div>` : ""}</div>`;
    }).join("");
    const done = exp.filter(e => revs[e]).length;
    box.innerHTML = `<div class="pd-review-label" style="margin-top:10px">Reviews (${done}/${exp.length} required)</div>${rows}${extras}`;
    box.style.display = "";
    if (!box._wired) {
      box._wired = true;
      box.addEventListener("click", (ev) => { const b = ev.target.closest("[data-waive]"); if (b) waiveReviewer(b.dataset.waive); });
    }
  }
  async function waiveReviewer(email) {
    const d = deliv(curId); const v = d && active(d); if (!v) return;
    if (!(typeof canEdit === "function" ? canEdit() : false)) return;
    const em = String(email || "").toLowerCase();
    const remaining = expectedOf(v).filter(x => x !== em);
    // Never waive the round into a reviewer-less pending limbo: with no reviews at all it
    // would sit "Pending" forever with nobody expected to act.
    if (!remaining.length && !Object.keys(reviewsOf(v)).length) {
      if (window.TJA_UI) window.TJA_UI.alert("At least one reviewer is required — this round has no reviews yet. Delete the version instead if it shouldn't be reviewed.", { title: "Can't waive the last reviewer" });
      return;
    }
    if (window.TJA_UI) {
      const ok = await window.TJA_UI.confirm(`Waive ${em}?\n\nThe round will complete without their review${remaining.length ? "" : " (all remaining reviews are in)"}.`, { title: "Waive reviewer", okText: "Waive" });
      if (!ok) return;
    }
    v.expectedReviewers = remaining;
    if (reviewComplete(v) || !remaining.length) {
      v.status = aggregateStatus(v);
      v.reviewedAt = v.reviewedAt || stamp();
      v.reviewedStatus = v.status || null;
    }
    try { if (window.SUPA && window.SUPA.auditEvent) window.SUPA.auditEvent(sess.client, "deliverable.reviewer_waived", `waived ${em}'s review on ${d.name}${v.label ? " " + v.label : ""}`, { scope: "deliverables" }); } catch (e) {}
    await saveNow();
    renderPeerReviews(v); updateMeta(); renderGallery();
  }
  function updateMeta() {
    const d = deliv(curId); if (!d) return; const v = active(d);
    const rev = v.reviewedAt ? ` · reviewed ${v.reviewedAt}${v.reviewedStatus ? " (" + (STATUS_WORD[v.reviewedStatus] || v.reviewedStatus) + ")" : ""}` : "";
    const exp = expectedOf(v);
    const prog = exp.length > 1 ? ` · ${exp.filter(e => reviewsOf(v)[e]).length}/${exp.length} reviews in` : "";
    $("pdMeta").textContent = `${v.label} · uploaded ${v.uploaded || "—"}${rev}${prog} · ${d.versions.length} version(s)`;
    // small specs line so the client sees the artwork's specifications at a glance
    const sl = $("pdSpecsLine");
    if (sl) { sl.style.display = d.specs ? "" : "none"; sl.textContent = d.specs ? "Specs: " + d.specs : ""; }
    // PDF proof: page 1 is what's marked up, so always offer the FULL document (and say how many
    // pages there are, otherwise a reviewer has no idea anything else exists).
    let pl = $("pdPdfLine");
    if (!pl && sl) { pl = document.createElement("div"); pl.id = "pdPdfLine"; pl.className = "pd-specs-line pd-pdf-line"; sl.parentNode.insertBefore(pl, sl.nextSibling); }
    if (pl) {
      if (v.sourceUrl) {
        const n = +v.pdfPages || 0;
        const shown = +v.pdfRendered || (pagesOf(v) || [1]).length;
        const note = (n > shown)
          ? `${n} pages — first ${shown} available to mark up`      // deck longer than the cap
          : (n > 1 ? `${n} pages — mark up any of them above` : ``);
        pl.innerHTML = `📄 <a href="#" data-openpdf="1">Open the full PDF</a>` +
          (note ? ` <span class="pd-pdf-n">${note}</span>` : ``);
        pl.style.display = "";
      } else { pl.style.display = "none"; pl.innerHTML = ""; }
    }
  }
  // In-flight guard: a double-click on Submit (the revisions path has no confirm dialog to
  // slow it down) ran the entire pipeline twice — two saves, two Slack pings, two emails for
  // the same review (seen live 2026-07-28, duplicate pings at 3:24 PM). One submit at a time.
  let submitBusy = false;
  async function finishSubmit() {
    if (submitBusy) return;
    submitBusy = true;
    try { await finishSubmitInner(); } finally { submitBusy = false; }
  }
  async function finishSubmitInner() {
    const d = deliv(curId);
    const v = active(d);
    const clientView = typeof effectiveRole === "function" && effectiveRole() === "client";
    const multi = !!(v && expectedOf(v).length);
    // The verdict being submitted: MY private selection in multi-reviewer mode, else the
    // shared field (legacy single-reviewer path — unchanged behavior).
    const sel = multi && clientView
      ? (pendingSel[v.vid] != null ? pendingSel[v.vid] : ((myReviewOf(v) || {}).status || null))
      : (v && v.status);
    // Final client-facing confirm on any APPROVAL (approved / approved w/ changes) —
    // the same "Mistakes Cost Money" terms, acknowledged at the moment of sign-off
    // (Cameron, 2026-07-20). Covers both submit paths: direct submit with an existing
    // signature, and straight out of the signature pad.
    if (v && (sel === "approved" || sel === "changes") && clientView && window.TJA_UI) {
      const ok = await window.TJA_UI.confirm(
        PDF_DISCLAIMER + "\n\nSubmit your approval?",
        { title: "Confirm approval", okText: "Submit approval" });
      if (!ok) return;
    }
    // Preview-as-client on a multi-reviewer round: record NOTHING — a staff-keyed entry in the
    // reviews map would pollute the aggregate verdict and confuse the who's-left strip.
    const realClient = !!(getSession && getSession() && getSession().role === "client");
    if (multi && clientView && !realClient) {
      flashDocsToast("Preview mode — reviews on this deliverable are only recorded from a real client login.");
      return;
    }
    // If the round was ALREADY complete before this submit (a stale tab re-submitting, or a
    // second login on a legacy single-review doc), the team was already pinged — never again.
    const wasComplete = !!(v && (multi ? reviewComplete(v) : v.reviewedAt));
    let completeNow = true;
    if (multi && clientView && v) {
      // Stamp MY review into the per-reviewer map. The shared completion fields only move
      // when EVERYONE expected has responded — one teammate can't settle a round alone.
      v.reviews = Object.assign({}, v.reviews);
      v.reviews[myEmail()] = { name: myName(), email: myEmail(), status: sel || null,
        notes: $("pdClientNotes") ? $("pdClientNotes").value : "", reviewedAt: stamp() };
      delete pendingSel[v.vid];
      v.status = aggregateStatus(v);           // worst-wins verdict for the badge/PDF
      completeNow = reviewComplete(v);
      if (completeNow) { v.reviewedAt = stamp(); v.reviewedStatus = v.status || null; }
    } else if (v) {
      v.reviewedAt = stamp(); v.reviewedStatus = v.status || null;   // stamp date+time of this review submit
    }
    // Notify the TJA team when a CLIENT submits a review (not when an admin does) — and in
    // multi-reviewer mode only when the LAST teammate lands (Cameron: one ping, not one each).
    if (v && d && getSession && getSession() && getSession().role === "client" && completeNow && !wasComplete) {
      if (window.TJA_NOTIFY) {
        window.TJA_NOTIFY.record({
          type: "review", docId: d.id, docName: d.name, versionLabel: v.label,
          status: v.status || null, comments: allPins(v).length,
          by: multi ? "All reviewers in" : (getSession().name || "Client"),
        });
      }
    }
    saveCur(); renderGallery(); updateSignStatus(); updateMeta();
    // Merge-then-flush: graft MY review (and any pins I added) onto the FRESHEST server copy
    // before pushing, so two teammates submitting near-simultaneously can't clobber each
    // other — the deliverables scope has no CAS, the last writer wins wholesale.
    if (multi && clientView && v && window.SUPA && window.SUPA.enabled && window.SUPA.pullScope) {
      try {
        const fresh = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
        if (Array.isArray(fresh) && fresh.length) {
          const fd = fresh.find(x => x.id === d.id);
          const fv = fd && (fd.versions || []).find(x => x.vid === v.vid);
          if (fv) {
            fv.reviews = Object.assign({}, fv.reviews, { [myEmail()]: v.reviews[myEmail()] });
            // carry MY pins + drawings across — per page for a multi-page proof
            mergeVersionSurfaces(v, fv, myEmail());
            if (v.signature && !fv.signature) { fv.signature = v.signature; fv.signedBy = v.signedBy; fv.signedDate = v.signedDate; }
            fv.status = aggregateStatus(fv);
            completeNow = reviewComplete(fv);
            if (completeNow) { fv.reviewedAt = fv.reviewedAt || stamp(); fv.reviewedStatus = fv.status || null; }
            items = fresh;
            try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
            renderGallery();
          }
        }
      } catch (e) { /* pull failed — push the local copy; my review still lands */ }
    }
    // Flush the review to the shared row IMMEDIATELY (not just the debounced push) so the
    // agency sees the client's revisions the moment they land — and even if the client
    // closes the tab right after submitting.
    if (window.SUPA && window.SUPA.enabled && window.SUPA.pushScopeNow && !(typeof isCreative === "function" && isCreative())) {
      // The review MUST reach the server the instant Submit is hit — NEVER deferred to when the
      // client happens to close the page. A client who submits then forgets to exit would
      // otherwise strand their feedback where the team never sees it. Await it and retry once on
      // a transient failure; the debounced push saveCur() queued above remains as a last resort.
      let flushed = false;
      for (let attempt = 0; attempt < 2 && !flushed; attempt++) {
        guardLive();
        try { const r = await window.SUPA.pushScopeNow(sess.client, "deliverables", items); flushed = !!(r && r.ok); }
        catch (e) { flushed = false; }
      }
      if (!flushed) { try { console.warn("review flush failed — debounced push still queued"); save(); } catch (e) {} }
    }
    // Confirmation now STAYS (no 5s fade) and the rail locks — the client can't silently
    // change a submitted review. applyReviewLock hides Submit, pins "Review submitted",
    // and freezes the fields for this version.
    applyReviewLock();
    // on the record — who reviewed what, with THEIR verdict (each submit is audited, even
    // though the team notification below waits for the full round)
    try {
      if (v && d && window.SUPA && window.SUPA.auditEvent) {
        const verdict = STATUS_WORD[sel || v.status] || sel || v.status || "responded";
        window.SUPA.auditEvent(sess.client, "deliverable.reviewed",
          `reviewed ${d.name}${v.label ? " " + v.label : ""} — ${verdict}`, { scope: "deliverables" });
      }
    } catch (e) {}
    // Notify the team — with the deliverable's PDF attached to the Slack post. Fires ONLY when
    // the round is COMPLETE (every expected reviewer in): one ping per round, not one per person
    // (Cameron 2026-07-28). Generated AFTER the UI locks so the client never waits on it.
    if (v && d && getSession && getSession() && getSession().role === "client" && completeNow && !wasComplete
        && window.TJA_MAIL && window.TJA_MAIL.sendReviewResponse) {
      // items may have been replaced by the merge above — resolve the CURRENT objects
      const curD = deliv(curId) || d;
      const curV = ((curD.versions || []).find(x => x.vid === v.vid)) || v;
      const vIdx = (curD.versions || []).findIndex(x => x.vid === v.vid);
      if (vIdx > -1) curD.active = vIdx;   // exportPDF renders active(d) — pin it to THIS round
      let pdfBase64 = "";
      try { pdfBase64 = await exportPDF(curD, { returnBase64: true }); } catch (e) { console.warn("proof PDF export failed", e); }
      /* ARCHIVE the reviewed proof to Drive — this single PDF is both things that were missing:
         the client's MARKED-UP submission (it carries their pins, drawings and notes) and the
         APPROVED export (it carries the signature and verdict). It lands in the deliverable's
         own folder beside V1/V2. The driveLink also rides along to Slack, so the team still
         gets the document even when the bot can't attach a file natively. */
      let pdfDriveLink = "";
      if (pdfBase64 && window.TJA_FILES && window.TJA_FILES.enabled() && window.TJA_FILES.uploadPdfBase64) {
        const verdict = (STATUS_WORD[curV.status] || curV.status || "reviewed").replace(/[^\w]+/g, "-");
        const fname = `${(curD.name || "deliverable").replace(/[^\w-]+/g, "_")}-${curV.label}-${verdict}.pdf`;
        try {
          const up = await window.TJA_FILES.uploadPdfBase64(pdfBase64, fname, {
            category: "present-docs", clientId: sess.client,
            subfolder: curD.name || "", folderId: curD.driveFolderId || "",
          });
          if (up) {
            pdfDriveLink = up.driveLink || "";
            if (!curD.driveFolderId && up.folderId) curD.driveFolderId = up.folderId;
            // remember it on the round so the team can re-open the signed copy later
            curV.reviewedPdfUrl = up.url || ""; curV.reviewedPdfLink = pdfDriveLink;
            saveCur();
          }
        } catch (e) { console.warn("reviewed-proof archive to Drive failed", e); }
      }
      const reviewerLine = expectedOf(curV).length > 1
        ? Object.values(reviewsOf(curV)).map(r => `${r.name || r.email}: ${STATUS_WORD[r.status] || r.status || "responded"}`).join(" · ")
        : "";
      try {
        window.TJA_MAIL.sendReviewResponse({
          docId: curD.id, docName: curD.name, versionLabel: curV.label,
          status: curV.status || null, comments: allPins(curV).length, reviewerLine,
          pdfBase64, pdfName: `${(curD.name || "deliverable").replace(/[^\w-]+/g, "_")}-${curV.label}.pdf`,
          pdfDriveLink,
        });
      } catch (e) { console.warn("review-response notify failed", e); }
    }
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

  /* ---------- PDF export — renders the TJA Present Template 2025 ----------
     Rebuilt (2026-07-20) to Cameron's InDesign proof template spec:
       • two page formats — vertical 612×792pt (8.5×11) and horizontal 1224×792pt
         (17×11), auto-chosen by the creative's aspect ratio;
       • the image NEVER changes aspect ratio — scaled to fit its bounding box;
       • real Inter (Regular/Bold/Black) embedded from assets/fonts;
       • header: PROOF · DATE (signature date on approved/approved-w-changes,
         else export date) · ROUND (version) · CLIENT // ARTWORK · SPECIFICATIONS
         (static line — final wording bookmarked with Cameron);
       • top-right approval box: CLIENT SIGNATURE cell (portal signature pad
         image), the three portal statuses as checkboxes, Mistakes-Cost-Money
         disclaimer;
       • comments listed below the image, numbered to match the pins;
       • overflow pages get a SLIM header (no signature/approval box);
       • footer on every page: tja mark + THE JAMES AGENCY + page number.
     Brand color #F68E21 sampled from the logo file (assets/img/tja-logo.svg —
     the designer-authored vector; the EPS's embedded 2017 preview renders a
     shifted #FF9A33 and is not trusted). Wordmark gray #666 from the lockup. */
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

  // Inter TTFs, fetched once per session only when an export actually happens
  // (~940KB total — never loaded on normal page views).
  let interFonts = null;
  async function loadInterFonts() {
    if (interFonts) return interFonts;
    const b64 = async (path) => {
      const buf = await (await fetch(path)).arrayBuffer();
      let s = ""; const bytes = new Uint8Array(buf), CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      return btoa(s);
    };
    const [reg, bold, black] = await Promise.all([
      b64("assets/fonts/Inter-Regular.ttf"), b64("assets/fonts/Inter-Bold.ttf"), b64("assets/fonts/Inter-Black.ttf"),
    ]);
    interFonts = { reg, bold, black };
    return interFonts;
  }
  function registerInter(pdf, f) {
    pdf.addFileToVFS("Inter-Regular.ttf", f.reg); pdf.addFont("Inter-Regular.ttf", "Inter", "normal");
    pdf.addFileToVFS("Inter-Bold.ttf", f.bold); pdf.addFont("Inter-Bold.ttf", "Inter", "bold");
    pdf.addFileToVFS("Inter-Black.ttf", f.black); pdf.addFont("Inter-Black.ttf", "InterBlack", "normal");
  }

  // the tja mark (assets/img/tja-logo.svg) rasterized at 3× for crisp embedding
  let tjaMarkPng = null;
  function loadTjaMark() {
    if (tjaMarkPng) return Promise.resolve(tjaMarkPng);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth * 3 || 1420; c.height = img.naturalHeight * 3 || 648;
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        try { tjaMarkPng = { data: c.toDataURL("image/png"), ratio: c.width / c.height }; } catch (e) { tjaMarkPng = null; }
        resolve(tjaMarkPng);
      };
      img.onerror = () => resolve(null);
      img.src = "assets/img/tja-logo.svg";
    });
  }

  const PDF_DISCLAIMER =
    "Mistakes Cost Money. Proof this document for typographic errors, images and all content or " +
    "pertinent information. Note that colors may differ when viewing on various electronic devices and " +
    "when printed using office vs. professional printers. Signed approval of this document means the " +
    "content has been reviewed thoroughly and it is to your liking. Changes made after approval may " +
    "result in additional charges or fees based on project.";
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
      if (v.url) base.crossOrigin = "anonymous";   // stored proof — keep the export canvas untainted
      // blob: URL for a Drive-stored proof — same-origin, so toDataURL() can't throw
      window.TJA_FILES.blobUrl(v.url || v.dataUrl)
        .then((u) => { base.src = u; })
        .catch(() => { base.src = v.dataUrl || ""; });
    });
  }
  // opts.returnBase64 → build the PDF and return its base64 (no download, no UI) so the
  // review-submit flow can push it to Slack. Default = interactive download.
  async function exportPDF(d, opts) {
    if (!d) return;
    const silent = !!(opts && opts.returnBase64);
    const btn = silent ? null : $("pdExport"); const old = btn ? btn.innerHTML : "";
    try {
      if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
      const jsPDF = await loadJsPDF(); if (!jsPDF) throw new Error("no jsPDF");
      const [fonts, mark] = await Promise.all([loadInterFonts(), loadTjaMark()]);
      const v = active(d);
      // One PDF page per document page for a multi-page proof, each with ITS own markup. A
      // single-surface deliverable yields exactly one, so nothing changes for image proofs.
      const surfaces = pagesOf(v) || [v];
      const composites = [];
      for (const sf of surfaces) composites.push(await buildComposite(sf));
      const composite = composites[0];

      // ---- orientation: the IMAGE decides. Wide creative → 17×11 horizontal,
      // tall/square → 8.5×11 vertical. Aspect ratio itself is never touched.
      let imgW = 0, imgH = 0;
      if (composite) {
        const probe = new Image();
        await new Promise((res) => { probe.onload = res; probe.onerror = res; probe.src = composite; });
        imgW = probe.naturalWidth; imgH = probe.naturalHeight;
      }
      const horizontal = imgW > imgH;
      const pageW = horizontal ? 1224 : 612, pageH = 792;
      const pdf = new jsPDF({ unit: "pt", format: [pageW, pageH], orientation: pageW > pageH ? "landscape" : "portrait" });
      registerInter(pdf, fonts);

      const ORANGE = [246, 142, 33], INK = [34, 34, 34], GRAY = [102, 102, 102], LINE = [225, 225, 225];
      const M = 24, HEAD_RULE = 86, FOOT_TOP = pageH - 42;
      const clientName = (window.CLIENT_DATA && window.CLIENT_DATA.client && window.CLIENT_DATA.client.name) || "";
      let clientCode = "";
      try { const ent = window.TJA_STORE && window.TJA_STORE.get(getSession().client); if (ent && ent.code) clientCode = ent.code; } catch (e) {}
      const approvedish = v.status === "approved" || v.status === "changes";
      const dateStr = (approvedish && v.signedDate) ? v.signedDate : new Date().toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "2-digit" });

      const setF = (family, style, size, color) => { pdf.setFont(family, style); pdf.setFontSize(size); pdf.setTextColor(...color); };
      const label = (txt, x, y2) => { setF("Inter", "bold", 6.2, ORANGE); pdf.text(txt, x, y2, { charSpace: 0.4 }); };
      // wrap into at most maxLines, ellipsizing the last — header meta must never run
      // under the approval box (tight on the 8.5×11 vertical format)
      const fitLines = (txt, maxW, maxLines) => {
        const lines = pdf.splitTextToSize(String(txt || ""), maxW);
        if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, "") + "…"; }
        return lines;
      };

      /* ---- header — full on page 1, slim (no approval box) on overflow pages ---- */
      const BOX_W = 320, BOX_X = pageW - M - BOX_W;
      const drawHeader = (slim) => {
        setF("InterBlack", "normal", 15, INK); pdf.text("PROOF", M, 32, { charSpace: 0.5 });
        label("DATE:", M, 52); setF("Inter", "normal", 7.5, INK); pdf.text(dateStr, M, 63);
        pdf.setDrawColor(...LINE); pdf.setLineWidth(0.8); pdf.line(M + 86, 16, M + 86, 74);
        const mx = M + 104;
        const metaMaxW = (slim ? pageW - M : BOX_X - 10) - mx;
        label("ROUND:", mx, 22); setF("Inter", "normal", 7.5, INK); pdf.text(String(v.label || ""), mx + 32, 22);
        // this label is the longest thing in the header — on the narrow vertical format
        // it would run under the approval box at full size, so it steps down slightly
        setF("Inter", "bold", horizontal ? 6.2 : 5.5, ORANGE);
        pdf.text("JOB NUMBER // CLIENT // ARTWORK/PROJECT:", mx, 36, { charSpace: horizontal ? 0.4 : 0.1 });
        setF("Inter", "normal", 7.5, INK);
        const jobLines = fitLines(`${clientCode ? clientCode + " // " : ""}${clientName} // ${d.name}`, metaMaxW, 2);
        jobLines.forEach((ln, i) => pdf.text(ln, mx, 46 + i * 9));
        // SPECIFICATIONS: entered (optionally) in the upload dialog, stored per deliverable
        label("SPECIFICATIONS:", mx, 64);
        setF("Inter", "normal", 7.5, INK);
        pdf.text(fitLines(d.specs || "—", metaMaxW, 1), mx, 74);
        pdf.setDrawColor(...LINE); pdf.setLineWidth(0.8); pdf.line(0, HEAD_RULE, pageW, HEAD_RULE);
        if (slim) return;

        /* approval box, top-right: signature cell · status checkboxes · disclaimer.
           The signature cell is the WIDEST cell — the drawn signature must be readable
           on the export (Cameron 2026-07-20). */
        const bx = BOX_X, by = 12, bh = 66;
        const sigW = 122, ckW = 94, disW = BOX_W - sigW - ckW;
        // signature cell
        pdf.setDrawColor(...ORANGE); pdf.setLineWidth(1.2); pdf.rect(bx, by, sigW, bh, "S");
        label("CLIENT SIGNATURE", bx + 4, by + 9);
        if (v.signature) {
          try { pdf.addImage(v.signature, "PNG", bx + 5, by + 12, sigW - 10, bh - 24); } catch (e) {}
          setF("Inter", "normal", 5, GRAY);
          pdf.text(`${v.signedBy || ""}${v.signedDate ? " · " + v.signedDate : ""}`.trim(), bx + 4, by + bh - 4);
        }
        // status checkboxes — the three portal statuses, checked per this version
        pdf.setFillColor(...ORANGE); pdf.rect(bx + sigW, by, ckW, bh, "F");
        const rows = [["approved", STATUS.approved.label], ["changes", STATUS.changes.label], ["revisions", STATUS.revisions.label]];
        rows.forEach(([key, txt], i) => {
          const ry = by + 13 + i * 20;
          pdf.setFillColor(255, 255, 255); pdf.rect(bx + sigW + 6, ry - 6.5, 8, 8, "F");
          if (v.status === key) { pdf.setFillColor(...INK); pdf.rect(bx + sigW + 7.5, ry - 5, 5, 5, "F"); }
          setF("Inter", "bold", 5.6, [255, 255, 255]); pdf.text(txt.toUpperCase(), bx + sigW + 18, ry, { charSpace: 0.2 });
        });
        // disclaimer cell
        pdf.setDrawColor(...ORANGE); pdf.setLineWidth(1.2); pdf.rect(bx + sigW + ckW, by, disW, bh, "S");
        setF("Inter", "bold", 4.4, [200, 60, 30]);
        pdf.text("Mistakes Cost Money.", bx + sigW + ckW + 4, by + 8);
        setF("Inter", "normal", 4.4, [60, 60, 60]);
        const disLines = pdf.splitTextToSize(PDF_DISCLAIMER.replace(/^Mistakes Cost Money\.\s*/, ""), disW - 8);
        pdf.text(disLines.slice(0, 11), bx + sigW + ckW + 4, by + 14);
      };

      /* ---- footer on every page: tja lockup + page number ---- */
      const drawFooter = (pageNo, pageCount) => {
        const fy = FOOT_TOP + 8;
        if (mark) { const mh = 17, mw = mh * mark.ratio; pdf.addImage(mark.data, "PNG", M, fy, mw, mh);
          setF("Inter", "bold", 6, GRAY); pdf.text("THE JAMES AGENCY", M + mw + 8, fy + 11, { charSpace: 1.4 }); }
        else { setF("InterBlack", "normal", 9, ORANGE); pdf.text("tja", M, fy + 11);
          setF("Inter", "bold", 6, GRAY); pdf.text("THE JAMES AGENCY", M + 22, fy + 11, { charSpace: 1.4 }); }
        setF("Inter", "normal", 7, GRAY); pdf.text(String(pageNo), pageW - M, fy + 11, { align: "right" });
      };

      drawHeader(false);
      let y = HEAD_RULE + 22;
      const bottom = () => FOOT_TOP - 10;
      const newPage = () => { pdf.addPage([pageW, pageH], pageW > pageH ? "landscape" : "portrait"); drawHeader(true); y = HEAD_RULE + 22; };

      /* ---- ADDITIONAL DETAILS (the portal notes), centered per the template ---- */
      const noteBlocks = [];
      if (v.clientNotes) noteBlocks.push(["CLIENT NOTES", v.clientNotes]);
      if (v.agencyNotes) noteBlocks.push(["AGENCY NOTES", v.agencyNotes]);
      if (noteBlocks.length) {
        setF("Inter", "bold", 8, INK); pdf.text("ADDITIONAL DETAILS:", pageW / 2, y, { align: "center", charSpace: 0.3 });
        y += 12;
        noteBlocks.forEach(([lbl, txt]) => {
          setF("Inter", "bold", 7, GRAY); pdf.text(lbl, pageW / 2, y, { align: "center", charSpace: 0.3 }); y += 10;
          setF("Inter", "normal", 8, INK);
          const lines = pdf.splitTextToSize(txt, Math.min(pageW * 0.72, 640));
          lines.forEach(ln => { pdf.text(ln, pageW / 2, y, { align: "center" }); y += 10.5; });
          y += 6;
        });
        y += 6;
      }

      /* ---- each page: the creative, then ITS comments, numbered to match its pins ---- */
      for (let si = 0; si < surfaces.length; si++) {
        const sf = surfaces[si], comp = composites[si];
        if (si > 0) newPage();                      // pages 2+ get the slim header
        const pins = (sf && sf.pins) || [];
        let cW = imgW, cH = imgH;
        if (si > 0 && comp) {                       // measure this page's own bitmap
          const probe2 = new Image();
          await new Promise((res) => { probe2.onload = res; probe2.onerror = res; probe2.src = comp; });
          cW = probe2.naturalWidth; cH = probe2.naturalHeight;
        }
        if (comp && cW && cH) {
          const reserve = pins.length ? Math.min(150, 34 + pins.length * 22) : 16;
          const boxW = pageW - M * 2, boxH = Math.max(120, bottom() - y - reserve);
          const scale = Math.min(boxW / cW, boxH / cH);
          const w = cW * scale, h = cH * scale;
          pdf.addImage(comp, "JPEG", M + (boxW - w) / 2, y + (boxH - h) / 2, w, h);
          y += boxH + 14;
        }
        if (surfaces.length > 1) {                  // label which page this is
          setF("Inter", "bold", 7, GRAY);
          pdf.text(`PAGE ${si + 1} OF ${surfaces.length}`, M, y, { charSpace: 0.4 });
          y += 12;
        }
        if (pins.length) {
          setF("Inter", "bold", 9, INK); pdf.text(`COMMENTS (${pins.length})`, M, y, { charSpace: 0.4 }); y += 14;
          pins.forEach((pn, i) => {
            const lines = pdf.splitTextToSize(`${pn.by ? pn.by + ": " : ""}${pn.text || "(no note)"}${pn.resolved ? "   [resolved]" : ""}`, pageW - M * 2 - 22);
            if (y + lines.length * 11.5 > bottom()) newPage();
            pdf.setFillColor(...(pn.resolved ? [54, 194, 117] : ORANGE));
            pdf.circle(M + 6, y - 3, 6, "F");
            setF("Inter", "bold", 7, [255, 255, 255]); pdf.text(String(i + 1), M + 6, y - 0.6, { align: "center" });
            setF("Inter", "normal", 8.5, INK);
            pdf.text(lines, M + 20, y); y += lines.length * 11.5 + 7;
          });
        }
      }

      const pages = pdf.getNumberOfPages();
      for (let p = 1; p <= pages; p++) { pdf.setPage(p); drawFooter(p, pages); }

      if (silent) return String(pdf.output("datauristring") || "").split(",")[1] || "";   // base64 only
      pdf.save(`${(d.name || "deliverable").replace(/[^\w-]+/g, "_")}-${v.label}.pdf`);
    } catch (e) {
      console.warn("PDF export failed", e);
      if (!silent) window.TJA_UI.alert("Sorry — couldn’t generate the PDF (the PDF library may have failed to load). Check your connection and try again.");
      return "";
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
  /* ---------- live auto-refresh (Present Docs) ----------
     Keep an open gallery current when the OTHER side acts — a client submits a review, an
     AM/PM releases a draft, a creative posts a proposal — without a manual refresh. Re-pulls
     the deliverable scope(s) and repaints, but NEVER while a review/upload overlay is open
     (that would clobber an in-progress annotation) or while our own write is in flight. The
     INSTANT path is app.js's Realtime socket, which calls liveRefresh() on any deliverables
     change; this module also self-polls (focus / tab-visible / 25s) as the resilient fallback. */
  let liveBusy = false, liveWired = false;
  async function liveRefresh() {
    if (liveBusy) return;
    if (nowMs() < suppressLiveUntil) return;                        // just mutated — don't re-pull stale
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pullScope)) return;
    const g = $("pdGallery"); if (!g) return;                       // docs page not mounted
    // Reviewing: don't yank the gallery out from under an open proof — but DO merge remote work
    // into it (see syncOpenModal). This used to `return`, which threw away the Realtime push and
    // left teammates' comments invisible until the modal was closed. Now the instant path
    // reaches the open modal too, so comments appear as they're made.
    const m = $("pdModal");
    if (m && m.classList.contains("open")) { liveBusy = true; try { await syncOpenModal(); } finally { liveBusy = false; } return; }
    const up = $("pdUpOverlay"); if (up && up.style.display !== "none") return;
    if (window.SUPA.hasPendingWrite &&
       (window.SUPA.hasPendingWrite(sess.client, "deliverables") ||
        window.SUPA.hasPendingWrite(sess.client, "deliverables_draft"))) return;
    liveBusy = true;
    try {
      // 12s budget: deliverable rows carry inline base64 proofs (several MB) — the default
      // 3.5s pull timeout regularly failed silently and left this page rendering a STALE
      // local copy (the "client review / waiting-room item not showing up" delays).
      const sent = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      // Adopting the server copy makes it the new merge ancestor for staff writes — without this
      // the 3-way merge would keep comparing against a stale base and mis-read remote additions.
      if (Array.isArray(sent)) { items = sent; setBase(sent); try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }
      if (isStaffFn()) {
        const dr = await window.SUPA.pullScope(sess.client, "deliverables_draft", 12000);
        if (Array.isArray(dr)) { draftItems = dr; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {} }
      }
      renderGallery();
    } catch (e) { /* transient — next tick */ }
    finally { liveBusy = false; }
  }
  function startLiveRefresh() {
    if (liveWired) return; liveWired = true;
    // Poll cadence is the FALLBACK when the Realtime socket misses a change (it's the reason a
    // client's just-submitted review can lag on the staff gallery). 12s keeps staff current
    // without hammering the API; the instant path is still app.js's Realtime nudge.
    setInterval(liveRefresh, 12000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) liveRefresh(); });
    window.addEventListener("focus", liveRefresh);
  }
  /* Merge remote work INTO the open review modal — teammates' pins/comments and their submitted
     reviews appear while you're still in the proof. Driven by the Realtime push (instant, via
     liveRefresh) with the 12s poll as the fallback. Pauses while this person is mid-draw,
     mid-signature or typing so nothing is yanked out from under them; their own work is grafted
     back on by mergeMineInto, so an in-flight markup is never lost. */
  async function syncOpenModal() {
    if (!(getSession && getSession() && getSession().role === "client")) return;
    const d = deliv(curId); const v = d && active(d);
    if (!v || !expectedOf(v).length) return;              // single-reviewer round: nothing to sync
    if (drawing || sigDrawing) return;
    const ae = document.activeElement;
    if (ae && (/^(input|textarea|select)$/i.test(ae.tagName || "") || ae.isContentEditable)) return;
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pullScope)) return;
    try {
      const fresh = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      if (!Array.isArray(fresh) || !fresh.length) return;
      items = mergeMineInto(fresh, items);
      try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
      const d2 = deliv(curId); const v2 = d2 && active(d2);
      if (!v2) { closeModal(); return; }                   // the open card was deleted elsewhere
      renderPins(); renderPinList(); renderPeerReviews(v2); updateMeta();
    } catch (e) { /* transient — next tick */ }
  }

  function init() {
    load(); loadDrafts(); renderGallery();
    wireElements();
    startLiveRefresh();
    liveRefresh();   // pull fresh on open — localStorage may be stale (e.g. a client just submitted a review)
    if (wiredGlobal) return;
    wiredGlobal = true;
    document.addEventListener("keydown", e => {
      const m = $("pdModal"); if (!m || !m.classList.contains("open")) return;
      const typing = /INPUT|TEXTAREA/.test(e.target.tagName || "") || e.target.isContentEditable;
      if (e.code === "Space" && !typing) { spaceDown = true; const w = $("pdWrap"); if (w) w.classList.add("space-pan"); e.preventDefault(); return; }
      if (e.key === "Escape") closeModal();
      // ← / → page through a multi-page proof (not while typing a note)
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !typing) {
        const d = deliv(curId);
        if (d && pagesOf(active(d))) { e.preventDefault(); switchPage(curPage + (e.key === "ArrowRight" ? 1 : -1)); }
      }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
    });
    document.addEventListener("keyup", e => {
      if (e.code === "Space") { spaceDown = false; const w = $("pdWrap"); if (w) w.classList.remove("space-pan"); }
    });
    window.addEventListener("resize", () => {
      const m = $("pdModal"); if (!m || !m.classList.contains("open")) return;
      const v = active(deliv(curId));
      persistCanvas(); sizeOverlay(); if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); drawSaved(surface(v).annotation); renderPins(); hidePopup(); clampPan(); applyZoom();
    });
  }

  function wireElements() {
    $("pdUploadBtn").addEventListener("click", () => $("pdFile").click());
    $("pdFile").addEventListener("change", e => { handleNewDeliverables(e.target.files); e.target.value = ""; });
    $("pdUpCancel").addEventListener("click", closeUploadDialog);
    $("pdUpSend").addEventListener("click", () => { if (pendingSendDraftId) commitSend(); else commitUpload(); });
    // Shared helper — a bare click listener closed this dialog while you were typing the
    // subject/message (drag-select out of a field fires click on the overlay).
    window.TJA_UI.backdropClose($("pdUpOverlay"), closeUploadDialog);
    // Keyword-exercise builder
    if ($("pdKwBtn")) $("pdKwBtn").addEventListener("click", () => openKeywordDialog(null));
    if ($("pdKwCancel")) $("pdKwCancel").addEventListener("click", closeKeywordDialog);
    if ($("pdKwSend")) $("pdKwSend").addEventListener("click", commitKeywords);
    // `input` covers typing AND paste (and cut/undo); `paste` fires one tick early, so re-run
    // after the browser has inserted the text so the preview + counts reflect it.
    ["pdKwLook", "pdKwTone", "pdKwAud"].forEach(id => {
      const el = $(id); if (!el) return;
      el.addEventListener("input", () => { kwCounts(); kwPreview(); });
      el.addEventListener("paste", () => setTimeout(() => { kwCounts(); kwPreview(); }, 0));
    });
    if ($("pdKwOverlay")) window.TJA_UI.backdropClose($("pdKwOverlay"), closeKeywordDialog);
    // A new round of a KEYWORD deliverable edits the words — it never asks for a file.
    $("pdResubmit").addEventListener("click", () => {
      const d = deliv(curId);
      if (d && isKeywordDoc(d)) {
        if (!isDraft(d) && blockNewRound(d)) return;
        closeModal();
        openKeywordDialog(d);
        return;
      }
      $("pdVerFile").click();
    });
    $("pdVerFile").addEventListener("change", e => { handleResubmit(e.target.files[0]); e.target.value = ""; });

    $("pdGallery").addEventListener("click", async e => {
      const lnk = e.target.closest("[data-copylink]");
      if (lnk) { e.stopPropagation(); copyDeliverableLink(lnk.dataset.copylink); return; }
      const exp = e.target.closest("[data-export]");
      if (exp) { e.stopPropagation(); exportPDF(deliv(exp.dataset.export)); return; }
      const snd = e.target.closest("[data-send]");
      if (snd) { e.stopPropagation(); openSendDialog(snd.dataset.send); return; }
      const del = e.target.closest("[data-del]");
      if (del) {
        e.stopPropagation();
        const id = del.dataset.del;
        const gone = (draftItems.find(x => x.id === id) || items.find(x => x.id === id) || {}).name || "a deliverable";
        // The ✕ sits right on the card — an accidental click must not silently remove a
        // deliverable mid-review. Confirm first (history/snapshots keep it recoverable, but
        // the client-facing gallery changes instantly).
        if (window.TJA_UI) {
          const sure = await window.TJA_UI.confirm(
            `Delete “${gone}”?\n\nIt disappears from the gallery for everyone (including the client) right away.`,
            { title: "Delete deliverable", okText: "Delete" });
          if (!sure) return;
        }
        // Remove locally + repaint immediately, then flush the removal to the server RIGHT AWAY
        // (guardLive keeps a stray pull from re-adding it — the "deletes, pops back" bug).
        if (draftItems.some(x => x.id === id)) { draftItems = draftItems.filter(x => x.id !== id); renderGallery(); await saveDraftsNow(); }
        else { items = items.filter(x => x.id !== id); renderGallery(); await saveNow(); }
        // deletions are the events people most need to trace back
        try { if (window.SUPA && window.SUPA.auditEvent) window.SUPA.auditEvent(sess.client, "deliverable.deleted", `deleted ${gone}`, { scope: "deliverables" }); } catch (e) {}
        return;
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
    if ($("pdPagePrev")) $("pdPagePrev").addEventListener("click", () => switchPage(curPage - 1));
    if ($("pdPageNext")) $("pdPageNext").addEventListener("click", () => switchPage(curPage + 1));
    const badge = $("pdPageBadge");
    if (badge) badge.addEventListener("click", e => {
      const d = e.target.closest("[data-page]"); if (d) switchPage(+d.dataset.page);
    });
    $("pdStatus").addEventListener("click", e => {
      const opt = e.target.closest(".pd-status-opt"); if (!opt) return;
      const v = active(deliv(curId)); if (!v) return;
      const val = opt.dataset.val;
      // Multi-reviewer client: the choice is PRIVATE until Submit (pendingSel), so a teammate
      // looking at the same proof never sees a half-made verdict — and one person clicking
      // around can't repaint the shared card status for everyone.
      if (expectedOf(v).length && typeof effectiveRole === "function" && effectiveRole() === "client") {
        const cur = pendingSel[v.vid] != null ? pendingSel[v.vid] : ((myReviewOf(v) || {}).status || null);
        pendingSel[v.vid] = (cur === val) ? null : val;
        document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === pendingSel[v.vid]));
        return;
      }
      v.status = (v.status === val) ? null : val;
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
        const v = curSurface(); const p = v && v.pins.find(x => x.id === id);
        if (p) { p.text = e.target.value; saveCur(); const ta = document.querySelector(`[data-pintext="${id}"]`); if (ta) ta.value = p.text; }
      });
      $("pdPopupClose").addEventListener("click", hidePopup);
    }

    // zoom controls + wheel + pan. ZOOM only on pinch / Ctrl(⌘)+scroll — hijacking EVERY wheel
    // event meant a trackpad's ordinary two-finger scroll zoomed the proof mid-draw/comment
    // ("the zoom function was getting in the way"). A plain scroll now pans when zoomed in and
    // does nothing at 100%; the +/− buttons and pinch still zoom.
    $("pdWrap").addEventListener("wheel", e => {
      if (e.ctrlKey || e.metaKey) {            // pinch gestures arrive as ctrlKey wheel events
        e.preventDefault();
        const r = $("pdWrap").getBoundingClientRect();
        setZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
        return;
      }
      if (zoom > 1) {                          // scrolling while zoomed = panning, not zooming
        e.preventDefault();
        panX -= e.deltaX; panY -= e.deltaY;
        clampPan(); applyZoom(); hidePopup();
      }
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
    $("pdRevDue").addEventListener("change", e => {
      if (typeof effectiveRole === "function" && effectiveRole() === "client") return;   // clients can't set their own deadline
      const v = active(deliv(curId)); if (v) { v.revisionsDue = e.target.value; saveCur(); }
    });

    $("pdSubmit").addEventListener("click", submitReview);
    // "Open the full PDF" — resolve through the authenticated proxy, then open the blob.
    document.addEventListener("click", async (e) => {
      const a = e.target.closest("[data-openpdf]"); if (!a) return;
      e.preventDefault();
      const d = deliv(curId); const v = d && active(d);
      if (!v || !v.sourceUrl) return;
      try { window.open(await window.TJA_FILES.blobUrl(v.sourceUrl), "_blank", "noopener"); }
      catch (err) { window.TJA_UI.alert("Couldn't open the PDF — your session may have expired. Sign out and back in, then try again."); }
    });
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

  // Deep-link entry: open a specific deliverable by id (from the email's
  // ?open=docs&doc=<id>, or a notification click). Retries briefly while the docs
  // page is still painting OR the deliverables scope is still pulling from Supabase
  // (a fresh-login arrival can beat the data). Gives up silently after ~6s — a stale
  // link (released draft, another client's id) just leaves the user on the gallery.
  function openDoc(id, tries) {
    if (!id) return;
    const t = tries || 0;
    if (!deliv(id) || !$("pdModal")) {
      // Wait out the PULL, not just the paint. Following a Slack/email link into a client this
      // tab hasn't opened means nothing is cached locally, so the deliverable only exists once
      // the deliverables scope arrives — and that pull is allowed 12s (the rows carry inline
      // proofs). The old 6s ceiling gave up first and left the deliverable unopened on an
      // otherwise correct page. 140 x 150ms ≈ 21s covers the pull plus a retry.
      if (t < 140) setTimeout(() => openDoc(id, t + 1), 150);
      return;
    }
    openModal(id);
  }

  return { render, init, openDoc, liveRefresh };
})();
