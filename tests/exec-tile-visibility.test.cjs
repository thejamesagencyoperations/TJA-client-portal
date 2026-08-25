/* Tile visibility: defaults, legacy migration, and the promise that matters most —
   REMOVING A TILE MUST NOT TOUCH ITS DATA. Functions are lifted out of the real file. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/exec-summary.js", "utf8");
const a = src.indexOf("  const VIEW_TILES = {");
const b = src.indexOf("  /* ---- Layout engine");
if (a < 0 || b < 0) throw new Error("markers not found");
global.window = { tjaCanonDiscipline: (n) => String(n).toLowerCase().includes("pr") ? "pr" : "other" };
const { tileOn, setTile, prInSow, depsOn } =
  new Function(src.slice(a, b) + "\n return { tileOn, setTile, prInSow, depsOn };")();

let pass = 0, fail = 0;
const is = (got, want, msg) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; }
  else { console.log(`  FAIL ${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; }
};

// ---- defaults
const ret = { type: "retainer", serviceDisciplines: [] };
is(["burn","service","milestones","todosdep","kpis"].map(k => tileOn(ret, k)), [true,true,true,true,true], "retainer defaults on");
is(tileOn(ret, "pr"), false, "retainer PR off when no PR in SOW");
is(tileOn({ type: "retainer", serviceDisciplines: [{ name: "PR", contracted: 10 }] }, "pr"), true, "retainer PR on when contracted");
is(tileOn({ type: "retainer", serviceDisciplines: [], prCoverage: [{ outlet: "x" }] }, "pr"), true, "retainer PR on when hits exist");

const proj = { type: "project" };
is(["burn","service","milestones","todosdep"].map(k => tileOn(proj, k)), [true,true,true,true], "project defaults on");
is([tileOn(proj,"kpis"), tileOn(proj,"pr")], [false,false], "project kpis+pr off by default");

// ---- legacy flags still honoured (existing production data)
is(tileOn({ type: "retainer", serviceDisciplines: [{ name: "PR", contracted: 10 }], prTile: false }, "pr"), false, "legacy prTile:false wins over auto-detect");
is(tileOn({ type: "project", milestonesTile: false }, "milestones"), false, "legacy milestonesTile:false honoured");
// ...but the new map wins over the legacy flag once it exists
is(tileOn({ type: "project", milestonesTile: false, tileVis: { milestones: true } }, "milestones"), true, "tileVis overrides legacy");

// ---- setTile round-trip + legacy mirroring
const e1 = { type: "project" };
setTile(e1, "milestones", false);
is([tileOn(e1, "milestones"), e1.milestonesTile], [false, false], "setTile writes map and mirrors legacy");
setTile(e1, "milestones", true);
is([tileOn(e1, "milestones"), e1.milestonesTile], [true, true], "setTile back on");
const e2 = { type: "retainer", serviceDisciplines: [] };
setTile(e2, "kpis", false);
is([tileOn(e2, "kpis"), "milestonesTile" in e2], [false, false], "non-legacy key writes the map without inventing a legacy mirror");

// ---- VIEW_TILES is authoritative: a project never shows KPIs or PR, whatever is stored
is(tileOn({ type: "project", tileVis: { kpis: true, pr: true } }, "kpis"), false, "stored kpis:true cannot resurrect KPIs on a project");
is(tileOn({ type: "project", tileVis: { pr: true } }, "pr"), false, "stored pr:true cannot resurrect PR on a project");
is(tileOn({ type: "project", prTile: true }, "pr"), false, "legacy prTile:true cannot resurrect PR on a project");
setTile({ type: "project" }, "pr", true);   // must not throw
pass++;

// ---- THE INDEPENDENCE GUARANTEE: the two views are separate engagement objects, so a
// switch on one must never move the other. This is what the Customize dialog's two headers
// promise, and it is the whole reason the dialog writes through the scope's engagement
// rather than through whichever view is on screen.
const ret2 = { type: "retainer", serviceDisciplines: [] };
const proj2 = { type: "project" };
setTile(ret2, "milestones", false);           // hide Sprint Goals on Monthly Services
is(tileOn(proj2, "milestones"), true, "hiding Sprint Goals on the retainer leaves the project's Milestones on");
setTile(proj2, "todosdep", false);            // hide To Do's on the project
is(tileOn(ret2, "todosdep"), true, "hiding To Do's on the project leaves the retainer's To Do's on");
ret2.depsSection = false;
is(depsOn(proj2), true, "the Dependencies section is per-engagement too");
is([tileOn(ret2, "milestones"), tileOn(proj2, "todosdep")], [false, false], "each view kept its own choice");

// ---- THE DATA RETENTION GUARANTEE
const rich = {
  type: "retainer",
  serviceDisciplines: [{ name: "PR", contracted: 10 }],
  prCoverage: [{ outlet: "AZ Republic", headline: "Big win", impressions: "40000" }],
  milestones: [{ text: "Sprint one", done: true }],
  kpis: [{ label: "Leads", value: "128" }],
  todos: [{ text: "Send brief", link: "https://example.com" }],
  dependencies: [{ text: "Await assets" }],
};
const before = JSON.stringify(rich);
["pr", "milestones", "kpis", "todosdep", "burn", "service"].forEach(k => setTile(rich, k, false));
// every content array must be byte-identical after hiding everything
["prCoverage", "milestones", "kpis", "todos", "dependencies", "serviceDisciplines"].forEach(key =>
  is(JSON.stringify(rich[key]), JSON.stringify(JSON.parse(before)[key]), `hiding tiles preserves e.${key}`));
// and switching back on restores visibility with the data intact
["pr", "milestones", "kpis", "todosdep", "burn", "service"].forEach(k => setTile(rich, k, true));
is(["pr","milestones","kpis","todosdep","burn","service"].map(k => tileOn(rich, k)), [true,true,true,true,true,true], "all restored");
is(rich.prCoverage[0].headline, "Big win", "PR hit content survived the round trip");
is(rich.todos[0].link, "https://example.com", "to-do hyperlink survived the round trip");

// ---- deps section is independent of the tile
is(depsOn({}), true, "deps default on");
is(depsOn({ depsSection: false }), false, "deps off honoured");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
