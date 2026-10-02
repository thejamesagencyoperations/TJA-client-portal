/* ============================================================
   ASSIGN-SYNC — reads the AM/PM client-assignment workbook and sets
   each client's Account Manager + Project Manager (both get edit
   access). Always uses the MOST RECENT month tab ("<Month> <Year>",
   e.g. "July 2026"), so it tracks the current assignments.

   The workbook is PUBLIC, so we read it via the public gviz CSV +
   htmlview endpoints — no Google Sheets API (it's not enabled on the
   Cloud project) and no service-account file access needed.

   MANUAL WINS: a client an admin assigned by hand in the portal
   (integrations.amPmManual === true) is never overwritten.

   Names: the sheet uses FIRST names ("Alysha"); we resolve those to the
   login's full display name ("Alysha Wolfe") so the existing full-name
   manager-tag match keeps working. Client names are matched fuzzily to
   the portal roster (+ an alias map for the odd ones).

   ?dry=1 → report the proposed mapping, write NOTHING. Gate: the
   SNAPSHOT_SECRET header. Deploy:
     supabase functions deploy assign-sync --use-api --no-verify-jwt
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { audit } from "../_shared/audit.ts";
import { csvToRows } from "../_shared/plan.ts";
import { reportHealth } from "../_shared/health.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SHEET_ID = "1_I3UlEU__O4ea9SVV2J4ERKww3XWumc68wGDr0cDrQM";
/* The quarterly CLIENT HEALTH workbook (tabs "Q2-2026", "Q3-2026", …). Since 2026-10-02 it is the
   source of truth for ACCOUNT MANAGERS (Cameron). It has no Project Manager column, so PMs still
   come from the monthly workbook above. Per client we take the AM from the NEWEST quarter tab that
   lists one, falling back to earlier quarters (SRP is on Q2 but not Q3). Rows are matched by the
   "Client Code" column ("400 SRP" → code SRP) first, then by name. Fail-soft: if this workbook
   can't be read, the run falls back to the monthly workbook's AMs exactly as before. */
const HEALTH_SHEET_ID = "1cg7cpRautvKCiabRjOreJniBl8alBYfxoTDhqmAYtis";
const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const CLIENT_ALIAS: Record<string, string> = {
  "ray cammack shows": "rcs-inc",
  "department of child safety": "arizona-department-of-child-safety",
  "dellshire opening projects": "dellshire-resort",
  "santan brewing company": "santan-brewing",
  "hopco": "healthcare-outcome-performance-company",
  "ycs mongolian grill": "yc-s-mongolian-grill",
};
// sheet clients that are NOT portal clients — ignore silently (don't report as "unmatched").
const IGNORE_CLIENTS = new Set(["the james agency"]);

const norm = (s: string) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
const firstName = (full: string) => norm(full).split(" ")[0] || "";

