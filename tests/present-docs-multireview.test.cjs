/* Present Docs multi-approver rounds — replayed against a fake shared database.
   Runs the REAL present-docs.js (and the real casUpdate from supabase-sync.js) in one sandbox
   per "browser", all talking to ONE in-memory app_state row with real compare-and-set
   semantics, so two reviewers can race each other exactly as they would live.
   Covers the 8 failure modes found in the 2026-09-28 review. */
const fs = require("fs");
const vm = require("vm");
const SRC = fs.readFileSync(__dirname + "/../assets/js/present-docs.js", "utf8")
  .replace("return { render, init, openDoc, liveRefresh };",
    "return { render, init, openDoc, liveRefresh, __t: { get items(){return items;}, set items(v){items=v;}, get curId(){return curId;}, set curId(v){curId=v;}," +
    " mergeMineInto, mergeStaff, normalizeRounds, unreviewedSentVersion, finishSubmitInner, pushDeliverables, flushPending, SAVE, LOCK, dirtyAnno," +
    " pendingSel, saveMyDraft, annoLoaded, myDraftOf, addReply, confirmSign: null, setBase, get baseItems(){return baseItems;}, viewerCanMarkup, parseVideoUrl, allSignatures, iHaveSigned, fmtT, parseT, videoPins, reviewersForSend, stampRound, archiveProof } };");
const SYNC = fs.readFileSync(__dirname + "/../assets/js/supabase-sync.js", "utf8");
const casSrc = SYNC.slice(SYNC.indexOf("  async function casUpdate("), SYNC.indexOf("  // delete every scope row for a client"));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

/* ---------- one shared fake database (single app_state row per scope) ---------- */
function makeServer() {
  const rows = {};           // scope -> { data, updated_at }
  let n = 0;
  const srv = { rows, failReads: 0, readDelay: 0, writes: 0 };
  // a minimal supabase-js query builder: select/eq/maybeSingle, update/eq/select, insert/select
  srv.from = () => {
    const q = { f: {}, op: "select" };
    q.select = () => q; q.eq = (k, v) => { q.f[k] = v; return q; };
    q.update = (v) => { q.op = "update"; q.val = v; return q; };
    q.insert = (v) => { q.op = "insert"; q.val = v; return q; };
    q.maybeSingle = () => q;
    q.then = (res, rej) => (async () => {
      await tick(srv.readDelay);
      const sc = q.f.scope || (q.val && q.val.scope);
      if (q.op === "select") {
        if (srv.failReads > 0) { srv.failReads--; return { __timeout: true }; }
        const r = rows[sc];
        return { data: r ? JSON.parse(JSON.stringify({ data: r.data, updated_at: r.updated_at })) : null, error: null };
      }
      await tick(1);
      if (q.op === "update") {
        const r = rows[sc];
        if (!r || r.updated_at !== q.f.updated_at) return { data: [], error: null };   // CAS lost
        r.data = JSON.parse(JSON.stringify(q.val.data)); r.updated_at = "t" + (++n); srv.writes++;
        return { data: [{ updated_at: r.updated_at }], error: null };
      }
      if (q.op === "insert") {
        if (rows[sc]) return { data: null, error: { message: "duplicate" } };
        rows[sc] = { data: JSON.parse(JSON.stringify(q.val.data)), updated_at: "t" + (++n) }; srv.writes++;
        return { data: [{ updated_at: rows[sc].updated_at }], error: null };
      }
    })().then(res, rej);
    return q;
  };
  return srv;
}

