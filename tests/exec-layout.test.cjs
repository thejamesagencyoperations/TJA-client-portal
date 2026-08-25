/* Reflow engine: every tile combination must completely fill the canvas with no overlap.
   The functions under test are LIFTED OUT OF THE REAL FILE rather than copied, so the test
   can't quietly drift away from what ships. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/exec-summary.js", "utf8");

const grab = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("marker not found: " + startMarker);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error("end marker not found: " + endMarker);
  return src.slice(a, b);
};
const code = grab("const CANVAS = {", "  function getLayout(e)");
const { CANVAS, GAP, COLUMNS, computeLayout } = new Function(code + "\n return { CANVAS, GAP, COLUMNS, computeLayout };")();

const KEYS = ["burn", "service", "milestones", "todosdep", "kpis", "pr"];
let pass = 0, fail = 0;
const bad = (msg) => { console.log("  FAIL " + msg); fail++; };

for (const type of ["retainer", "project"]) {
  const { W, H } = CANVAS[type];
  for (let mask = 0; mask < (1 << KEYS.length); mask++) {
    const on = KEYS.filter((_, i) => mask & (1 << i));
    const lay = computeLayout(type, (k) => on.includes(k));
    const label = `${type} [${on.join(",") || "none"}]`;

    // keys that this view can actually place
    const placeable = COLUMNS[type].flatMap(c => c.tiles.map(t => t[0]));
    const expect = on.filter(k => placeable.includes(k));
    const got = Object.keys(lay);
    if (got.length !== expect.length || !expect.every(k => got.includes(k))) {
      bad(`${label}: placed [${got}] expected [${expect}]`); continue;
    }
    if (!expect.length) { pass++; continue; }

    const R = Object.values(lay);
    // 1. every tile inside the canvas
    if (R.some(r => r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H))
      bad(`${label}: tile outside canvas`);
    // 2. reaches the right edge and the bottom edge EXACTLY — this is "fills the page"
    if (Math.max(...R.map(r => r.x + r.w)) !== W) bad(`${label}: right edge ${Math.max(...R.map(r => r.x + r.w))} != ${W}`);
    if (Math.max(...R.map(r => r.y + r.h)) !== H) bad(`${label}: bottom edge ${Math.max(...R.map(r => r.y + r.h))} != ${H}`);
    // 3. every column reaches the bottom (no short column leaving dead space)
    const byX = {}; R.forEach(r => { (byX[r.x] = byX[r.x] || []).push(r); });
    for (const [x, col] of Object.entries(byX)) {
      const bottom = Math.max(...col.map(r => r.y + r.h));
      if (bottom !== H) bad(`${label}: column x=${x} stops at ${bottom}, not ${H}`);
    }
    // 4. no overlaps
    for (let i = 0; i < R.length; i++) for (let j = i + 1; j < R.length; j++) {
      const a = R[i], b = R[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
        bad(`${label}: overlap`);
    }
    // 5. positive dimensions
    if (R.some(r => r.w <= 0 || r.h <= 0)) bad(`${label}: non-positive size`);
    pass++;
  }
}

// The everything-on case must still reproduce Cameron's captured arrangement within a pixel
// or two, or the reflow engine has silently redesigned the default page.
const CAPTURED = {
  retainer: { burn:[0,0,491,377], service:[506,0,704,451], milestones:[0,393,489,368],
              todosdep:[1226,0,405,522], kpis:[1226,537,407,225], pr:[507,467,703,293] },
  project:  { burn:[0,0,809,306], service:[0,322,808,434], todosdep:[823,0,424,758],
              milestones:[1263,0,363,760] },
};
for (const [type, want] of Object.entries(CAPTURED)) {
  const defaults = type === "project"
    ? ["burn", "service", "milestones", "todosdep"]
    : KEYS;
  const lay = computeLayout(type, (k) => defaults.includes(k));
  for (const [k, [x, y, w, h]] of Object.entries(want)) {
    const g = lay[k];
    if (!g) { bad(`default ${type}.${k} missing`); continue; }
    const off = Math.max(Math.abs(g.x-x), Math.abs(g.y-y), Math.abs(g.w-w), Math.abs(g.h-h));
    // 3px, not 0: the captured numbers were hand-placed and not quite self-consistent —
    // retainer.kpis was x=1226 w=407, a right edge of 1633 on a 1631 canvas and 2px wider
    // than todosdep directly above it in the same column. The engine normalises both to the
    // column width, which is why kpis lands 3px narrower. That is the engine being right.
    if (off > 3) bad(`default ${type}.${k} drifted ${off}px: got [${g.x},${g.y},${g.w},${g.h}] want [${x},${y},${w},${h}]`);
    else pass++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
