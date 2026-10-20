/* ============================================================
   SNAPSHOT-MONTHS — the scheduled, no-one-online monthly freeze.
   Runs on a schedule (daily; see .github/workflows/monthly-snapshot.yml),
   fetches the WMJ retainer sheet ITSELF, and writes each client's
   current-calendar-month burn + service-line snapshot into e.mom —
   so month-end data is captured with NO dependency on an admin having
   the portal open. Freezes past months automatically (keyed by
   month+year); running daily means the closing month holds its
   last-day value, then the 1st starts a fresh month.

   NOT a JWT endpoint — it's a machine call. Deploy with
   --no-verify-jwt and gate on a shared secret header:
     supabase functions deploy snapshot-months --use-api --no-verify-jwt
     supabase secrets set SNAPSHOT_SECRET=<random>
   The caller sends  x-snapshot-secret: <same value>.

   Minimal mutation: only touches each client's retainer burn.usedHours,
   burn.periodLabel and mom[] — never the fields the client sync owns —
   so it can't clobber dashboard state. Uses the service role.
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { fetchRetainerActuals, canon, normName } from "../_shared/wmj.ts";
import { reportHealth } from "../_shared/health.ts";
import { wmjAliasMap } from "../_shared/registry.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const round2 = (n: number) => Math.round((+n || 0) * 100) / 100;
// key-order-insensitive JSON (jsonb doesn't preserve key order)
// deno-lint-ignore no-explicit-any
function stableStr(v: any): string {
  // deno-lint-ignore no-explicit-any
  const walk = (x: any): any => (x === null || typeof x !== "object") ? x
    : Array.isArray(x) ? x.map(walk) : Object.keys(x).sort().reduce((o: any, k) => { o[k] = walk(x[k]); return o; }, {});
  return JSON.stringify(walk(v));
}

/* ---------- CLIENT REVENUE FORECAST (read directly; public CSV export) ----------
   One tab per client. Retainer rows (Type = Retainer, signed, not pending) give the RATE and
   each month's $. The NORMAL month is the amount the retainer bills most often (it must repeat
   at least twice, else there's no reliable baseline and no extension is inferred). This month
   above normal = scope extension; below normal = a lighter month (just fewer hours). */
const CRF_ID = Deno.env.get("CRF_SHEET_ID") || "1kO3Ar6AQoS72VTfUwJ1GP037kRgAlQrX55qGB2yJNY0";
export type CrfInfo = { month: string; tab: string; rate: number; monthDollars: number; baselineDollars: number;
  baseHours: number; extHours: number; sows: string[] };
