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
    editSeq++;                                           // a local edit happened (see pushResult)
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
  function mergeSurfaceMine(lsf, fsf, me, sfKey) {
    if (!lsf || !fsf) return;
    const mineOwned = (pn) => !pn.byEmail || pn.byEmail === me;
    const localById = new Map((lsf.pins || []).map(pn => [pn.id, pn]));
    const byId = new Map((fsf.pins || []).map(pn => [pn.id, pn]));
    (lsf.pins || []).forEach(pn => { if (mineOwned(pn)) byId.set(pn.id, Object.assign({}, pn)); });
    (fsf.pins || []).forEach(pn => { if (mineOwned(pn) && !localById.has(pn.id)) byId.delete(pn.id); });
    /* REPLIES are written by anyone on anyone's pin, so they merge per reply (author-keyed),
       independently of who owns the pin: my replies ride along, teammates' replies survive even
       on a pin whose own text I just edited. */
    const freshById = new Map((fsf.pins || []).map(pn => [pn.id, pn]));
    byId.forEach((pn, id) => {
      const fp = freshById.get(id), lp = localById.get(id);
      const rs = mergeRepliesMine(fp && fp.replies, lp && lp.replies, me, !!lp);
      if (rs.length) pn.replies = rs; else delete pn.replies;
    });
    fsf.pins = [...byId.values()];
    /* The drawing is ONE shared canvas per surface, so it only travels when THIS browser actually
       drew on it this session. Grafting it unconditionally let a reviewer who never drew wipe a
       teammate's markup with their own blank canvas. */
    // …and only if nobody else changed it since this browser loaded it (a per-surface
    // compare-and-set). If it moved underneath us, the current lock holder's drawing wins.
    if (sfKey && dirtyAnno.has(sfKey) && lsf.annotation !== undefined) {
      const seen = annoLoaded.has(sfKey) ? annoLoaded.get(sfKey) : undefined;
      if (seen === undefined || (fsf.annotation || null) === seen || (fsf.annotation || null) === (lsf.annotation || null)) fsf.annotation = lsf.annotation;
    }
  }
  function mergeRepliesMine(freshR, localR, me, haveLocalPin) {
    const out = new Map((freshR || []).map(r => [r.id, r]));
    (localR || []).forEach(r => { if (r.byEmail === me) out.set(r.id, r); });
    if (haveLocalPin) (freshR || []).forEach(r => {
      if (r.byEmail === me && !(localR || []).some(x => x.id === r.id)) out.delete(r.id);   // I deleted it
    });
    return [...out.values()].sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  }
  // Surface keys for the dirty-drawing set: "<vid>#<page>" (page -1 = the version itself).
  const sfKeyOf = (v, pageIdx) => (v && v.vid ? v.vid : "?") + "#" + (pageIdx == null ? -1 : pageIdx);
  const dirtyAnno = new Set();
  const annoLoaded = new Map();      // sfKey → the annotation value this browser started from
  // after a successful save, what we wrote IS the server's value — the new baseline
  function rebaseAnnotations() {
    dirtyAnno.forEach(k => {
      const [vid, pg] = k.split("#");
      const v = findVersion(vid); if (!v) return;
      const ps = pagesOf(v); const sf = (ps && +pg >= 0) ? ps[+pg] : v;
      if (sf) annoLoaded.set(k, sf.annotation || null);
    });
  }
  // Apply across EVERY surface of a version — each page when paged, else the version itself.
  function mergeVersionSurfaces(lv, fv, me) {
    const lp = pagesOf(lv), fp = pagesOf(fv);
    if (lp && fp) {
      const n = Math.min(lp.length, fp.length);
      for (let i = 0; i < n; i++) mergeSurfaceMine(lp[i], fp[i], me, sfKeyOf(lv, i));
    } else {
      mergeSurfaceMine(lv, fv, me, sfKeyOf(lv, null));
    }
  }

  function mergeMineInto(fresh, local) {
    const me = myEmail();
    const freshById = new Map(fresh.map(x => [x.id, x]));
    local.forEach(ld => {
      const fd = freshById.get(ld.id);
      if (!fd) return;   // card the server doesn't have (deleted elsewhere) — server wins
      // the deliverable's Drive folder, if this browser was the one that resolved it
      if (ld.driveFolderId && !fd.driveFolderId) fd.driveFolderId = ld.driveFolderId;
      (ld.versions || []).forEach(lv => {
        if (!lv.vid) return;
        const fv = (fd.versions || []).find(x => x.vid === lv.vid);
        if (!fv) return;   // version the server doesn't have — server wins
        mergeVersionSurfaces(lv, fv, me);        // pins + drawings, per page when paged
        if (lv.reviews && lv.reviews[me]) fv.reviews = Object.assign({}, fv.reviews, { [me]: lv.reviews[me] });
        if (lv.signatures && lv.signatures[me]) fv.signatures = Object.assign({}, fv.signatures, { [me]: lv.signatures[me] });
        // my unsubmitted draft (notes + verdict) — saved so closing the proof never loses it
        if (lv.reviewDrafts && lv.reviewDrafts[me] && !(fv.reviews && fv.reviews[me])) {
          fv.reviewDrafts = Object.assign({}, fv.reviewDrafts, { [me]: lv.reviewDrafts[me] });
        } else if (fv.reviewDrafts && fv.reviewDrafts[me] && ((fv.reviews && fv.reviews[me]) || !(lv.reviewDrafts && lv.reviewDrafts[me]))) {
          fv.reviewDrafts = Object.assign({}, fv.reviewDrafts); delete fv.reviewDrafts[me];
          if (!Object.keys(fv.reviewDrafts).length) delete fv.reviewDrafts;
        }
        /* Facts this browser just PRODUCED about the round — the archived proof PDF is written
           after the review flush, so without carrying it here the very next merge drops it and
           the Drive copy is orphaned (the link came back null even though the upload succeeded). */
        ["reviewedPdfUrl", "reviewedPdfLink"].forEach(k => { if (lv[k] && !fv[k]) fv[k] = lv[k]; });
        if (expectedOf(fv).length) {
          fv.status = aggregateStatus(fv);
        } else {
          // legacy single-reviewer round: my in-progress verdict + notes (never over a finished review)
          if (!fv.reviewedAt) ["status", "clientNotes"].forEach(k => { if (lv[k] !== undefined) fv[k] = lv[k]; });
        }
      });
    });
    return normalizeRounds(fresh);
  }
  /* COMPLETION, derived from the data — never left to whichever browser happened to submit
     last. Any write (client or staff) that finds every expected reviewer in but no completion
     stamp stamps it. That's what makes "all reviews in, but the next round is still blocked and
     there's nobody left to waive" impossible. completedAtMs drives the notification sweep. */
  function normalizeRounds(list) {
    (list || []).forEach(d => (d && d.versions || []).forEach(v => {
      if (!v || v.state === "pending_approval" || !expectedOf(v).length) return;
      if (Object.keys(reviewsOf(v)).length) v.status = aggregateStatus(v);
      if (reviewComplete(v) && !v.reviewedAt) {
        v.reviewedAt = stamp(); v.reviewedStatus = v.status || null; v.completedAtMs = Date.now();
      }
    }));
    return list;
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
  const CLIENT_OWNED = ["reviews", "signatures", "reviewDrafts", "status", "reviewedAt", "reviewedStatus", "completedAtMs", "clientNotes",
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
      if (k === "pins" || k === "reviews" || k === "reviewDrafts" || k === "signatures") return;   // handled below
      const iChanged = !same(mine[k], b[k]);
      const theyChanged = !same(theirs[k], b[k]);
      if (iChanged && theyChanged) { if (!CLIENT_OWNED.includes(k)) out[k] = mine[k]; return; }
      if (iChanged) out[k] = mine[k];
    });
    // reviews: an email-keyed map, each entry written only by its owner → union, server wins ties
    out.reviews = Object.assign({}, mine.reviews, theirs.reviews);
    if (!Object.keys(out.reviews).length) delete out.reviews;
    out.signatures = Object.assign({}, mine.signatures, theirs.signatures);
    if (!Object.keys(out.signatures).length) delete out.signatures;
    // drafts belong to clients; staff never author them → the server's copy stands
    if (theirs.reviewDrafts) out.reviewDrafts = theirs.reviewDrafts; else delete out.reviewDrafts;
    out.pins = mergeById(b.pins, mine.pins, theirs.pins, "id", mergePin3);
    // PAGES: a whole-array win would throw away one side's markup, so merge each page's pins
    // (id-keyed 3-way) and take a changed drawing from whoever changed it.
    const bp = pagesOf(b), mp = pagesOf(mine), tp = pagesOf(theirs);
    if (mp && tp) {
      out.pages = tp.map((tpg, i) => {
        const mpg = mp[i]; if (!mpg) return tpg;
        const bpg = (bp && bp[i]) || {};
        const merged = Object.assign({}, tpg);
        merged.pins = mergeById(bpg.pins, mpg.pins, tpg.pins, "id", mergePin3);
        if (!same(mpg.annotation, bpg.annotation)) merged.annotation = mpg.annotation;
        return merged;
      });
    }
    return out;
  }
  // A pin 3-way: its own fields from whoever changed them; its REPLIES merged per reply id, so
  // a staff edit to a pin can't drop a client's reply to it (and vice versa).
  function mergePin3(pb, pm, pt) {
    const strip = (p) => { const c = Object.assign({}, p || {}); delete c.replies; return c; };
    const out = same(strip(pm), strip(pb)) ? Object.assign({}, pt) : Object.assign({}, pm);
    const rs = mergeById((pb || {}).replies, (pm || {}).replies, (pt || {}).replies, "id",
      (rb, rm, rt) => (same(rm, rb) ? rt : rm));
    if (rs.length) out.replies = rs; else delete out.replies;
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
  /* ---------- the ONE write path for the deliverables scope ----------
     Every write — client or staff, debounced or immediate — is a compare-and-set
     (SUPA.casUpdate): pull the freshest copy, merge this browser's work into it, write only if
     nobody saved in between, else re-pull and re-merge. There is NO blind-overwrite fallback any
     more: if the latest copy can't be read (slow connection, timeout) nothing is written, the
     edit stays in this browser, the page shows "Not saved yet — retrying" and it retries with
     backoff until it lands. That is what stops a stale copy ever replacing a teammate's review. */
  let editSeq = 0;                 // bumps on every local edit — tells us if edits landed mid-flight
  const supaOn = () => !!(window.SUPA && window.SUPA.enabled && window.SUPA.casUpdate);
  const SAVE = { dirty: false, busy: false, again: false, fails: 0, retryTimer: null, lastError: "" };
  function setSaveState() {
    const el = $("pdSaveState"); if (!el) return;
    if (SAVE.fails && SAVE.dirty) {
      el.textContent = "⚠ Not saved yet — retrying… (keep this page open)";
      el.className = "pd-save-state warn";
    } else if (SAVE.busy || SAVE.dirty) { el.textContent = "Saving…"; el.className = "pd-save-state"; }
    else { el.textContent = "✓ All changes saved"; el.className = "pd-save-state ok"; }
  }
  // Adopt a successful write. If the user kept editing while it was in flight, graft those
  // newer edits back on top so not a keystroke is lost; the next push carries them.
  function adoptWrite(written, seqAtStart, isClient, baseAtStart) {
    if (editSeq === seqAtStart) items = written;
    // staff: 3-way against the ancestor we merged FROM, so only the genuinely-new local edits win
    // (diffing against `written` would read every remote change we hadn't seen as "my edit").
    else items = isClient ? mergeMineInto(cloneJ(written), items) : mergeStaff(baseAtStart, items, cloneJ(written));
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
  }
  async function pushDeliverables() {
    if (!supaOn()) return { ok: true };
    // already saving → wait for it, then run a NEW write that starts after the caller's edit (so
    // "saved" never means "an earlier write was saved")
    if (SAVE.busy) { try { await SAVE.busyPromise; } catch (e) {} return pushDeliverables(); }
    SAVE.busy = true; SAVE.dirty = true; setSaveState();
    const isClient = !!(getSession && getSession() && getSession().role === "client");
    const seq = editSeq;
    const baseAtStart = cloneJ(baseItems) || null;
    const run = (async () => {
      const r = await window.SUPA.casUpdate(sess.client, "deliverables", (fresh) => {
        const theirs = Array.isArray(fresh) ? fresh : [];
        return isClient ? mergeMineInto(theirs, items) : normalizeRounds(mergeStaff(baseItems, items, theirs));
      });
      if (r.ok && !r.noop) {
        adoptWrite(r.data, seq, isClient, baseAtStart);
        setBase(r.data); rebaseAnnotations();
        SAVE.fails = 0; SAVE.lastError = "";
        if (editSeq === seq) SAVE.dirty = false;
      } else if (!r.ok) {
        SAVE.fails++; SAVE.lastError = r.error || "network";
        console.warn("Present Docs save failed — will retry:", SAVE.lastError);
      } else { SAVE.dirty = editSeq !== seq; }
      return r;
    })();
    SAVE.busyPromise = run;
    let r;
    try { r = await run; } finally { SAVE.busy = false; }
    guardLive();
    if (SAVE.dirty && r && r.ok) schedulePush(300);
    else if (!r.ok) scheduleRetry();
    setSaveState();
    if (r && r.ok) { try { maybeReleaseAfterSave(); } catch (e) {} }
    return r;
  }
  let pushTimer = null;
  function schedulePush(ms) {
    SAVE.dirty = true; setSaveState();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushDeliverables().then(() => { if (!$("pdModal") || !$("pdModal").classList.contains("open")) renderGallery(); }); }, ms == null ? 900 : ms);
  }
  function scheduleRetry() {
    clearTimeout(SAVE.retryTimer);
    const wait = Math.min(30000, 2000 * Math.pow(2, Math.max(0, SAVE.fails - 1)));
    SAVE.retryTimer = setTimeout(() => { if (SAVE.dirty) pushDeliverables(); }, wait);
  }
  // Leaving with unsaved work → the browser asks first (a review is never silently dropped).
  window.addEventListener("beforeunload", (e) => {
    if (SAVE.dirty || SAVE.busy || submitBusy || DRAFT.dirty) { e.preventDefault(); e.returnValue = ""; return ""; }
  });
  // Staff writes (kept as a named function — sendDraft/saveNow await it for ordering).
  async function staffMergedPush() {
    clearTimeout(pushTimer);
    return await pushDeliverables();
  }
  function scheduleStaffMergedPush() { schedulePush(900); }
  function scheduleClientMergedPush() { schedulePush(900); }
  // flush anything queued, now (used before releasing the review lock / leaving the modal)
  async function flushPending() {
    clearTimeout(pushTimer);
    while (SAVE.busy) { try { await SAVE.busyPromise; } catch (e) {} }
    if (SAVE.dirty) return await pushDeliverables();
    return { ok: true };
  }
  const isStaffFn = () => (typeof isStaff === "function" ? isStaff() : true);
  function loadDrafts() {
    if (!isStaffFn()) { draftItems = []; return; }   // clients never even look locally
    try { draftItems = JSON.parse(localStorage.getItem(DRAFT_KEY)) || []; }
    catch { draftItems = []; }
    dedupeDrafts();
  }
  /* WAITING-ROOM writes, also compare-and-set. A draft I hold wins; a draft someone else added
     survives; a draft I deleted/sent stays gone; a draft that vanished remotely (sent/deleted by
     a colleague) is not resurrected by my stale copy. */
  const draftDeleted = new Set();
  let draftBaseIds = new Set();
  function mergeDrafts(fresh, local) {
    const L = new Map(local.map(d => [d.id, d]));
    const out = [];
    (fresh || []).forEach(f => { if (!draftDeleted.has(f.id)) out.push(L.has(f.id) ? L.get(f.id) : f); });
    local.forEach(l => {
      if (out.some(x => x.id === l.id) || draftDeleted.has(l.id)) return;
      if (draftBaseIds.has(l.id)) return;              // removed elsewhere since we last looked
      out.push(l);                                     // new here → keep
    });
    return out;
  }
  let draftTimer = null, draftRetry = null;
  const DRAFT = { dirty: false, busy: false };
  function saveDrafts() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); }
    catch (e) { console.warn("Portal sandbox: storage full — keeping drafts in memory only.", e); }
    if (!supaOn()) return;
    DRAFT.dirty = true;                                  // holds liveRefresh off until it lands
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { pushDrafts(); }, 700);
  }
  async function pushDrafts() {
    if (!supaOn()) return { ok: true };
    DRAFT.dirty = true; DRAFT.busy = true;
    let r;
    try { r = await window.SUPA.casUpdate(sess.client, "deliverables_draft", (fresh) => mergeDrafts(Array.isArray(fresh) ? fresh : [], draftItems)); }
    finally { DRAFT.busy = false; }
    clearTimeout(draftRetry); draftRetry = null;
    if (r.ok) {
      if (!r.noop) {
        draftItems = r.data; draftBaseIds = new Set(draftItems.map(d => d.id));
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {}
      }
      DRAFT.dirty = false;
    } else {
      draftRetry = setTimeout(pushDrafts, 5000);         // ONE retry chain, never several
    }
    return r;
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
    guardLive(); editSeq++;
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
    if (!supaOn()) return { ok: true };
    return await staffMergedPush();
  }
  async function saveDraftsNow() {
    guardLive();
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {}
    clearTimeout(draftTimer);
    return await pushDrafts();
  }
  // Self-heal for a crash between the two Send pushes (sent write landed, draft removal
  // didn't): any draft whose version already exists in `items` is a stale duplicate.
  function dedupeDrafts() {
    const sentVids = new Set();
    items.forEach(d => (d.versions || []).forEach(v => { if (v.vid) sentVids.add(v.vid); }));
    const before = draftItems.length;
    draftItems = draftItems.filter(d => {
      const dup = (d.versions || []).some(v => v.vid && sentVids.has(v.vid));
      if (dup) draftDeleted.add(d.id);
      return !dup;
    });
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
  /* EVERY approver signs (Cameron 2026-09-28 — was "first approver only"). Each signature lives
     under its signer's email in v.signatures, written only by that person, so it merges exactly
     like reviews. v.signature/signedBy/signedDate stay as the FIRST signature for old readers. */
  const signaturesOf = (v) => (v && v.signatures && typeof v.signatures === "object" && !Array.isArray(v.signatures)) ? v.signatures : {};
  function allSignatures(v) {
    const out = Object.keys(signaturesOf(v)).map(e => Object.assign({ email: e }, signaturesOf(v)[e]));
    if (!out.length && v && v.signature) out.push({ email: "", signature: v.signature, signedBy: v.signedBy, signedDate: v.signedDate });
    return out;
  }
  const iHaveSigned = (v) => !!signaturesOf(v)[myEmail()] || (!expectedOf(v).length && !!(v && v.signature));
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
  /* MY UNSUBMITTED DRAFT (notes + chosen verdict) — saved to the record as v.reviewDrafts[me]
     (and to this browser as a backup), so closing the proof, refreshing, or switching devices
     never loses what someone was writing. Never shown to teammates; removed on Submit. */
  const DRAFT_LS = (vid) => "tja_pd_mydraft_" + sess.client + "_" + vid + "_" + myEmail();
  function myDraftOf(v) {
    const server = v && v.reviewDrafts && v.reviewDrafts[myEmail()];
    let local = null; try { local = JSON.parse(localStorage.getItem(DRAFT_LS(v.vid)) || "null"); } catch (e) {}
    if (server && local) return (local.atMs || 0) > (server.atMs || 0) ? local : server;
    return server || local || null;
  }
  function saveMyDraft() {
    const v = active(deliv(curId));
    if (!v || !v.vid || !isRealClient() || !expectedOf(v).length || myReviewOf(v) || !viewerCanMarkup()) return;
    const draft = { notes: $("pdClientNotes") ? $("pdClientNotes").value : "",
      status: pendingSel[v.vid] != null ? pendingSel[v.vid] : null, atMs: Date.now() };
    v.reviewDrafts = Object.assign({}, v.reviewDrafts, { [myEmail()]: draft });
    try { localStorage.setItem(DRAFT_LS(v.vid), JSON.stringify(draft)); } catch (e) {}
    saveCur();
  }
  function clearMyDraft(vid) { try { localStorage.removeItem(DRAFT_LS(vid)); } catch (e) {} }

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
      <!-- Video review: a LINK (YouTube / Vimeo / Loom / Drive / direct file) plays inside the
           review screen; reviewers leave comments stamped at the moment they paused on. -->
      <button class="btn btn-upload btn-kw${(typeof canUploadDocs === "function" && canUploadDocs()) ? "" : " admin-only"}" id="pdVidBtn" title="Send a video link for timestamped review">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>
        Video link
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
              <div class="pd-video" id="pdVideo" style="display:none"></div>
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
            <div class="pd-vtimeline" id="pdVTimeline" style="display:none"></div>
            <div class="pd-draw-tools">
              <div class="pd-seg">
                <button class="pd-seg-btn active" data-tool="draw" id="pdToolDraw">✎ Draw</button>
                <button class="pd-seg-btn" data-tool="comment" id="pdToolComment">💬 Comment</button>
              </div>
              <button class="btn btn-primary pd-vcomment" id="pdVComment" style="display:none">💬 Comment at <span id="pdVTime">0:00</span></button>
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
            <div class="pd-save-state" id="pdSaveState"></div>

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

    <!-- Video-link builder. Sibling of #pdModal (raised from the gallery). -->
    <div class="pd-up-overlay" id="pdVidOverlay" style="display:none">
      <div class="pd-up-card pd-kw-card">
        <div class="pd-sign-title" id="pdVidTitle">Video for review</div>
        <div class="pd-sign-sub">Paste a link — YouTube, Vimeo, Loom, a Google Drive video or a direct .mp4. It plays inside the review screen, and the client comments at exact moments in the video.</div>
        <label class="pd-review-label" for="pdVidUrl">Video link <span class="pd-up-hint">— required</span></label>
        <input type="url" id="pdVidUrl" class="pd-up-subject" placeholder="https://youtu.be/… · https://vimeo.com/… · https://drive.google.com/file/d/…">
        <div class="pd-kw-hint" id="pdVidKind"></div>
        <div class="pd-vid-preview" id="pdVidPreview"><span class="pd-kw-phint">A preview appears here — make sure it plays before you send (private videos must be viewable by the client).</span></div>
        <label class="pd-review-label" for="pdVidSubject">Subject <span class="pd-up-hint">— required</span></label>
        <input type="text" id="pdVidSubject" class="pd-up-subject" placeholder="e.g. Brand video — rough cut">
        <label class="pd-review-label" for="pdVidMsg">Message to client <span class="pd-up-hint">— optional</span></label>
        <textarea id="pdVidMsg" class="pd-up-msg" placeholder="Context for this round — what you'd like feedback on…"></textarea>
        <div class="pd-revdue-row">
          <label class="pd-review-label" for="pdVidDue">Feedback due <span class="pd-up-hint" id="pdVidDueHint"></span></label>
          <input type="date" id="pdVidDue" class="pd-revdue">
        </div>
        <div class="pd-up-err" id="pdVidErr" style="display:none"></div>
        <div class="pd-sign-actions">
          <button class="pd-tool-btn" id="pdVidCancel">Cancel</button>
          <button class="btn btn-primary" id="pdVidSend">📤 Send to client</button>
        </div>
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
        <div class="pd-thumb">${thumbHtml(v, d.name)}</div>
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
        <div class="pd-thumb">${thumbHtml(v, d.name)}</div>
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
    const isNewDoc = !opts;              // V1 of a new deliverable → its own fresh folder
    const built = dataUrls.map(() => ({ pins: [], annotation: null }));
    const out = { name, pdfPages: pages, pdfRendered: rendered };
    /* ORIGINAL PDF FIRST — it creates (or joins) the deliverable's own folder, so the page images
       can then go into a tidy "<round> pages" subfolder INSIDE it rather than sitting loose beside
       the PDFs (Cameron 2026-10-01). Present Docs / <title> / { the PDFs, V1 pages/, V2 pages/ }. */
    if (store) {
      busySub("Saving the original PDF…");
      try {
        const src = await window.TJA_FILES.upload(file, { category: "present-docs", clientId: sess.client, name: file.name, subfolder,
          folderId, newFolder: isNewDoc });
        if (src && src.url) { out.sourceUrl = src.url; out.sourceName = file.name; }
        if (src && src.folderId) out.driveFolderId = src.folderId;
      } catch (e) { console.warn("original pdf upload failed — page images still saved", e); }
    }
    if (store) {
      busySub(multi ? `Uploading ${dataUrls.length} pages…` : "");
      try {
        const round = String((opts && opts.roundLabel) || "V1").replace(/\s*\(proposed\)\s*/i, "").trim() || "V1";
        // batched: 6 pages per request rather than one request per page
        const res = await window.TJA_FILES.uploadDataUrls(dataUrls,
          { category: "present-docs", clientId: sess.client, name, subfolder,
            folderId: folderId || out.driveFolderId || "",
            newFolder: isNewDoc && !out.driveFolderId,
            // a multi-page proof's pages get their own subfolder; a single page stays beside its PDF
            childFolder: multi ? round + " pages" : "" },
          (done, total) => busySub(total > 1 ? `Uploaded ${done} of ${total} pages…` : ""));
        res.forEach((r, i) => { if (r && r.url && built[i]) built[i].url = r.url; });
        if (res[0] && res[0].folderId && !out.driveFolderId) out.driveFolderId = res[0].folderId;
      } catch (e) { console.warn("pdf page upload — keeping inline", e); }
    }
    dataUrls.forEach((du, i) => { if (!built[i].url) built[i].dataUrl = du; });
    // Page 1 doubles as the version's own image so the gallery thumbnail and anything predating
    // pages keeps working with no special case.
    if (built[0].url) out.url = built[0].url; else out.dataUrl = built[0].dataUrl;
    if (multi) out.pages = built;
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
                subfolder: (opts && opts.subfolder) || name, folderId: (opts && opts.folderId) || "", newFolder: !opts });
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

  /* ---------- VIDEO REVIEW (a link that plays inside the review screen) ----------
     A video version carries v.videoUrl (+ provider/embed/thumb) instead of an image. Comments
     are ordinary pins with a TIME (p.t, seconds) instead of x/y — so replies, author rules,
     merging, the review lock, approvals, signatures, the team ping and the PDF all work
     unchanged. YouTube, Vimeo and direct files expose the playhead, so "Comment at 0:42"
     stamps the exact moment; Loom / Drive / other links can't be read from the page, so the
     reviewer types the time. */
  const isVideoV = (v) => !!(v && v.videoUrl);
  const isVideoDoc = (d) => !!(d && (d.kind === "video" || (d.versions || []).some(isVideoV)));
  function fmtT(sec) {
    if (sec == null || isNaN(sec)) return "—";
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
  }
  function parseT(str) {                       // "1:23", "01:02:03", "83" → seconds
    const p = String(str || "").trim().split(":").map(Number);
    if (!p.length || p.some(isNaN)) return null;
    return p.reduce((a, n) => a * 60 + n, 0);
  }
  function parseVideoUrl(raw) {
    let u; try { u = new URL(String(raw || "").trim()); } catch (e) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    const h = u.hostname.replace(/^(www|m)\./, "");
    let id;
    if (h === "youtu.be" || /(^|\.)youtube(-nocookie)?\.com$/.test(h)) {
      id = h === "youtu.be" ? u.pathname.slice(1).split("/")[0]
        : (u.searchParams.get("v") || (u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/) || [])[1]);
      if (id) return { provider: "youtube", id, embed: "https://www.youtube.com/embed/" + id, thumb: "https://img.youtube.com/vi/" + id + "/hqdefault.jpg", timed: true };
    }
    if (h === "vimeo.com" || h === "player.vimeo.com") {
      const m = u.pathname.match(/(?:\/video)?\/(\d+)(?:\/([\da-f]+))?/i);
      if (m) {
        const hash = m[2] || u.searchParams.get("h") || "";
        return { provider: "vimeo", id: m[1], embed: "https://player.vimeo.com/video/" + m[1] + (hash ? "?h=" + hash : ""), thumb: "", timed: true };
      }
    }
    if (h === "loom.com") {
      const m = u.pathname.match(/\/(?:share|embed)\/([\w]+)/);
      if (m) return { provider: "loom", id: m[1], embed: "https://www.loom.com/embed/" + m[1], thumb: "", timed: false };
    }
    if (h === "drive.google.com") {
      const m = u.pathname.match(/\/file\/d\/([\w-]+)/) || [null, u.searchParams.get("id")];
      if (m && m[1]) return { provider: "drive", id: m[1], embed: "https://drive.google.com/file/d/" + m[1] + "/preview", thumb: "", timed: false };
    }
    if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(u.pathname)) return { provider: "file", id: "", embed: u.href, thumb: "", timed: true };
    return { provider: "other", id: "", embed: u.href, thumb: "", timed: false };
  }
  const PROVIDER_NAME = { youtube: "YouTube", vimeo: "Vimeo", loom: "Loom", drive: "Google Drive", file: "Video file", other: "Web link" };
  function thumbHtml(v, alt) {
    if (isVideoV(v)) {
      return v.thumbUrl
        ? `<img src="${esc(v.thumbUrl)}" alt="${esc(alt)}"><span class="pd-vid-badge">▶ ${esc(PROVIDER_NAME[v.videoProvider] || "Video")}</span>`
        : `<div class="pd-vid-thumb">▶<span>${esc(PROVIDER_NAME[v.videoProvider] || "Video")}</span></div>`;
    }
    return `<img ${imgSrcAttr(v)} alt="${esc(alt)}">`;
  }
  function loadScriptOnce(src, ready) {
    if (ready()) return Promise.resolve();
    return new Promise((res, rej) => {
      let el = document.querySelector(`script[data-src="${src}"]`);
      if (!el) { el = document.createElement("script"); el.src = src; el.async = true; el.setAttribute("data-src", src); document.head.appendChild(el); }
      const t0 = Date.now();
      const wait = () => { if (ready()) return res(); if (Date.now() - t0 > 15000) return rej(new Error("player failed to load")); setTimeout(wait, 100); };
      wait();
    });
  }
  // One active player. getTime() → seconds or null (the provider can't tell us).
  const VID = { vid: null, provider: null, yt: null, vim: null, el: null, timer: null, duration: 0 };
  function exitVideo() {
    clearInterval(VID.timer); VID.timer = null;
    try { VID.yt && VID.yt.destroy && VID.yt.destroy(); } catch (e) {}
    try { VID.vim && VID.vim.destroy && VID.vim.destroy(); } catch (e) {}
    VID.vid = null; VID.provider = null; VID.yt = null; VID.vim = null; VID.el = null; VID.duration = 0;
    const box = $("pdVideo"); if (box) { box.innerHTML = ""; box.style.display = "none"; }
    const m = $("pdModal"); if (m) m.classList.remove("pd-videomode");
    ["pdVTimeline", "pdVComment"].forEach(id => { const e = $(id); if (e) e.style.display = "none"; });
  }
  async function vidTime() {
    try {
      if (VID.provider === "youtube" && VID.yt && VID.yt.getCurrentTime) return VID.yt.getCurrentTime();
      if (VID.provider === "vimeo" && VID.vim) return await VID.vim.getCurrentTime();
      if (VID.provider === "file" && VID.el) return VID.el.currentTime;
    } catch (e) {}
    return null;
  }
  function vidSeek(t) {
    if (t == null) return;
    try {
      if (VID.provider === "youtube" && VID.yt && VID.yt.seekTo) { VID.yt.seekTo(t, true); VID.yt.pauseVideo && VID.yt.pauseVideo(); }
      else if (VID.provider === "vimeo" && VID.vim) { VID.vim.setCurrentTime(t).then(() => VID.vim.pause()).catch(() => {}); }
      else if (VID.provider === "file" && VID.el) { VID.el.currentTime = t; VID.el.pause(); }
    } catch (e) {}
  }
  function vidPause() {
    try {
      if (VID.provider === "youtube" && VID.yt && VID.yt.pauseVideo) VID.yt.pauseVideo();
      else if (VID.provider === "vimeo" && VID.vim) VID.vim.pause().catch(() => {});
      else if (VID.provider === "file" && VID.el) VID.el.pause();
    } catch (e) {}
  }
  async function enterVideo(v) {
    const m = $("pdModal"); if (m) m.classList.add("pd-videomode");
    const box = $("pdVideo"); if (!box) return;
    box.style.display = "";
    const btn = $("pdVComment"); if (btn) btn.style.display = viewerCanMarkup() ? "" : "none";
    const tl = $("pdVTimeline"); if (tl) tl.style.display = "";
    setTool("comment");
    if (VID.vid === v.vid) return;                         // already playing this round
    exitVideo(); if (m) m.classList.add("pd-videomode"); box.style.display = ""; if (tl) tl.style.display = "";
    if (btn) btn.style.display = viewerCanMarkup() ? "" : "none";
    VID.vid = v.vid; VID.provider = v.videoProvider;
    const hint = VIDEO_TIMED[v.videoProvider] ? "" :
      `<div class="pd-vid-note">${esc(PROVIDER_NAME[v.videoProvider] || "This player")} doesn't share its playback position — type the time (e.g. 1:23) on each comment.</div>`;
    try {
      if (v.videoProvider === "youtube") {
        box.innerHTML = `<div class="pd-vid-frame"><div id="pdYt"></div></div>`;
        await loadScriptOnce("https://www.youtube.com/iframe_api", () => !!(window.YT && window.YT.Player));
        if (VID.vid !== v.vid) return;
        VID.yt = new window.YT.Player("pdYt", { videoId: v.videoId, width: "100%", height: "100%",
          playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
          events: { onReady: () => { try { VID.duration = VID.yt.getDuration() || 0; } catch (e) {} renderPins(); } } });
      } else if (v.videoProvider === "vimeo") {
        box.innerHTML = `<div class="pd-vid-frame"><iframe id="pdVim" src="${esc(v.videoEmbed)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
        await loadScriptOnce("https://player.vimeo.com/api/player.js", () => !!(window.Vimeo && window.Vimeo.Player));
        if (VID.vid !== v.vid) return;
        VID.vim = new window.Vimeo.Player($("pdVim"));
        VID.vim.getDuration().then(d => { VID.duration = d || 0; renderPins(); }).catch(() => {});
      } else if (v.videoProvider === "file") {
        box.innerHTML = `<div class="pd-vid-frame"><video id="pdVidEl" controls playsinline preload="metadata" src="${esc(v.videoEmbed)}"></video></div>`;
        VID.el = $("pdVidEl");
        VID.el.addEventListener("loadedmetadata", () => { VID.duration = VID.el.duration || 0; renderPins(); });
      } else {
        box.innerHTML = `<div class="pd-vid-frame"><iframe src="${esc(v.videoEmbed)}" allow="autoplay; fullscreen" allowfullscreen></iframe></div>${hint}`;
      }
    } catch (e) {
      box.innerHTML = `<div class="pd-vid-note">Couldn't load the video player (${esc(e && e.message || e)}). <a href="${esc(v.videoUrl)}" target="_blank" rel="noopener">Open the video in a new tab</a> and type the time on each comment.</div>`;
      VID.provider = "other";
    }
    VID.timer = setInterval(async () => {
      const t = await vidTime();
      const lbl = $("pdVTime"); if (lbl) lbl.textContent = t == null ? "…" : fmtT(t);
      const ph = document.querySelector(".pd-vt-head");
      if (ph && t != null && VID.duration) ph.style.left = Math.min(100, (t / VID.duration) * 100) + "%";
    }, 400);
  }
  const VIDEO_TIMED = { youtube: true, vimeo: true, file: true };
  // pins of a video round, in time order (untimed ones last) — the list AND the timeline use this
  function videoPins(v) {
    return (v.pins || []).slice().sort((a, b) => (a.t == null ? 1e12 : a.t) - (b.t == null ? 1e12 : b.t));
  }
  function renderTimeline(v) {
    const tl = $("pdVTimeline"); if (!tl) return;
    const pins = videoPins(v);
    const dur = VID.duration || Math.max(0, ...pins.map(p => p.t || 0)) || 0;
    tl.innerHTML = `<div class="pd-vt-track">${dur ? `<div class="pd-vt-head"></div>` : ""}` +
      pins.map((p, i) => (p.t == null || !dur) ? "" :
        `<button class="pd-vt-mark${(p.replies && p.replies.length) ? " has-replies" : ""}" data-seek="${p.t}" data-pin="${esc(p.id)}" title="${esc(fmtT(p.t))} · ${esc(pinAuthor(p))}" style="left:${Math.min(100, (p.t / dur) * 100)}%">${i + 1}</button>`).join("") +
      `</div><div class="pd-vt-legend">${pins.length ? pins.length + " comment" + (pins.length === 1 ? "" : "s") + " — click a marker or a timestamp to jump there" : "Pause where you want to comment, then press “💬 Comment at …”"}</div>`;
  }
  async function addVideoComment() {
    if (!viewerCanMarkup()) return;
    const v = active(deliv(curId)); if (!isVideoV(v)) return;
    let t = await vidTime();
    vidPause();
    const p = { id: "p_" + Date.now() + "_" + (seq++), t: t == null ? null : Math.round(t * 10) / 10, x: null, y: null,
      text: "", resolved: false, by: myName(), byEmail: myEmail() };
    v.pins = (v.pins || []).concat([p]);
    history.push({ type: "pinAdd", id: p.id });
    saveCur(); renderPins(); renderPinList();
    const ta = document.querySelector(`[data-pintext="${p.id}"]`);
    if (ta) { ta.focus(); try { ta.scrollIntoView({ block: "nearest" }); } catch (e) {} }
  }

  /* the send dialog (V1, or a new round of an existing video deliverable) */
  let vidParentId = null;
  function openVideoDialog(parent) {
    const ov = $("pdVidOverlay"); if (!ov) return;
    vidParentId = parent ? parent.id : null;
    const prev = parent ? active(parent) : null;
    $("pdVidUrl").value = "";
    $("pdVidSubject").value = parent ? (parent.name || "") : "";
    $("pdVidMsg").value = ""; $("pdVidDue").value = "";
    $("pdVidErr").style.display = "none";
    $("pdVidKind").textContent = prev ? `Previous round: ${prev.videoUrl}` : "";
    $("pdVidPreview").innerHTML = `<span class="pd-kw-phint">A preview appears here — make sure it plays before you send (private videos must be viewable by the client).</span>`;
    const r = uploadRules();
    $("pdVidDueHint").textContent = r.due ? "— required" : "— optional"; $("pdVidDueHint").classList.toggle("req", r.due);
    $("pdVidTitle").textContent = parent ? "Video — new round" : "Video for review";
    $("pdVidSend").textContent = (uploadsToDraft() || parent) ? "Add to waiting room" : "📤 Send to client";
    ov.style.display = "flex";
    setTimeout(() => $("pdVidUrl").focus(), 0);
  }
  function closeVideoDialog() { const ov = $("pdVidOverlay"); if (ov) { ov.style.display = "none"; $("pdVidPreview").innerHTML = ""; } vidParentId = null; }
  let vidPrevTimer = null;
  function videoPreview() {
    clearTimeout(vidPrevTimer);
    vidPrevTimer = setTimeout(() => {
      const info = parseVideoUrl($("pdVidUrl").value);
      const box = $("pdVidPreview"); const kind = $("pdVidKind");
      if (!info) { box.innerHTML = `<span class="pd-kw-phint">Paste a full https:// link.</span>`; kind.textContent = ""; return; }
      kind.textContent = `${PROVIDER_NAME[info.provider]} · ${info.timed ? "comments are stamped automatically at the paused moment" : "reviewers type the time on each comment (this player doesn't share its position)"}`;
      box.innerHTML = info.provider === "file"
        ? `<video controls preload="metadata" src="${esc(info.embed)}"></video>`
        : `<iframe src="${esc(info.embed)}" allow="fullscreen" allowfullscreen></iframe>`;
    }, 350);
  }
  let vidBusy = false;
  async function commitVideo() {
    if (vidBusy) return;
    const info = parseVideoUrl($("pdVidUrl").value);
    const subject = $("pdVidSubject").value.trim(), message = $("pdVidMsg").value.trim(), due = $("pdVidDue").value;
    const err = $("pdVidErr");
    const missing = [];
    if (!info) missing.push("a valid video link (https://…)");
    if (!subject) missing.push("Subject");
    if (uploadRules().due && !due) missing.push("Feedback due");
    if (missing.length) { err.textContent = "Please add: " + missing.join(", ") + "."; err.style.display = ""; return; }
    const parent = vidParentId ? items.find(x => x.id === vidParentId) : null;
    const toDraft = uploadsToDraft() || !!parent;
    const label = parent ? "V" + (parent.versions.length + 1) + (toDraft ? " (proposed)" : "") : "V1";
    const v = newVersion({}, label);
    Object.assign(v, { videoUrl: $("pdVidUrl").value.trim(), videoProvider: info.provider, videoId: info.id,
      videoEmbed: info.embed, thumbUrl: info.thumb || "", subject, message, revisionsDue: due });
    vidBusy = true; const btn = $("pdVidSend"); const old = btn.textContent; btn.disabled = true; btn.textContent = "Sending…";
    try {
      if (toDraft) {
        v.state = "pending_approval";
        const card = { id: uid(), name: subject, active: 0, versions: [v], kind: "video" };
        if (parent) card.parentId = parent.id;
        draftItems.unshift(card);
        if (window.TJA_NOTIFY) { try { window.TJA_NOTIFY.record({ type: "upload", docId: card.id, docName: subject, versionLabel: v.label, by: sess.name || "Staff" }); } catch (e) {} }
        const w = await saveDraftsNow();
        renderGallery();
        if (w && w.ok === false) { err.textContent = "Couldn't save to the waiting room yet (" + (w.error || "network") + ") — it will keep retrying; don't close this page."; err.style.display = ""; return; }
        closeVideoDialog();
        flashDocsToast(`${subject} staged — click “📤 Send to client” to submit it for review.`);
        return;
      }
      const reviewers = await reviewersForSend();
      if (reviewers === null) return;
      stampRound(v, reviewers);
      v.sentAt = stamp(); v.sentBy = sess.name || sess.email || "TJA";
      const item = { id: uid(), name: subject, active: 0, versions: [v], kind: "video" };
      items.unshift(item);
      const w = await saveNow();
      if (w && w.ok === false) {
        items = items.filter(x => x.id !== item.id); renderGallery();
        err.textContent = "Send failed (" + (w.error || "network") + ") — nothing reached the client. Press Send to try again."; err.style.display = "";
        return;
      }
      closeVideoDialog(); renderGallery();
      announceSend({ id: item.id, name: subject, version: v });
      warnNoReviewers(reviewers);
    } finally { vidBusy = false; btn.disabled = false; btn.textContent = old; }
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
          folderId: (kwParent && kwParent.driveFolderId) || "", newFolder: !kwParent });
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
    const reviewers = await reviewersForSend();
    if (reviewers === null) return;
    stampRound(v, reviewers);
    v.sentAt = stamp(); v.sentBy = sess.name || sess.email || "TJA";
    const item = { id: uid(), name: subject, active: 0, versions: [v], kind: "keywords", driveFolderId: img.driveFolderId || null };
    items.unshift(item);
    const w = await saveNow();
    if (w && w.ok === false) {
      items = items.filter(x => x.id !== item.id); renderGallery();
      window.TJA_UI.alert("Send failed (" + (w.error || "network") + ") — nothing reached the client. Please try again.", { title: "Not sent" });
      return;
    }
    renderGallery();
    announceSend({ id: item.id, name: subject, version: v });
    warnNoReviewers(reviewers);
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
    // A first-round draft named by the creative may be retitled on release — the card AND its
    // Drive folder follow the subject, so the folder always matches the Present Doc's title.
    if (!parent && subject && subject !== d.name) {
      d.name = subject;
      if (d.driveFolderId && window.TJA_FILES && window.TJA_FILES.renameFolder)
        window.TJA_FILES.renameFolder(d.driveFolderId, subject, sess.client).catch(e => console.warn("drive folder rename failed", e));
    }
    if (specsVal) { if (parent) parent.specs = specsVal; else d.specs = specsVal; }
    pendingSendDraftId = null;
    closeUploadDialog();
    await sendDraft(draftId);
  }
  // Upload routing: an admin/AM-PM upload goes STRAIGHT to the client — so it is itself
  // a send, and announces (notification + email) via announceSend. A CREATIVE'S upload
  // lands in the waiting room and stays silent to the client until an AM/PM releases it.
  const uploadsToDraft = () => (typeof isCreative === "function" && isCreative());
  let uploadBusy = false;
  async function commitUpload() {
    if (uploadBusy) return;
    const subject = $("pdUpSubject") ? $("pdUpSubject").value.trim() : "";
    const message = $("pdUpMsg") ? $("pdUpMsg").value.trim() : "";
    const due = $("pdUpDue") ? $("pdUpDue").value : "";
    const showErr = (msg) => { const err = $("pdUpErr"); if (err) { err.textContent = msg; err.style.display = ""; } else window.TJA_UI.alert(msg); };
    // validate required fields (only when the dialog is actually present)
    if ($("pdUpOverlay") && $("pdUpErr")) {
      const r = uploadRules();
      const specsVal = $("pdUpSpecs") ? $("pdUpSpecs").value.trim() : "";
      const missing = [];
      if (!subject) missing.push("Subject");
      if (r.specs && !specsVal) missing.push("Specifications");
      if (r.due && !due) missing.push("Feedback due");
      if (missing.length) { showErr("Please fill in: " + missing.join(", ") + "."); return; }
    }
    // Specifications: OPTIONAL (an AM/PM uploading may not know them — Cameron 2026-07-20).
    // Lives on the DELIVERABLE (set at V1, carried by every later version) — it describes
    // the artwork, not the round. Shown small on the review screen + in the PDF header.
    const specs = $("pdUpSpecs") ? $("pdUpSpecs").value.trim() : "";
    const toDraft = uploadsToDraft();
    const batch = (pendingUpload || []).slice();
    const multi = batch.length > 1;
    // The card is named by the SUBJECT you typed, not the raw filename — that's what the
    // client reads in the gallery. Falls back to the filename if the subject is left blank.
    // When several files share one subject, the filename is appended so the cards stay
    // tellable apart (they'd otherwise all carry the same name).
    const nameFor = (p) => !subject ? p.name : (multi ? subject + " — " + p.name : subject);
    const btn = $("pdUpSend"); const label = btn ? btn.textContent : "";
    uploadBusy = true; if (btn) { btn.disabled = true; btn.textContent = toDraft ? "Saving…" : "Sending…"; }
    try {
      // Straight-to-client sends confirm WHO must review before anything is written.
      let reviewers = [];
      if (!toDraft) { reviewers = await reviewersForSend(); if (reviewers === null) return; }
      /* The Drive folder was created at file-select time and named after the FILE — the subject
         didn't exist yet. Now it does, so rename it to match the Present Doc's title. Every
         deliverable has its OWN folder (created fresh, never shared by name). */
      renameFolders(batch, nameFor);
      const added = [];
      batch.forEach(p => {
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
          stampRound(v, reviewers);
          v.sentAt = stamp(); v.sentBy = sess.name || sess.email || "TJA";
          // capture the DELIVERABLE id (not v.vid) — it's what openModal / the email
          // deep-link (?open=docs&doc=<id>) resolve against.
          const item = { id: uid(), name: name, active: 0, versions: [v], specs: specs, driveFolderId: p.driveFolderId || null };
          items.unshift(item);
          added.push(item);
        }
      });
      if (toDraft) {
        const w = await saveDraftsNow();
        renderGallery();
        if (w && w.ok === false) { showErr("Couldn't save to the waiting room yet (" + (w.error || "network") + ") — it will keep retrying; don't close this page."); return; }
        closeUploadDialog(); return;
      }
      // The deliverable must be SAVED before the client is emailed about it — otherwise the email
      // could point at something that never landed.
      const w = await saveNow();
      if (w && w.ok === false) {
        const ids = new Set(added.map(x => x.id));
        items = items.filter(x => !ids.has(x.id)); renderGallery();
        showErr("Send failed (" + (w.error || "network") + ") — nothing reached the client. Press Send to try again.");
        return;
      }
      closeUploadDialog();
      renderGallery();
      added.forEach(item => announceSend({ id: item.id, name: item.name, version: item.versions[0] }));
      warnNoReviewers(reviewers);
    } finally {
      uploadBusy = false; if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }
  function renameFolders(batch, nameFor) {
    if (!(window.TJA_FILES && window.TJA_FILES.renameFolder)) return;
    const seen = new Set();
    (batch || []).forEach(p => {
      if (!p.driveFolderId || seen.has(p.driveFolderId)) return;
      seen.add(p.driveFolderId);
      const nm = nameFor(p); if (!nm) return;
      window.TJA_FILES.renameFolder(p.driveFolderId, nm, sess.client)
        .catch(e => console.warn("drive folder rename failed", e));
    });
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
          // expectedReviewers is stamped BEFORE the send now (reviewersForSend). This is only a
          // belt-and-braces reconcile for a version that somehow went out without it — and it
          // re-finds the version by id, because `items` may have been replaced since.
          const live = findVersion(version.vid);
          if (live && !Array.isArray(live.expectedReviewers) && res && Array.isArray(res.reviewers) && res.reviewers.length) {
            live.expectedReviewers = res.reviewers.map(e => String(e).toLowerCase());
            live.reviews = live.reviews || {};
            saveNow().then(() => renderGallery());
          }
        }).catch(() => {});
      } catch (e) { console.warn("deliverable email failed", e); }
    }
  }
  // find a version anywhere in the live (sent) items by its stable id
  function findVersion(vid) {
    for (const d of items) for (const v of (d.versions || [])) if (v && v.vid === vid) return v;
    return null;
  }
  /* WHO MUST REVIEW this round — fetched BEFORE the version is written, so it's part of the
     round's very first save. If it can't be confirmed, the send is refused (with the reason)
     rather than going out as a silent single-approver round. */
  async function reviewersForSend() {
    if (!(window.TJA_MAIL && window.TJA_MAIL.fetchReviewers)) return [];
    try {
      const r = await window.TJA_MAIL.fetchReviewers(sess.client);
      return r.reviewers || [];
    } catch (e) {
      window.TJA_UI.alert("Couldn't confirm who needs to review this (" + (e && e.message || e) + "). Nothing was sent — please try again.", { title: "Not sent" });
      return null;
    }
  }
  function stampRound(v, reviewers) {
    if (!v) return;
    if (reviewers && reviewers.length) { v.expectedReviewers = reviewers.slice(); v.reviews = {}; }
  }
  function warnNoReviewers(reviewers) {
    if (reviewers && !reviewers.length && supaOn())
      flashDocsToast("⚠ This client has no portal logins yet — nobody can review this until you invite them in the Admin Center.", 7000);
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
    try { p = await processFile(file, { folderId: d.driveFolderId || "", subfolder: d.name || "",
      roundLabel: "V" + (d.versions.length + 1) }); }   // the round these pages belong to
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
    const reviewers = await reviewersForSend();
    if (reviewers === null) return;                      // couldn't confirm → nothing sent
    stampRound(draft.versions[draft.versions.length - 1], reviewers);
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
    draftDeleted.add(draft.id);
    draftItems = draftItems.filter(x => x.id !== draft.id);
    await saveDraftsNow();
    // 3. tell the client — the same announcement a direct upload makes
    const sentV = parent ? parent.versions[parent.versions.length - 1] : draft.versions[draft.versions.length - 1];
    const sentName = parent ? parent.name : draft.name;
    announceSend({ id: (parent || draft).id, name: sentName, version: sentV });
    warnNoReviewers(reviewers);
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
  /* Only a surface this person actually DREW on (or cleared) is written back — re-saving an
     untouched canvas would re-encode it and, worse, could replace someone else's markup. */
  let canvasTouched = false;
  function persistCanvas() {
    const d = deliv(curId); if (!d || !ctx || !cv || !canvasTouched) return false;
    const v = active(d); if (!v) return false;
    // a reviewer whose lock lapsed (sleep, dropped connection) must never write their canvas
    // over whoever holds the proof now
    if (clientEyes() && isRealClient() && !holdsLock()) { canvasTouched = false; return false; }
    const ps = pagesOf(v);
    surface(v).annotation = isBlank(cv) ? null : cv.toDataURL("image/png");
    dirtyAnno.add(sfKeyOf(v, ps ? Math.min(Math.max(0, curPage), ps.length - 1) : null));
    canvasTouched = false; editSeq++;
    return true;
  }
  function loseLock() {                // the moment we know the lock is gone: drop unsaved strokes
    LOCK.lost = true; canvasTouched = false; dirtyAnno.clear();
  }
  function isBlank(c) {
    const b = document.createElement("canvas"); b.width = c.width; b.height = c.height;
    return c.toDataURL() === b.toDataURL();
  }

  /* ---------- who may do what on the open proof ----------
     markup  = drop/move/edit/delete MY pins + draw. A client needs the review lock, an open
               round, and not to have submitted yet; staff keep their existing abilities.
     reply   = answer anyone's comment. A client needs the lock + an open round (replying after
               you've submitted is fine — that's how teammates settle a question); staff who can
               edit this client may reply too. */
  const clientEyes = () => (typeof effectiveRole === "function") ? effectiveRole() === "client" : true;
  function versionDone(v) { return !!(v && (v.reviewedAt || (expectedOf(v).length && reviewComplete(v)))); }
  function holdsLock() { return !supaOn() || !isRealClient() || (LOCK.docId === curId && !LOCK.lost); }
  function viewerCanMarkup() {
    const d = deliv(curId); const v = active(d); if (!v) return false;
    if (typeof isCreative === "function" && isCreative() && !isDraft(d)) return false;
    if (!clientEyes()) return true;
    const mineDone = expectedOf(v).length ? !!myReviewOf(v) : !!v.reviewedAt;
    return holdsLock() && !mineDone && !versionDone(v);
  }
  function viewerCanReply() {
    const d = deliv(curId); const v = active(d); if (!v || isDraft(d)) return false;
    if (!clientEyes()) return (typeof canEdit === "function" ? canEdit() : false) && !(typeof isCreative === "function" && isCreative());
    if (versionDone(v)) return false;
    const filed = expectedOf(v).length ? !!myReviewOf(v) : !!v.reviewedAt;
    return holdsLock() || (filed && isRealClient());
  }
  // a pin's own text/resolve/delete: its author (clients) or staff
  function canEditPin(p) {
    if (!viewerCanMarkup()) return false;
    if (!clientEyes()) return true;
    return !p.byEmail || p.byEmail === myEmail();
  }
  const pinAuthor = (p) => p.by || (p.byEmail ? p.byEmail.split("@")[0] : "");

  /* ---------- pins ---------- */
  function renderPins() {
    if (isVideoV(active(deliv(curId)))) { renderTimeline(active(deliv(curId))); const l = $("pdPins"); if (l) l.innerHTML = ""; return; }
    const v = curSurface(); const layer = $("pdPins");
    layer.innerHTML = v.pins.map((p, i) =>
      `<button class="pd-pin ${p.resolved ? "resolved" : ""}${(p.replies && p.replies.length) ? " has-replies" : ""}" data-pin="${p.id}" title="${esc(pinAuthor(p))}${(p.replies && p.replies.length) ? " · " + p.replies.length + " repl" + (p.replies.length === 1 ? "y" : "ies") : ""}" style="left:${p.x * 100}%;top:${p.y * 100}%">${i + 1}</button>`).join("");
  }
  function repliesHtml(p) {
    const me = myEmail();
    return (p.replies || []).map(r => `
      <div class="pd-reply">
        <div class="pd-reply-top"><b>${esc(r.by || (r.byEmail || "").split("@")[0])}</b><span class="pd-reply-at">${esc(r.at || "")}</span>
          ${(r.byEmail === me && viewerCanReply()) ? `<button class="pd-cbtn danger pd-reply-del" data-replydel="${esc(p.id)}::${esc(r.id)}" title="Delete reply">✕</button>` : ""}</div>
        <div class="pd-reply-text">${esc(r.text)}</div>
      </div>`).join("");
  }
  function replyBoxHtml(p) {
    if (!viewerCanReply()) return "";
    return `<div class="pd-reply-new"><textarea data-replytext="${esc(p.id)}" placeholder="Reply to ${esc(pinAuthor(p) || "this comment")}…"></textarea>
      <button class="pd-tool-btn" data-replysend="${esc(p.id)}">Reply</button></div>`;
  }
  function renderPinList() {
    const v = curSurface(); const box = $("pdPinList");
    const n = v.pins.length;
    const cc = $("pdCommentsCount"); if (cc) cc.textContent = n ? `Comments (${n})` : "Comments";
    const clr = $("pdClearComments"); if (clr) clr.style.display = (n && !clientEyes() && viewerCanMarkup()) ? "" : "none";
    if (!n) { box.innerHTML = `<div class="pd-pinlist-empty">${viewerCanMarkup() ? "Switch to the Comment tool and click the image to pin a note." : "No comments on this page."}</div>`; return; }
    const isVid = isVideoV(active(deliv(curId)));
    const list = isVid ? videoPins(v) : v.pins;
    box.innerHTML = list.map((p, i) => {
      const editable = canEditPin(p);
      const tchip = !isVid ? "" : (p.t != null
        ? `<button class="pd-vts" data-seek="${p.t}" title="Jump to ${esc(fmtT(p.t))}">▶ ${esc(fmtT(p.t))}</button>`
        : (editable ? `<input class="pd-vts-in" data-pintime="${p.id}" placeholder="m:ss" title="Time in the video">` : `<span class="pd-vts none">no time</span>`));
      return `
      <div class="pd-comment ${p.resolved ? "resolved" : ""}" data-row="${p.id}">
        <div class="pd-comment-top">
          <span class="pd-pinnum">${i + 1}</span>${tchip}
          ${pinAuthor(p) ? `<span class="pd-pin-by" title="${esc(p.byEmail || "")}">${esc(pinAuthor(p))}${p.byEmail && p.byEmail === myEmail() ? " (you)" : ""}</span>` : ""}
          <div class="pd-comment-actions">
            ${editable ? `<button class="pd-cbtn ok" data-resolve="${p.id}" title="${p.resolved ? "Reopen" : "Mark resolved"}">${p.resolved ? "↩" : "✓"}</button>
            <button class="pd-cbtn danger" data-pindel="${p.id}" title="Delete">✕</button>` : ""}
          </div>
        </div>
        ${editable
          ? `<textarea data-pintext="${p.id}" placeholder="Add a note for pin ${i + 1}…">${esc(p.text)}</textarea>`
          : `<div class="pd-comment-text">${esc(p.text) || "<em>(no note)</em>"}</div>`}
        ${(p.replies && p.replies.length) ? `<div class="pd-replies">${repliesHtml(p)}</div>` : ""}
        ${replyBoxHtml(p)}
      </div>`;
    }).join("");
  }
  function addPin(xFrac, yFrac) {
    if (!viewerCanMarkup()) return;
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
    if (index < 0 || !canEditPin(v.pins[index])) return;
    const [pin] = v.pins.splice(index, 1);
    history.push({ type: "pinDel", pin, index });
    const pop = $("pdPopup"); if (pop && pop.dataset.pin === id) hidePopup();
    saveCur(); renderPins(); renderPinList();
  }
  function clearComments() {
    const v = curSurface(); if (!v.pins.length || !viewerCanMarkup() || clientEyes()) return;
    history.push({ type: "pinClear", pins: v.pins.slice() });
    v.pins = [];
    hidePopup(); saveCur(); renderPins(); renderPinList();
  }
  function toggleResolve(id) {
    const v = curSurface(); const p = v.pins.find(x => x.id === id); if (!p || !canEditPin(p)) return;
    p.resolved = !p.resolved; saveCur(); renderPins(); renderPinList();
  }
  function addReply(pinId, text) {
    const t = String(text || "").trim(); if (!t || !viewerCanReply()) return false;
    const v = curSurface(); const p = v.pins.find(x => x.id === pinId); if (!p) return false;
    p.replies = (p.replies || []).concat([{ id: "r_" + Date.now() + "_" + (seq++), by: myName(), byEmail: myEmail(),
      text: t, at: stamp(), atMs: Date.now() }]);
    saveCur(); renderPins(); renderPinList();
    const pop = $("pdPopup"); if (pop && pop.dataset.pin === pinId) showPopup(p, true);
    return true;
  }
  function deleteReply(pinId, replyId) {
    const v = curSurface(); const p = v.pins.find(x => x.id === pinId); if (!p || !viewerCanReply()) return;
    const r = (p.replies || []).find(x => x.id === replyId); if (!r || r.byEmail !== myEmail()) return;
    p.replies = p.replies.filter(x => x.id !== replyId);
    if (!p.replies.length) delete p.replies;
    saveCur(); renderPins(); renderPinList();
    const pop = $("pdPopup"); if (pop && pop.dataset.pin === pinId) showPopup(p);
  }
  function selectPin(id) {
    const av = active(deliv(curId));
    if (isVideoV(av)) {
      const p = (av.pins || []).find(x => x.id === id);
      document.querySelectorAll(".pd-comment").forEach(c => c.classList.toggle("sel", c.dataset.row === id));
      if (p && p.t != null) vidSeek(p.t);
      return;
    }
    document.querySelectorAll(".pd-pin").forEach(m => m.classList.toggle("sel", m.dataset.pin === id));
    document.querySelectorAll(".pd-comment").forEach(c => c.classList.toggle("sel", c.dataset.row === id));
    const m = document.querySelector(`.pd-pin[data-pin="${id}"]`);
    if (m) { m.classList.add("pulse"); setTimeout(() => m.classList.remove("pulse"), 700); }
    const v = curSurface(); const p = v && v.pins.find(x => x.id === id);
    if (p) showPopup(p);   // bring the note up on the image, anchored to the pin
  }

  /* ---------- in-image comment popup (anchored to the pin) ----------
     Shows who wrote the comment, its note (editable only by its author), the whole reply
     thread, and a reply box — so reviewers can answer each other right on the pin. */
  function showPopup(p, noFocus) {
    const wrap = $("pdWrap"), pins = $("pdPins"), pop = $("pdPopup");
    if (!wrap || !pins || !pop) return;
    const ox = parseFloat(pins.style.left) || 0, oy = parseFloat(pins.style.top) || 0;
    const pw = parseFloat(pins.style.width) || 0, ph = parseFloat(pins.style.height) || 0;
    const px = panX + (ox + p.x * pw) * zoom, py = panY + (oy + p.y * ph) * zoom;   // account for zoom/pan
    pop.dataset.pin = p.id;
    const editable = canEditPin(p);
    const ta = pop.querySelector("[data-popuptext]");
    ta.value = p.text || "";
    ta.style.display = editable ? "" : "none";
    let extra = pop.querySelector(".pd-popup-extra");
    if (!extra) { extra = document.createElement("div"); extra.className = "pd-popup-extra"; pop.appendChild(extra); }
    let head = pop.querySelector(".pd-popup-head");
    if (!head) { head = document.createElement("div"); head.className = "pd-popup-head"; pop.insertBefore(head, ta); }
    head.innerHTML = pinAuthor(p) ? `<b>${esc(pinAuthor(p))}</b>${p.byEmail === myEmail() ? " (you)" : ""}` : "";
    extra.innerHTML = (editable ? "" : `<div class="pd-comment-text">${esc(p.text) || "<em>(no note)</em>"}</div>`) +
      ((p.replies && p.replies.length) ? `<div class="pd-replies">${repliesHtml(p)}</div>` : "") + replyBoxHtml(p);
    pop.style.display = "block";
    const popW = pop.offsetWidth || 230, popH = pop.offsetHeight || 110;
    let left = px + 18, top = py - 12;
    if (left + popW > wrap.clientWidth - 4) left = px - popW - 18;
    if (left < 4) left = 4;
    top = Math.max(4, Math.min(top, wrap.clientHeight - popH - 4));
    pop.style.left = left + "px"; pop.style.top = top + "px";
    const focusEl = editable ? ta : pop.querySelector("[data-replytext]");
    if (focusEl && !noFocus) focusEl.focus();
  }
  function hidePopup() { const pop = $("pdPopup"); if (pop) { pop.style.display = "none"; pop.dataset.pin = ""; } }
  function syncPopup(p) { const pop = $("pdPopup"); if (pop && pop.dataset.pin === p.id) { const ta = pop.querySelector("[data-popuptext]"); if (ta && ta.value !== p.text) ta.value = p.text; } }

  /* ---------- unified undo ---------- */
  function undo() {
    const a = history.pop();
    if (!a) return;
    if (a.type === "draw") {
      if (ctx && a.img) { ctx.putImageData(a.img, 0, 0); canvasTouched = true; }
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
    if (persistCanvas()) saveCur();    // bank this page's drawing before leaving it
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
    if (persistCanvas()) saveCur();
    d.active = i;
    curPage = 0;                      // a new round starts at its first page
    loadVersionIntoModal();
    maybeShowDisclaimer();   // each version is its own proof — first view gets the disclaimer
  }

  /* ---------- modal ---------- */
  function loadVersionIntoModal() {
    const d = deliv(curId); const v = active(d);
    history = []; canvasTouched = false; hidePopup(); resetZoom(); closeSignaturePad(); updateSignStatus();
    $("pdTitle").textContent = d.name;
    const _clientView = typeof effectiveRole === "function" && effectiveRole() === "client";
    // Multi-reviewer client: the notes box is MINE (my review entry), teammates' notes render
    // read-only in the peer panel below. Everyone else keeps the legacy shared field.
    // (a submitted review wins; otherwise my saved DRAFT — so notes survive closing the proof)
    const _draft = (_clientView && expectedOf(v).length) ? myDraftOf(v) : null;
    if (_draft && _draft.status && pendingSel[v.vid] == null && !myReviewOf(v)) pendingSel[v.vid] = _draft.status;
    $("pdClientNotes").value = (_clientView && expectedOf(v).length)
      ? (myReviewOf(v) ? (myReviewOf(v).notes || "") : ((_draft && _draft.notes) || ""))
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
    if (isVideoV(v)) { enterVideo(v); renderPins(); renderPinList(); return; }
    exitVideo();
    const img = $("pdImg");
    // Robust paint: wait (up to ~20 frames) until the image is decoded AND laid
    // out (clientWidth > 0) before sizing the canvas/pin overlay. Fixes markup +
    // comment pins silently failing when the modal opens or an image is cached.
    const paint = (tries) => {
      tries = tries || 0;
      if ((!img.clientWidth || !img.naturalWidth) && tries < 20) { requestAnimationFrame(() => paint(tries + 1)); return; }
      sizeOverlay();
      if (ctx) ctx.clearRect(0, 0, cv.width, cv.height);
      { const ps = pagesOf(v); const k = sfKeyOf(v, ps ? Math.min(Math.max(0, curPage), ps.length - 1) : null);
        if (!dirtyAnno.has(k)) annoLoaded.set(k, surface(v).annotation || null); }
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
  /* ---------- ONE CLIENT REVIEWER AT A TIME ----------
     A client login opening a proof whose round is still open takes the deliverable's review
     lock (review-lock Edge Function). Anyone else gets "<Name> is currently reviewing". The lock
     heartbeats every 20s and frees itself ~60s after a tab closes or drops offline. Staff never
     lock. Completed rounds open read-only without a lock (nothing left to edit). */
  const LOCK_SESSION = "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  const LOCK = { docId: null, timer: null, lost: false, fails: 0 };
  const isRealClient = () => !!(getSession && getSession() && getSession().role === "client");
  function roundOpen(d) {
    const last = d && d.versions && [...d.versions].reverse().find(v => v.state !== "pending_approval");
    return !!(last && !(last.reviewedAt || (expectedOf(last).length && reviewComplete(last))));
  }
  // Only someone who still has a review to FILE takes the lock. After you've submitted you can
  // still read and reply (replies merge per author, safely, without the lock) — and you no longer
  // block a teammate who hasn't reviewed yet.
  function mineFiled(d) {
    const last = d && d.versions && [...d.versions].reverse().find(v => v.state !== "pending_approval");
    return !!(last && (expectedOf(last).length ? myReviewOf(last) : last.reviewedAt));
  }
  const needsLock = (d) => isRealClient() && !!d && !isDraft(d) && roundOpen(d) && !mineFiled(d) && supaOn();
  const needsLockFor = (id) => { const d = deliv(id); return isRealClient() && !!d && !isDraft(d) && roundOpen(d) && supaOn(); };
  /* IDLE RELEASE: a proof left open with nobody at the keyboard must not block teammates all
     day. After 10 minutes without activity the work is saved, the lock is released and the
     proof turns read-only with a note to reopen it. */
  const IDLE_MS = 10 * 60 * 1000;
  let lastActivity = Date.now();
  ["pointerdown", "keydown", "wheel"].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, true));
  async function acquireLock(d) {
    LOCK.releaseWhenSaved = false;
    if (LOCK.docId && LOCK.docId !== d.id) { await flushPending(); dirtyAnno.clear(); await releaseLock(); }
    const res = await window.TJA_MAIL.reviewLock("acquire", d.id, LOCK_SESSION);
    if (!res.ok) return res;
    LOCK.docId = d.id; LOCK.lost = false; LOCK.idle = false; LOCK.fails = 0; lastActivity = Date.now();
    clearInterval(LOCK.timer);
    LOCK.timer = setInterval(heartbeatLock, 20000);
    return res;
  }
  // confirm we STILL hold the lock right now (before any write that could overwrite a drawing)
  async function confirmLock() {
    if (!LOCK.docId || LOCK.lost) return false;
    try {
      const r = await window.TJA_MAIL.reviewLock("heartbeat", LOCK.docId, LOCK_SESSION);
      if (!r.ok) { loseLock(); applyReviewLock(); return false; }
      return true;
    } catch (e) { return false; }
  }
  async function heartbeatLock() {
    if (!LOCK.docId) return;
    if (!curId && LOCK.releaseWhenSaved) { maybeReleaseAfterSave(); if (!LOCK.docId) return; }
    if (!LOCK.lost && curId === LOCK.docId && Date.now() - lastActivity > IDLE_MS) {
      const still = await confirmLock();
      LOCK.idle = true;
      if (still && persistCanvas()) save();
      await flushPending();          // save WHILE still holding it (the drawing graft needs dirtyAnno)
      loseLock();
      const id = LOCK.docId;
      clearInterval(LOCK.timer); LOCK.timer = null;
      try { await window.TJA_MAIL.reviewLock("release", id, LOCK_SESSION); } catch (e) {}
      applyReviewLock();
      window.TJA_UI.alert("This proof was paused after 10 minutes without activity so your teammates can review it. Everything you'd entered is saved — close it and open it again to continue.",
        { title: "Review paused" });
      return;
    }
    try {
      const r = await window.TJA_MAIL.reviewLock("heartbeat", LOCK.docId, LOCK_SESSION);
      LOCK.fails = 0;
      if (!r.ok && !LOCK.lost) {
        // our lock lapsed (connection dropped / laptop slept) and someone else took the proof
        loseLock();
        applyReviewLock();
        window.TJA_UI.alert(`Your review session timed out (the connection dropped) and ${(r.holder && r.holder.name) || "another reviewer"} is now reviewing this deliverable. Your comments and notes are saved; any drawing made while the connection was down couldn't be kept. Please close it and try again later.`,
          { title: "Review paused" });
      }
    } catch (e) { LOCK.fails++; }
  }
  // Called after every save: once the proof is closed AND everything is saved, free the lock.
  // If the save is still failing, we keep holding it (heartbeating) so nobody opens a copy
  // that's missing this person's work; it frees the moment the retry lands.
  function maybeReleaseAfterSave() {
    if (!LOCK.releaseWhenSaved || SAVE.dirty || SAVE.busy || submitBusy || curId) return;
    LOCK.releaseWhenSaved = false; dirtyAnno.clear(); releaseLock();
  }
  async function releaseLock() {
    const id = LOCK.docId; if (!id) return;
    clearInterval(LOCK.timer); LOCK.timer = null; LOCK.docId = null; LOCK.lost = false; LOCK.idle = false;
    try { await window.TJA_MAIL.reviewLock("release", id, LOCK_SESSION); } catch (e) {}
  }
  // background tabs are throttled — beat as soon as the tab is visible again
  document.addEventListener("visibilitychange", () => { if (!document.hidden && LOCK.docId) heartbeatLock(); });
  window.addEventListener("pagehide", () => {
    if (LOCK.docId && window.TJA_MAIL && window.TJA_MAIL.releaseLockOnExit) window.TJA_MAIL.releaseLockOnExit(LOCK.docId, LOCK_SESSION);
  });
  let opening = false;
  async function openModal(id) {
    let d = deliv(id); if (!d || opening) return;
    if (needsLock(d)) {
      opening = true; showBusy("Opening the proof…");
      try {
        let res;
        try { res = await acquireLock(d); }
        catch (e) {
          window.TJA_UI.alert("Couldn't open this proof for review (" + (e && e.message || e) + "). Please check your connection and try again.", { title: "Couldn't open" });
          return;
        }
        if (!res.ok) {
          const who = (res.holder && res.holder.name) || "Someone else";
          window.TJA_UI.alert(res.sameUser
            ? "You already have this deliverable open for review in another tab or window. Close it there first (or wait a minute), then try again."
            : `${who} is currently reviewing this deliverable. Please try again later.`,
            { title: "Currently being reviewed" });
          return;
        }
        // Now that it's ours, start from the FRESHEST copy so we see the previous reviewer's
        // latest comments and markup (our own unsaved edits, if any, are grafted back on).
        await flushPending();
        let fresh = null;
        for (let i = 0; i < 3 && !Array.isArray(fresh); i++) {
          try { fresh = await window.SUPA.pullScope(sess.client, "deliverables", 20000); } catch (e) { fresh = null; }
        }
        if (!Array.isArray(fresh)) {
          // never review on top of a stale copy — that's how the last reviewer's markup gets lost
          await releaseLock();
          window.TJA_UI.alert("Couldn't load the latest version of this proof (slow connection). Please try again in a moment.", { title: "Couldn't open" });
          return;
        }
        items = mergeMineInto(fresh, items); setBase(items);
        try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
        d = deliv(id); if (!d) { await releaseLock(); return; }
      } finally { opening = false; hideBusy(); }
    }
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
    // not holding the review lock (lost it to a dropped connection) → everything read-only
    const lockedOut = !!(clientView && isRealClient() && supaOn() && d && !isDraft(d) && !versionDone(v) && !mineDone && !holdsLock());
    m.classList.toggle("pd-lockedout", lockedOut);
    const cn = $("pdClientNotes"); if (cn) cn.readOnly = reviewed || lockedOut;
    if (reviewed) { const rd = $("pdRevDue"); if (rd) rd.disabled = true; }
    const saved = $("pdSaved");
    if (saved) {
      if (reviewed) { saved.textContent = "✓ Review submitted — thank you"; saved.classList.add("show"); }
      else { saved.textContent = "✓ Review saved"; saved.classList.remove("show"); }
    }
    const vb = $("pdVComment"); if (vb && v && isVideoV(v)) vb.style.display = viewerCanMarkup() ? "" : "none";
    if (lockedOut) { const sv = $("pdSaved"); if (sv) { sv.textContent = "Read-only — this review session ended. Close and reopen the proof to continue."; sv.classList.add("show"); } }
    setSaveState();
    try { renderPinList(); } catch (e) {}
  }

  // A new round must not reach the client until they've reviewed the current one. Returns
  // the blocking version (the latest ALREADY-SENT version with no client review yet) or
  // null when it's fine to add/send a new version (nothing sent yet, or it's been reviewed).
  function unreviewedSentVersion(d) {
    if (!d || !d.versions) return null;
    for (let i = d.versions.length - 1; i >= 0; i--) {
      const v = d.versions[i];
      if (v.state === "pending_approval") continue;   // still in the waiting room — hasn't reached the client
      // the latest sent one gates the next round. Completion is read from the DATA (every
      // required reviewer in), not only from the stamp, so a round can never end up "all
      // reviews in" yet still blocking V2.
      return (v.reviewedAt || (expectedOf(v).length && reviewComplete(v))) ? null : v;
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
    const wasDraft = isDraft(deliv(curId));
    if (persistCanvas()) { if (wasDraft) saveDrafts(); else save(); }
    exitVideo();
    renderGallery(); hidePopup(); resetZoom(); closeSignaturePad(); $("pdModal").classList.remove("open"); curId = null;
    // Save FIRST, then hand the proof to the next reviewer — so they open it with everything
    // this person did, including their last strokes and comments.
    if (!wasDraft) { LOCK.releaseWhenSaved = true; flushPending().then(maybeReleaseAfterSave); }
    else releaseLock();
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
    if (!viewerCanMarkup()) {
      window.TJA_UI.alert("This proof is read-only right now. Close it and open it again to continue your review.", { title: "Can't submit" });
      return;
    }
    if (!multi) av.clientNotes = $("pdClientNotes").value;   // legacy single-reviewer field
    persistCanvas();
    // an approval needs a signature — ONE per round: the first approver signs, teammates don't
    // an approval needs THIS person's signature (every approver signs, not just the first)
    if ((sel === "approved" || sel === "changes") && !iHaveSigned(av)) { openSignaturePad(); return; }
    finishSubmit(null);
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
    const wasDone = versionDone(v);
    v.expectedReviewers = remaining;
    if (reviewComplete(v) || !remaining.length) {
      v.status = aggregateStatus(v);
      if (!v.reviewedAt) { v.reviewedAt = stamp(); v.completedAtMs = Date.now(); }
      v.reviewedStatus = v.status || null;
    }
    try { if (window.SUPA && window.SUPA.auditEvent) window.SUPA.auditEvent(sess.client, "deliverable.reviewer_waived", `waived ${em}'s review on ${d.name}${v.label ? " " + v.label : ""}`, { scope: "deliverables" }); } catch (e) {}
    const vid = v.vid, did = d.id;
    const w = await saveNow();
    if (w && w.ok === false) { window.TJA_UI.alert("Couldn't save the waiver (" + (w.error || "network") + ") — it will keep retrying; don't close this page yet.", { title: "Not saved yet" }); }
    const lv = findVersion(vid) || v;
    renderPeerReviews(lv); updateMeta(); renderGallery();
    // a round completed by a waiver pings the team (and gets its PDF) exactly like a submission
    if (!wasDone && versionDone(lv) && (!w || w.ok !== false)) { notifyTeam(did, vid); archiveProof(did, vid); }
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
  async function finishSubmit(sig) {
    if (submitBusy) return;
    submitBusy = true;
    const btn = $("pdSubmit"); const label = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Submitting…"; }
    try { await finishSubmitInner(sig); }
    finally { submitBusy = false; if (btn) { btn.disabled = false; btn.textContent = label; } }
  }
  /* SUBMIT — one atomic save, then the team is told, then the PDF follows.
       1. The review is written with a compare-and-set against the freshest copy (my review,
          pins, drawing and signature grafted on). Completion is decided INSIDE that same write,
          so it's computed from everyone's reviews — never from a stale copy — and two people
          can't both think they were "not last".
       2. Only once it is saved does the rail lock. If it can't be saved, NOTHING is locked or
          lost: the reviewer is told and can press Submit again.
       3. If this completed the round, the team ping is fired immediately (server-built from the
          saved record, sent once, retried until it lands — it doesn't wait for the PDF and it
          survives the tab closing).
       4. The signed/marked-up proof PDF is then built and archived to the deliverable's Drive
          folder, and threaded under the Slack post. If this browser can't finish that, a staff
          browser picks it up automatically (archivePendingProofs). */
  async function finishSubmitInner(sig) {
    const d = deliv(curId);
    const v = active(d);
    if (!d || !v) return;
    const clientView = clientEyes();
    const multi = !!expectedOf(v).length;
    const sel = multi && clientView
      ? (pendingSel[v.vid] != null ? pendingSel[v.vid] : ((myReviewOf(v) || {}).status || null))
      : v.status;
    // Final client-facing confirm on any APPROVAL — the "Mistakes Cost Money" terms,
    // acknowledged at the moment of sign-off (Cameron, 2026-07-20).
    if ((sel === "approved" || sel === "changes") && clientView && window.TJA_UI) {
      const ok = await window.TJA_UI.confirm(PDF_DISCLAIMER + "\n\nSubmit your approval?",
        { title: "Confirm approval", okText: "Submit approval" });
      if (!ok) return;                                   // cancelled → the signature is discarded
    }
    // Preview-as-client on a multi-reviewer round records NOTHING.
    const realClient = isRealClient();
    if (multi && clientView && !realClient) {
      flashDocsToast("Preview mode — reviews on this deliverable are only recorded from a real client login.");
      return;
    }
    persistCanvas();
    const me = myEmail(), vid = v.vid, did = d.id, when = stamp();
    const notes = $("pdClientNotes") ? $("pdClientNotes").value : "";
    const myReview = { name: myName(), email: me, status: sel || null, notes, reviewedAt: when };
    let outcome = { was: false, complete: false };

    // what this submit does to a version — applied to whatever copy is freshest
    const applyMine = (fv, localV) => {
      if (localV && localV !== fv) mergeVersionSurfaces(localV, fv, me);        // my pins + drawing
      const was = versionDone(fv);
      if (multi) {
        fv.reviews = Object.assign({}, fv.reviews, { [me]: myReview });
        if (fv.reviewDrafts && fv.reviewDrafts[me]) {
          fv.reviewDrafts = Object.assign({}, fv.reviewDrafts); delete fv.reviewDrafts[me];
          if (!Object.keys(fv.reviewDrafts).length) delete fv.reviewDrafts;
        }
        fv.status = aggregateStatus(fv);
      } else {
        fv.status = sel || null; fv.clientNotes = notes;
      }
      if (sig) {
        fv.signatures = Object.assign({}, fv.signatures, { [me]: Object.assign({ status: sel || null }, sig) });
        if (!fv.signature) { fv.signature = sig.signature; fv.signedBy = sig.signedBy; fv.signedDate = sig.signedDate; }
      }
      const complete = multi ? reviewComplete(fv) : true;
      if (complete && !fv.reviewedAt) { fv.reviewedAt = when; fv.reviewedStatus = fv.status || null; fv.completedAtMs = Date.now(); }
      outcome = { was, complete };
    };

    let saved = false, err = "";
    if (supaOn() && realClient) {
      clearTimeout(pushTimer);
      while (SAVE.busy) { try { await SAVE.busyPromise; } catch (e) {} }
      // re-check right before writing: never submit (and never graft a drawing) without the lock
      if (needsLockFor(did) && !(await confirmLock())) {
        window.TJA_UI.alert("Your review session ended (the connection dropped or the page was asleep) and someone else may be reviewing now. Your notes are saved as a draft — close the proof, reopen it and submit again.",
          { title: "Not submitted yet" });
        return;
      }
      let release;
      SAVE.busy = true; SAVE.busyPromise = new Promise(r => { release = r; }); setSaveState();
      const seq = editSeq;
      try {
        const r = await window.SUPA.casUpdate(sess.client, "deliverables", (fresh) => {
          const list = mergeMineInto(Array.isArray(fresh) ? fresh : [], items);   // everything else of mine too
          const fd = list.find(x => x.id === did);
          const fv = fd && (fd.versions || []).find(x => x.vid === vid);
          if (!fv) throw new Error("this version is no longer available");
          const ld = items.find(x => x.id === did);
          const lv = ld && (ld.versions || []).find(x => x.vid === vid);
          applyMine(fv, lv);
          return normalizeRounds(list);
        }, { tries: 8, timeoutMs: 20000 });
        if (r.ok) {
          saved = true;
          adoptWrite(r.data, seq, true, null); setBase(r.data); rebaseAnnotations();
          SAVE.dirty = editSeq !== seq; SAVE.fails = 0;
        } else err = r.error || "network";
      } catch (e) { err = String(e && e.message || e); }
      finally {
        SAVE.busy = false; release();
        if (SAVE.dirty) schedulePush(300);              // edits made during the submit still go out
        setSaveState();
      }
    } else {
      // offline sandbox / staff preview on a legacy round: local only (nothing to share)
      applyMine(v, v); saved = true; saveCur();
    }
    if (!saved) {
      window.TJA_UI.alert("Your review hasn't been saved yet (" + err + "). Nothing you entered has been lost — please check your connection and press Submit Review again.",
        { title: "Not submitted yet" });
      return;
    }
    delete pendingSel[vid]; clearMyDraft(vid);
    // Filed → this person no longer needs the proof to themselves (they can still read and
    // reply). Free the lock now so a teammate who hasn't reviewed isn't kept waiting.
    if (LOCK.docId === did) flushPending().then(() => { dirtyAnno.clear(); releaseLock().then(() => applyReviewLock()); });
    // re-point the modal at the live objects (the save replaced `items`)
    const vIdx = (deliv(did) && deliv(did).versions || []).findIndex(x => x.vid === vid);
    if (vIdx > -1 && deliv(did)) deliv(did).active = vIdx;
    renderGallery(); updateSignStatus(); updateMeta(); renderPeerReviews(active(deliv(did)));
    applyReviewLock();
    try {
      if (window.SUPA && window.SUPA.auditEvent) {
        const verdict = STATUS_WORD[sel || v.status] || sel || v.status || "responded";
        window.SUPA.auditEvent(sess.client, "deliverable.reviewed",
          `reviewed ${d.name}${v.label ? " " + v.label : ""} — ${verdict}`, { scope: "deliverables" });
      }
    } catch (e) {}
    if (!(realClient && outcome.complete && !outcome.was)) return;
    const liveV = findVersion(vid) || v;
    if (window.TJA_NOTIFY) {
      try {
        window.TJA_NOTIFY.record({ type: "review", docId: did, docName: d.name, versionLabel: liveV.label,
          status: liveV.status || null, comments: allPins(liveV).length, by: multi ? "All reviewers in" : (getSession().name || "Client") });
      } catch (e) {}
    }
    // 3. the team ping — right now, not after the PDF
    notifyTeam(did, vid);
    // 4. the proof PDF, in the background
    archiveProof(did, vid, { fromSubmit: true });
  }

  /* ---------- the team ping + the archived proof (both idempotent, both retried) ---------- */
  const notifyChecked = new Set();          // rounds this browser has confirmed with the server
  async function notifyTeam(docId, vid) {
    if (!(window.TJA_MAIL && window.TJA_MAIL.notifyReview)) return;
    const payload = { docId, vid };
    if (!isRealClient()) payload.clientId = sess.client;          // staff safety-net call
    const r = await window.TJA_MAIL.notifyReview(payload);
    if (r && (r.ok || r.already)) notifyChecked.add(vid);
    return r;
  }
  const archiving = new Set();
  async function archiveProof(docId, vid, opts) {
    if (archiving.has(vid)) return;
    if (!(window.TJA_FILES && window.TJA_FILES.enabled() && window.TJA_FILES.uploadPdfBase64)) return;
    archiving.add(vid);
    try {
      const d = items.find(x => x.id === docId); const v = d && (d.versions || []).find(x => x.vid === vid);
      if (!d || !v || v.reviewedPdfUrl) return;
      const pdfBase64 = await exportPDF(d, { returnBase64: true, vid });
      if (!pdfBase64) return;
      const verdict = (STATUS_WORD[v.status] || v.status || "reviewed").replace(/[^\w]+/g, "-");
      const fname = `${(d.name || "deliverable").replace(/[^\w-]+/g, "_")}-${v.label}-${verdict}.pdf`;
      const up = await window.TJA_FILES.uploadPdfBase64(pdfBase64, fname, {
        category: "present-docs", clientId: sess.client, subfolder: d.name || "", folderId: d.driveFolderId || "" });
      if (!up) return;
      // record it on the round (re-resolved: `items` may have been replaced while we worked)
      const liveD = items.find(x => x.id === docId); const liveV = liveD && (liveD.versions || []).find(x => x.vid === vid);
      if (liveD && !liveD.driveFolderId && up.folderId) liveD.driveFolderId = up.folderId;
      if (liveV) { liveV.reviewedPdfUrl = up.url || ""; liveV.reviewedPdfLink = up.driveLink || ""; save(); }
      if (window.TJA_MAIL && window.TJA_MAIL.notifyReviewPdf) {
        const payload = { docId, vid, pdfBase64, pdfName: fname, pdfDriveLink: up.driveLink || "" };
        if (!isRealClient()) payload.clientId = sess.client;
        window.TJA_MAIL.notifyReviewPdf(payload);
      }
    } catch (e) { console.warn("proof archive failed — a staff browser will retry", e); }
    finally { archiving.delete(vid); }
  }
  /* SAFETY NET, run after every refresh: any round completed recently that this browser hasn't
     confirmed as notified gets (re)sent — the server ignores duplicates — and any completed round
     still missing its archived PDF gets one built by a STAFF browser (after a short grace period,
     so the submitting client's own browser gets first go). */
  const RECENT_MS = 3 * 24 * 3600 * 1000;
  function afterRefresh() {
    const now = Date.now();
    const staffCanFix = !isRealClient() && (typeof canEdit === "function" ? canEdit() : false) && !(typeof isCreative === "function" && isCreative());
    items.forEach(d => (d.versions || []).forEach(v => {
      const done = +v.completedAtMs || 0;
      if (!done || now - done > RECENT_MS || !versionDone(v)) return;
      if (!notifyChecked.has(v.vid) && (isRealClient() || staffCanFix)) { notifyChecked.add(v.vid); notifyTeam(d.id, v.vid).then(r => { if (!(r && (r.ok || r.already))) notifyChecked.delete(v.vid); }); }
      if (staffCanFix && !v.reviewedPdfUrl && now - done > 3 * 60 * 1000) archiveProof(d.id, v.vid);
    }));
  }
  function updateSignStatus() {
    const el = $("pdSignStatus"); if (!el) return;
    const v = active(deliv(curId));
    const sigs = v ? allSignatures(v) : [];
    el.innerHTML = sigs.map(g => `<span class="pd-signed">✓ Signed${g.signedBy ? " by " + esc(g.signedBy) : ""}${g.signedDate ? " · " + esc(g.signedDate) : ""}</span>`).join("<br>");
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
  /* The signature is held ASIDE and only written onto the round inside the same save as the
     review itself. It used to be attached the moment the pad closed — so cancelling the final
     "Submit your approval?" confirm left a phantom "Approved & signed by …" behind. */
  async function confirmSign() {
    const name = $("pdSignName").value.trim();
    let signature;
    if (sigMode === "type") {
      if (!name) { $("pdSignSub").textContent = "Type your name to create a signature."; return; }
      signature = await typedSignature(name);
    } else {
      if (!sigDirty) { $("pdSignSub").textContent = "Draw your signature, or switch to Type."; return; }
      signature = $("pdSignPad").toDataURL("image/png");
    }
    const sig = { signature,
      signedBy: name || ((typeof getSession === "function" && getSession() && getSession().name) || "Client"),
      signedDate: new Date().toLocaleDateString() };
    closeSignaturePad(); finishSubmit(sig);
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
      const v = (opts && opts.vid && (d.versions || []).find(x => x.vid === opts.vid)) || active(d);
      // One PDF page per document page for a multi-page proof, each with ITS own markup. A
      // single-surface deliverable yields exactly one, so nothing changes for image proofs.
      const surfaces = pagesOf(v) || [v];
      const composites = [];
      // a video round has no image to composite (buildComposite would wait on an empty <img>)
      for (const sf of surfaces) composites.push(isVideoV(v) ? null : await buildComposite(sf));
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
        const sigsAll = allSignatures(v);
        if (sigsAll.length) {
          const g0 = sigsAll[0];
          try { pdf.addImage(g0.signature, "PNG", bx + 5, by + 12, sigW - 10, bh - 24); } catch (e) {}
          setF("Inter", "normal", 5, GRAY);
          pdf.text(`${g0.signedBy || ""}${g0.signedDate ? " · " + g0.signedDate : ""}${sigsAll.length > 1 ? `  (+${sigsAll.length - 1} more below)` : ""}`.trim(), bx + 4, by + bh - 4);
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

      /* ---- REVIEWS: every reviewer's verdict, date and notes (multi-approver rounds) ----
         Each person's notes live in their own review entry, NOT in the shared clientNotes field,
         so they were missing from the archived proof. They are the record of what the client
         asked for — they go on the PDF, in full, before the artwork. */
      const noteW = Math.min(pageW * 0.72, 640);
      const ensure = (h) => { if (y + h > bottom()) newPage(); };
      const exp = expectedOf(v), revs = reviewsOf(v);
      const order = [...exp.filter(e => revs[e]), ...Object.keys(revs).filter(e => exp.indexOf(e) === -1)];
      if (order.length) {
        setF("Inter", "bold", 8, INK); pdf.text("CLIENT REVIEWS:", pageW / 2, y, { align: "center", charSpace: 0.3 }); y += 13;
        order.forEach(e => {
          const r = revs[e];
          const head = `${r.name || e}${exp.indexOf(e) === -1 ? " (optional)" : ""} — ${STATUS_WORD[r.status] || r.status || "Responded"}${r.reviewedAt ? "  ·  " + r.reviewedAt : ""}`;
          ensure(22);
          setF("Inter", "bold", 7.5, INK); pdf.text(head, pageW / 2, y, { align: "center" }); y += 10.5;
          if (r.notes) {
            setF("Inter", "normal", 8, INK);
            pdf.splitTextToSize(String(r.notes), noteW).forEach(ln => { ensure(11); pdf.text(ln, pageW / 2, y, { align: "center" }); y += 10.5; });
          }
          // this reviewer's own signature, right under their review
          const g = signaturesOf(v)[e] || ((!Object.keys(signaturesOf(v)).length && v.signature && order[0] === e && (r.status === "approved" || r.status === "changes")) ? { signature: v.signature, signedBy: v.signedBy, signedDate: v.signedDate } : null);
          if (g && g.signature) {
            ensure(50);
            try { pdf.addImage(g.signature, "PNG", pageW / 2 - 75, y - 2, 150, 35); } catch (err) {}
            y += 36;
            setF("Inter", "normal", 6.5, GRAY);
            pdf.text(`Signed by ${g.signedBy || r.name || e}${g.signedDate ? " · " + g.signedDate : ""}`, pageW / 2, y, { align: "center" }); y += 9;
          }
          y += 6;
        });
        const waiting = exp.filter(e => !revs[e]);
        if (waiting.length) { ensure(12); setF("Inter", "normal", 7, GRAY); pdf.text("Not reviewed: " + waiting.join(", "), pageW / 2, y, { align: "center" }); y += 12; }
        y += 4;
      }
      /* ---- ADDITIONAL DETAILS (the shared portal notes), centered per the template ---- */
      const noteBlocks = [];
      if (v.clientNotes && !order.length) noteBlocks.push(["CLIENT NOTES", v.clientNotes]);
      if (v.agencyNotes) noteBlocks.push(["AGENCY NOTES", v.agencyNotes]);
      if (noteBlocks.length) {
        ensure(24);
        setF("Inter", "bold", 8, INK); pdf.text("ADDITIONAL DETAILS:", pageW / 2, y, { align: "center", charSpace: 0.3 });
        y += 12;
        noteBlocks.forEach(([lbl, txt]) => {
          ensure(20);
          setF("Inter", "bold", 7, GRAY); pdf.text(lbl, pageW / 2, y, { align: "center", charSpace: 0.3 }); y += 10;
          setF("Inter", "normal", 8, INK);
          const lines = pdf.splitTextToSize(txt, noteW);
          lines.forEach(ln => { ensure(11); pdf.text(ln, pageW / 2, y, { align: "center" }); y += 10.5; });
          y += 6;
        });
        y += 6;
      }
      // the artwork needs real room — if the notes filled page 1, it starts on a fresh page
      if (bottom() - y < 220) newPage();

      /* ---- each page: the creative, then ITS comments, numbered to match its pins ---- */
      for (let si = 0; si < surfaces.length; si++) {
        const sf = surfaces[si], comp = composites[si];
        if (si > 0) newPage();                      // pages 2+ get the slim header
        const pins = isVideoV(v) ? videoPins(sf) : ((sf && sf.pins) || []);
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
        if (isVideoV(v)) {                          // a video round: the link IS the artwork
          setF("Inter", "bold", 9, INK); pdf.text("VIDEO REVIEW", M, y, { charSpace: 0.4 }); y += 13;
          setF("Inter", "normal", 8.5, [30, 90, 200]);
          const vl = pdf.splitTextToSize(String(v.videoUrl), pageW - M * 2);
          try { pdf.textWithLink(vl[0], M, y, { url: v.videoUrl }); } catch (e) { pdf.text(vl[0], M, y); }
          y += 12 * vl.length + 8;
        }
        if (surfaces.length > 1) {                  // label which page this is
          setF("Inter", "bold", 7, GRAY);
          pdf.text(`PAGE ${si + 1} OF ${surfaces.length}`, M, y, { charSpace: 0.4 });
          y += 12;
        }
        if (pins.length) {
          setF("Inter", "bold", 9, INK); pdf.text(`COMMENTS (${pins.length})`, M, y, { charSpace: 0.4 }); y += 14;
          pins.forEach((pn, i) => {
            const at = isVideoV(v) ? `[${pn.t != null ? fmtT(pn.t) : "no time"}] ` : "";
            const lines = pdf.splitTextToSize(`${at}${pn.by ? pn.by + ": " : ""}${pn.text || "(no note)"}${pn.resolved ? "   [resolved]" : ""}`, pageW - M * 2 - 22);
            if (y + lines.length * 11.5 > bottom()) newPage();
            pdf.setFillColor(...(pn.resolved ? [54, 194, 117] : ORANGE));
            pdf.circle(M + 6, y - 3, 6, "F");
            setF("Inter", "bold", 7, [255, 255, 255]); pdf.text(String(i + 1), M + 6, y - 0.6, { align: "center" });
            setF("Inter", "normal", 8.5, INK);
            pdf.text(lines, M + 20, y); y += lines.length * 11.5 + 7;
            // the reply thread, indented under its comment
            (pn.replies || []).forEach(r => {
              const rl = pdf.splitTextToSize(`Reply from ${r.by || r.byEmail || "reviewer"}: ${r.text || ""}`, pageW - M * 2 - 40);
              if (y + rl.length * 10.5 > bottom()) newPage();
              setF("Inter", "normal", 7.8, GRAY);
              pdf.text(rl, M + 34, y); y += rl.length * 10.5 + 4;
            });
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

  // Reply send / delete, shared by the sidebar list and the in-image popup.
  function handleReplyClick(e, root) {
    const snd = e.target.closest("[data-replysend]");
    if (snd) {
      e.stopPropagation();
      const id = snd.dataset.replysend;
      const ta = root.querySelector(`[data-replytext="${CSS.escape(id)}"]`);
      if (ta && addReply(id, ta.value)) ta.value = "";
      return true;
    }
    const del = e.target.closest("[data-replydel]");
    if (del) { e.stopPropagation(); const [pid, rid] = del.dataset.replydel.split("::"); deleteReply(pid, rid); return true; }
    return false;
  }

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
      if (SAVE.dirty || SAVE.busy) return;                            // our own unsaved work first
      const sent = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      // Adopting the server copy makes it the new merge ancestor for staff writes — without this
      // the 3-way merge would keep comparing against a stale base and mis-read remote additions.
      if (Array.isArray(sent) && !SAVE.dirty && !SAVE.busy) { items = sent; setBase(sent); try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }
      if (isStaffFn()) {
        const dr = await window.SUPA.pullScope(sess.client, "deliverables_draft", 12000);
        if (Array.isArray(dr) && !DRAFT.dirty && !DRAFT.busy) { draftItems = dr; draftBaseIds = new Set(dr.map(d => d.id)); try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draftItems)); } catch (e) {} }
      }
      afterRefresh();
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
    const d = deliv(curId); const v = d && active(d);
    if (!v || isDraft(d)) return;
    if (drawing || sigDrawing || SAVE.busy || submitBusy) return;
    const ae = document.activeElement;
    if (ae && (/^(input|textarea|select)$/i.test(ae.tagName || "") || ae.isContentEditable)) return;
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pullScope)) return;
    try {
      const fresh = await window.SUPA.pullScope(sess.client, "deliverables", 12000);
      if (!Array.isArray(fresh) || !fresh.length || SAVE.busy) return;
      // client: graft my own work back on; staff: adopt the server copy unless we have unsaved edits
      if (isRealClient()) items = mergeMineInto(fresh, items);
      else if (!SAVE.dirty) { items = fresh; setBase(fresh); }
      else return;
      try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {}
      const d2 = deliv(curId); const v2 = d2 && active(d2);
      if (!v2) { closeModal(); return; }                   // the open card was deleted elsewhere
      renderPins(); renderPinList(); renderPeerReviews(v2); updateMeta(); updateSignStatus();
      { const ps = pagesOf(v2); const k = sfKeyOf(v2, ps ? Math.min(Math.max(0, curPage), ps.length - 1) : null);
        const now = surface(v2).annotation || null;
        if (!canvasTouched && !dirtyAnno.has(k) && annoLoaded.get(k) !== now && ctx) {
          annoLoaded.set(k, now); ctx.clearRect(0, 0, cv.width, cv.height); drawSaved(now);
        } }
      const pop = $("pdPopup");
      if (pop && pop.style.display !== "none" && pop.dataset.pin) {
        const p = (curSurface().pins || []).find(x => x.id === pop.dataset.pin); if (p) showPopup(p, true); else hidePopup();
      }
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
      if (e.code === "Space" && !typing && !m.classList.contains("pd-videomode")) { spaceDown = true; const w = $("pdWrap"); if (w) w.classList.add("space-pan"); e.preventDefault(); return; }
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
    // Video-link review
    if ($("pdVidBtn")) $("pdVidBtn").addEventListener("click", () => openVideoDialog(null));
    if ($("pdVidCancel")) $("pdVidCancel").addEventListener("click", closeVideoDialog);
    if ($("pdVidSend")) $("pdVidSend").addEventListener("click", commitVideo);
    if ($("pdVidUrl")) ["input", "paste"].forEach(ev => $("pdVidUrl").addEventListener(ev, videoPreview));
    if ($("pdVidOverlay")) window.TJA_UI.backdropClose($("pdVidOverlay"), closeVideoDialog);
    if ($("pdVComment")) $("pdVComment").addEventListener("click", addVideoComment);
    if ($("pdVTimeline")) $("pdVTimeline").addEventListener("click", e => {
      const mk = e.target.closest("[data-seek]"); if (!mk) return;
      vidSeek(+mk.dataset.seek);
      if (mk.dataset.pin) document.querySelectorAll(".pd-comment").forEach(c => c.classList.toggle("sel", c.dataset.row === mk.dataset.pin));
    });
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
      if (d && isVideoDoc(d)) {
        if (!isDraft(d) && blockNewRound(d)) return;
        closeModal(); openVideoDialog(isDraft(d) ? null : d);
        return;
      }
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
        if (draftItems.some(x => x.id === id)) { draftDeleted.add(id); draftItems = draftItems.filter(x => x.id !== id); renderGallery(); await saveDraftsNow(); }
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
    $("pdClear").addEventListener("click", () => { if (!viewerCanMarkup()) return; snapshot(); canvasTouched = true; if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); });
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
        if (!viewerCanMarkup()) return;
        pendingSel[v.vid] = (cur === val) ? null : val;
        document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === pendingSel[v.vid]));
        saveMyDraft();
        return;
      }
      if (clientEyes() && !viewerCanMarkup()) return;
      v.status = (v.status === val) ? null : val;
      document.querySelectorAll(".pd-status-opt").forEach(o => o.classList.toggle("sel", o.dataset.val === v.status));
      saveCur();
    });

    $("pdPinList").addEventListener("input", e => {
      const ta = e.target.closest("[data-pintext]"); if (!ta) return;
      // curSurface(), NOT the version: on a multi-page proof the pins live on the CURRENT PAGE,
      // and looking them up in v.pins found nothing — so typing a comment silently saved nowhere
      // (Cameron 2026-08-01). Every other pin site already resolves through curSurface().
      const v = curSurface(); const p = v && (v.pins || []).find(x => x.id === ta.dataset.pintext);
      if (p && canEditPin(p)) { p.text = ta.value; saveCur(); syncPopup(p); }
    });
    $("pdPinList").addEventListener("click", e => {
      const res = e.target.closest("[data-resolve]"); if (res) { toggleResolve(res.dataset.resolve); return; }
      const del = e.target.closest("[data-pindel]"); if (del) { deletePin(del.dataset.pindel); return; }
      if (handleReplyClick(e, $("pdPinList"))) return;
      const sk = e.target.closest("[data-seek]"); if (sk) { e.stopPropagation(); vidSeek(+sk.dataset.seek); return; }
      if (e.target.closest("[data-pintime]")) return;
      const card = e.target.closest(".pd-comment");
      if (card && e.target.tagName !== "TEXTAREA" && !e.target.closest(".pd-reply-new")) selectPin(card.dataset.row);  // highlight pin + open its in-image note
    });
    // a typed time on a comment (players that can't report their position)
    $("pdPinList").addEventListener("change", e => {
      const inp = e.target.closest && e.target.closest("[data-pintime]"); if (!inp) return;
      const v = curSurface(); const p = (v.pins || []).find(x => x.id === inp.dataset.pintime);
      const t = parseT(inp.value);
      if (p && canEditPin(p) && t != null) { p.t = t; saveCur(); renderPins(); renderPinList(); }
    });
    $("pdPinList").addEventListener("keydown", e => {
      // ⌘/Ctrl+Enter sends a reply
      const ta = e.target.closest && e.target.closest("[data-replytext]");
      if (ta && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (addReply(ta.dataset.replytext, ta.value)) ta.value = ""; }
    });
    $("pdClearComments").addEventListener("click", clearComments);

    $("pdPins").addEventListener("click", e => {
      if (justPanned || spaceDown) return;
      // a pin is ALWAYS clickable (any tool, even after you've submitted): it opens the comment,
      // its replies, and the reply box
      const marker = e.target.closest(".pd-pin");
      if (marker) { selectPin(marker.dataset.pin); return; }
      if (tool !== "comment") return;
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
        if (p && canEditPin(p)) { p.text = e.target.value; saveCur(); const ta = document.querySelector(`[data-pintext="${id}"]`); if (ta) ta.value = p.text; }
      });
      $("pdPopupClose").addEventListener("click", hidePopup);
      pop.addEventListener("click", e => { handleReplyClick(e, pop); });
      pop.addEventListener("keydown", e => {
        const ta = e.target.closest && e.target.closest("[data-replytext]");
        if (ta && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (addReply(ta.dataset.replytext, ta.value)) ta.value = ""; }
      });
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
      if (tool !== "draw" || !ctx || !viewerCanMarkup()) return; hidePopup(); snapshot(); drawing = true; canvasTouched = true; lastPt = pos(e); cv.setPointerCapture(e.pointerId);
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

    $("pdClientNotes").addEventListener("input", e => {
      const v = active(deliv(curId)); if (!v) return;
      // multi-reviewer client: the box is MY review → saved as my private draft until Submit
      if (clientEyes() && expectedOf(v).length) { saveMyDraft(); return; }
      if (clientEyes() && !viewerCanMarkup()) return;
      v.clientNotes = e.target.value; saveCur();
    });
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
