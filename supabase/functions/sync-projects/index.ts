/* ============================================================
   SYNC-PROJECTS — refresh every client's PROJECT data from Workamajig,
   server-side, with nobody's browser open.

   WHY THIS EXISTS
   Until now the projects feed ran ONLY in the browser: clients.html starts wmj-sync.js on
   page load and then hourly WHILE THAT PAGE STAYS OPEN. Nothing refreshed it on a schedule.
   So project pages — which clients look at — silently froze whenever no admin happened to
   have the Clients page open. Observed 2026-09-03: last sync 27 Aug, seven days stale.
   The retainer side never had this problem because snapshot-months does it on a cron; the
   projects side was simply never given the same treatment.

   WHAT IT DELIBERATELY DOES NOT DO
   It never CREATES a client. The browser sync does that, because creating a workspace also
   means a registry write, a client code, a logo lookup and a login convention — none of
   which belong in an unattended job that would happily invent 40 workspaces from a bad feed.
   WMJ clients with no portal match are REPORTED (`unmatched`) so they stay visible, and an
   admin opening the Clients page still creates them.

   Deploy:  supabase functions deploy sync-projects --use-api
   ============================================================ */
import { json, handleOptions } from "../_shared/cors.ts";
import { fetchT } from "../_shared/http.ts";
import { assertLooksLikeWmjCsv, wmjReportRequest, normName, fetchWmjReportCached } from "../_shared/wmj.ts";
import { reportHealth } from "../_shared/health.ts";
import { wmjAliasMap, applyWmjAliases } from "../_shared/registry.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
/* The BROWSER's transform, byte-for-byte — imported for its side effect (it assigns to
   globalThis when there's no window). Using the same code rather than a re-implementation is
   what stops the cron and the browser quietly disagreeing about a client's projects;
   tests/wmj-transform-copy asserts the two files stay identical. */
import "../_shared/wmj-transform.js";
// deno-lint-ignore no-explicit-any
const T = (globalThis as any).WMJ_TRANSFORM;
// key-order-insensitive JSON (jsonb does not preserve key order, so a plain stringify reports
// phantom changes on every run)
// deno-lint-ignore no-explicit-any
function stableStr(v: any): string {
  // deno-lint-ignore no-explicit-any
  const walk = (x: any): any => (x === null || typeof x !== "object") ? x
    : Array.isArray(x) ? x.map(walk) : Object.keys(x).sort().reduce((o: any, k) => { o[k] = walk(x[k]); return o; }, {});
  return JSON.stringify(walk(v));
}

/* Every column the transform reads. Same guard as the browser: a report missing any of these
   is the WRONG report, and must fail loudly rather than write a half-parsed picture over
   every client's projects. */
const PROJECT_COLS = ["Client_Name", "Campaign_Name", "Project_Name", "Task_Full_Name",
  "Allocated_Hours", "Project_Status", "Plan_Start_Date", "Plan_Completion_Date", "Service"];

function projectShell(id: string) {
  return {
    id, type: "project", source: "wmj", label: "Project", name: "Project",
    northStar: "", dueDate: "",
    pizza: { phases: [] },
    condition: { level: "green", note: "" },
    serviceLines: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
    wmjTasks: [], status: { groups: [] },
    projectPlan: { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] },
  };
}

/* KEEP IN SYNC with wmj-sync.js mergeProject. WMJ owns structure/hours/status; everything an
   admin types — north star, condition note, milestones, to-dos, KPIs, layout — is preserved
   by merging onto the existing project rather than replacing it. */
