/* ============================================================
   SAP — the client's SERVICE ALLOCATION PLAN (Cameron 2026-10-19).

   The team keeps one private Google Sheet per client per year (e.g. "2026 DNA Service
   Allocation Plan") with a tab per month. This function reads it with the portal's service
   account (same path as plan-fetch — the sheet stays private, it only has to be shared with
   the service account's email as Viewer) and returns the CURRENT month:
     • tab choice: "REVISED <Month YYYY>" beats "<Month YYYY>" — never both; "OLD …" ignored;
     • content: every service heading and every line item under it, plus Notes.
       Planned hours / % are deliberately NOT returned — clients don't see them.
   Every month read is SNAPSHOTTED into the retainer (e.sap.months["YYYY-MM"]) and stops
   refreshing once its month is over, so past months stay viewable exactly as they ended.
   Starts at October 2026 — nothing earlier is ever stored.

   Actions (POST JSON):
     connect {clientId, url}      staff — validate + store the sheet link
     fetch   {clientId}           anyone on that account — refresh this month (≤ every 5 min)
     sign    {clientId, name, signature}   anyone on that account — ONE signature per month:
             records it, builds the signed PDF server-side, files it in Drive at
             Service Allocation Plans/<YYYY>/<MM-YYYY Month SAP>/, posts it to the client's
             Slack channel. After signing, later sheet edits flag "changed since signed".
     sweep   (x-snapshot-secret)  hourly — refresh every connected client so month-end
             snapshots land even if nobody opens the page.

   SECURITY: the sheet id is read from the client's OWN stored record, never from a client's
   request, so a client login can't make the service account read an arbitrary file; a client
   caller is pinned to its JWT client id.

   Deploy: supabase functions deploy sap --use-api --no-verify-jwt   (does its own auth)
   ============================================================ */
import * as XLSX from "npm:xlsx@0.18.5";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken, driveExportBytes, driveDownloadBytes, driveGetMeta, parseDriveFileId, sheetsHiddenRowSet, driveUploadBytes } from "../_shared/google.ts";
import { ensureClientFolders, ensureFolder } from "../_shared/drive-tree.ts";
import { registryEntry } from "../_shared/registry.ts";
import { uploadFileToSlack, postToSlack } from "../_shared/slack.ts";

const FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const START_KEY = "2026-10";                       // no SAP months before October 2026
const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// the agency runs on Arizona time — the month turns at Phoenix midnight, not UTC
function nowMonth(): { key: string; label: string; mi: number; yr: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "numeric" }).formatToParts(new Date());
  const yr = +p.find((x) => x.type === "year")!.value, mi = +p.find((x) => x.type === "month")!.value - 1;
  return { key: `${yr}-${String(mi + 1).padStart(2, "0")}`, label: `${FULL[mi]} ${yr}`, mi, yr };
}

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

/* ---- tab choice: REVISED <label> > <label>; OLD/other prefixes never match ---- */
function pickTab(names: string[], label: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = norm(label);
  return names.find((n) => norm(n) === "revised " + want) || names.find((n) => norm(n) === want) || null;
}

type SapItem = { name: string; notes: string };
type SapSection = { name: string; notes: string; items: SapItem[] };

/* ---- parse one month tab ----
   Layout (DNA 2026): a few title rows, then a header row "Retainer Items | Hours Planned |
   % Planned | [Hours Actual | Completion] | Notes". A row with a % Planned value is a SERVICE
   HEADING; rows without one are its line items. Notes is found by header text because it
   moves (column E on older tabs, G on newer). Hours/% are read only to classify rows. */