async function fetchText(u: string): Promise<string> {
  const r = await fetch(u, { redirect: "follow" });
  if (!r.ok) throw new Error(`fetch ${r.status} ${u.slice(0, 80)}`);
  return await r.text();
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    // 1) most-recent "<Month> <Year>" tab, from the public htmlview tab list
    const html = await fetchText(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`);
    let tabName = "", tabGid = "", tabKey = -1;
    for (const m of html.matchAll(/name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g)) {
      const nm = m[1].trim();
      const mm = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})$/i.exec(nm);
      if (!mm) continue;
      const key = (+mm[2]) * 100 + MONTHS[mm[1].toLowerCase()];
      if (key > tabKey) { tabKey = key; tabName = nm; tabGid = m[2]; }
    }
    if (!tabGid) return json(req, 422, { error: "no <Month> <Year> tab found in the workbook" });

    // 2) that tab's rows (public gviz CSV)
    const csv = await fetchText(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${tabGid}`);
    const rows = csvToRows(csv);
    const header = (rows[0] || []).map((h) => norm(h));
    const ci = header.indexOf("client"), ai = header.indexOf("account manager"), pi = header.indexOf("project manager");
    if (ci < 0 || ai < 0 || pi < 0) return json(req, 422, { error: "couldn't find Client/Account Manager/Project Manager columns", tab: tabName, header });

    // 2b) the quarterly health workbook → { code/name → AM first names }, newest quarter wins
    type QRow = { client: string; code: string; ams: string[]; tab: string };
    const qRows: QRow[] = [];
    const qTabsUsed: string[] = [];
    let qError = "";
    try {
      const qhtml = await fetchText(`https://docs.google.com/spreadsheets/d/${HEALTH_SHEET_ID}/htmlview`);
      const tabs: { name: string; gid: string; key: number }[] = [];
      for (const m of qhtml.matchAll(/name:\s*"([^"]+)"[^}]*?gid:\s*"(\d+)"/g)) {
        const mm = /^Q([1-4])[\s-]*(\d{4})$/i.exec(m[1].trim());
        if (mm) tabs.push({ name: m[1].trim(), gid: m[2], key: (+mm[2]) * 10 + (+mm[1]) });
      }
      tabs.sort((a, b) => b.key - a.key);                       // newest quarter first
      for (const t of tabs) {
        const qr = csvToRows(await fetchText(`https://docs.google.com/spreadsheets/d/${HEALTH_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${t.gid}`));
        const qh = (qr[0] || []).map((h) => norm(h));
        const qci = qh.indexOf("client"), qai = qh.indexOf("account manager"), qcc = qh.indexOf("client code");
        if (qci < 0 || qai < 0) continue;
        qTabsUsed.push(t.name);
        for (const row of qr.slice(1)) {
          const client = String(row[qci] || "").trim();
          const code = qcc > -1 ? String(row[qcc] || "").trim().split(/\s+/).pop()!.toUpperCase() : "";
          // "Sheridan/Alex", "Sheridan & Alex", "Sheridan, Alex" → both
          const ams = String(row[qai] || "").split(/\s*(?:\/|&|,|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
          if (client || code) qRows.push({ client, code, ams, tab: t.name });   // newest tabs pushed first
        }
      }
      if (!qTabsUsed.length) qError = "no Q<n>-<year> tab with Client + Account Manager columns";
    } catch (e) { qError = String((e as Error).message || e).slice(0, 160); }

    // 3) first-name → login full name (managers + admins). Robust fetch: listUsers can
    // intermittently return empty/error, and an empty user list would resolve every name to
    // "not found" and (worse) let the write wipe managers. So retry, and hard-abort below if
    // it still looks empty.
    const authUsers: any[] = [];
    for (let page = 1; page <= 50; page++) {
      let got: any[] | null = null;
      for (let attempt = 0; attempt < 3 && got === null; attempt++) {
        const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
        if (!error && data && Array.isArray(data.users)) got = data.users;
        else await new Promise((r) => setTimeout(r, 400));
      }
      if (got === null) return json(req, 503, { error: "couldn't load logins (auth listUsers failed) — aborting so assignments are never wiped" });
      authUsers.push(...got);
      if (got.length < 200) break;
    }
    const { data: profs } = await svc.from("profiles").select("id,role");
    const roleById: Record<string, string> = {}; (profs || []).forEach((p: any) => roleById[p.id] = p.role);
    const byFirst: Record<string, string[]> = {};
    for (const u of authUsers) {
      const r = roleById[u.id] || u.user_metadata?.role;
      if (r !== "manager" && r !== "admin") continue;
      const full = String(u.user_metadata?.name || "").trim();
      if (!full) continue;
      const f = firstName(full);
      if (!(byFirst[f] || (byFirst[f] = [])).includes(full)) byFirst[f].push(full);
    }
    // Safety: if the login map is suspiciously empty, something's wrong with the auth read —
    // abort rather than resolve everyone to null and wipe assignments.
    if (Object.keys(byFirst).length < 2) return json(req, 503, { error: "login map came back nearly empty — aborting to protect existing assignments" });
    const resolve = (first: string): { name?: string; issue?: string } => {
      const f = firstName(first);
      if (!f) return {};
      const hits = byFirst[f];
      if (!hits || !hits.length) return { issue: `no login named "${first}"` };
      if (hits.length > 1) return { issue: `"${first}" → ${hits.length} logins (${hits.join(", ")})` };
      return { name: hits[0] };
    };

    // 4) roster + client matcher
    const { data: reg } = await svc.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
    const roster: any[] = Array.isArray(reg?.data) ? reg!.data : [];
    const byNorm: Record<string, any> = {};
    roster.forEach((c) => { byNorm[norm(c.name)] = c; if (c.id) byNorm[norm(c.id)] = byNorm[norm(c.id)] || c; });
    const byCode: Record<string, any> = {};
    roster.forEach((c) => { if (c && c.code) byCode[String(c.code).trim().toUpperCase()] = c; });
    const matchClient = (sheetName: string): any => {
      const n = norm(sheetName);
      if (!n) return null;
      if (CLIENT_ALIAS[n]) return roster.find((c) => c.id === CLIENT_ALIAS[n]) || null;
      if (byNorm[n]) return byNorm[n];
      return roster.find((c) => { const cn = norm(c.name); return cn.startsWith(n) || n.startsWith(cn); }) || null;
    };

    // client id → { ams, tab } from the NEWEST quarter tab that names an AM for it
    const qAm: Record<string, { ams: string[]; tab: string; sheetClient: string }> = {};
    const qUnmatched: string[] = [];
    for (const r of qRows) {
      const c = (r.code && byCode[r.code]) || matchClient(r.client);
      if (!c) { if (r.ams.length && !IGNORE_CLIENTS.has(norm(r.client))) qUnmatched.push(`${r.client || r.code} (${r.tab})`); continue; }
      if (qAm[c.id] || !r.ams.length) continue;               // newer tab already set it / blank → older tab
      qAm[c.id] = { ams: r.ams, tab: r.tab, sheetClient: r.client || r.code };
    }

    const applied: any[] = [], skippedManual: any[] = [], unmatchedClients: string[] = [], nameIssues: string[] = [];
    const blankRows: string[] = [];
    const seen = new Set<string>();
    for (const row of rows.slice(1)) {
      const sheetClient = String(row[ci] || "").trim();
      if (!sheetClient || seen.has(norm(sheetClient))) continue;
      seen.add(norm(sheetClient));
      if (IGNORE_CLIENTS.has(norm(sheetClient))) continue;
      const amRaw = String(row[ai] || "").trim(), pmRaw = String(row[pi] || "").trim();
      // A row with a client but NO names was skipped silently — indistinguishable from a client
      // that simply isn't in the workbook, and both leave every AM/PM locked out of that client.
      if (!amRaw && !pmRaw) { blankRows.push(sheetClient); continue; }
      const c = matchClient(sheetClient);
      if (!c) { unmatchedClients.push(sheetClient); continue; }
      if (c.integrations?.amPmManual === true) { skippedManual.push({ client: c.id, sheetClient }); continue; }
      const pm = pmRaw ? resolve(pmRaw) : {};
      if (pm.issue) nameIssues.push(`${sheetClient}: PM ${pm.issue}`);
      // AM: the quarterly health workbook wins; the monthly workbook is the fallback
      const q = qAm[c.id];
      let amNames: string[] = [], amFrom = "monthly";
      if (q) {
        const res = q.ams.map((n) => ({ n, r: resolve(n) }));
        res.forEach((x) => { if (x.r.issue) nameIssues.push(`${q.sheetClient} (${q.tab}): AM ${x.r.issue}`); });
        amNames = res.map((x) => x.r.name).filter(Boolean) as string[];
        if (amNames.length) amFrom = q.tab;
      }
      if (!amNames.length && amRaw) {
        const am = resolve(amRaw);
        if (am.issue) nameIssues.push(`${sheetClient}: AM ${am.issue}`);
        if (am.name) amNames = [am.name];
      }
      const managers = [...new Set([...amNames, pm.name].filter(Boolean))] as string[];
      applied.push({ client: c.id, name: c.name, sheetClient, am: amNames[0] || null, pm: pm.name || null, managers, amFrom });
    }
    // clients ONLY the quarterly workbook lists (not on the monthly tab): set their AM, keep their PM
    for (const id of Object.keys(qAm)) {
      if (applied.some((a) => a.client === id)) continue;
      const c = roster.find((x) => x.id === id); if (!c) continue;
      if (c.integrations?.amPmManual === true) { skippedManual.push({ client: c.id, sheetClient: qAm[id].sheetClient }); continue; }
      const q = qAm[id];
      const res = q.ams.map((n) => ({ n, r: resolve(n) }));
      res.forEach((x) => { if (x.r.issue) nameIssues.push(`${q.sheetClient} (${q.tab}): AM ${x.r.issue}`); });
      const amNames = res.map((x) => x.r.name).filter(Boolean) as string[];
      if (!amNames.length) continue;
      const keepPm = c.pm || null;
      const managers = [...new Set([...amNames, keepPm].filter(Boolean))] as string[];
      applied.push({ client: c.id, name: c.name, sheetClient: q.sheetClient, am: amNames[0], pm: keepPm, managers, amFrom: q.tab, pmKept: true });
    }

    if (!dry) {
      for (const a of applied) {
        // NEVER wipe a client's managers because a name failed to resolve — only write when we
        // got at least one real login for this client. (Manual/unresolved clients keep theirs.)
        if (!a.managers.length) continue;
        const c = roster.find((x) => x.id === a.client); if (!c) continue;
        c.am = a.am; c.pm = a.pm; c.managers = a.managers;
      }
      await svc.from("app_state").update({ data: roster, updated_at: new Date().toISOString() })
        .eq("client_id", "_registry").eq("scope", "clients");
      // on the record: who ended up assigned where, per run
      audit({
        clientId: "_registry", scope: "clients", action: "assignments.synced",
        summary: `AM/PM assignments synced — AMs from the quarterly health workbook (${qTabsUsed.join(", ") || "unavailable"}), PMs from "${tabName}" — ${applied.length} client${applied.length === 1 ? "" : "s"}`,
        changes: applied.slice(0, 40).map((a) => ({ p: a.name, f: "", t: `AM ${a.am || "—"} · PM ${a.pm || "—"}` })),
        n: applied.length,
      });
    }

    /* Clients in the portal that this run left WITHOUT an assignment — from the workbook's
       point of view they don't exist, and the consequence is invisible in the portal: their
       AM/PM silently cannot edit anything. Reported so the health page can name them. */
    const assignedIds = new Set(applied.filter((a) => a.managers.length).map((a) => a.client));
    const unassigned = roster
      .filter((c) => c && c.id && !c.archived && !assignedIds.has(c.id)
        && !(Array.isArray(c.managers) && c.managers.length))
      .map((c) => c.name || c.id);
    /* Portal clients this tab DIDN'T cover but which still carry managers from some earlier
       state. Nobody maintains these: the workbook has moved on, so whoever is listed stays
       listed for ever — and a newly-assigned AM/PM silently cannot edit, because the sync has
       no row to learn about them from (Circle the City / Alex, 2026-08-03). Reported WITH the
       current owners so the gap is obvious at a glance. */
    const notInWorkbook = roster
      .filter((c) => c && c.id && !c.archived && !assignedIds.has(c.id)
        && Array.isArray(c.managers) && c.managers.length)
      .map((c) => `${c.name || c.id} — currently ${c.managers.join(" + ")}`);

    const result = {
      dry, tab: tabName, am_source: { workbook: "quarterly health", tabs: qTabsUsed, error: qError || undefined, unmatched: qUnmatched },
      applied_count: applied.length, skipped_manual: skippedManual.length,
      applied, unmatched_clients: unmatchedClients, name_issues: nameIssues,
      blank_rows: blankRows, unassigned, not_in_workbook: notInWorkbook,
    };
    if (!dry) await reportHealth("assign-sync", result);
    return json(req, 200, result);
  } catch (e) {
    return json(req, 500, { error: String((e as Error).message || e).slice(0, 300) });
  }
});
