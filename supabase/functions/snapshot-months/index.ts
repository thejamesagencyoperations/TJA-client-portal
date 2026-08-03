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
import { createClient } from "npm:@supabase/supabase-js@2";

const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const round2 = (n: number) => Math.round((+n || 0) * 100) / 100;

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

  let actuals;
  try { actuals = await fetchRetainerActuals(); }
  catch (e) { return json(req, 502, { error: String((e as Error).message || e) }); }

  // roster: clientId → name/wmjName, to match a stored dashboard to WMJ actuals
  const { data: regRow } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: any[] = Array.isArray(regRow?.data) ? regRow!.data : [];
  const nameById: Record<string, { name: string; wmj: string }> = {};
  roster.forEach((c) => { nameById[c.id] = { name: c.name || "", wmj: c.wmjName || "" }; });

  // every retainer dashboard row
  const { data: rows, error } = await svc.from("app_state")
    .select("client_id,data").eq("scope", "dashboard");
  if (error) return json(req, 500, { error: error.message });

  let snapped = 0, skipped = 0, rolled = 0, suspect = 0;
  for (const r of rows ?? []) {
    const clientId = r.client_id as string;
    if (!clientId || clientId.startsWith("_")) { skipped++; continue; }
    const data = r.data;
    const e = data?.engagements?.retainer;
    if (!e || !e.burn) { skipped++; continue; }

    // match this client to WMJ actuals by normalized name (name or wmjName)
    const nm = nameById[clientId] || { name: clientId, wmj: "" };
    const a = actuals.get(normName(nm.name)) || (nm.wmj && actuals.get(normName(nm.wmj))) || null;

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
    if (!a && actuals.size === 0 && existing && +(existing.usedHours ?? 0) > 0) { suspect++; continue; }

    const used = a ? a.total : 0;
    const disc: any[] = Array.isArray(e.serviceDisciplines) ? e.serviceDisciplines : [];
    const sowOk = e.retainerValueMonthly === true && e.retainerValueTarget != null && +e.retainerValueTarget > 0;
    const contracted = sowOk ? +e.retainerValueTarget
      : disc.reduce((s, d) => s + (+d.contracted || 0), 0);

    // per-discipline billable from fresh actuals, matched by canon key
    const actByCanon: Record<string, number> = {};
    if (a) for (const [dept, b] of Object.entries(a.byDept)) actByCanon[canon(dept)] = (actByCanon[canon(dept)] || 0) + (b as number);
    const lines = disc.map((d) => ({
      name: d.name, contracted: +d.contracted || 0, billable: round2(actByCanon[canon(d.name)] || 0),
    }));

    // upsert the current calendar month (freeze the past — never touch older entries).
    // Match by (month, year) ANYWHERE in the array — not just the last entry — so that
    // even if another writer appended a different month first (boundary race), we update
    // our month in place instead of pushing a duplicate. Legacy no-year entries are only
    // adopted when they're the last entry (an old same-name month, e.g. last July, must
    // never be mistaken for this one). KEEP IN SYNC with wmj-sync.js snapshotMonth and
    // exec-summary.js syncCurrentMonth.
    e.mom = Array.isArray(e.mom) ? e.mom : [];
    const entry = { month: short, year: yr, usedHours: round2(used), contractedHours: round2(contracted), lines };
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

    // keep the live burn fresh too (so the dashboard is current even with no admin online)
    e.burn.usedHours = round2(used);
    e.burn.periodLabel = periodLabel;

    const { error: werr } = await svc.from("app_state")
      .update({ data }).eq("client_id", clientId).eq("scope", "dashboard");
    if (werr) { skipped++; continue; }
    if (a) snapped++; else rolled++;      // rolled = carried into the new month at zero hours
  }

  // snapped = had hours this month · rolled = retainer client at 0 so far (label still moves
  // forward) · suspect = left alone because the sheet came back empty over existing data
  return json(req, 200, { ok: true, month: periodLabel, snapped, rolled, suspect, skipped, clientsInSheet: actuals.size });
});