function parseSap(rows: string[][]): { sections: SapSection[]; terms: string } | null {
  const cell = (r: string[], i: number) => String((r && r[i]) ?? "").replace(/\s+/g, " ").trim();
  const hi = rows.findIndex((r) => r.some((c) => /retainer items/i.test(String(c))) && r.some((c) => /planned/i.test(String(c))));
  if (hi < 0) return null;
  const head = rows[hi].map((c) => String(c).toLowerCase());
  const nameCol = Math.max(0, head.findIndex((c) => /retainer items/.test(c)));
  const pctCol = head.findIndex((c) => /%\s*planned/.test(c));
  const hrsCol = head.findIndex((c) => /hours planned/.test(c));
  const notesCol = head.findIndex((c) => /^\s*notes?\b/.test(c));
  const out: SapSection[] = [];
  let terms = "", inSig = false;
  for (const r of rows.slice(hi + 1)) {
    let name = cell(r, nameCol) || cell(r, nameCol + 1);
    if (!name) continue;
    // the sheet's own signature block ends the plan; its long terms paragraph is kept as `terms`
    if (/^authori[sz]ed signature/i.test(name)) { inSig = true; continue; }
    if (inSig) { if (name.length > 80) terms = terms ? terms + " " + name : name; continue; }
    if (/^(grand\s+)?totals?\b/i.test(name) || /^total (hours|retainer)/i.test(name)) continue;
    const notes = notesCol >= 0 ? String((r && r[notesCol]) ?? "").trim() : "";
    const isHeading = pctCol >= 0 ? !!cell(r, pctCol) : (name === name.toUpperCase() && /[A-Z]/.test(name));
    name = name.replace(/\s+/g, " ");
    if (isHeading || !out.length) out.push({ name, notes, items: [] });
    else out[out.length - 1].items.push({ name, notes });
    void hrsCol;
  }
  return out.length ? { sections: out, terms } : null;
}

async function readMonth(sheetUrl: string, label: string) {
  const fileId = parseDriveFileId(sheetUrl);
  if (!fileId) throw new Error("not a Google Sheets link");
  const token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");
  const meta = await driveGetMeta(token, fileId);
  const native = meta.mimeType === "application/vnd.google-apps.spreadsheet";
  const bytes = native
    ? await driveExportBytes(token, fileId, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    : await driveDownloadBytes(token, fileId);
  const wb = XLSX.read(bytes, { type: "array" });
  const tab = pickTab(wb.SheetNames || [], label);
  if (!tab) return { fileName: meta.name, tab: null, sections: null, tabs: wb.SheetNames || [] };
  const ws = wb.Sheets[tab];
  const startRow = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
  let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: true }) as string[][];
  if (native) {
    const hidden = await sheetsHiddenRowSet(fileId, tab);
    if (hidden.size) rows = rows.filter((_, i) => !hidden.has(startRow + i));
  }
  const parsed = parseSap(rows);
  return { fileName: meta.name, tab, sections: parsed ? parsed.sections : null, terms: parsed ? parsed.terms : "", tabs: wb.SheetNames || [] };
}

/* ---- compare-and-set write of ONE client's retainer (never a blind whole-row write) ---- */
// deno-lint-ignore no-explicit-any
async function casRetainer(clientId: string, mutate: (e: any) => boolean | void): Promise<any> {
  const db = svc();
  for (let i = 0; i < 6; i++) {
    const { data: row } = await db.from("app_state").select("data,updated_at").eq("client_id", clientId).eq("scope", "dashboard").maybeSingle();
    if (!row) throw new Error("client not found");
    const e = row.data?.engagements?.retainer;
    if (!e) throw new Error("this client has no retainer");
    const before = stableStr(e);
    if (mutate(e) === false || stableStr(e) === before) return e;
    const { data: w } = await db.from("app_state").update({ data: row.data, updated_at: new Date().toISOString() })
      .eq("client_id", clientId).eq("scope", "dashboard").eq("updated_at", row.updated_at).select("updated_at");
    if (w && w.length) return e;
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 300 * (i + 1)));
  }
  throw new Error("couldn't save — please try again");
}

