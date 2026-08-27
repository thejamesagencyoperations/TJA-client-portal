/* ============================================================
   WMJ-REPORT — serves a Workamajig report to the BROWSER.

   WHY THIS EXISTS
   Until now the portal had TWO writers for the same retainer numbers, reading two
   different sources:
     • snapshot-months (cron)  → the WMJ Report Endpoint  (correct, converted 2026-08-26)
     • wmj-sync.js  (browser)  → the published Google Sheet
   The sheet is fed by an =IMPORTDATA(...linkKey=...) formula whose linkKey EXPIRES, and it
   also mangles rows whose Comments contain a comma — measured: A New Leaf reported 98.8h via
   the sheet against 100.1h via the API, because a column-shifted row dropped 1.25 billable
   hours. Whichever writer ran last won, so a client's hours could change depending on
   whether an admin happened to have the Clients page open.

   The browser can't call Workamajig itself: the API needs an APIAccessToken and a UserToken
   as HEADERS, and shipping those to a browser would expose account-wide credentials. So the
   browser asks this function, which holds the tokens server-side. One source of truth.

   Caller: STAFF ONLY. Clients never sync WMJ, and the payload is every client's timesheet —
   exactly the cross-client data a client account must never receive.

   Returns text/csv on success (the callers all want raw CSV to parse) and JSON on error, so
   a failure can never be mistaken for an empty report.

   Deploy:  supabase functions deploy wmj-report --use-api
   ============================================================ */
import { handleOptions, json, corsHeaders } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { fetchT } from "../_shared/http.ts";
import { assertLooksLikeWmjCsv, wmjReportRequest } from "../_shared/wmj.ts";

// Which report, and the column that proves we got the right one back.
const REPORTS: Record<string, { env: string; label: string; requiredCol: string }> = {
  retainer: { env: "WMJ_RETAINER_REPORTKEY", label: "WMJ retainer actuals", requiredCol: "Client_Name" },
  projects: { env: "WMJ_PROJECTS_REPORTKEY", label: "WMJ projects allocated hours", requiredCol: "Campaign_Name" },
};

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (caller.role === "client") return json(req, 403, { error: "staff only" });

  let body: { report?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const spec = REPORTS[String(body.report || "")];
  if (!spec) return json(req, 400, { error: `report must be one of: ${Object.keys(REPORTS).join(", ")}` });

  const key = Deno.env.get(spec.env) || "";
  const request = wmjReportRequest(key);
  // 503, not 500: "not configured yet" is a deployment state, and the caller is expected to
  // fall back to its existing behaviour rather than treat this as the feed being broken.
  if (!request) return json(req, 503, { error: `WMJ direct API not configured (need WMJ_SUBDOMAIN, WMJ_API_ACCESS_TOKEN, WMJ_USER_TOKEN and ${spec.env})` });

  try {
    const res = await fetchT(request.url, request.init,
      { timeoutMs: 30_000, retries: 2, label: spec.label });
    if (!res.ok) return json(req, 502, { error: `${spec.label}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}` });
    const csv = await res.text();
    // Same guard the scheduled path uses: an HTTP 200 full of #N/A, or a JSON error envelope,
    // must NOT reach a parser that would read it as "no rows".
    assertLooksLikeWmjCsv(csv, spec.label, spec.requiredCol);
    return new Response(csv, {
      status: 200,
      headers: { ...corsHeaders(req), "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    return json(req, 502, { error: String((e as Error).message || e) });
  }
});
