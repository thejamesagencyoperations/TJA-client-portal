/* ============================================================
   BUDGET — the client's yearly paid-media BUDGET CONTROL (Cameron 2026-11-04).

   Same shape as the SAP (sap/index.ts), one per client per YEAR:
     • laid out exactly like the team's Budget Control sheet — categories (SEARCH ADS,
       PAID SOCIAL, DISPLAY, VIDEO, PRINT …) with their channels under them, a $ amount per
       month (Q1 → Q4), an estimated NET total per channel, the Digital Sub-Total (NET) and
       the Total Monthly Spend (GROSS = NET ÷ (1 − agency %));
     • ORANGE cells = actualized (spent). The team flips a cell orange with one click;
     • built in the portal (2027 on), or imported once from a connected Google Sheet
       (one tab per year; orange fills come across as actualized; the CHANGE LOG tab too);
     • the client signs the year with a typed signature. If planned $ change after that,
       the year reads "Amended — needs re-signing" and can be signed again; every signed
       version is a PDF in Drive at Budget Controls/<YYYY>/ and posted to the client's Slack.
       Marking cells actualized never needs a re-sign (it isn't part of what was signed);
     • a CHANGE LOG: once a year has been signed, every $ the team changes is logged
       automatically (channel, month, old → new, who, when), plus manual Reflight / Rollover
       entries with notes.

   Stored SERVER-OWNED in app_state (client_id, scope 'budget') — the browser never writes it
   (clients can't by RLS; staff go through here so signatures can't be clobbered).
   No figures are kept in the repo — they live only in the database / the client's sheet.

   Actions (POST JSON, all {clientId}):
     fetch                                   anyone on the account
     save    {year, groups, grossUp}         editors (admin / manager / media)
     newyear {year, copyFrom?}               editors — blank template or last year's channels ($ cleared)
     delyear {year}                          admins — unsigned years only
     connect {url}                           editors — store the sheet + import every year tab
     import  {force?}                        editors — re-read the connected sheet
     log     {year, entry? | removeId?}      editors — add / remove a manual change-log entry
     sign    {year, name, signature}         anyone on the account

   Deploy: supabase functions deploy budget --use-api --no-verify-jwt   (does its own auth)
   ============================================================ */
import * as XLSX from "npm:xlsx@0.18.5";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken, driveExportBytes, driveDownloadBytes, driveGetMeta, parseDriveFileId, driveUploadBytes } from "../_shared/google.ts";
import { ensureClientFolders, ensureFolder } from "../_shared/drive-tree.ts";
import { registryEntry } from "../_shared/registry.ts";
import { uploadFileToSlack, postToSlack } from "../_shared/slack.ts";

const SCOPE = "budget";
const MON = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
const EDITORS = ["admin", "manager", "media"];
const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Cell = { v: number | null; x?: string; a?: boolean };          // value · typed expression ("1500+250") · actualized
type Channel = { name: string; cells: Cell[] };
type Group = { name: string; channels: Channel[] };
type LogEntry = { id: string; at: string; by: string; initials: string; channel: string; type: string;
  amount: number | null; month?: number; from?: number | null; to?: number | null; note?: string; auto?: boolean; date?: string };
// deno-lint-ignore no-explicit-any
type Year = any;

// deno-lint-ignore no-explicit-any
function stableStr(v: any): string {
  // deno-lint-ignore no-explicit-any
  const walk = (x: any): any => (x === null || typeof x !== "object") ? x
    : Array.isArray(x) ? x.map(walk) : Object.keys(x).sort().reduce((o: any, k) => { o[k] = walk(x[k]); return o; }, {});
  return JSON.stringify(walk(v));
}
async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
// what a signature covers: the categories, channels and planned $ — NOT the actualized flags
const contentOf = (groups: Group[], grossUp: number | null) => ({
  grossUp: grossUp ?? null,
  groups: (groups || []).map((g) => ({ name: g.name, channels: (g.channels || []).map((c) => ({ name: c.name, v: (c.cells || []).map((x) => x.v ?? null) })) })),
});
const hashOf = (y: Year) => sha(stableStr(contentOf(y.groups, y.grossUp)));
const phoenixYear = () => +new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric" }).format(new Date());
const blankCells = (): Cell[] => Array.from({ length: 12 }, () => ({ v: null }));
const uid = () => crypto.randomUUID().slice(0, 8);