function parseCsvText(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; } else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const money = (s: string) => { const v = parseFloat(String(s || "").replace(/[^0-9.\-]/g, "")); return isFinite(v) ? v : 0; };
// deno-lint-ignore no-explicit-any
async function loadCrf(roster: any[], monthKey: string): Promise<Map<string, CrfInfo>> {
  const out = new Map<string, CrfInfo>();
  const html = await (await fetch(`https://docs.google.com/spreadsheets/d/${CRF_ID}/htmlview`)).text();
  const tabs = [...html.matchAll(/name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g)].map((m) => ({ name: m[1].trim(), gid: m[2] }))
    .filter((t) => !/^(job aids|clients index|template)$/i.test(t.name));
  const live = roster.filter((c) => c && c.id && !c.mergedInto);
  const byCode = new Map(live.filter((c) => c.code).map((c) => [String(c.code).trim().toUpperCase(), c]));
  const nn = (x: string) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let i = 0;
  const worker = async () => {
    while (i < tabs.length) {
      const t = tabs[i++];
      try {
        const rows = parseCsvText(await (await fetch(`https://docs.google.com/spreadsheets/d/${CRF_ID}/export?format=csv&gid=${t.gid}`)).text());
        const h = (rows[0] || []).map((x) => x.trim());
        // some tabs have a mangled "SOW Name" header (ANL's reads " with ") → it's the column
        // just before "Total Contract $"
        let iName = h.findIndex((x) => /sow\s*name/i.test(x));
        if (iName < 0) { const iTot = h.findIndex((x) => /total contract/i.test(x)); if (iTot > 0) iName = iTot - 1; }
        const iType = h.indexOf("Type"), iRate = h.indexOf("$ Rate/Hr"), iStat = h.indexOf("Status");
        const yr = monthKey.slice(-4);
        const monthCols = h.map((x, k) => ({ x, k })).filter((o) => new RegExp(`^[A-Z][a-z]{2} ${yr}$`).test(o.x));
        const firstCols = new Map<string, number>(); monthCols.forEach((o) => { if (!firstCols.has(o.x)) firstCols.set(o.x, o.k); });
        if (iName < 0 || iType < 0 || iRate < 0 || !firstCols.has(monthKey)) continue;
        let base = 0, ext = 0, monthD = 0, baseD = 0, rate = 0; const sows: string[] = []; let code = "";
        for (const r of rows.slice(1)) {
          if (!/^retainer$/i.test((r[iType] || "").trim())) continue;
          if (/pending|proposal|draft|on\s*hold/i.test(`${r[iName]} ${r[iStat] || ""}`)) continue;
          const rt = money(r[iRate]); if (!(rt > 0)) continue;
          const cols = [...firstCols.values()];
          const curIdx = cols.indexOf(firstCols.get(monthKey)!);
          const now = money(r[firstCols.get(monthKey)!]);
          /* the NORMAL month = the value that repeats in the months AROUND this one (±3, this month
             excluded), so a mid-year step-up (ANL $10,745 → $15,245 in June) doesn't make the old
             rate look "normal". No repeat nearby → the whole year's most common value → else none. */
          const modeOf = (vals: number[]) => {
            const f = new Map<number, number>(); vals.filter((v) => v > 0).forEach((v) => f.set(v, (f.get(v) || 0) + 1));
            let nv = 0, nb = 1; f.forEach((n, v) => { if (n > nb || (n === nb && n >= 2 && v > nv)) { nb = n; nv = v; } });
            return nb >= 2 ? nv : 0;
          };
          const near = cols.filter((_, k) => k !== curIdx && Math.abs(k - curIdx) <= 3).map((k) => money(r[k]));
          let normal = modeOf(near) || modeOf(cols.filter((_, k) => k !== curIdx).map((k) => money(r[k])));
          if (!normal) normal = now;                      // no repeating month → no inferred extension
          base += Math.min(now, normal) / rt; ext += Math.max(0, now - normal) / rt;
          monthD += now; baseD += Math.min(now, normal); rate = rt; sows.push(String(r[iName]).trim());
          if (!code) code = String(r[iName] || "").trim().split(/\s+/)[0].toUpperCase();
        }
        if (!sows.length) continue;
        const c = byCode.get(code) || live.find((x) => nn(x.name) === nn(t.name) || nn(x.name).startsWith(nn(t.name)) || nn(t.name) === nn(x.code));
        if (!c) continue;
        out.set(c.id, { month: monthKey, tab: t.name, rate, monthDollars: round2(monthD), baselineDollars: round2(baseD),
          baseHours: round2(base), extHours: round2(ext), sows });
      } catch (_e) { /* one tab failing never blocks the rest */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json(req, 405, { error: "POST/GET only" });

  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret)
    return json(req, 401, { error: "bad or missing snapshot secret" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  // The month is TJA's business month — America/Phoenix wall time (UTC-7 year-round, no
  // DST), NOT UTC. The cron fires 06:00 UTC = 23:00 Phoenix the PREVIOUS day; keying by
  // UTC would flip to the new month an hour early and fight the browsers' local-time
  // writers, appending duplicate month entries at every boundary (found in QA 2026-07-20).
  const now = new Date(Date.now() - 7 * 3600e3);
  const yr = now.getUTCFullYear(), mi = now.getUTCMonth();
  const short = MON[mi], periodLabel = `${FULL[mi]} ${yr}`;

  // roster FIRST: clientId → name/wmjName (to match a dashboard to WMJ actuals), plus each
  // client's extra WMJ names (wmjAliases) so hours logged under any of them land on it
  const { data: regRow } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: any[] = Array.isArray(regRow?.data) ? regRow!.data : [];
  const nameById: Record<string, { name: string; wmj: string }> = {};
  roster.forEach((c) => { nameById[c.id] = { name: c.name || "", wmj: c.wmjName || "" }; });
  const merged = new Set(roster.filter((c) => c && c.mergedInto).map((c) => c.id));   // folded into another client

  let actuals;
  try { actuals = await fetchRetainerActuals(wmjAliasMap(roster)); }
  catch (e) {
    const msg = String((e as Error).message || e);
    await reportHealth("snapshot-months", { ok: false, error: msg });   // a dead sheet must be visible
    return json(req, 502, { error: msg });
  }

  // which clients have a dashboard (ids only — each client's data is re-read fresh below)
  const { data: rows, error } = await svc.from("app_state")
    .select("client_id").eq("scope", "dashboard");
  if (error) return json(req, 500, { error: error.message });

  // the Client Revenue Forecast, read DIRECTLY (rate + this month's $ + the normal month's $)
  const crf = await loadCrf(roster, short + " " + yr).catch((e) => { console.warn("CRF read failed", e); return new Map<string, CrfInfo>(); });

  let snapped = 0, skipped = 0, rolled = 0, suspect = 0, expired = 0, unchanged = 0;
  // sets, not arrays: a client's mutation can run more than once when a save is retried
  const suspectClients = new Set<string>(), noDenominator = new Set<string>(), expiredSet = new Set<string>();
  const matchedKeys = new Set<string>();      // WMJ clients that found a portal client
  for (const r of rows ?? []) {
    const clientId = r.client_id as string;
    if (!clientId || clientId.startsWith("_")) { skipped++; continue; }
    if (merged.has(clientId)) { skipped++; continue; }   // its hours now belong to the client it merged into

    /* COMPARE-AND-SET (2026-10-19). This job used to read EVERY client up front and write each
       whole record back later, blind and without bumping updated_at — so anything an admin
       saved in between (a manual burn adjustment, a scope extension) was silently overwritten:
       the "burn randomly resets / Reset to actuals disappeared / scope extension vanished" bug
       (DNA, ANL). Now each client is re-read immediately before the write, only this job's own
       fields are applied to that fresh copy, and the write lands only if nobody saved in
       between (else re-read + retry). Clients with nothing new aren't written at all. */
    let outcome = "skip";
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row } = await svc.from("app_state").select("data,updated_at")
        .eq("client_id", clientId).eq("scope", "dashboard").maybeSingle();
      if (!row) break;
      const data = row.data;
      const e = data?.engagements?.retainer;
      if (!e || !e.burn) break;
      /* DEMO / PITCH workspaces are hand-authored and have NO Workamajig counterpart. */
      if (data?.demo === true) break;
      const before = stableStr(e);
      const res = applyMonth(e, clientId);
      if (res === "suspect") { outcome = "suspect"; break; }
      if (stableStr(e) === before) { outcome = "unchanged"; break; }
      const w = await svc.from("app_state").update({ data, updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("scope", "dashboard").eq("updated_at", row.updated_at).select("updated_at");
      if (!w.error && w.data && w.data.length) { outcome = res; break; }
      await new Promise((rr) => setTimeout(rr, 120 + Math.random() * 250 * (attempt + 1)));
    }
    if (outcome === "skip") skipped++;
    else if (outcome === "unchanged") unchanged++;
    else if (outcome === "suspect") suspect++;
    else if (outcome === "snapped") snapped++;
    else rolled++;
  }

  // ---- this job's changes to ONE client's retainer (pure: operates on the copy it's given) ----
  function applyMonth(e: any, clientId: string): "snapped" | "rolled" | "suspect" {
    const nm = nameById[clientId] || { name: clientId, wmj: "" };
    const a = actuals.get(normName(nm.name)) || (nm.wmj && actuals.get(normName(nm.wmj))) || null;
    if (a) matchedKeys.add(a.norm);

    /* NO MATCH means this client has logged no retainer hours YET this month — which, on the
       1st, is EVERY client. This used to `continue`, so burn.periodLabel and burn.usedHours
       kept LAST month's values and the portal read as though the month had never turned over.
       On 2026-08-03 that left 43 of 46 clients still showing July's burn as if it were live
       (Cameron). A retainer client must roll into the new month at zero and climb from there,
       so roll forward with used = 0 rather than skipping.

       ONE exception, so a broken export can't zero real data: if the WHOLE sheet came back
       empty AND we already recorded hours for THIS month, treat it as suspect and leave the
       client alone. A genuine start-of-month zero is unaffected — there is no entry for the
       new month yet, so `existing` is undefined and the roll-forward proceeds. */
    const priorMom: Array<{ month?: string; year?: number; usedHours?: number }> = Array.isArray(e.mom) ? e.mom : [];
    const existing = priorMom.find((m) => m && m.month === short && m.year === yr);
    if (!a && actuals.size === 0 && existing && +(existing.usedHours ?? 0) > 0) {
      suspectClients.add(nm.name || clientId); return "suspect";
    }

    const used = a ? a.total : 0;
    const disc: any[] = Array.isArray(e.serviceDisciplines) ? e.serviceDisciplines : [];
    const sowOk = e.retainerValueMonthly === true && e.retainerValueTarget != null && +e.retainerValueTarget > 0;
    /* THE CLIENT REVENUE FORECAST is the governing truth for the rate and this month's $
       (Cameron 2026-10-19). baseHours = the NORMAL retainer month; anything the CRF bills above
       that normal month is a SCOPE EXTENSION (extHours), shown as its own line and dropped when
       the month ends. ANL Oct: $18,845 vs normal $15,245 at $150/hr → 101.63h + 24h extension. */
    const cr = crf.get(clientId);
    if (cr) e.crf = { ...cr, period: periodLabel }; else delete e.crf;   // `period` = the burn label it belongs to
    const contracted = cr ? cr.baseHours
      : sowOk ? +e.retainerValueTarget
      : disc.reduce((s, d) => s + (+d.contracted || 0), 0);

    // per-discipline billable from fresh actuals, matched by canon key
    const actByCanon: Record<string, number> = {};
    // e.deptMap: WMJ departments an admin allocated to a service line (Unallocated view) —
    // KEEP IN SYNC with exec-summary.js deptKey
    const dk = (dept: string) => { const k = canon(dept); return (e.deptMap && e.deptMap[k]) || k; };
    if (a) for (const [dept, b] of Object.entries(a.byDept)) actByCanon[dk(dept)] = (actByCanon[dk(dept)] || 0) + (b as number);
    /* MANUAL HOURS ADJUSTMENTS are a DELTA on top of actuals (Cameron 2026-10-19: "if i up it
       from 20 to 30, then the actuals show 25, we should show 35"). They ride into THIS month's
       record so the frozen month keeps what was presented. Keyed by canon discipline. */
    const adj: Record<string, number> = (e.overrideMonth === periodLabel && e.hoursAdjust) ? e.hoursAdjust : {};
    const adjTotal = Object.values(adj).reduce((s: number, v) => s + (+v || 0), 0);
    const lines = disc.map((d) => ({
      name: d.name, contracted: +d.contracted || 0,
      billable: round2(Math.max(0, (actByCanon[canon(d.name)] || 0) + (+adj[canon(d.name)] || 0))),
    }));

    // upsert the current calendar month (freeze the past — never touch older entries).
    // Match by (month, year) ANYWHERE in the array — not just the last entry — so that
    // even if another writer appended a different month first (boundary race), we update
    // our month in place instead of pushing a duplicate. Legacy no-year entries are only
    // adopted when they're the last entry (an old same-name month, e.g. last July, must
    // never be mistaken for this one). KEEP IN SYNC with wmj-sync.js snapshotMonth and
    // exec-summary.js syncCurrentMonth.
    e.mom = Array.isArray(e.mom) ? e.mom : [];
    // the month record's denominator INCLUDES this month's extensions (CRF + hand-added), so a
    // frozen month's % reads the way it was presented. KEEP IN SYNC with syncCurrentMonth.
    const manualExt = (e.burn && e.burn.scopeExtMonth === periodLabel && Array.isArray(e.burn.scopeExts))
      ? e.burn.scopeExts.reduce((s2: number, x: any) => s2 + (+x.hours || 0), 0) : 0;
    const extNow = (cr ? (+cr.extHours || 0) : 0) + manualExt;
    const entry: any = { month: short, year: yr, usedHours: round2(Math.max(0, used + adjTotal)), contractedHours: round2(contracted + extNow), lines };
    entry.scopeExtHours = cr ? (+cr.extHours || 0) : 0;   // CRF extension for this month (frozen with it)
    let idx = e.mom.findIndex((m: { month?: string; year?: number }) => m && m.month === short && m.year === yr);
    if (idx < 0) {
      const last = e.mom[e.mom.length - 1];
      if (last && last.month === short && last.year == null) idx = e.mom.length - 1;
    }
    if (idx >= 0) e.mom[idx] = { ...e.mom[idx], ...entry };
    else e.mom.push(entry);
    if (e.mom.length > 24) e.mom = e.mom.slice(-24);

    /* THE PER-DISCIPLINE ACTUALS. This is not optional bookkeeping: the browser computes the
       burn gauge from wmjServiceLines (exec-summary retainerUsed → actualByDiscipline), NOT
       from burn.usedHours. Leaving it stale is why HVH read "August 2026 · 79%" while
       burn.usedHours was correctly 0 — the label had rolled but the needle was still summing
       July's 54.4h (Cameron 2026-08-03). Rewritten from THIS month's actuals every run, and
       emptied when the client has none yet, so nothing from last month can survive into this
       one. Shape matches wmj-sync.js's rc.serviceLines for the fields anything reads
       (name, billable, projects); `allocated` stays the browser sync's to own. */
    e.wmjServiceLines = a
      ? Object.entries(a.byDept).map(([dept, bill]) => ({
          name: dept,
          billable: round2(bill as number),
          projects: Object.entries(a.byDeptProjects[dept] || {})
            .map(([name, b]) => ({ name, billable: round2(b as number) }))
            .filter((pr) => pr.billable > 0)
            .sort((x, y) => y.billable - x.billable),
        }))
      : [];

    /* EXPIRE LAST MONTH'S PRESENTATION OVERRIDES. svcUtilOverride (a dragged service-line %)
       and hoursRealloc (hours moved between lines) describe how ONE month was presented, but
       carried no month stamp and never expired — so the browser kept computing the burn from a
       July override and Arizona Dept of Child Safety still read 98% in August (Cameron
       2026-08-03). Cleared here rather than only in the browser so it self-heals with nobody
       online. Unstamped overrides are legacy (set before stamping existed) and are treated as
       expired; anything stamped with THIS month is the admin's current intent and survives.
       KEEP IN SYNC with exec-summary.js ovActive/stampOv. */
    if (e.overrideMonth !== periodLabel) {
      const had = !!(e.svcUtilOverride || e.hoursRealloc || (e.burn && e.burn.pctOverride != null));
      const hadAdj = !!(e.hoursAdjust && Object.keys(e.hoursAdjust).length);
      delete e.svcUtilOverride; delete e.hoursRealloc; delete e.hoursAdjust; delete e.overrideMonth;
      if (e.burn) delete e.burn.pctOverride;
      if (had || hadAdj) expiredSet.add(clientId);
    }

    // A retainer with no contracted hours has no denominator, so its burn % is meaningless
    // (renders as "—"). Surfaced on the health page rather than silently looking fine.
    if (!(contracted > 0)) noDenominator.add(nm.name || clientId);

    // keep the live burn fresh too (so the dashboard is current even with no admin online)
    e.burn.usedHours = round2(used);
    e.burn.periodLabel = periodLabel;

    return a ? "snapped" : "rolled";
  }

  // snapped = had hours this month · rolled = retainer client at 0 so far (label still moves
  // forward) · suspect = left alone because the sheet came back empty over existing data
  /* WMJ clients whose hours matched NO portal client. Their hours are silently dropped from
     every dashboard (Ignite, 2026-10-19), so they're reported here — and on the health page —
     with the hours at stake, so a name mismatch is visible the same day. */
  const unmatchedWmj = [...actuals.values()].filter((x) => !matchedKeys.has(x.norm) && x.total > 0)
    .map((x) => x.wmjName);
  expired = expiredSet.size;
  const result = { ok: true, month: periodLabel, snapped, rolled, unchanged, suspect, skipped, expired,
    clientsInSheet: actuals.size, crfClients: crf.size, unmatchedWmj,
    suspectClients: [...suspectClients], noDenominator: [...noDenominator] };
  await reportHealth("snapshot-months", result);
  return json(req, 200, result);
});
