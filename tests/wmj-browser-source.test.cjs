/* The browser's WMJ source-selection. Subtle enough to be worth pinning:
     proxy 200  -> use it            (the whole point — one source of truth)
     proxy 503  -> fall back to sheet (not configured yet; keep working)
     proxy 502  -> THROW             (the guard caught a broken feed — falling back to the
                                      sheet here would restore the silent-wrong-data bug)
     no session -> fall back to sheet
   Lifted from the real file so it can't drift. */
const fs = require("fs");
const src = fs.readFileSync(__dirname + "/../assets/js/wmj-sync.js", "utf8");
const a = src.indexOf("  const PROXY_REPORTS = {");
const b = src.indexOf("  const LAST_KEY =");
if (a < 0 || b < 0) throw new Error("markers not found");
const make = new Function("window", "fetch", "console", src.slice(a, b) + "\n return { wmjCsv, syncErrors };");

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
  const mod = make(win, fetchStub, quietConsole);
  return { fn: mod.wmjCsv, calls, errors: mod.syncErrors };
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
    const fn = make(win, async (url, opts) => { calls.push(JSON.parse(opts.body).report); return { ok: true, status: 200, text: async () => "OK" }; }, quietConsole).wmjCsv;
    await fn("retainer", "https://s");
    ok(calls.join(",") === "retainer", "report name is passed through: " + calls.join(","));
  }

  /* THE PROJECTS SWITCH-OVER IS SELF-VERIFYING.
     The first reportKey supplied for projects was the TIMESHEET report — missing five of the
     columns the transform reads — and it broke every project page. So the response is checked
     against the real column list before being used, and anything short falls back to the sheet
     with the reason RECORDED (red on the Clients page), never silently. */
  const FULL = "Client_Name,Campaign_Name,Project_Name,Task_Full_Name,Allocated_Hours,Project_Status,Plan_Start_Date,Plan_Completion_Date,Service\nAcme,A,B,C,1,Production,,,Web\n";
  const SHEET_STYLE = FULL.replace(/_/g, " ");
  const TIMESHEET = "Client_Name,Campaign_Name,Project_Name,Task_Name,Comments,Actual_Billable_Hours\nAcme,A,B,C,,1\n";
  {
    const h = harness({ proxyStatus: 200, proxyBody: FULL });
    ok(await h.fn("projects", "https://sheet") === FULL, "a COMPLETE projects report is used");
  }
  {
    // the same check must accept the sheet's space-separated spelling, or a correct feed
    // would be rejected purely on punctuation
    const h = harness({ proxyStatus: 200, proxyBody: SHEET_STYLE });
    ok(await h.fn("projects", "https://sheet") === SHEET_STYLE, "space-separated headers are accepted too");
  }
  {
    const h = harness({ proxyStatus: 200, proxyBody: TIMESHEET });
    const out = await h.fn("projects", "https://sheet");
    ok(out === "SHEET_DATA", "the WRONG report falls back to the sheet instead of breaking the page");
    const errs = h.errors();
    ok(errs.length === 1, "and the fallback is recorded, not silent");
    ok(errs[0] && /Task_Full_Name/.test(errs[0]), "the record names a missing column: " + errs[0]);
    ok(errs[0] && /wrong report/.test(errs[0]), "and says what to check");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