/* ---- sanitising what the browser sends ---- */
// deno-lint-ignore no-explicit-any
const clean = (x: any, n = 200) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// deno-lint-ignore no-explicit-any
function cleanGroups(raw: any): Group[] {
  // deno-lint-ignore no-explicit-any
  return (Array.isArray(raw) ? raw : []).slice(0, 30).map((g: any) => ({
    name: clean(g && g.name, 120),
    // deno-lint-ignore no-explicit-any
    channels: (Array.isArray(g && g.channels) ? g.channels : []).slice(0, 60).map((c: any) => ({
      name: clean(c && c.name, 160),
      cells: Array.from({ length: 12 }, (_, i) => {
        const x = (c && Array.isArray(c.cells) ? c.cells[i] : null) || {};
        const v = (x.v === "" || x.v == null || !isFinite(+x.v)) ? null : r2(Math.max(-1e9, Math.min(1e9, +x.v)));
        const cell: Cell = { v };
        if (x.x && /^[0-9.+\-*/() ]{1,120}$/.test(String(x.x)) && /[+\-*/]/.test(String(x.x).replace(/^-/, ""))) cell.x = String(x.x);
        if (x.a) cell.a = true;
        return cell;
      }),
    })),
  }));
}
const cleanGross = (g: unknown) => (g === "" || g == null || !isFinite(+g!)) ? null : Math.max(0, Math.min(90, r2(+g!)));

/* ---- the stored document: { sheetUrl, fileName, error, years: { "2026": Year } } ---- */
// deno-lint-ignore no-explicit-any
async function readDoc(clientId: string): Promise<{ doc: any; updatedAt: string | null }> {
  const { data } = await svc().from("app_state").select("data,updated_at").eq("client_id", clientId).eq("scope", SCOPE).maybeSingle();
  const doc = (data && data.data && typeof data.data === "object" && !Array.isArray(data.data)) ? data.data : {};
  doc.years = doc.years || {};
  return { doc, updatedAt: data ? data.updated_at : null };
}
// compare-and-set (never a blind overwrite); mutate may return false = nothing to do
// deno-lint-ignore no-explicit-any
async function casDoc(clientId: string, mutate: (doc: any) => boolean | void | Promise<boolean | void>): Promise<any> {
  const db = svc();
  for (let i = 0; i < 6; i++) {
    const { doc, updatedAt } = await readDoc(clientId);
    const before = stableStr(doc);
    if ((await mutate(doc)) === false || stableStr(doc) === before) return doc;
    const now = new Date().toISOString();
    if (updatedAt) {
      const { data: w } = await db.from("app_state").update({ data: doc, updated_at: now })
        .eq("client_id", clientId).eq("scope", SCOPE).eq("updated_at", updatedAt).select("updated_at");
      if (w && w.length) return doc;
    } else {
      const { error } = await db.from("app_state").insert({ client_id: clientId, scope: SCOPE, data: doc, updated_at: now });
      if (!error) return doc;
    }
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 300 * (i + 1)));
  }
  throw new Error("couldn't save — please try again");
}

/* ---- import from the team's Budget Control sheet ----
   Layout (the team's standard sheet): banner + client + year rows, a quarter row (Q1…Q4 + "ESTIMATED NET
   TOTAL"), a MONTH row (JANUARY … DECEMBER, each merged over 4 columns), then category rows
   (grey, ALL CAPS, no $) with their channel rows under them, then "Digital Sub-Total (NET)",
   "Total Monthly Spend (GROSS)" (= NET ÷ (1 − agency %)) and the Client Approval block. Orange-filled
   amount cells are actualized. Month columns are found by header text, so spacing can vary. */
function rgbOf(c: { s?: { patternType?: string; fgColor?: { rgb?: string } } } | undefined): [number, number, number] | null {
  const st = c && c.s; if (!st || st.patternType !== "solid") return null;
  const h = String((st.fgColor && st.fgColor.rgb) || "").slice(-6); if (!/^[0-9A-Fa-f]{6}$/.test(h)) return null;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// deno-lint-ignore no-explicit-any
const isOrange = (c: any) => { const k = rgbOf(c); return !!k && k[0] >= 200 && k[1] >= 90 && k[1] <= 190 && k[2] <= 120; };
// deno-lint-ignore no-explicit-any
const isGrey = (c: any) => { const k = rgbOf(c); return !!k && Math.abs(k[0] - k[1]) < 12 && Math.abs(k[1] - k[2]) < 12 && k[0] > 150 && k[0] < 245; };
// deno-lint-ignore no-explicit-any
const txt = (c: any) => String((c && (c.w ?? c.v)) ?? "").replace(/\s+/g, " ").trim();
// deno-lint-ignore no-explicit-any
function num(c: any): number | null {
  if (!c) return null;
  if (typeof c.v === "number") return r2(c.v);
  const s = String(c.v ?? "").replace(/[$,\s]/g, ""); if (!s || isNaN(+s)) return null;
  return r2(+s);
}
const excelDate = (v: unknown) => {
  if (typeof v === "number" && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); return d.toISOString().slice(0, 10); }
  return String(v ?? "").trim();
};