/* ---------- one "browser" ---------- */
function makeBrowser(srv, who, log) {
  const el = () => {
    const e = { value: "", textContent: "", innerHTML: "", style: {}, dataset: {}, disabled: false, readOnly: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      addEventListener() {}, removeEventListener() {}, focus() {}, appendChild() {}, insertBefore() {},
      querySelector: () => null, querySelectorAll: () => [], getContext: () => null, setPointerCapture() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }), parentNode: null };
    e.parentNode = { insertBefore() {} };
    return e;
  };
  const els = {};
  const ls = {};
  const alerts = [], confirms = [], notifies = [], pdfs = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    Date, JSON, Math, Promise, Map, Set, Object, Array, String, Number, Error, RegExp, Boolean, URL,
    CSS: { escape: (x) => x }, requestAnimationFrame: (f) => setTimeout(f, 0),
    localStorage: { getItem: (k) => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; } },
    document: { getElementById: (id) => (els[id] = els[id] || el()), querySelector: () => null, querySelectorAll: () => [],
      addEventListener() {}, createElement: () => el(), activeElement: null, fonts: { load: async () => {} }, body: el() },
    location: { href: "http://localhost/", origin: "http://localhost" },
    getSession: () => ({ client: "acme", email: who.email, name: who.name, role: who.role }),
    effectiveRole: () => who.role === "client" ? "client" : "admin",
    isCreative: () => false, isStaff: () => who.role !== "client", canEdit: () => who.role !== "client",
    canUploadDocs: () => who.role !== "client", canSendDocs: () => who.role !== "client",
  };
  ctx.window = ctx;
  ctx.addEventListener = () => {};
  ctx.TJA_UI = { alert: (m) => { alerts.push(m); }, confirm: async (m) => { confirms.push(m); return who.confirmAnswer !== false; }, backdropClose() {} };
  ctx.TJA_FILES = { enabled: () => false, isProxy: () => false, hydrate() {}, blobUrl: async (u) => u };
  ctx.TJA_NOTIFY = { record() {} };
  ctx.TJA_MAIL = {
    fetchReviewers: async () => { if (who.reviewersFail) throw new Error("boom"); return { ok: true, reviewers: srv.reviewers || [] }; },
    notifyReview: async (p) => { notifies.push(p); log.push(["notify", who.email, p.vid]); return { ok: true }; },
    notifyReviewPdf: async (p) => { pdfs.push(p); return { ok: true }; },
    reviewLock: async () => ({ ok: true }), releaseLockOnExit() {}, sendDeliverable: async () => ({ ok: true }),
  };
  vm.createContext(ctx);
  // the REAL casUpdate, bound to this browser's view of the shared server
  const SUPA = vm.runInContext(`(function(){ const client = __srv; const ready = Promise.resolve(); const pending = {};
      function withTimeout(p){ return p; } function auditWrite(){}
      ${casSrc}
      return { enabled: true, client, casUpdate,
        pullScope: async (c, s) => { const r = await client.from().select().eq("scope", s).maybeSingle(); return r && r.data ? r.data.data : null; },
        hasPendingWrite: () => false, auditEvent() {} };
    })()`, Object.assign(ctx, { __srv: srv }));
  ctx.SUPA = SUPA;
  const PD = vm.runInContext(SRC + "\n;window.PresentDocs;", ctx);
  return { PD, t: PD.__t, els, ls, alerts, confirms, notifies, pdfs, ctx, who };
}

const A = { email: "ann@acme.com", name: "Ann", role: "client" };
const B = { email: "bob@acme.com", name: "Bob", role: "client" };
const STAFF = { email: "pm@thejamesagency.com", name: "Pat PM", role: "admin" };
function seedRound(srv, extra) {
  const v = Object.assign({ label: "V1", vid: "v1", state: "sent", pins: [], annotation: null, status: null,
    expectedReviewers: [A.email, B.email], reviews: {}, url: "x" }, extra || {});
  srv.rows.deliverables = { data: [{ id: "d1", name: "Logo", active: 0, versions: [v] }], updated_at: "t0" };
}
const serverV = (srv) => srv.rows.deliverables.data[0].versions[0];
async function load(b, srv) {            // like opening the page: adopt the server copy
  b.t.items = JSON.parse(JSON.stringify(srv.rows.deliverables.data)); b.t.setBase(b.t.items); b.t.curId = "d1";
  if (b.who.role === "client") b.t.LOCK.docId = "d1";   // opened for review = holding the lock
}
async function submit(b, status, notes) {
  b.t.pendingSel["v1"] = status;
  b.els.pdClientNotes = Object.assign(b.els.pdClientNotes || {}, { value: notes || "" });
  const sig = (status === "approved" || status === "changes") ? { signature: "data:sig-" + b.who.name, signedBy: b.who.name, signedDate: "9/28/2026" } : null;
  await b.t.finishSubmitInner(sig);
}