// refresh the CURRENT month only (past months are frozen snapshots). Returns the retainer.
// deno-lint-ignore no-explicit-any
async function refresh(clientId: string, force = false): Promise<any> {
  const m = nowMonth();
  const db = svc();
  const { data: row } = await db.from("app_state").select("ret:data->engagements->retainer").eq("client_id", clientId).eq("scope", "dashboard").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const e: any = row?.ret;
  if (!e || !e.sapUrl) return e;
  if (m.key < START_KEY) return e;
  const cur = e.sap?.months?.[m.key];
  if (!force && cur && cur.fetchedAt && Date.now() - Date.parse(cur.fetchedAt) < 5 * 60 * 1000) return e;
  let got;
  try { got = await readMonth(e.sapUrl, m.label); }
  catch (err) {
    const msg = String((err as Error).message || err);
    const nice = /404|not ?found/i.test(msg) ? "the sheet isn't shared with the portal's service account (Viewer)" : "couldn't read the sheet";
    return await casRetainer(clientId, (x) => { x.sap = x.sap || { months: {} }; x.sap.error = nice; x.sap.checkedAt = new Date().toISOString(); });
  }
  const content = got.sections ? { tab: got.tab, sections: got.sections, terms: got.terms || "" } : null;
  const hash = content ? await sha(stableStr(content)) : "";
  return await casRetainer(clientId, (x) => {
    x.sap = x.sap || { months: {} };
    x.sap.months = x.sap.months || {};
    x.sap.fileName = got.fileName;
    delete x.sap.error;
    const prev = x.sap.months[m.key] || {};
    const next = Object.assign({}, prev, { key: m.key, label: m.label, fetchedAt: new Date().toISOString() });
    if (content) { next.tab = content.tab; next.sections = content.sections; next.terms = content.terms; next.hash = hash; delete next.missing; }
    else if (!prev.sections) next.missing = true;          // no tab for this month (yet)
    // only the timestamp moved → skip the write (keeps the hourly sweep from churning rows)
    if (prev.hash === next.hash && prev.tab === next.tab && !!prev.missing === !!next.missing && prev.fetchedAt &&
        Date.now() - Date.parse(prev.fetchedAt) < 55 * 60 * 1000) return false;
    x.sap.months[m.key] = next;
  });
}

/* ---- signed PDF (built here, from the stored plan — not from anything the browser sends) ---- */
const winAnsi = (s: string) => String(s || "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
  .replace(/•/g, "-").replace(/…/g, "...").replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "");