// deno-lint-ignore no-explicit-any
function parseBudgetTab(ws: any, tabName: string): Year | null {
  if (!ws || !ws["!ref"]) return null;
  const R = XLSX.utils.decode_range(ws["!ref"]);
  const at = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })];
  // the MONTH row: the row naming the most months (3-letter prefix — the sheets spell "FEBURARY")
  let monthRow = -1, cols: number[] = [];
  for (let r = R.s.r; r <= Math.min(R.e.r, R.s.r + 30) && monthRow < 0; r++) {
    const found: number[] = Array(12).fill(-1);
    for (let c = R.s.c; c <= R.e.c; c++) {
      const t = txt(at(r, c)).toUpperCase().slice(0, 3);
      const mi = MON.findIndex((m) => m.slice(0, 3) === t);
      if (mi >= 0 && found[mi] < 0 && t.length === 3) found[mi] = c;
    }
    if (found.filter((x) => x >= 0).length >= 10) { monthRow = r; cols = found; }
  }
  if (monthRow < 0 || cols.some((c) => c < 0)) return null;
  const labelCol = R.s.c;
  // the year: from the tab name, else a 20xx cell above the month row
  let year = +((/(20\d{2})/.exec(tabName) || [])[1] || 0);
  for (let r = R.s.r; r < monthRow && !year; r++) for (let c = R.s.c; c <= Math.min(R.e.c, R.s.c + 3); c++) {
    const v = at(r, c); const n = v && (typeof v.v === "number" ? v.v : +String(v.v || "").trim());
    if (n >= 2020 && n <= 2100) { year = n; break; }
  }
  if (!year) return null;
  const groups: Group[] = []; let grossUp: number | null = null, net: number | null = null, gross: number | null = null;
  for (let r = monthRow + 1; r <= R.e.r; r++) {
    const label = txt(at(r, labelCol));
    if (!label) continue;
    if (/client approval|print name|date of approval|authori[sz]ed/i.test(label)) break;
    if (/sub-?\s*total|total|gross|\bnet\b/i.test(label)) {            // computed rows — the portal recalculates them
      const c0 = at(r, cols[0]);
      if (/gross/i.test(label)) {
        const f = String((c0 && c0.f) || "");
        const d = /\/\s*(0?\.\d+|1(?:\.0+)?)\s*$/.exec(f);
        if (d) grossUp = r2((1 - +d[1]) * 100);
        gross = num(c0);
      } else if (/net|sub-?\s*total/i.test(label)) net = num(c0);
      continue;
    }
    const cells = cols.map((c) => at(r, c));
    const empty = cells.every((x) => num(x) == null);
    const isHeading = empty && (isGrey(at(r, labelCol)) || (label === label.toUpperCase() && /[A-Z]/.test(label)));
    if (isHeading) { groups.push({ name: label, channels: [] }); continue; }
    if (!groups.length) groups.push({ name: "", channels: [] });
    groups[groups.length - 1].channels.push({
      name: label,
      cells: cells.map((x) => {
        const cell: Cell = { v: num(x) };
        const f = String((x && x.f) || "").replace(/^=/, "").replace(/\s+/g, "");
        if (f && /^[0-9.+\-*/()]{1,120}$/.test(f) && /[+\-*/]/.test(f.replace(/^-/, ""))) cell.x = f;
        if (isOrange(x)) cell.a = true;
        return cell;
      }),
    });
  }
  if (grossUp == null && net && gross && gross > net) grossUp = r2((1 - net / gross) * 100);
  if (!groups.some((g) => g.channels.length)) return null;
  return { year, groups, grossUp, tab: tabName };
}
// deno-lint-ignore no-explicit-any
function parseChangeLog(ws: any): LogEntry[] {
  if (!ws || !ws["!ref"]) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" }) as unknown[][];
  const hi = rows.findIndex((r) => r.some((c) => /^channel$/i.test(String(c).trim())) && r.some((c) => /amount/i.test(String(c))));
  if (hi < 0) return [];
  const h = rows[hi].map((c) => String(c).toLowerCase().trim());
  const col = (re: RegExp) => h.findIndex((c) => re.test(c));
  const ci = { ch: col(/^channel/), ty: col(/reflight|rollover|type/), am: col(/amount/), dt: col(/date/), in: col(/initial/), no: col(/note/) };
  const out: LogEntry[] = [];
  for (const r of rows.slice(hi + 1)) {
    const channel = String(r[ci.ch] ?? "").trim(); if (!channel) continue;
    const a = ci.am >= 0 ? r[ci.am] : ""; const amount = typeof a === "number" ? r2(a) : (String(a).replace(/[$,\s]/g, "") && !isNaN(+String(a).replace(/[$,\s]/g, "")) ? r2(+String(a).replace(/[$,\s]/g, "")) : null);
    out.push({ id: uid(), at: "", by: "", initials: ci.in >= 0 ? String(r[ci.in] ?? "").trim().slice(0, 6) : "", channel: channel.slice(0, 120),
      type: ci.ty >= 0 ? String(r[ci.ty] ?? "").trim().slice(0, 40) : "", amount, date: ci.dt >= 0 ? excelDate(r[ci.dt]) : "",
      note: ci.no >= 0 ? String(r[ci.no] ?? "").trim().slice(0, 600) : "" });
  }
  return out.slice(0, 500);
}
async function readSheet(url: string) {
  const fileId = parseDriveFileId(url);
  if (!fileId) throw new Error("not a Google Sheets link");
  const token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");
  const meta = await driveGetMeta(token, fileId);
  const bytes = meta.mimeType === "application/vnd.google-apps.spreadsheet"
    ? await driveExportBytes(token, fileId, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    : await driveDownloadBytes(token, fileId);
  const wb = XLSX.read(bytes, { type: "array", cellStyles: true });
  const years: Year[] = [];
  let log: LogEntry[] = [];
  for (const name of wb.SheetNames || []) {
    if (/change\s*log/i.test(name)) { log = parseChangeLog(wb.Sheets[name]); continue; }
    if (/^old\b/i.test(name.trim())) continue;
    const y = parseBudgetTab(wb.Sheets[name], name);
    if (y && !years.some((x) => x.year === y.year)) years.push(y);
  }
  return { fileName: meta.name as string, years, log };
}
// bring sheet years into the doc. A year already built/edited in the portal (or signed) is
// only replaced when `force` (the staff "Re-import" button, after a confirm).
// deno-lint-ignore no-explicit-any
async function applyImport(doc: any, got: { fileName: string; years: Year[]; log: LogEntry[] }, force: boolean, by: string) {
  doc.fileName = got.fileName; delete doc.error;
  const imported: number[] = [], kept: number[] = [];
  for (const y of got.years) {
    const k = String(y.year), prev = doc.years[k];
    if (prev && (prev.source === "portal" || prev.signed) && !force) { kept.push(y.year); continue; }
    const next = Object.assign({}, prev || {}, { year: y.year, groups: y.groups, grossUp: y.grossUp ?? (prev && prev.grossUp) ?? null,
      source: "sheet", tab: y.tab, importedAt: new Date().toISOString(), importedBy: by });
    // the sheet's change log belongs to the year it sits beside (the newest year in the file)
    if (got.log.length && y.year === Math.max(...got.years.map((z) => z.year))) {
      // re-import replaces the sheet's rows; entries made in the portal stay
      const portalMade = ((prev && prev.log) || []).filter((e: LogEntry & { imported?: boolean }) => !e.imported);
      next.log = [...got.log.map((e) => ({ ...e, imported: true })), ...portalMade];
    } else next.log = (prev && prev.log) || [];
    next.hash = await hashOf(next);
    doc.years[k] = next; imported.push(y.year);
  }
  return { imported, kept };
}

/* ---- the automatic change log (only once a year has been signed — before that it's a draft) ---- */
const MON_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function diffLog(prev: Year, groups: Group[], who: { by: string; initials: string }): LogEntry[] {
  if (!prev || !(prev.signatures && prev.signatures.length)) return [];
  const old = new Map<string, Channel>();
  (prev.groups || []).forEach((g: Group) => (g.channels || []).forEach((c) => old.set(g.name + "\u0000" + c.name, c)));
  const out: LogEntry[] = [], now = new Date().toISOString();
  const seen = new Set<string>();
  groups.forEach((g) => g.channels.forEach((c) => {
    const k = g.name + "\u0000" + c.name; seen.add(k);
    const o = old.get(k);
    if (!o) { if (c.name) out.push({ id: uid(), at: now, ...who, channel: c.name, type: "Added channel", amount: null, auto: true }); return; }
    c.cells.forEach((x, i) => {
      const a = (o.cells[i] && o.cells[i].v) ?? null, b = x.v ?? null;
      if (a === b) return;
      out.push({ id: uid(), at: now, ...who, channel: c.name, type: "Change", month: i, from: a, to: b, amount: r2((b || 0) - (a || 0)), auto: true });
    });
  }));
  old.forEach((c, k) => { if (!seen.has(k) && c.name) out.push({ id: uid(), at: now, ...who, channel: c.name, type: "Removed channel", amount: null, auto: true }); });
  return out;
}
// fold a fresh auto entry into the same person's entry for the same cell from the last 15 min
function mergeLog(log: LogEntry[], add: LogEntry[]): LogEntry[] {
  const out = [...log];
  for (const e of add) {
    const j = e.type === "Change" ? out.findIndex((x) => x.auto && x.type === "Change" && x.by === e.by && x.channel === e.channel &&
      x.month === e.month && Date.now() - Date.parse(x.at) < 15 * 60 * 1000) : -1;
    if (j >= 0) {
      const x = out[j]; x.to = e.to; x.at = e.at; x.amount = r2((e.to || 0) - (x.from || 0));
      if ((x.from ?? null) === (x.to ?? null)) out.splice(j, 1);
    } else out.push(e);
  }
  return out.slice(-1000);
}

/* ---- signed PDF (landscape, laid out like the sheet; built from the stored year) ---- */
const winAnsi = (s: string) => String(s || "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/•/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
const money = (n: number | null | undefined) => n == null ? "" : (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const totals = (y: Year) => {
  const chans: Channel[] = (y.groups || []).flatMap((g: Group) => g.channels || []);
  const net = Array.from({ length: 12 }, (_, i) => r2(chans.reduce((t, c) => t + (+(c.cells[i] && c.cells[i].v) || 0), 0)));
  const k = y.grossUp != null && y.grossUp < 100 ? 1 - y.grossUp / 100 : null;
  const gross = k ? net.map((v) => r2(v / k)) : null;
  return { net, gross, netTotal: r2(net.reduce((a, b) => a + b, 0)), grossTotal: gross ? r2(gross.reduce((a, b) => a + b, 0)) : null };
};
async function buildPdf(clientName: string, y: Year, signer: { name: string; email: string; at: string }, sigPng: Uint8Array | null, n: number) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 792, H = 612, M = 28;
  const ORANGE = rgb(0.965, 0.557, 0.129), INK = rgb(0.07, 0.07, 0.07), DIM = rgb(0.4, 0.4, 0.4), GREY = rgb(0.851, 0.851, 0.851),
    LINE = rgb(0.85, 0.85, 0.85), QL = rgb(0.655, 0.859, 0.949), QD = rgb(0.141, 0.31, 0.337), WHITE = rgb(1, 1, 1);
  let page = pdf.addPage([W, H]);
  const labW = 128, totW = 66, colW = (W - 2 * M - labW - totW) / 12, rowH = 15;
  let yy = H - M;
  page.drawText("BUDGET CONTROL", { x: M, y: yy - 18, size: 18, font: bold, color: ORANGE }); yy -= 26;
  page.drawText(winAnsi(clientName), { x: M, y: yy - 12, size: 12, font: bold, color: INK }); yy -= 15;
  page.drawText(String(y.year), { x: M, y: yy - 8, size: 8, font: bold, color: INK }); yy -= 16;
  const cellX = (i: number) => M + labW + i * colW;
  // deno-lint-ignore no-explicit-any
  const textIn = (t: string, x: number, w: number, f: any, size: number, color: any, align: "l" | "c" | "r") => {
    let s = winAnsi(t); while (s && f.widthOfTextAtSize(s, size) > w - 4) s = s.slice(0, -1);
    const tw = f.widthOfTextAtSize(s, size);
    const tx = align === "l" ? x + 3 : align === "c" ? x + (w - tw) / 2 : x + w - tw - 3;
    page.drawText(s, { x: tx, y: yy - rowH + 4.5, size, font: f, color });
  };
  const rowLine = () => page.drawLine({ start: { x: M, y: yy - rowH }, end: { x: W - M, y: yy - rowH }, thickness: 0.4, color: LINE });
  // quarter row
  for (let q = 0; q < 4; q++) {
    const fill = q % 2 ? QD : QL;
    page.drawRectangle({ x: cellX(q * 3), y: yy - rowH, width: colW * 3, height: rowH, color: fill });
    textIn(`Q${q + 1}`, cellX(q * 3), colW * 3, bold, 7.5, WHITE, "c");
  }
  page.drawRectangle({ x: W - M - totW, y: yy - rowH * 2, width: totW, height: rowH * 2, color: GREY });
  page.drawText("ESTIMATED", { x: W - M - totW + 6, y: yy - 12, size: 6.5, font: bold, color: WHITE });
  page.drawText("NET TOTAL", { x: W - M - totW + 6, y: yy - 21, size: 6.5, font: bold, color: WHITE });
  yy -= rowH;
  textIn("MONTH", M, labW, bold, 6.5, INK, "l");
  MON.forEach((m, i) => textIn(m, cellX(i), colW, bold, 6, INK, "c"));
  rowLine(); yy -= rowH;
  for (const g of (y.groups || []) as Group[]) {
    if (yy - rowH < M + 90) { page = pdf.addPage([W, H]); yy = H - M; }
    if (g.name) {
      page.drawRectangle({ x: M, y: yy - rowH, width: W - 2 * M - totW, height: rowH, color: GREY });
      textIn(g.name.toUpperCase(), M, labW, bold, 6.5, INK, "l"); yy -= rowH;
    }
    for (const c of g.channels || []) {
      if (yy - rowH < M + 90) { page = pdf.addPage([W, H]); yy = H - M; }
      textIn(c.name, M, labW, font, 6.5, INK, "l");
      let t = 0;
      c.cells.forEach((x, i) => {
        if (x.a) page.drawRectangle({ x: cellX(i) + 0.5, y: yy - rowH + 0.5, width: colW - 1, height: rowH - 1, color: ORANGE });
        if (x.v != null) textIn(money(x.v), cellX(i), colW, bold, 6, INK, "c");
        t += +x.v! || 0;
      });
      textIn(money(r2(t)), W - M - totW, totW, bold, 6.5, INK, "r");
      rowLine(); yy -= rowH;
    }
  }
  const tt = totals(y);
  yy -= 4;
  textIn("Digital Sub-Total (NET)", M, labW, bold, 6.5, INK, "l");
  tt.net.forEach((v, i) => textIn(money(v), cellX(i), colW, bold, 6, INK, "c"));
  textIn(money(tt.netTotal), W - M - totW, totW, bold, 6.5, INK, "r"); rowLine(); yy -= rowH;
  if (tt.gross) {
    textIn("Total Monthly Spend (GROSS)", M, labW, bold, 6.5, INK, "l");
    tt.gross.forEach((v, i) => textIn(money(v), cellX(i), colW, bold, 6, INK, "c"));
    page.drawRectangle({ x: W - M - totW, y: yy - rowH, width: totW, height: rowH, color: GREY });
    textIn(money(tt.grossTotal), W - M - totW, totW, bold, 6.5, INK, "r"); rowLine(); yy -= rowH;
  }
  // legend + approval block
  yy -= 10;
  if (yy < M + 110) { page = pdf.addPage([W, H]); yy = H - M; }
  page.drawRectangle({ x: M, y: yy - 8, width: 10, height: 8, color: ORANGE });
  page.drawText("Actualized (spent)", { x: M + 14, y: yy - 7, size: 7, font, color: DIM });
  page.drawRectangle({ x: M + 100, y: yy - 8, width: 10, height: 8, borderColor: DIM, borderWidth: 0.5, color: WHITE });
  page.drawText("Planned", { x: M + 114, y: yy - 7, size: 7, font, color: DIM });
  yy -= 22;
  page.drawText("Client Approval:", { x: M, y: yy - 30, size: 8, font, color: INK });
  if (sigPng) {
    try {
      const img = await pdf.embedPng(sigPng); const h = 44, w = Math.min(200, img.width * (h / img.height));
      page.drawImage(img, { x: M + 90, y: yy - 42, width: w, height: h });
    } catch (_e) { /* name + date are still recorded */ }
  }
  page.drawLine({ start: { x: M + 88, y: yy - 42 }, end: { x: M + 340, y: yy - 42 }, thickness: 0.5, color: DIM });
  yy -= 58;
  page.drawText("Print Name:", { x: M, y: yy, size: 8, font, color: INK });
  page.drawText(winAnsi(`${signer.name}${signer.email ? "  (" + signer.email + ")" : ""}`), { x: M + 90, y: yy, size: 8, font: bold, color: INK });
  yy -= 16;
  page.drawText("Date of Approval:", { x: M, y: yy, size: 8, font, color: INK });
  page.drawText(new Date(signer.at).toLocaleString("en-US", { timeZone: "America/Phoenix", dateStyle: "long", timeStyle: "short" }) + " (Arizona time)", { x: M + 90, y: yy, size: 8, font: bold, color: INK });
  if (n > 1) { yy -= 16; page.drawText(`Amendment ${n - 1} - replaces the budget signed earlier.`, { x: M, y: yy, size: 7.5, font, color: DIM }); }
  return await pdf.save();
}
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

// deno-lint-ignore no-explicit-any
const publicView = (doc: any, staff: boolean) => ({
  connected: !!doc.sheetUrl, sheetUrl: staff ? doc.sheetUrl || "" : "", fileName: staff ? doc.fileName || "" : "",
  error: staff ? doc.error || "" : "", years: doc.years || {}, currentYear: phoenixYear(),
});
const DEFAULT_GROUPS = (): Group[] => [
  { name: "SEARCH ADS", channels: [{ name: "Google Search", cells: blankCells() }, { name: "Microsoft Bing Search", cells: blankCells() }] },
  { name: "PAID SOCIAL", channels: [{ name: "Meta", cells: blankCells() }] },
  { name: "DISPLAY", channels: [{ name: "Display - Contextual/Retargeting", cells: blankCells() }] },
  { name: "VIDEO", channels: [{ name: "YouTube", cells: blankCells() }, { name: "CTV/Streaming TV", cells: blankCells() }] },
  { name: "PRINT", channels: [] },
];
const DEFAULT_GROSS_UP = 15;   // standard agency media commission; editable per year

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  // deno-lint-ignore no-explicit-any
  let body: any; try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const action = String(body.action || "fetch");
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  const staff = caller.role !== "client";
  const editor = EDITORS.includes(caller.role);
  const clientId = staff ? String(body.clientId || "") : caller.clientId;     // a client is pinned to its own account
  if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "clientId required" });
  const yk = String(parseInt(String(body.year || ""), 10) || "");
  const needEditor = () => editor ? null : json(req, 403, { error: "Only the account and paid-media team can change the budget control." });
  // who's making the change — for the change log
  const who = async () => {
    let name = "";
    try { const { data: u } = await svc().auth.admin.getUserById(caller.userId); name = String(u?.user?.user_metadata?.name || "").trim(); } catch { /* optional */ }
    const base = name || String(caller.email || "").split("@")[0];
    const initials = base.split(/[\s._-]+/).filter(Boolean).map((p) => p[0].toUpperCase()).join("").slice(0, 3);
    return { by: name || caller.email || "", initials };
  };

  try {
    if (action === "fetch") return json(req, 200, { ok: true, view: publicView((await readDoc(clientId)).doc, staff) });

    if (action === "save") {
      const deny = needEditor(); if (deny) return deny;
      if (!yk) return json(req, 400, { error: "year required" });
      const groups = cleanGroups(body.groups);
      if (!groups.length) return json(req, 400, { error: "Add at least one category." });
      const grossUp = cleanGross(body.grossUp);
      const w = await who();
      const doc = await casDoc(clientId, async (d) => {
        const prev = d.years[yk];
        if (!prev) return false;
        const next = Object.assign({}, prev, { groups, grossUp, source: "portal", savedAt: new Date().toISOString(), savedBy: w.by });
        next.log = mergeLog(prev.log || [], diffLog(prev, groups, w));
        next.hash = await hashOf(next);
        d.years[yk] = next;
      });
      if (!doc.years[yk]) return json(req, 404, { error: "That year doesn't exist yet — use ＋ New year." });
      return json(req, 200, { ok: true, view: publicView(doc, staff) });
    }

    if (action === "newyear") {
      const deny = needEditor(); if (deny) return deny;
      const yr = +yk; if (!(yr >= 2020 && yr <= 2100)) return json(req, 400, { error: "Pick a year." });
      const from = body.copyFrom ? String(parseInt(String(body.copyFrom), 10)) : "";
      const w = await who();
      let exists = false;
      const doc = await casDoc(clientId, async (d) => {
        if (d.years[yk]) { exists = true; return false; }
        const src = from && d.years[from];
        // duplicate = the same categories + channels, every $ and actualized flag cleared
        const groups: Group[] = src ? (src.groups || []).map((g: Group) => ({ name: g.name, channels: (g.channels || []).map((c) => ({ name: c.name, cells: blankCells() })) })) : DEFAULT_GROUPS();
        const y: Year = { year: yr, groups, grossUp: src ? src.grossUp ?? DEFAULT_GROSS_UP : DEFAULT_GROSS_UP, source: "portal", log: [],
          createdAt: new Date().toISOString(), createdBy: w.by, ...(src ? { copiedFrom: +from } : {}) };
        y.hash = await hashOf(y);
        d.years[yk] = y;
      });
      if (exists) return json(req, 409, { error: `There's already a ${yk} budget control.` });
      return json(req, 200, { ok: true, view: publicView(doc, staff) });
    }

    if (action === "delyear") {
      if (caller.role !== "admin") return json(req, 403, { error: "admins only" });
      let signed = false;
      const doc = await casDoc(clientId, (d) => { const y = d.years[yk]; if (!y) return false; if (y.signatures && y.signatures.length) { signed = true; return false; } delete d.years[yk]; });
      if (signed) return json(req, 409, { error: "A signed budget control can't be deleted — its signed PDFs are the record." });
      return json(req, 200, { ok: true, view: publicView(doc, staff) });
    }

    if (action === "connect" || action === "import") {
      const deny = needEditor(); if (deny) return deny;
      if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "Google access isn't configured" });
      let url = action === "connect" ? String(body.url || "").trim() : "";
      if (action === "connect" && !url) {
        const doc = await casDoc(clientId, (d) => { delete d.sheetUrl; delete d.fileName; delete d.error; });
        return json(req, 200, { ok: true, view: publicView(doc, staff), imported: [], kept: [] });
      }
      if (action === "import") url = String((await readDoc(clientId)).doc.sheetUrl || "");
      if (!url) return json(req, 400, { error: "Connect the budget control sheet first." });
      if (!parseDriveFileId(url)) return json(req, 400, { error: "That doesn't look like a Google Sheets link." });
      let got;
      try { got = await readSheet(url); }
      catch (_e) { return json(req, 404, { error: "Couldn't open that sheet — share it with the portal's service account (Viewer) and try again." }); }
      if (!got.years.length) return json(req, 422, { error: "Couldn't find a budget in that sheet — it needs a MONTH row (January … December) with channels under it, and the year in the tab name or above the months." });
      const w = await who();
      let res = { imported: [] as number[], kept: [] as number[] };
      const doc = await casDoc(clientId, async (d) => { d.sheetUrl = url; res = await applyImport(d, got!, !!body.force, w.by); });
      return json(req, 200, { ok: true, view: publicView(doc, staff), ...res });
    }

    if (action === "log") {
      const deny = needEditor(); if (deny) return deny;
      const w = await who();
      let missing = false;
      const doc = await casDoc(clientId, (d) => {
        const y = d.years[yk]; if (!y) { missing = true; return false; }
        y.log = y.log || [];
        if (body.removeId) { const i = y.log.findIndex((e: LogEntry) => e.id === String(body.removeId) && !e.auto); if (i < 0) return false; y.log.splice(i, 1); return; }
        const e = body.entry || {};
        const amt = (e.amount === "" || e.amount == null || !isFinite(+e.amount)) ? null : r2(+e.amount);
        const channel = clean(e.channel, 120); if (!channel) return false;
        y.log.push({ id: uid(), at: new Date().toISOString(), by: w.by, initials: clean(e.initials, 6) || w.initials, channel,
          type: clean(e.type, 40) || "Reflight", amount: amt, date: clean(e.date, 20) || new Date().toISOString().slice(0, 10), note: String(e.note || "").trim().slice(0, 600) });
      });
      if (missing) return json(req, 404, { error: "year not found" });
      return json(req, 200, { ok: true, view: publicView(doc, staff) });
    }

    if (action === "sign") {
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json(req, 400, { error: "Sign by typing your name." });
      const sig = String(body.signature || "");
      const sigPng = /^data:image\/png;base64,/.test(sig) && sig.length < 600_000 ? Uint8Array.from(atob(sig.split(",")[1]), (c) => c.charCodeAt(0)) : null;
      if (!sigPng) return json(req, 400, { error: "Type your name to create a signature." });
      const signer = { name, email: caller.email || "", at: new Date().toISOString() };
      // claim the signature FIRST (compare-and-set): nobody else can sign the same version
      let err = "", y: Year = null, n = 0;
      await casDoc(clientId, (d) => {
        const yy = d.years[yk];
        if (!yy || !(yy.groups || []).length) { err = "There's no budget control for that year to sign yet."; return false; }
        if (yy.signed && yy.signed.hash === yy.hash) { err = `Already signed by ${yy.signed.name}.`; return false; }
        yy.signatures = yy.signatures || [];
        n = yy.signatures.length + 1;
        yy.signed = { ...signer, hash: yy.hash, role: caller.role, n };
        yy.signatures.push(yy.signed);
        y = JSON.parse(JSON.stringify(yy));
      });
      if (err) return json(req, 409, { error: err });

      const reg = await registryEntry(clientId);
      const clientName = reg?.name || clientId;
      const pdf = await buildPdf(clientName, y, signer, sigPng, n);
      const d8 = new Date(signer.at).toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });   // YYYY-MM-DD
      const fileName = `${yk} Budget Control - Signed${n > 1 ? ` (Amendment ${n - 1})` : ""} ${d8}.pdf`;
      let driveUrl = "", driveErr = "";
      try {
        const root = Deno.env.get("DRIVE_ROOT_FOLDER_ID");
        if (!root) throw new Error("Drive root not set");
        const token = await driveAccessToken();
        const tree = await ensureClientFolders(token, root, clientId);
        if (!tree) throw new Error("client Drive folder not found");
        // Budget Controls/<YYYY>/<YYYY Budget Control>/  — same depth as the SAP's year/month folders
        const bcF = await ensureFolder(token, tree.folderId, "Budget Controls");
        const yrF = await ensureFolder(token, bcF, yk);
        const up = await driveUploadBytes(token, yrF, fileName, pdf, "application/pdf");
        driveUrl = up.webViewLink || `https://drive.google.com/file/d/${up.id}/view`;
      } catch (e2) { driveErr = String((e2 as Error).message || e2); console.error("budget drive", driveErr); }

      const chan = reg?.integrations?.slackChannel;
      const msg = `✍️ *${clientName}* — ${yk} Budget Control ${n > 1 ? `re-signed (amendment ${n - 1})` : "signed"} by *${name}*.${driveUrl ? `\n<${driveUrl}|Open in Drive>` : ""}`;
      let slack = await uploadFileToSlack(chan, msg, b64(pdf), fileName);
      if (!slack.ok && !slack.skipped) slack = await postToSlack(chan, msg);

      const doc = await casDoc(clientId, (d) => {
        const x = d.years[yk]; if (!x) return false;
        const s = (x.signatures || []).find((z: { n: number }) => z.n === n); if (!s) return false;
        s.driveUrl = driveUrl; if (driveErr) s.driveError = "not saved to Drive"; s.slack = !!slack.ok;
        if (x.signed && x.signed.n === n) x.signed = s;
      });
      return json(req, 200, { ok: true, view: publicView(doc, staff), driveUrl, pdf: b64(pdf), fileName });
    }
    return json(req, 400, { error: "unknown action" });
  } catch (e) {
    console.error("budget", e);
    return json(req, 502, { error: String((e as Error).message || e) });
  }
});
