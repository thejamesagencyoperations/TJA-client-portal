/* The PXG pitch workspace. This is going in front of a prospect, so the numbers must be
   internally consistent and the shape must match what the portal actually renders — a tile
   that silently drops out, or a burn headline that contradicts its own service lines, would
   be visible to PXG before it was visible to us. */
const fs = require("fs");
const p = JSON.parse(fs.readFileSync(__dirname + "/../demo/pxg.json", "utf8"));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

const st = p.state, ret = st.engagements.retainer, projs = st.engagements.projects;

// ---- the guard that keeps the mock alive
ok(st.demo === true, "state.demo is true — the hourly snapshot skips it and cannot zero the burn");
ok(p.registry.id === "pxg" && p.registry.kind === "both", "registry: id 'pxg', engagement kind 'both'");

// ---- 27%, and the service lines that have to agree with it
const contracted = ret.serviceDisciplines.reduce((s, d) => s + d.contracted, 0);
const used = ret.wmjServiceLines.reduce((s, l) => s + l.billable, 0);
ok(contracted === ret.burn.contractedHours, `burn denominator equals the sum of the disciplines (${contracted})`);
ok(used === ret.burn.usedHours, `burn numerator equals the sum of the service lines (${used})`);
ok(Math.round(used / contracted * 100) === 27, `the gauge reads exactly 27% (${used}/${contracted})`);

// the gauge is computed from wmjServiceLines, so every discipline needs a matching line or
// its hours vanish from the headline number
const dn = ret.serviceDisciplines.map(d => d.name).sort();
const ln = ret.wmjServiceLines.map(l => l.name).sort();
ok(JSON.stringify(dn) === JSON.stringify(ln), "every discipline has a matching service line");
ok(ret.serviceDisciplines.length === 6, "six disciplines");
for (const want of ["Paid Media", "Organic Social", "Public Relations", "Creative", "Email", "Strategic Oversight"])
  ok(dn.includes(want), `  · ${want}`);
// no line may exceed its own contracted hours, which would render as >100% on that row
ok(ret.wmjServiceLines.every(l => {
  const d = ret.serviceDisciplines.find(x => x.name === l.name);
  return d && l.billable <= d.contracted;
}), "no service line exceeds its own contracted hours");

// ---- PR coverage
ok(Array.isArray(ret.prCoverage) && ret.prCoverage.length >= 5, `${ret.prCoverage.length} PR hits`);
ok(ret.prCoverage.every(h => h.outlet && h.date && h.link), "every hit has an outlet, a date and a link");
ok(ret.prCoverage.every(h => /^https:\/\//.test(h.link)), "every link is https");
ok(ret.prCoverage.every(h => h.headline && h.headline.length > 8), "every hit has a readable headline");
ok(ret.prCoverage.every(h => /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(h.date)), "dates are in the portal's M/D/YY format");

// ---- the two projects
ok(projs.length === 2, "two projects");
const strat = projs.find(x => x.label === "Stratagem");
const rap = projs.find(x => x.label === "Raptor Campaign Launch");
ok(!!strat, "Stratagem exists");
ok(!!rap, "Raptor Campaign Launch exists");
ok(rap && rap.dueDate === "2027-01-10", `Raptor is due 10 Jan 2027 (${rap && rap.dueDate})`);
ok(projs.every(x => x.type === "project" && x.id && x.pizza && Array.isArray(x.pizza.phases)), "both have the project shape + a phase tracker");
ok(projs.every(x => x.pizza.manual === true), "trackers are manual — so a WMJ sync can never overwrite them");
ok(new Set(projs.map(x => x.id)).size === 2, "project ids are unique");
ok(projs.every(x => x.source !== "wmj"), "neither is marked source:wmj — the projects cron only touches WMJ projects");

// ---- deliberately left blank for Cameron to fill in
ok(ret.milestones.length === 0 && ret.todos.length === 0 && ret.kpis.length === 0, "sprint goals / to-dos / KPIs left empty to fill in");
ok(ret.northStar === "" && projs.every(x => x.northStar === ""), "goals left empty to fill in");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