// deno-lint-ignore no-explicit-any
async function buildPdf(clientName: string, month: any, signer: { name: string; email: string; at: string }, sigPng: Uint8Array | null) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, ORANGE = rgb(1, 0.47, 0), INK = rgb(0.13, 0.13, 0.13), DIM = rgb(0.4, 0.4, 0.4);
  let page = pdf.addPage([W, H]); let y = H - M;
  const ensure = (h: number) => { if (y - h < M) { page = pdf.addPage([W, H]); y = H - M; } };
  // deno-lint-ignore no-explicit-any
  const wrap = (text: string, f: any, size: number, width: number) => {
    const out: string[] = [];
    winAnsi(text).split(/\r?\n/).forEach((para) => {
      let line = "";
      para.split(/\s+/).forEach((w) => {
        const t = line ? line + " " + w : w;
        if (f.widthOfTextAtSize(t, size) > width && line) { out.push(line); line = w; } else line = t;
      });
      out.push(line);
    });
    return out;
  };
  // deno-lint-ignore no-explicit-any
  const write = (text: string, f: any, size: number, color: any, x = M, width = W - 2 * M, gap = 3) => {
    for (const ln of wrap(text, f, size, width)) { ensure(size + gap); page.drawText(ln, { x, y: y - size, size, font: f, color }); y -= size + gap; }
  };
  write("Service Allocation Plan", bold, 20, ORANGE);
  write(`${clientName} · ${month.label}`, font, 12, INK); y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: ORANGE }); y -= 14;
  for (const s of month.sections || []) {
    ensure(40); y -= 4;
    write(s.name, bold, 12, INK);
    if (s.notes) write(s.notes, font, 9, DIM, M + 10, W - 2 * M - 10);
    for (const it of s.items || []) {
      write("- " + it.name, font, 10, INK, M + 12, W - 2 * M - 12, 2);
      if (it.notes) write(it.notes, font, 8.5, DIM, M + 24, W - 2 * M - 24, 2);
    }
    y -= 6;
  }
  if (month.terms) { ensure(60); y -= 6; write(month.terms, font, 8, DIM); }
  ensure(150); y -= 16;
  write("Approved and signed", bold, 12, INK); y -= 4;
  if (sigPng) {
    try {
      const img = await pdf.embedPng(sigPng);
      const h = 60, w = Math.min(240, img.width * (h / img.height));
      ensure(h + 6); page.drawImage(img, { x: M, y: y - h, width: w, height: h }); y -= h + 6;
    } catch (_e) { /* unreadable signature image → name + date still recorded */ }
  }
  page.drawLine({ start: { x: M, y }, end: { x: M + 260, y }, thickness: 0.6, color: DIM }); y -= 4;
  write(`${signer.name}${signer.email ? " (" + signer.email + ")" : ""}`, font, 10, INK);
  write(`Signed ${new Date(signer.at).toLocaleString("en-US", { timeZone: "America/Phoenix", dateStyle: "long", timeStyle: "short" })} (Arizona time)`, font, 9, DIM);
  return await pdf.save();
}
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

