/* Due-date ordering for sprint goals / milestones, to-do's and dependencies.
   The dangerous part isn't the comparator — it's that every row is addressed by its ARRAY
   INDEX (data-idx, listDel("todos", i), ed(…,"todos."+i+".text")). If the array and the
   rendered order ever disagree, ticking or deleting a row hits a DIFFERENT row. So these
   tests care as much about identity surviving the sort as about the order itself.
   Lifted from the real source. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/exec-summary.js", "utf8");
const grab = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("markers: " + a); return src.slice(i, j); };
const code = grab("  function toISODate(v) {", "  function shortDate(") + grab("  const DATED_LISTS =", "  function dateBtn(");
const { sortByDue, toISODate } = new Function(code + "\n return { sortByDue, toISODate };")();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };
const labels = (l) => l.map(x => x.t).join(",");

// ---- basic ordering
{
  const e = { todos: [{ t: "c", date: "2026-12-01" }, { t: "a", date: "2026-01-05" }, { t: "b", date: "2026-06-30" }] };
  sortByDue(e);
  ok(labels(e.todos) === "a,b,c", "soonest due first");
}
// ---- undated go last, not first
{
  const e = { todos: [{ t: "none1" }, { t: "dated", date: "2026-03-01" }, { t: "none2", date: "" }] };
  sortByDue(e);
  ok(labels(e.todos) === "dated,none1,none2", "undated sort LAST and keep their relative order");
}
// ---- stability: equal dates must not reshuffle between renders
{
  const e = { todos: [{ t: "x", date: "2026-05-05" }, { t: "y", date: "2026-05-05" }, { t: "z", date: "2026-05-05" }] };
  sortByDue(e); const once = labels(e.todos);
  sortByDue(e); sortByDue(e);
  ok(once === "x,y,z" && labels(e.todos) === "x,y,z", "ties keep insertion order and repeat sorts are stable");
}
// ---- all three lists, and nothing else
{
  const e = {
    milestones: [{ t: "m2", date: "2026-08-01" }, { t: "m1", date: "2026-02-01" }],
    todos: [{ t: "t2", date: "2026-09-09" }, { t: "t1", date: "2026-09-01" }],
    dependencies: [{ t: "d2", date: "2027-01-01" }, { t: "d1", date: "2026-11-11" }],
    kpis: [{ t: "k2" }, { t: "k1" }],
    prCoverage: [{ t: "p2", date: "2026-01-01" }, { t: "p1", date: "2025-01-01" }],
  };
  sortByDue(e);
  ok(labels(e.milestones) === "m1,m2", "milestones sorted");
  ok(labels(e.todos) === "t1,t2", "to-do's sorted");
  ok(labels(e.dependencies) === "d1,d2", "dependencies sorted");
  ok(labels(e.kpis) === "k2,k1", "KPIs are NOT touched (they carry no due date)");
  ok(labels(e.prCoverage) === "p2,p1", "PR coverage is NOT touched (its date is a publish date, not a due date)");
}
// ---- INDEX INTEGRITY: the array is what got reordered, so index still means the same row
{
  const e = { todos: [{ t: "late", date: "2026-12-01" }, { t: "soon", date: "2026-01-01" }] };
  sortByDue(e);
  ok(e.todos[0].t === "soon", "index 0 IS the first-rendered row after sorting");
  // simulate what listDel('todos', 0) does — it must remove the row the user actually clicked
  e.todos.splice(0, 1);
  ok(labels(e.todos) === "late", "deleting index 0 removes the row that rendered first, not a stale one");
}
// ---- mixed date formats: the picker stores ISO, but older data can hold anything Date.parse reads
{
  const e = { todos: [{ t: "iso", date: "2026-07-04" }, { t: "us", date: "1/15/2026" }, { t: "junk", date: "not a date" }] };
  sortByDue(e);
  ok(labels(e.todos) === "us,iso,junk", `mixed formats normalise via toISODate; unparseable counts as undated (${labels(e.todos)})`);
}
// ---- done items are ordered by date like everything else (not floated away)
{
  const e = { todos: [{ t: "openLate", date: "2026-10-01" }, { t: "doneSoon", date: "2026-02-01", done: true }] };
  sortByDue(e);
  ok(labels(e.todos) === "doneSoon,openLate", "completed items still sort by date — no hidden second rule");
}
// ---- degenerate input must not throw
{
  let threw = false;
  try {
    sortByDue({}); sortByDue({ todos: [] }); sortByDue({ todos: [{ t: "one" }] });
    sortByDue({ todos: null }); sortByDue({ todos: [null, { t: "a", date: "2026-01-01" }] }); sortByDue(null);
  } catch (err) { threw = true; console.log("     threw: " + err.message); }
  ok(!threw, "empty / single / null / missing lists and null rows don't throw");
}
// ---- the sort is actually reachable from render()
ok(/function render\(e\) \{\s*\n\s*sortByDue\(e\);/.test(src), "render() calls sortByDue before building any tile");
ok(!/data-drag=/.test(src), "the drag-to-reorder handle is gone (it would fight the sort)");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
