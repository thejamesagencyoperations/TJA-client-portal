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
  const now = new Date();
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

  let snapped = 0, skipped = 0;
  for (const r of rows ?? []) {
    const clientId = r.client_id as string;
    if (!clientId || clientId.startsWith("_")) { skipped++; continue; }
    const data = r.data;
    const e = data?.engagements?.retainer;
    if (!e || !e.burn) { skipped++; continue; }

    // match this client to WMJ actuals by normalized name (name or wmjName)
    const nm = nameById[clientId] || { name: clientId, wmj: "" };
    const a = actuals.get(normName(nm.name)) || (nm.wmj && actuals.get(normName(nm.wmj)));
    if (!a) { skipped++; continue; }                     // no retainer billing for this client this month

    const used = a.total;
    const disc: any[] = Array.isArray(e.serviceDisciplines) ? e.serviceDisciplines : [];
    const sowOk = e.retainerValueMonthly === true && e.retainerValueTarget != null && +e.retainerValueTarget > 0;
    const contracted = sowOk ? +e.retainerValueTarget
      : disc.reduce((s, d) => s + (+d.contracted || 0), 0);

    // per-discipline billable from fresh actuals, matched by canon key
    const actByCanon: Record<string, number> = {};
    for (const [dept, b] of Object.entries(a.byDept)) actByCanon[canon(dept)] = (actByCanon[canon(dept)] || 0) + (b as number);
    const lines = disc.map((d) => ({
      name: d.name, contracted: +d.contracted || 0, billable: round2(actByCanon[canon(d.name)] || 0),
    }));

    // upsert the current calendar month (freeze the past — never touch older entries)
    e.mom = Array.isArray(e.mom) ? e.mom : [];
    const last = e.mom[e.mom.length - 1];
    const entry = { month: short, year: yr, usedHours: round2(used), contractedHours: round2(contracted), lines };
    if (last && last.month === short && (last.year == null || last.year === yr)) e.mom[e.mom.length - 1] = { ...last, ...entry };
    else e.mom.push(entry);
    if (e.mom.length > 24) e.mom = e.mom.slice(-24);

    // keep the live burn fresh too (so the dashboard is current even with no admin online)
    e.burn.usedHours = round2(used);
    e.burn.periodLabel = periodLabel;

    const { error: werr } = await svc.from("app_state")
      .update({ data }).eq("client_id", clientId).eq("scope", "dashboard");
    if (werr) { skipped++; continue; }
    snapped++;
  }

  return json(req, 200, { ok: true, month: periodLabel, snapped, skipped, clientsInSheet: actuals.size });
});
