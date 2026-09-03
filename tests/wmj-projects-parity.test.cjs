/* The server cron and the browser sync write the SAME clients' projects. Any difference
   between them makes data flip-flop depending on which ran last — the retainer split-brain
   all over again. These tests make divergence impossible to ship unnoticed. */
const fs = require("fs");
const root = __dirname + "/..";
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

// 1. the transform is used, not re-implemented — the two copies must be byte-identical
{
  const a = fs.readFileSync(root + "/assets/js/wmj-transform.js");
  const b = fs.readFileSync(root + "/supabase/functions/_shared/wmj-transform.js");
  ok(a.equals(b), `wmj-transform.js is byte-identical in assets/ and _shared/ (${a.length} vs ${b.length} bytes)`);
}

// 2. mergeProject must behave identically in both
const grabFn = (src, name, endMarker) => {
  const a = src.indexOf(name);
  const b = src.indexOf(endMarker, a);
  if (a < 0 || b < 0) throw new Error("markers not found for " + name);
  return src.slice(a, b);
};
const browserSrc = fs.readFileSync(root + "/assets/js/wmj-sync.js", "utf8");
const serverSrc = fs.readFileSync(root + "/supabase/functions/sync-projects/index.ts", "utf8");

const shell = grabFn(browserSrc, "function projectShell(id)", "\n  function mergeProject");
const bMerge = grabFn(browserSrc, "function mergeProject(existing, w)", "\n  /* ---------- RETAINERS")
  || grabFn(browserSrc, "function mergeProject(existing, w)", "\n  async function");
const browserMerge = new Function("window", shell + "\n" + bMerge + "\n return mergeProject;")({});

let sMerge = grabFn(serverSrc, "function mergeProject(existing: any, w: any)", "\nDeno.serve")
  .replace(/: any/g, "").replace(/\/\/ deno-lint-ignore.*\n/g, "");
const sShell = grabFn(serverSrc, "function projectShell(id: string)", "\n/* KEEP IN SYNC").replace(/: string/g, "");
const serverMerge = new Function(sShell + "\n" + sMerge + "\n return mergeProject;")();

const W = (over) => Object.assign({
  id: "p1", label: "Fall Campaign", name: "ACM Fall", dueDate: "2026-10-01",
  status: "Production", progressPct: 40, tasks: [{ name: "t" }], contractedHours: 100,
  allocatedHours: 80, phases: [{ label: "Design", done: true, status: "Completed" }],
}, over || {});

const cases = [
  ["a brand-new WMJ project", null, W()],
  ["a completed project", null, W({ status: "Completed", progressPct: 100 })],
  ["an existing project with an ADMIN tracker", { id: "p1", pizza: { manual: true, phases: [{ label: "Kickoff", done: true }] }, northStar: "keep me" }, W()],
  ["an existing project with WMJ phases, now in production", { id: "p1", pizza: { phases: [{ label: "old", done: true }] } }, W()],
  ["an on-hold project", null, W({ status: "On Hold" })],
  ["progressPct 100 but status Production", null, W({ progressPct: 100 })],
];
for (const [label, existing, w] of cases) {
  const x = browserMerge(existing ? JSON.parse(JSON.stringify(existing)) : null, w);
  const y = serverMerge(existing ? JSON.parse(JSON.stringify(existing)) : null, w);
  // the browser attaches a layout from TJA_STORE, which has no server equivalent; ignore it
  const strip = (o) => { const c = JSON.parse(JSON.stringify(o)); delete c.layout; return c; };
  ok(JSON.stringify(strip(x)) === JSON.stringify(strip(y)), `mergeProject identical — ${label}`);
}

// 3. the admin's manual fields survive a merge (that is the whole point of merging)
{
  const existing = { id: "p1", northStar: "Ship it", milestones: [{ text: "m" }], todos: [{ text: "t" }],
    condition: { level: "green", note: "all good" }, pizza: { manual: true, phases: [{ label: "Kickoff", done: true }] } };
  const out = serverMerge(JSON.parse(JSON.stringify(existing)), W());
  ok(out.northStar === "Ship it", "north star preserved");
  ok(out.milestones.length === 1 && out.todos.length === 1, "milestones and to-dos preserved");
  ok(out.condition.note === "all good", "condition note preserved");
  ok(out.pizza.manual && out.pizza.phases[0].label === "Kickoff", "an admin's pizza tracker is NOT overwritten");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
