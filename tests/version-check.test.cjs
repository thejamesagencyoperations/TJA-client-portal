/* The stale-code auto-reload. Lifted from the real file.
   The bug this pins: the original guard recorded "tried version N" once and never revisited
   it, so a reload that landed on GitHub Pages' 10-minute cached HTML left that tab stuck on
   old code for the whole session — while still believing it had updated. */
const fs = require("fs");
let src = fs.readFileSync(__dirname + "/../assets/js/version-check.js", "utf8");

function run({ mine, remote, hidden = true, editing = false, store = {}, now = 1_000_000 }) {
  let reloaded = 0;
  const sessionStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
  };
  const document = {
    currentScript: { src: "https://x/assets/js/version-check.js?v=" + mine },
    hidden, activeElement: editing ? { tagName: "INPUT" } : null,
    addEventListener() {},
  };
  const window = {};
  const fetch = async () => ({ ok: true, json: async () => ({ v: remote }) });
  const location = { reload: () => { reloaded++; } };
  const Date_ = { now: () => now };
  const setInterval = () => {};
  const fn = new Function("document", "window", "fetch", "location", "sessionStorage", "setInterval", "Date", "URLSearchParams",
    src + "\n return window.TJA_VCHECK;");
  const check = fn(document, window, fetch, location, sessionStorage, setInterval, Date_, URLSearchParams);
  return check().then(() => ({ reloaded, store }));
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };

(async () => {
  // the normal case: a stale tab picks up the new version by itself
  ok((await run({ mine: 371, remote: 372 })).reloaded === 1, "a stale tab reloads itself");
  // already current — must not reload (that would be an endless refresh loop)
  ok((await run({ mine: 372, remote: 372 })).reloaded === 0, "a current tab does NOT reload");
  ok((await run({ mine: 373, remote: 372 })).reloaded === 0, "a NEWER tab does not downgrade-reload");
  // never yank the page out from under someone mid-edit
  ok((await run({ mine: 371, remote: 372, hidden: false, editing: true })).reloaded === 0, "does not reload while a field has focus");
  ok((await run({ mine: 371, remote: 372, hidden: false, editing: false })).reloaded === 1, "reloads a visible tab when nothing is focused");

  // THE FIX: a reload that landed on cached HTML must get a second chance
  {
    const store = {};
    const a = await run({ mine: 371, remote: 372, store, now: 1_000_000 });
    ok(a.reloaded === 1, "first attempt fires");
    // still within the Pages cache window — must not loop
    const b = await run({ mine: 371, remote: 372, store, now: 1_000_000 + 60_000 });
    ok(b.reloaded === 0, "no retry one minute later (would be a reload loop)");
    const c = await run({ mine: 371, remote: 372, store, now: 1_000_000 + 10 * 60_000 });
    ok(c.reloaded === 0, "still no retry at 10 minutes (cache may not have expired)");
    // past the 10-minute cache — the old HTML can no longer be served, so try once more
    const d = await run({ mine: 371, remote: 372, store, now: 1_000_000 + 12 * 60_000 });
    ok(d.reloaded === 1, "retries after the cache window has passed — this is the fix");
  }
  // the old sessionStorage format (a bare version string) must not crash or block forever
  {
    const store = { tja_vreload_target: "372" };
    const r = await run({ mine: 371, remote: 372, store, now: 5_000_000 });
    ok(r.reloaded === 1, "legacy stored format is tolerated and retried");
  }
  // a different version always gets its own fresh attempt
  {
    const store = {};
    await run({ mine: 371, remote: 372, store, now: 1_000_000 });
    const r = await run({ mine: 371, remote: 373, store, now: 1_000_000 + 30_000 });
    ok(r.reloaded === 1, "a newer version gets its own attempt immediately");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