// deno-lint-ignore no-explicit-any
const publicView = (e: any) => ({
  connected: !!(e && e.sapUrl), sapUrl: e?.sapUrl || "", fileName: e?.sap?.fileName || "",
  error: e?.sap?.error || "", months: e?.sap?.months || {}, current: nowMonth().key,
});

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  // deno-lint-ignore no-explicit-any
  let body: any; try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const action = String(body.action || "fetch");

  if (action === "sweep") {
    if (req.headers.get("x-snapshot-secret") !== Deno.env.get("SNAPSHOT_SECRET")) return json(req, 401, { error: "bad secret" });
    const { data: rows } = await svc().from("app_state").select("client_id, url:data->engagements->retainer->>sapUrl").eq("scope", "dashboard");
    // deno-lint-ignore no-explicit-any
    const ids = (rows || []).filter((r: any) => r.url && !String(r.client_id).startsWith("_")).map((r: any) => r.client_id);
    let ok = 0, failed = 0;
    for (const id of ids) { try { await refresh(id, true); ok++; } catch (_e) { failed++; } }
    return json(req, 200, { ok: true, connected: ids.length, refreshed: ok, failed });   // counts only — the log is public
  }

  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "Google access isn't configured" });
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  const staff = caller.role !== "client";
  const clientId = staff ? String(body.clientId || "") : caller.clientId;     // a client is pinned to its own account
  if (!clientId) return json(req, 400, { error: "clientId required" });

  try {
    if (action === "connect") {
      if (!staff) return json(req, 403, { error: "staff only" });
      const url = String(body.url || "").trim();
      if (!url) { await casRetainer(clientId, (e) => { delete e.sapUrl; }); return json(req, 200, { ok: true, view: publicView(await refresh(clientId)) }); }
      if (!parseDriveFileId(url)) return json(req, 400, { error: "That doesn't look like a Google Sheets link." });
      const m = nowMonth();
      let got;
      try { got = await readMonth(url, m.label); }
      catch (_e) { return json(req, 404, { error: "Couldn't open that sheet — share it with the portal's service account (Viewer) and try again." }); }
      await casRetainer(clientId, (e) => { e.sapUrl = url; });
      const e = await refresh(clientId, true);
      return json(req, 200, { ok: true, view: publicView(e), tabFound: got.tab, parsed: !!got.sections });
    }

    if (action === "fetch") {
      const e = await refresh(clientId, !!body.force && staff);
      return json(req, 200, { ok: true, view: publicView(e) });
    }

    if (action === "sign") {
      const name = String(body.name || "").trim().slice(0, 120);
      if (!name) return json(req, 400, { error: "Type your full name to sign." });
      const sig = String(body.signature || "");
      const sigPng = /^data:image\/png;base64,/.test(sig) && sig.length < 600_000
        ? Uint8Array.from(atob(sig.split(",")[1]), (c) => c.charCodeAt(0)) : null;
      if (!sigPng) return json(req, 400, { error: "Draw your signature first." });
      const m = nowMonth();
      const e0 = await refresh(clientId, true);
      const month = e0?.sap?.months?.[m.key];
      if (!month || !month.sections) return json(req, 409, { error: "There's no plan for this month to sign yet." });
      if (month.signed) return json(req, 409, { error: `Already signed by ${month.signed.name}.` });
      const signer = { name, email: caller.email || "", at: new Date().toISOString() };
      // claim the signature FIRST (compare-and-set), so two people signing at once can't both win
      let won = false;
      await casRetainer(clientId, (e) => {
        const mm = e.sap?.months?.[m.key]; if (!mm || mm.signed) return false;
        mm.signed = { ...signer, hash: mm.hash, role: caller.role };
        won = true;
      });
      if (!won) return json(req, 409, { error: "Someone on your team just signed this plan." });

      const reg = await registryEntry(clientId);
      const clientName = reg?.name || clientId;
      const pdf = await buildPdf(clientName, month, signer, sigPng);
      const mm = String(m.mi + 1).padStart(2, "0");
      const folderName = `${mm}-${m.yr} ${FULL[m.mi]} SAP`;
      const fileName = `${folderName} - Signed.pdf`;
      let driveUrl = "", driveErr = "";
      try {
        const root = Deno.env.get("DRIVE_ROOT_FOLDER_ID");
        if (!root) throw new Error("Drive root not set");
        const token = await driveAccessToken();   // same (write) scope drive-upload uses
        const tree = await ensureClientFolders(token, root, clientId);
        if (!tree) throw new Error("client Drive folder not found");
        const sapF = await ensureFolder(token, tree.folderId, "Service Allocation Plans");
        const yrF = await ensureFolder(token, sapF, String(m.yr));
        const monF = await ensureFolder(token, yrF, folderName);
        const up = await driveUploadBytes(token, monF, fileName, pdf, "application/pdf");
        driveUrl = up.webViewLink || `https://drive.google.com/file/d/${up.id}/view`;
      } catch (err) { driveErr = String((err as Error).message || err); console.error("sap drive", driveErr); }

      const chan = reg?.integrations?.slackChannel;
      const msg = `✍️ *${clientName}* — ${month.label} Service Allocation Plan signed by *${name}*.${driveUrl ? `\n<${driveUrl}|Open in Drive>` : ""}`;
      let slack = await uploadFileToSlack(chan, msg, b64(pdf), fileName);
      if (!slack.ok && !slack.skipped) slack = await postToSlack(chan, msg);

      await casRetainer(clientId, (e) => {
        const x = e.sap?.months?.[m.key]; if (!x || !x.signed) return false;
        x.signed.driveUrl = driveUrl; if (driveErr) x.signed.driveError = "not saved to Drive"; x.signed.slack = !!slack.ok;
      });
      const e = await refresh(clientId);
      return json(req, 200, { ok: true, view: publicView(e), driveUrl, slack: !!slack.ok, pdf: b64(pdf) });
    }
    return json(req, 400, { error: "unknown action" });
  } catch (err) {
    console.error("sap", err);
    return json(req, 502, { error: String((err as Error).message || err) });
  }
});