// deno-lint-ignore no-explicit-any
function mergeProject(existing: any, w: any) {
  const p = existing || projectShell(w.id);
  p.id = w.id; p.type = "project"; p.source = "wmj";
  p.label = w.label; p.name = w.name;
  p.dueDate = w.dueDate || p.dueDate || "";
  const completed = (w.status === "Completed") || (+w.progressPct >= 100);
  if (p.pizza && p.pizza.manual && Array.isArray(p.pizza.phases)) {
    /* an admin-managed tracker is sacrosanct — never overwritten */
  } else if (completed) {
    // deno-lint-ignore no-explicit-any
    p.pizza = { phases: (w.phases || []).map((ph: any) => ({ label: ph.label, done: !!ph.done, status: ph.status })) };
  } else {
    /* Identical to the browser, deliberately — including seeding three blank steps here.
       My first version only seeded when the tracker was empty, which reads like an
       improvement but ISN'T: the browser sync writes the same clients, so any difference
       between the two makes the tracker flip-flop depending on which ran last. Same class of
       bug as the retainer split-brain. If this seeding should change, change BOTH. */
    p.pizza = { manual: true, phases: [{ label: "", done: false }, { label: "", done: false }, { label: "", done: false }] };
  }
  p.wmjTasks = w.tasks;
  p.contractedHours = w.contractedHours;
  p.allocatedHours = w.allocatedHours;
  p.progressPct = w.progressPct;
  p.wmjStatus = w.status;
  p.condition = p.condition || { level: "green", note: "" };
  p.condition.level = w.status === "On Hold" ? "yellow" : "green";
  return p;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (req.headers.get("x-snapshot-secret") !== Deno.env.get("SNAPSHOT_SECRET"))
    return json(req, 401, { error: "bad secret" });
  if (!T || !T.transform) return json(req, 500, { error: "wmj-transform failed to load" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ---- fetch + validate the report
  let rows: Record<string, string>[];
  let reportFrom = "wmj", aliasedRows = 0;
  try {
    const key = Deno.env.get("WMJ_PROJECTS_REPORTKEY") || "";
    if (!wmjReportRequest(key)) throw new Error("WMJ direct API not configured (WMJ_SUBDOMAIN / tokens / WMJ_PROJECTS_REPORTKEY)");
    // shared 15-min cache: rate-limit-proof (see _shared/wmj.ts fetchWmjReportCached)
    const got = await fetchWmjReportCached(key, "WMJ projects report", (csv) => {
      assertLooksLikeWmjCsv(csv, "WMJ projects report", "Task_Full_Name");
      const head = csv.split(/\r?\n/)[0] || "";
      const miss = PROJECT_COLS.filter((c) => !new RegExp(c.replace(/_/g, "[ _]"), "i").test(head));
      if (miss.length) throw new Error(`WMJ projects report is missing [${miss.join(", ")}] — WMJ_PROJECTS_REPORTKEY is pointing at the wrong report`);
    });
    if (got.stale) console.warn("projects report served from cache — WMJ unavailable:", got.failure);
    reportFrom = got.stale ? `cache (${Math.round((Date.now() - got.cachedAt) / 60000)} min old — WMJ: ${got.failure})` : got.source;
    rows = T.parseCSV(got.csv);
    // relabel rows logged under a client's OTHER WMJ name (wmjAliases) to its primary name,
    // so one client's projects aren't split across two names / two workspaces
    {
      const { data: rr } = await svc.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
      aliasedRows = applyWmjAliases(rows, wmjAliasMap(Array.isArray(rr?.data) ? rr!.data : []));
    }
  } catch (e) {
    const msg = String((e as Error).message || e);
    await reportHealth("sync-projects", { ok: false, error: msg });
    return json(req, 502, { error: msg });
  }

  const wmjClients = T.transform(rows);

  // ---- roster: normalised name → clientId (matching wmj-sync's resolveClientId, minus creation)
  const { data: regRow } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const roster: any[] = Array.isArray(regRow?.data) ? regRow!.data : [];
  const idByName = new Map<string, string>();
  roster.forEach((c) => {
    if (c.mergedInto) return;                    // folded into another client — never written again
    if (c.name) idByName.set(normName(c.name), c.id);
    if (c.wmjName) idByName.set(normName(c.wmjName), c.id);
  });

  let updated = 0, unchanged = 0, projects = 0, failed = 0;
  const unmatched: string[] = [];

  for (const wc of wmjClients) {
    const cid = idByName.get(normName(wc.wmjName));
    if (!cid) { unmatched.push(wc.wmjName); continue; }

    /* COMPARE-AND-SET (2026-10-15). This used to read the client's dashboard, replace its
       projects and write the WHOLE row back blind — and without bumping updated_at. So an admin
       edit landing between the read and the write was silently lost, and an open admin tab
       (whose guarded writes key on updated_at) could just as silently write stale projects back
       over the sync. Now: re-read → merge ONLY the WMJ projects into that fresh copy → write it
       only if nobody saved in between (and stamp updated_at so open tabs know to re-merge) →
       otherwise retry. Unchanged clients aren't written at all. */
    let outcome: "updated" | "unchanged" | "failed" = "failed", nWmj = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row, error: rerr } = await svc.from("app_state").select("data,updated_at")
        .eq("client_id", cid).eq("scope", "dashboard").maybeSingle();
      if (rerr || !row) break;
      const state = row.data || {};
      state.engagements = state.engagements || {};
      const existing = Array.isArray(state.engagements.projects) ? state.engagements.projects : [];
      // deno-lint-ignore no-explicit-any
      const byId = new Map(existing.map((p: any) => [p.id, p]));
      // manual (non-WMJ) projects are the admin's and are kept untouched
      // deno-lint-ignore no-explicit-any
      const manual = existing.filter((p: any) => p.source !== "wmj");
      // deno-lint-ignore no-explicit-any
      const wmjProjects = wc.projects.map((w: any) => mergeProject(byId.get(w.id), w));
      const next = manual.concat(wmjProjects);
      nWmj = wmjProjects.length;
      if (stableStr(next) === stableStr(existing)) { outcome = "unchanged"; break; }
      state.engagements.projects = next;
      const { data: w, error: werr } = await svc.from("app_state")
        .update({ data: state, updated_at: new Date().toISOString() })
        .eq("client_id", cid).eq("scope", "dashboard").eq("updated_at", row.updated_at).select("updated_at");
      if (!werr && w && w.length) { outcome = "updated"; break; }
      await new Promise((r) => setTimeout(r, 150 + Math.random() * 300 * (attempt + 1)));   // someone saved first → re-merge
    }
    if (outcome === "failed") { failed++; continue; }
    if (outcome === "unchanged") { unchanged++; projects += nWmj; continue; }
    updated++; projects += nWmj;
  }

  const result = { ok: true, reportFrom, aliasedRows, clientsInReport: wmjClients.length, updated, unchanged, projects, failed,
    unmatched: unmatched.length, unmatchedNames: unmatched.slice(0, 30) };
  await reportHealth("sync-projects", result);
  return json(req, 200, result);
});
