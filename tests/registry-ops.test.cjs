/* Client registry writes — a stale browser tab must never undo someone else's change.
   Replays the "Alex keeps getting kicked off / reviewer toggles revert" bug against the REAL
   client-store.js with a fake registry row that enforces compare-and-set. */
const fs = require("fs"), vm = require("vm");
const SRC = fs.readFileSync(__dirname + "/../assets/js/client-store.js", "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };
const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));

function server(initial) {
  const row = { data: JSON.parse(JSON.stringify(initial)), stamp: 1 };
  return {
    row,
    async casUpdate(cid, scope, mutate) {
      const seen = row.stamp, fresh = JSON.parse(JSON.stringify(row.data));
      await tick(2);
      const next = mutate(fresh);
      if (next === undefined) return { ok: true, noop: true };
      if (row.stamp !== seen) return this.casUpdate(cid, scope, mutate);   // lost the race → retry
      row.data = JSON.parse(JSON.stringify(next)); row.stamp++;
      return { ok: true, data: next };
    },
    async pullScope() { return JSON.parse(JSON.stringify(row.data)); },
  };
}
function browser(srv) {
  const ls = {};
  const ctx = { console: { log() {}, warn() {} }, setTimeout, clearTimeout, JSON, Date, Math, Map, Set, Object, Array, String,
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    tjaSlugify: s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-"), tjaInitialsFrom: s => String(s).slice(0, 2) };
  ctx.window = ctx; ctx.TJA_CLIENTS = [];
  ctx.SUPA = { enabled: true, casUpdate: srv.casUpdate.bind(srv), pullScope: srv.pullScope.bind(srv) };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  return ctx.TJA_STORE;
}
const base = [
  { id: "salt-river-project", name: "Salt River Project", am: "Tatum Skogebo", pm: null, managers: ["Tatum Skogebo"], integrations: { slackChannel: "#client-srp", approvalOff: [] } },
  { id: "jdm-golf", name: "JDM Golf", am: "Alysha Wolfe", pm: "Trinity Buerkel", managers: ["Alysha Wolfe", "Trinity Buerkel"], integrations: {} },
];
(async () => {
  const srv = server(base);
  const stale = browser(srv); await stale.hydrate();          // tab opened hours ago
  const alex = browser(srv); await alex.hydrate();
  // Alex: adds herself as a manager by hand + turns two reviewers off (Admin Center writes the
  // registry directly — simulate that server-side change)
  alex.update("salt-river-project", { managers: ["Tatum Skogebo", "Alex Duggan"] }, { manual: true });
  await tick(900);
  const s1 = srv.row.data.find(c => c.id === "salt-river-project");
  ok(s1.managers.includes("Alex Duggan"), "Alex's manual add saved");
  ok((s1.integrations.managersPinned || []).includes("Alex Duggan"), "…and pinned so the sheet sync keeps her");
  s1.integrations.approvalOff = ["lsingleton@arizonaforward.org", "sabrina@example.com"]; srv.row.stamp++;
  // the STALE tab now edits something unrelated (a logo on another client, a code on SRP)
  stale.update("jdm-golf", { logo: "x.png" });
  stale.update("salt-river-project", { code: "SRP" });
  await tick(900);
  const s2 = srv.row.data.find(c => c.id === "salt-river-project");
  ok(s2.managers.includes("Alex Duggan"), "stale tab did NOT remove Alex");
  ok(s2.integrations.approvalOff.length === 2, "stale tab did NOT revert the reviewer toggles");
  ok(s2.code === "SRP" && srv.row.data.find(c => c.id === "jdm-golf").logo === "x.png", "stale tab's own edits still landed");
  // removing someone by hand un-pins them
  alex.update("salt-river-project", { managers: ["Tatum Skogebo"] }, { manual: true });
  await tick(900);
  const s3 = srv.row.data.find(c => c.id === "salt-river-project");
  ok(!s3.managers.includes("Alex Duggan") && !(s3.integrations.managersPinned || []).includes("Alex Duggan"), "removing by hand un-pins");
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
