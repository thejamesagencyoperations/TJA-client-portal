/* ============================================================
   PROJECT-PLAN PARSER (server port)
   Reads columns A-H of a TJA Gantt project-plan sheet:
     # | TASK | WHO | DEPENDENCY | START | END | % DONE | NOTES
   Integer-numbered rows with no owner/dates are phase headers;
   decimal rows are tasks. A small header block above the table
   carries Outcome/Deliverables/Weeks/Start/End/Condition.

   KEEP IN SYNC with the browser copy in
   assets/js/client-pr-sheets.js (parseProjectPlan) — same shape,
   same math. This one takes rows[][] (from SheetJS) instead of a
   CSV string, so there's no quote-parsing step.
   ============================================================ */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(raw: string): string {
  const s = String(raw || "").trim(); if (!s) return "";
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (!m) return s;
  const y = m[3].length === 2 ? +("20" + m[3]) : +m[3];
  const mo = +m[1]; if (mo < 1 || mo > 12) return s;
  return MONTHS[mo - 1] + " " + (+m[2]) + ", " + y;
}
function pctOf(raw: string): number | null {
  const s = String(raw || "").trim(); if (!s) return null;
  const v = parseFloat(s.replace("%", "")); if (isNaN(v)) return null;
  if (s.indexOf("%") >= 0) return Math.round(v);
  if (v <= 1) return Math.round(v * 100);
  return Math.round(v);
}
function statusOf(notes: string, pct: number | null): string {
  const n = String(notes || "").toLowerCase();
  if (/complet|done/.test(n)) return "complete";
  if (/progress/.test(n)) return "in-progress";
  if (/hold/.test(n)) return "on-hold";
  if (/block/.test(n)) return "blocked";
  if (pct != null) { if (pct >= 100) return "complete"; if (pct > 0) return "in-progress"; }
  return "pending";
}
const afterColon = (s: string) => { const i = String(s).indexOf(":"); return i < 0 ? "" : s.slice(i + 1).trim(); };
const cell = (r: unknown[], i: number) => String((r?.[i] ?? "")).trim();

// Quote-aware CSV → rows[][] (mirrors client-pr-sheets.js parseRows) — used when a
// plan file is a native Google Sheet exported as CSV rather than an .xlsx.
export function csvToRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", i = 0, q = false; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (c === "\r") { /* skip */ } else field += c; }
    i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export type PlanTask = { num: string; task: string; who: string; dep: string; start: string; end: string; pct: number | null; notes: string; status: string };
export type PlanGroup = { num: string; name: string; tasks: PlanTask[] };
export type ParsedPlan = {
  meta: { title: string; outcome: string; deliverables: string; weeks: string; startDate: string; endDate: string; condition: { level: string; pct: number | null } };
  groups: PlanGroup[];
};

export function parseProjectPlanRows(rows: unknown[][]): ParsedPlan | null {
  const meta = { title: "", outcome: "", deliverables: "", weeks: "", startDate: "", endDate: "", condition: { level: "green", pct: null as number | null } };
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const a = cell(rows[i], 0), c = cell(rows[i], 2);
    if (a === "#" && /^task$/i.test(cell(rows[i], 1))) { headerIdx = i; break; }
    if (i === 0 && a && !/^(outcome|deliverables|weeks):/i.test(a)) meta.title = a;
    if (/^outcome:/i.test(a)) meta.outcome = afterColon(a) || c;
    else if (/^deliverables:/i.test(a)) meta.deliverables = afterColon(a) || c;
    else if (/^weeks:/i.test(a)) meta.weeks = c || afterColon(a);
    else if (/^project start date:/i.test(a)) meta.startDate = fmtDate(c || afterColon(a));
    else if (/^project end date:/i.test(a)) meta.endDate = fmtDate(c || afterColon(a));
    else if (/^project condition:/i.test(a)) {
      const lvl = afterColon(a).toLowerCase();
      meta.condition.level = /red/.test(lvl) ? "red" : (/(amber|yellow)/.test(lvl) ? "amber" : "green");
      meta.condition.pct = pctOf(c);
    }
  }
  if (headerIdx < 0) return null;
  const groups: PlanGroup[] = []; let cur: PlanGroup | null = null;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const num = cell(r, 0), task = cell(r, 1), who = cell(r, 2), dep = cell(r, 3),
      start = cell(r, 4), end = cell(r, 5), pctRaw = cell(r, 6), notes = cell(r, 7);
    if (!num && !task) continue;
    // A PHASE header is an integer-numbered row (1, 2, "4.0") with no owner/dates/%.
    // The numbering check keeps a TBD task ("3.2 | Draft copy", no owner/dates yet)
    // classified as a task. KEEP IN SYNC with client-pr-sheets.js parseProjectPlan.
    const emptyMeta = !who && !start && !end && !pctRaw;
    const numVal = parseFloat(num);
    const isGroup = emptyMeta && (!num || isNaN(numVal) || Number.isInteger(numVal));
    if (isGroup) { cur = { num, name: task, tasks: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { num: "", name: "Tasks", tasks: [] }; groups.push(cur); }
    const pct = pctOf(pctRaw);
    cur.tasks.push({ num, task, who, dep, start: fmtDate(start), end: fmtDate(end), pct, notes, status: statusOf(notes, pct) });
  }
  if (!groups.length) return null;
  return { meta, groups };
}
