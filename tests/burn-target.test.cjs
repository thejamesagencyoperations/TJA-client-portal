/* The burn popup's edit target. Lifted from the real source.
   Bug fixed 2026-09-08: editing a FROZEN month's burn skipped the allocate-across-disciplines
   popup entirely and just scaled every line proportionally. A past month is exactly when the
   allocation matters — you are reconstructing where hours actually went.
   The two months store their numbers differently, so the risk here is an edit landing on the
   wrong month, or a frozen edit leaking into the live month's overrides. Both are pinned. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/exec-summary.js", "utf8");
const a = src.indexOf("  function burnTarget(eng, idx) {");
const b = src.indexOf("  function openBurnPopup(");
if (a < 0 || b < 0) throw new Error("markers not found");

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const make = () => new Function(
  "round1", "round2", "histLines", "actualByDiscipline", "discUsed",
  "retainerTotalContracted", "retainerUsed", "stampOv",
  src.slice(a, b) + "\n return burnTarget;"
)(r1, r2,
  (m) => (Array.isArray(m && m.lines) ? m.lines : []),
  () => ({}),
  (_e, d) => +d.usedNow || 0,
  (e) => (e.serviceDisciplines || []).reduce((s, d) => s + (+d.contracted || 0), 0),
  (e) => (e.serviceDisciplines || []).reduce((s, d) => s + (+d.usedNow || 0), 0),
  (e) => { e.overrideMonth = "STAMPED"; });
const burnTarget = make();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

const eng = () => ({
  serviceDisciplines: [{ name: "Creative", contracted: 40, usedNow: 10 }, { name: "PR", contracted: 20, usedNow: 5 }],
  mom: [
    { month: "Jul", year: 2026, usedHours: 30, contractedHours: 60,
      lines: [{ name: "Creative", contracted: 40, billable: 20 }, { name: "PR", contracted: 20, billable: 10 }] },
    { month: "Aug", year: 2026, usedHours: 12, contractedHours: 60,
      lines: [{ name: "Creative", contracted: 40, billable: 8 }, { name: "PR", contracted: 20, billable: 4 }] },
  ],
});

// ---- the FROZEN month reads its own snapshot, not the live config
{
  const e = eng();
  const t = burnTarget(e, 0);
  ok(t.currentUsed === 30, "frozen target reads the snapshot's usedHours, not the live month's");
  ok(t.total === 60, "frozen target reads the snapshot's contractedHours");
  ok(JSON.stringify(t.rows.map(r => [r.name, r.used])) === '[["Creative",20],["PR",10]]', "frozen rows come from lines[].billable");
  ok(t.label === "Jul 2026", "the dialog can name the month being edited");
}
// ---- a frozen commit writes hours onto THAT month's lines and nowhere else
{
  const e = eng();
  burnTarget(e, 0).commit([25, 11]);
  const jul = e.mom[0], aug = e.mom[1];
  ok(jul.lines[0].billable === 25 && jul.lines[1].billable === 11, "allocated hours land on the right lines");
  ok(jul.usedHours === 36, `the month total follows the lines (got ${jul.usedHours})`);
  ok(jul.adjusted === true, "the month is stamped adjusted");
  ok(aug.usedHours === 12 && aug.lines[0].billable === 8, "a DIFFERENT month is untouched");
  ok(!e.svcUtilOverride, "a frozen edit does NOT write the live month's svcUtilOverride");
  ok(!e.overrideMonth, "and does not stamp the live override month");
}
// ---- editing August must not touch July (the wrong-month bug this replaces)
{
  const e = eng();
  burnTarget(e, 1).commit([9, 5]);
  ok(e.mom[0].usedHours === 30 && !e.mom[0].adjusted, "editing Aug leaves Jul exactly as it was");
  ok(e.mom[1].usedHours === 14, "and Aug's total is recomputed from its own lines");
}
// ---- the LIVE month still behaves exactly as before
{
  const e = eng();
  const t = burnTarget(e, null);
  ok(t.currentUsed === 15 && t.total === 60, "live target reads serviceDisciplines + actuals");
  t.commit([20, 10]);
  ok(e.svcUtilOverride.Creative === 50, `live commit writes a % override (20/40 = 50, got ${e.svcUtilOverride.Creative})`);
  ok(e.svcUtilOverride.PR === 50, "…for every discipline");
  ok(e.overrideMonth === "STAMPED", "and stamps the override month so it expires");
  ok(!e.mom[0].adjusted && !e.mom[1].adjusted, "a live edit does NOT touch any frozen month");
}
// ---- degenerate snapshots must not throw
{
  const e = eng();
  e.mom.push({ month: "Jun", year: 2026, usedHours: 5, contractedHours: 0 });   // no lines[]
  const t = burnTarget(e, 2);
  ok(t.rows.length === 0, "a snapshot with no lines[] yields no rows (popup falls back to scaling)");
  ok(t.currentUsed === 5, "and still reports its total");
  let threw = false;
  try { burnTarget(e, 99); } catch (err) { threw = true; }
  ok(!threw, "an out-of-range month index does not throw");
}
// ---- negatives are clamped: you cannot allocate a line below zero hours
{
  const e = eng();
  burnTarget(e, 0).commit([-5, 10]);
  ok(e.mom[0].lines[0].billable === 0, "a negative allocation clamps to 0, not a negative hour count");
  ok(e.mom[0].usedHours === 10, "and the total reflects the clamp");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
