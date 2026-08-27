/* ============================================================
   WMJ RETAINER ACTUALS (Deno port, for the scheduled snapshot)
   A lean server-side read of the Workamajig RETAINER timesheet:
   per-client BILLABLE hours, grouped by User_Department (with the
   Organic-Social split), plus each client's total.

   KEEP IN SYNC with assets/js/retainer-transform.js + the
   canonDiscipline in assets/js/client-template.js — same header
   normalization, same non-billable guard, same Organic-Social
   split, same canon keys. This is intentionally a small subset
   (actuals only — no allocated/projects) since the snapshot just
   needs billable hours by discipline.
   ============================================================ */

import { fetchT } from "./http.ts";

const RET_SHEET_ID = "1d-iwYnkA_rmdZyysRPz_b1X7zSucBBviIBwhzdlrj00";
const RET_CSV_URL = `https://docs.google.com/spreadsheets/d/${RET_SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;

export const normName = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// same discipline canonicalizer as client-template.js (social outranks media/oversight)
export function canon(s: string): string {
  s = String(s || "").toLowerCase();
  if (/social/.test(s)) return "social";
  if (/public relation|(^|[^a-z])pr([^a-z]|$)/.test(s)) return "pr";
  if (/paid media|(^|[^a-z])media/.test(s)) return "media";
  if (/creativ|design/.test(s)) return "creative";
  if (/web|seo|develop|coding/.test(s)) return "web";
  if (/strateg|oversight|account|client service|management|leadership|project manage/.test(s)) return "oversight";
  return s.replace(/[^a-z0-9]/g, "");
}

// quote-aware CSV → row objects; headers normalized to underscore form so both
// "Client_Name" and "Client Name" work (the export has flipped between them).
function parseCSV(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], field = "", i = 0, q = false; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (c === "\r") { /* skip */ } else field += c; }
    i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().replace(/\s+/g, "_"));
  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => { const o: Record<string, string> = {}; head.forEach((h, j) => o[h] = (r[j] || "").trim()); return o; });
}

function isNonBillable(r: Record<string, string>): boolean {
  const cm = (r.Campaign_Name || "").toLowerCase(), cl = (r.Client_Name || "").toLowerCase();
  if (/\b\d{1,2}(:\d{2})?\s*(a|p)m\b/i.test(r.Client_Name || "")) return true;   // note-text leaked into Client_Name
  return !cl || cm.indexOf("non-billable") > -1 || cl.indexOf("the james agency") > -1;
}

export interface ClientActuals {
  wmjName: string; norm: string;
  byDept: Record<string, number>;
  // dept → project name → billable hours. Feeds the admin "unallocated hours" drill-down
  // (exec-summary unmatchedProjects), so the scheduled writer can refresh wmjServiceLines
  // completely instead of leaving last month's project list attached to this month.
  byDeptProjects: Record<string, Record<string, number>>;
  total: number;
}

/* ---- Where the retainer CSV actually comes from -------------------------------
   TWO PATHS, and which one runs depends only on whether the WMJ secrets are set.

   DIRECT (preferred). Calls the Workamajig Report Endpoint with a `reportKey` plus two
   tokens, all of which are STABLE. This exists because the legacy path below is fed by a
   Google-Sheets `=IMPORTDATA(...linkKey=...)` formula, and Workamajig confirmed those
   linkKeys EXPIRE. When one does the sheet fills with #N/A, the parser reads zero rows, and
   — because of the month roll-forward — EVERY retainer client rolls to 0 hours with the burn
   gauge reading 0%. It kept breaking around month boundaries. Cutting out the sheet removes
   the expiring credential entirely.

   SHEET (legacy fallback). Still used when the secrets aren't configured, so this file can
   ship before the tokens exist and switch over by itself the moment they do — no flag day.

   Deliberately NO fallback from direct → sheet on error. Falling back would mean a broken
   direct path is invisible, and the sheet's own failure mode is silent zeros: the two
   together would hide exactly what this change exists to expose. If the direct call fails it
   throws, snapshot-months catches it, records it to _health and returns 502. Loud beats
   quietly wrong. */
const wmjEnv = () => ({
  sub: Deno.env.get("WMJ_SUBDOMAIN"),
  aat: Deno.env.get("WMJ_API_ACCESS_TOKEN"),
  ut:  Deno.env.get("WMJ_USER_TOKEN"),
  rk:  Deno.env.get("WMJ_RETAINER_REPORTKEY"),
});
export const wmjDirectConfigured = () => { const e = wmjEnv(); return !!(e.sub && e.aat && e.ut && e.rk); };

/* A response can be HTTP 200 and still be useless: an expired linkKey yields a sheet of
   #N/A, and an API error can arrive as a JSON envelope. Both used to parse as "no rows",
   which is indistinguishable from a quiet weekend — the single reason these outages went
   unnoticed for so long. Anything that doesn't look like the timesheet export is an ERROR now. */
export function assertLooksLikeWmjCsv(text: string, source: string, requiredCol = "Client_Name"): void {
  const head = text.slice(0, 2000);
  if (/^\s*[[{]/.test(text)) throw new Error(`${source} returned JSON, not CSV: ${head.slice(0, 200)}`);
  if (/#N\/A|#REF!|#ERROR!|Could not fetch url/i.test(head))
    throw new Error(`${source} is broken upstream — the sheet is full of #N/A, which usually means its IMPORTDATA linkKey has EXPIRED: ${head.slice(0, 200)}`);
  if (!new RegExp(requiredCol.replace(/_/g, "[ _]"), "i").test(head))
    throw new Error(`${source} has no ${requiredCol} column — not the expected export: ${head.slice(0, 200)}`);
}
const assertLooksLikeTimesheetCsv = (text: string, source: string) => assertLooksLikeWmjCsv(text, source);