(async () => {
  // ---- #7 + #8: two reviewers submit AT THE SAME TIME — nothing lost, exactly one ping ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);
    srv.readDelay = 5;
    await Promise.all([submit(a, "approved", "Love it"), submit(b, "revisions", "Logo too small")]);
    const v = serverV(srv);
    ok(!!v.reviews[A.email] && !!v.reviews[B.email], "#7 simultaneous submits: BOTH reviews saved");
    ok(v.reviews[B.email].notes === "Logo too small", "#7 each reviewer's notes saved with their review");
    ok(!!v.reviewedAt && !!v.completedAtMs, "#7 round stamped complete from the data");
    ok(v.status === "revisions", "worst-wins verdict = revisions");
    const pings = log.filter(x => x[0] === "notify");
    ok(pings.length === 1, "#8 exactly ONE team ping fired, at submission (got " + pings.length + ")");
    ok(a.t.unreviewedSentVersion(a.t.items[0]) === null, "#7 next round is unblocked");
  }
  // ---- #6: can't read the latest copy → NOTHING is written, reviewer is told, nothing locked ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    srv.rows.deliverables.data[0].versions[0].reviews = { [B.email]: { name: "Bob", email: B.email, status: "approved", notes: "ok" } };
    const a = makeBrowser(srv, A, log); await load(a, srv);
    a.t.items[0].versions[0].reviews = {};                    // A's copy is STALE (no Bob)
    srv.failReads = 99;
    await submit(a, "changes", "tweak");
    ok(!!serverV(srv).reviews[B.email], "#6 a stale copy never overwrote the teammate's review");
    ok(!serverV(srv).reviews[A.email], "#6 nothing was written while the latest copy was unreadable");
    ok(a.alerts.some(m => /hasn't been saved/.test(m)), "#6 reviewer told it isn't saved yet");
    ok(!a.t.items[0].versions[0].reviews[A.email], "#6 rail not locked — they can press Submit again");
    srv.failReads = 0;
    await submit(a, "changes", "tweak");
    ok(!!serverV(srv).reviews[A.email] && !!serverV(srv).reviews[B.email], "#6 retry lands, teammate's review intact");
  }
  // ---- #3: cancelling the final approval confirm leaves NO signature ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, Object.assign({}, A, { confirmAnswer: false }), log); await load(a, srv);
    await submit(a, "approved", "");
    await a.t.flushPending();
    ok(!serverV(srv).signature, "#3 cancelled approval → no phantom signature on the server");
    ok(!a.t.items[0].versions[0].signature, "#3 …or locally");
    ok(!serverV(srv).reviews[A.email], "#3 and no review recorded");
  }
  // ---- #2: a reviewer who never drew can't wipe a teammate's drawing ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);                  // B's copy predates A's drawing
    a.t.items[0].versions[0].annotation = "data:A-drawing"; a.t.dirtyAnno.add("v1#-1");
    a.t.items[0].versions[0].pins.push({ id: "pa", x: .1, y: .1, text: "A's note", by: "Ann", byEmail: A.email });
    await a.t.pushDeliverables();
    b.t.items[0].versions[0].pins.push({ id: "pb", x: .2, y: .2, text: "B's note", by: "Bob", byEmail: B.email });
    await b.t.pushDeliverables();
    ok(serverV(srv).annotation === "data:A-drawing", "#2 A's drawing survived B's save");
    ok(serverV(srv).pins.length === 2, "#2 both reviewers' comments kept");
  }
  // ---- #2 replies: B replies on A's pin while A edits it → both survive ----
  {
    const log = []; const srv = makeServer();
    seedRound(srv, { pins: [{ id: "pa", x: .1, y: .1, text: "Bigger logo?", by: "Ann", byEmail: A.email }] });
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);
    b.t.items[0].versions[0].pins[0].replies = [{ id: "r1", by: "Bob", byEmail: B.email, text: "Agreed", atMs: 1 }];
    a.t.items[0].versions[0].pins[0].text = "Bigger logo please";
    await Promise.all([a.t.pushDeliverables(), b.t.pushDeliverables()]);
    const p = serverV(srv).pins[0];
    ok(p.text === "Bigger logo please", "replies: author's edit to their own comment kept");
    ok(p.replies && p.replies.length === 1 && p.replies[0].text === "Agreed", "replies: teammate's reply kept");
    // staff 3-way merge must not drop a reply either
    const s = makeBrowser(srv, STAFF, log); await load(s, srv);
    s.t.items[0].versions[0].pins[0].resolved = true;
    b.t.items = JSON.parse(JSON.stringify(srv.rows.deliverables.data));
    b.t.items[0].versions[0].pins[0].replies.push({ id: "r2", by: "Bob", byEmail: B.email, text: "and bolder", atMs: 2 });
    await b.t.pushDeliverables(); await s.t.pushDeliverables();
    const p2 = serverV(srv).pins[0];
    ok(p2.resolved === true && p2.replies.length === 2, "replies: staff edit + new client reply both kept");
  }
  // ---- #5: notes typed then the proof closed → still there on reopen ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log); await load(a, srv);
    a.els.pdClientNotes = Object.assign(a.els.pdClientNotes || {}, { value: "Half-written thoughts" });
    a.t.pendingSel["v1"] = "changes";
    a.t.saveMyDraft(); await a.t.flushPending();
    ok(serverV(srv).reviewDrafts && serverV(srv).reviewDrafts[A.email].notes === "Half-written thoughts", "#5 draft notes saved to the record");
    const a2 = makeBrowser(srv, A, log); await load(a2, srv);   // new device, empty local storage
    const d = a2.t.myDraftOf(a2.t.items[0].versions[0]);
    ok(d && d.notes === "Half-written thoughts" && d.status === "changes", "#5 draft (notes + verdict) restored on another device");
    await submit(a2, "changes", "Final notes");
    ok(!serverV(srv).reviewDrafts, "#5 draft removed once submitted");
  }
  // ---- #7: all reviews in but no completion stamp → healed by the next write, V2 unblocked ----
  {
    const log = []; const srv = makeServer();
    seedRound(srv, { reviews: { [A.email]: { status: "approved" }, [B.email]: { status: "approved" } } });
    const a = makeBrowser(srv, A, log); await load(a, srv);
    ok(a.t.unreviewedSentVersion(a.t.items[0]) === null, "#7 gating reads completion from the data");
    a.t.items[0].versions[0].pins.push({ id: "x", x: 0, y: 0, text: "", byEmail: A.email });
    await a.t.pushDeliverables();
    ok(!!serverV(srv).reviewedAt, "#7 missing completion stamp healed by any save");
  }
  // ---- #2 lock: without the review lock a client can't mark up at all ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log); await load(a, srv);
    ok(a.t.viewerCanMarkup() === true, "lock: holder can mark up");
    a.t.LOCK.docId = null;
    ok(a.t.viewerCanMarkup() === false, "lock: no lock → read-only");
    a.t.LOCK.docId = "d1"; a.t.LOCK.lost = true;
    ok(a.t.viewerCanMarkup() === false, "lock: lost lock → read-only");
  }
  // ---- review follow-ups: lapsed lock, stale drawing baseline, awaited saves ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);
    a.t.annoLoaded.set("v1#-1", null);
    // B (the current lock holder) draws and saves
    b.t.items[0].versions[0].annotation = "data:B"; b.t.dirtyAnno.add("v1#-1"); b.t.annoLoaded.set("v1#-1", null);
    await b.t.pushDeliverables();
    // A wakes from sleep with an old dirty canvas and saves — B's drawing must survive
    a.t.items[0].versions[0].annotation = "data:A-stale"; a.t.dirtyAnno.add("v1#-1");
    await a.t.pushDeliverables();
    ok(serverV(srv).annotation === "data:B", "stale reviewer can't overwrite the current holder's drawing");
    // an awaited save must include the edit made while another save was in flight
    srv.readDelay = 20;
    const first = b.t.pushDeliverables();
    b.t.items[0].versions[0].pins.push({ id: "late", x: 0, y: 0, text: "late edit", byEmail: B.email });
    const r = await b.t.pushDeliverables(); await first;
    ok(r.ok && serverV(srv).pins.some(p => p.id === "late"), "awaited save covers the edit made mid-flight");
    srv.readDelay = 0;
    // submitting after the lock was lost is refused (nothing written)
    const c = makeBrowser(srv, A, log); await load(c, srv);
    c.ctx.TJA_MAIL.reviewLock = async () => ({ ok: false, holder: { name: "Bob" } });
    await submit(c, "revisions", "x");
    ok(!serverV(srv).reviews[A.email] && c.alerts.some(m => /session ended/.test(m)), "submit with a lapsed lock is refused, clearly");
  }
  // ---- every approver signs; every signature is kept ----
  {
    const log = []; const srv = makeServer(); seedRound(srv);
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);
    await Promise.all([submit(a, "approved", "yes"), submit(b, "changes", "tiny tweak")]);
    const v = serverV(srv);
    ok(v.signatures && v.signatures[A.email] && v.signatures[B.email], "both approvers' signatures saved");
    ok(a.t.allSignatures(v).length === 2, "PDF/modal read two signatures");
    ok(!!v.signature, "first signature still mirrored for older readers");
    const c = makeBrowser(srv, A, log); await load(c, srv);
    ok(c.t.iHaveSigned(c.t.items[0].versions[0]) === true, "a signer isn't asked to sign twice");
  }
  // ---- video links ----
  {
    const b = makeBrowser(makeServer(), STAFF, []);
    const P = b.t.parseVideoUrl;
    ok(P("https://youtu.be/dQw4w9WgXcQ").provider === "youtube" && P("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3").id === "dQw4w9WgXcQ", "YouTube links (short + watch)");
    ok(P("https://youtube.com/shorts/abcdefghijk").id === "abcdefghijk", "YouTube Shorts");
    ok(P("https://vimeo.com/76979871/abc123ef").embed === "https://player.vimeo.com/video/76979871?h=abc123ef", "Vimeo unlisted link keeps its hash");
    ok(P("https://drive.google.com/file/d/1AbC_dEf/view?usp=sharing").embed.endsWith("/1AbC_dEf/preview") && !P("https://drive.google.com/file/d/1AbC_dEf/view").timed, "Drive → preview embed, typed times");
    ok(P("https://www.loom.com/share/abc123").provider === "loom", "Loom");
    ok(P("https://cdn.example.com/cut.mp4").provider === "file" && P("https://cdn.example.com/cut.mp4").timed, "direct video file is timed");
    ok(P("not a link") === null && P("javascript:alert(1)") === null, "rejects non-links / non-http");
    ok(b.t.fmtT(83) === "1:23" && b.t.fmtT(3723) === "1:02:03" && b.t.parseT("1:23") === 83, "time format/parse");
    const vp = b.t.videoPins({ pins: [{ id: "c", t: null }, { id: "b", t: 40 }, { id: "a", t: 5 }] }).map(p => p.id).join("");
    ok(vp === "abc", "video comments listed in time order, untimed last");
  }
  // ---- video comments merge like any pin (timestamps survive, replies kept) ----
  {
    const log = []; const srv = makeServer();
    seedRound(srv, { videoUrl: "https://youtu.be/dQw4w9WgXcQ", videoProvider: "youtube", url: undefined });
    const a = makeBrowser(srv, A, log), b = makeBrowser(srv, B, log);
    await load(a, srv); await load(b, srv);
    a.t.items[0].versions[0].pins.push({ id: "va", t: 12.5, x: null, y: null, text: "logo late", byEmail: A.email, by: "Ann" });
    b.t.items[0].versions[0].pins.push({ id: "vb", t: 40, x: null, y: null, text: "music loud", byEmail: B.email, by: "Bob" });
    await Promise.all([a.t.pushDeliverables(), b.t.pushDeliverables()]);
    const pins = serverV(srv).pins;
    ok(pins.length === 2 && pins.find(p => p.id === "va").t === 12.5, "timestamped comments from both reviewers saved");
  }
  // ---- #1: reviewers are stamped BEFORE the send; a failed lookup sends nothing ----
  {
    const log = []; const srv = makeServer(); srv.reviewers = [A.email, B.email];
    const s = makeBrowser(srv, STAFF, log);
    const list = await s.t.reviewersForSend();
    ok(list && list.length === 2, "#1 reviewer list fetched before writing the version");
    const v = { vid: "vx" }; s.t.stampRound(v, list);
    ok(v.expectedReviewers.length === 2 && v.reviews && !Object.keys(v.reviews).length, "#1 round stamped on the version itself");
    const s2 = makeBrowser(srv, Object.assign({}, STAFF, { reviewersFail: true }), log);
    ok((await s2.t.reviewersForSend()) === null && s2.alerts.some(m => /Nothing was sent/.test(m)), "#1 lookup failure blocks the send with a clear message");
  }
  // ---- single-reviewer rounds still complete on the first review ----
  {
    const log = []; const srv = makeServer(); seedRound(srv, { expectedReviewers: [A.email] });
    const a = makeBrowser(srv, A, log); await load(a, srv);
    await submit(a, "revisions", "redo");
    ok(!!serverV(srv).reviewedAt && log.filter(x => x[0] === "notify").length === 1, "one required reviewer → completes + pings once");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
