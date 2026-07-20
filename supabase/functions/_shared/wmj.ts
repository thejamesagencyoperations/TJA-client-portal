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

export interface ClientActuals { wmjName: string; norm: string; byDept: Record<string, number>; total: number; }

export async function fetchRetainerActuals(): Promise<Map<string, ClientActuals>> {
  const res = await fetch(RET_CSV_URL, { headers: { "cache-control": "no-cache" } });
  if (!res.ok) throw new Error(`WMJ retainer fetch failed: ${res.status}`);
  const rows = parseCSV(await res.text());
  const map = new Map<string, ClientActuals>();
  for (const r of rows) {
    if (isNonBillable(r)) continue;
    const key = normName(r.Client_Name);
    if (!map.has(key)) map.set(key, { wmjName: (r.Client_Name || "").trim(), norm: key, byDept: {}, total: 0 });
    const c = map.get(key)!;
    // Organic Social lives as a Service_Description under Creative — split it out to its own line
    const dept = /organic\s*social/i.test(r.Service_Description || "")
      ? "Organic Social" : ((r.User_Department || "Other").trim() || "Other");
    const bill = parseFloat(r.Actual_Billable_Hours) || 0;
    c.byDept[dept] = (c.byDept[dept] || 0) + bill;
    c.total += bill;
  }
  // round
  for (const c of map.values()) {
    c.total = Math.round(c.total * 100) / 100;
    for (const k of Object.keys(c.byDept)) c.byDept[k] = Math.round(c.byDept[k] * 100) / 100;
  }
  return map;
}
