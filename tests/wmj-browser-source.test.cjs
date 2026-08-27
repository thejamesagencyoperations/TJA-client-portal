/* The browser's WMJ source-selection. Subtle enough to be worth pinning:
     proxy 200  -> use it            (the whole point — one source of truth)
     proxy 503  -> fall back to sheet (not configured yet; keep working)
     proxy 502  -> THROW             (the guard caught a broken feed — falling back to the
                                      sheet here would restore the silent-wrong-data bug)
     no session -> fall back to sheet
   Lifted from the real file so it can't drift. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/wmj-sync.js", "utf8");
const a = src.indexOf("  async function wmjCsv(report, sheetUrl) {");
const b = src.indexOf("  const LAST_KEY =");
if (a < 0 || b < 0) throw new Error("markers not found");
const make = new Function("window", "fetch", "console", src.slice(a, b) + "\n return wmjCsv;");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ok  " + m); } else { fail++; console.log("  FAIL " + m); } };
const quietConsole = { warn() {}, log() {} };

function harness({ proxyStatus, proxyBody, session = "tok", sheetBody = "SHEET_DATA", supa = true }) {
  const calls = [];
  const win = {
    SUPABASE_CONFIG: { url: "https://x.supabase.co" },
    SUPA: supa ? { enabled: true, client: { auth: { getSession: async () => ({ data: session ? { session: { access_token: session } } : {} }) } } } : null,
  };
  const fetchStub = async (url, opts) => {
    calls.push(url);
    if (String(url).includes("/wmj-report")) {
      return {
        ok: proxyStatus === 200, status: proxyStatus,
        text: async () => proxyBody ?? "PROXY_DATA",
        json: async () => ({ error: proxyBody || "boom" }),
      };
    }
    return { ok: true, status: 200, text: async () => sheetBody };
  };
  return { fn: make(win, fetchStub, quietConsole), calls };
}

(async () => {
  // 200 → proxy wins, sheet never touched
  {
    const h = harness({ proxyStatus: 200 });
    const out = await h.fn("retainer", "https://sheet");
    ok(out === "PROXY_DATA", "proxy 200 is used");
    ok(!h.calls.some(u => u === "https://sheet"), "sheet is NOT fetched when the proxy answers");
  }
  // 503 → not configured, fall back so nothing breaks mid-rollout
  {
    const h = harness({ proxyStatus: 503 });
    const out = await h.fn("retainer", "https://sheet");
    ok(out === "SHEET_DATA", "proxy 503 falls back to the sheet");
  }
  // 502 → the guard caught a broken feed; must NOT silently use the sheet
  {
    const h = harness({ proxyStatus: 502, proxyBody: "feed is full of #N/A" });
    let threw = null;
    try { await h.fn("retainer", "https://sheet"); } catch (e) { threw = e; }
    ok(!!threw, "proxy 502 throws instead of falling back");
    ok(threw && /#N\/A/.test(threw.message), "the error carries the reason: " + (threw && threw.message));
    ok(!h.calls.some(u => u === "https://sheet"), "sheet is NOT used to paper over a broken feed");
  }
  // no session / no backend → fall back (an admin on a stale tab still syncs)
  {
    const h = harness({ proxyStatus: 200, session: null });
    ok(await h.fn("retainer", "https://sheet") === "SHEET_DATA", "no session falls back to the sheet");
  }
  {
    const h = harness({ proxyStatus: 200, supa: false });
    ok(await h.fn("projects", "https://sheet") === "SHEET_DATA", "no Supabase client falls back to the sheet");
  }
  // the report name is actually passed through, or both feeds would fetch the same report
  {
    const calls = [];
    const win = { SUPABASE_CONFIG: { url: "https://x.supabase.co" },
      SUPA: { enabled: true, client: { auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } } } };
    const fn = make(win, async (url, opts) => { calls.push(JSON.parse(opts.body).report); return { ok: true, status: 200, text: async () => "OK" }; }, quietConsole);
    await fn("retainer", "https://s"); await fn("projects", "https://s");
    ok(calls.join(",") === "retainer,projects", "report name is passed through: " + calls.join(","));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
