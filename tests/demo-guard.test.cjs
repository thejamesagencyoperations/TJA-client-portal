/* A demo/pitch workspace must survive the hourly snapshot.
   PXG (and any future pitch mock) has no Workamajig counterpart, so the snapshot finds no
   actuals for it, blanks wmjServiceLines and rolls the burn to 0 — emptying a hand-built mock
   within the hour. The guard is one line, so what it needs is proof it sits BEFORE the write
   and that it can't accidentally skip real clients. Asserted against the real source. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../supabase/functions/snapshot-months/index.ts", "utf8");
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

const guard = src.indexOf("if (data?.demo === true)");
const wipe = src.indexOf("e.wmjServiceLines = a");
const loop = src.indexOf("for (const r of rows ?? [])");
const momWrite = src.indexOf("e.mom.push(entry)");

ok(guard > 0, "the demo guard exists");
ok(guard > loop, "…inside the per-client loop");
ok(guard < wipe, "…and BEFORE wmjServiceLines is overwritten (order is the whole point)");
ok(guard < momWrite, "…and before any month entry is written");
ok(/continue;/.test(src.slice(guard, guard + 60)), "it continues to the next client rather than returning");

// the condition must be an exact boolean match — a truthy-ish check would skip clients whose
// state happens to carry a stray `demo` string, and === true cannot be tripped by that
const cond = src.slice(guard, guard + 40);
ok(/data\?\.demo === true/.test(cond), "matches `demo === true` exactly, not a truthy value");

// simulate the branch both ways
const skip = (data) => (data && data.demo === true);
ok(skip({ demo: true }) === true, "a demo workspace is skipped");
ok(skip({ demo: false }) === false, "demo:false is NOT skipped");
ok(skip({}) === false, "a normal client (no flag) is NOT skipped");
ok(skip({ demo: "yes" }) === false, "a stray truthy value does not skip a real client");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