/* ONE place that knows how to address a WMJ report, so the scheduled snapshot and the
   browser proxy can never drift onto different subdomains or header shapes. */
export function wmjReportRequest(reportKey: string): { url: string; init: RequestInit } | null {
  const e = wmjEnv();
  if (!e.sub || !e.aat || !e.ut || !reportKey) return null;
  return {
    url: `https://${e.sub}.workamajig.com/api/beta1/reports?reportKey=${encodeURIComponent(reportKey)}&output=csv`,
    init: { headers: { "Content-Type": "application/json", APIAccessToken: e.aat, UserToken: e.ut } },
  };
}

async function fetchRetainerCsv(): Promise<string> {
  const e = wmjEnv();
  const direct = wmjReportRequest(e.rk || "");
  if (direct) {
    const res = await fetchT(direct.url, direct.init,
      { timeoutMs: 30_000, retries: 2, label: "WMJ retainer report (direct API)" });
    if (!res.ok) throw new Error(`WMJ retainer report failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    assertLooksLikeTimesheetCsv(text, "WMJ retainer report (direct API)");
    return text;
  }
  /* Timed + retried, NOT a bare fetch. This call hung mid-transfer on 2026-08-26 and took the
     whole snapshot down with a Supabase 150s IDLE_TIMEOUT (see _shared/http.ts). */
  const res = await fetchT(RET_CSV_URL, { headers: { "cache-control": "no-cache" } },
    { timeoutMs: 20_000, retries: 2, label: "WMJ retainer actuals sheet" });
  if (!res.ok) throw new Error(`WMJ retainer fetch failed: ${res.status}`);
  const text = await res.text();
  assertLooksLikeTimesheetCsv(text, "WMJ retainer actuals sheet");
  return text;
}

export async function fetchRetainerActuals(): Promise<Map<string, ClientActuals>> {
  const rows = parseCSV(await fetchRetainerCsv());
  const map = new Map<string, ClientActuals>();
  for (const r of rows) {
    if (isNonBillable(r)) continue;
    const key = normName(r.Client_Name);
    if (!map.has(key)) map.set(key, { wmjName: (r.Client_Name || "").trim(), norm: key, byDept: {}, byDeptProjects: {}, total: 0 });
    const c = map.get(key)!;
    // Organic Social lives as a Service_Description under Creative — split it out to its own line
    const dept = /organic\s*social/i.test(r.Service_Description || "")
      ? "Organic Social" : ((r.User_Department || "Other").trim() || "Other");
    const bill = parseFloat(r.Actual_Billable_Hours) || 0;
    c.byDept[dept] = (c.byDept[dept] || 0) + bill;
    const proj = (r.Project_Name || "").trim();
    if (proj) {
      const pm = c.byDeptProjects[dept] || (c.byDeptProjects[dept] = {});
      pm[proj] = (pm[proj] || 0) + bill;
    }
    c.total += bill;
  }
  // round
  for (const c of map.values()) {
    c.total = Math.round(c.total * 100) / 100;
    for (const k of Object.keys(c.byDept)) c.byDept[k] = Math.round(c.byDept[k] * 100) / 100;
    for (const d of Object.keys(c.byDeptProjects)) {
      const pm = c.byDeptProjects[d];
      for (const pn of Object.keys(pm)) pm[pn] = Math.round(pm[pn] * 100) / 100;
    }
  }
  return map;
}
