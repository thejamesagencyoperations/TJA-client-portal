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
import { assertLooksLikeWmjCsv, wmjReportRequest, normName } from "../_shared/wmj.ts";
import { reportHealth } from "../_shared/health.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
/* The BROWSER's transform, byte-for-byte — imported for its side effect (it assigns to
   globalThis when there's no window). Using the same code rather than a re-implementation is
   what stops the cron and the browser quietly disagreeing about a client's projects;
   tests/wmj-transform-copy asserts the two files stay identical. */
import "../_shared/wmj-transform.js";
// deno-lint-ignore no-explicit-any
const T = (globalThis as any).WMJ_TRANSFORM;

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
  try {
    const rq = wmjReportRequest(Deno.env.get("WMJ_PROJECTS_REPORTKEY") || "");
    if (!rq) throw new Error("WMJ direct API not configured (WMJ_SUBDOMAIN / tokens / WMJ_PROJECTS_REPORTKEY)");
    const res = await fetchT(rq.url, rq.init, { timeoutMs: 45_000, retries: 2, label: "WMJ projects report" });
    if (!res.ok) throw new Error(`WMJ projects report: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const csv = await res.text();
    assertLooksLikeWmjCsv(csv, "WMJ projects report", "Task_Full_Name");
    const head = csv.split(/\r?\n/)[0] || "";
    const miss = PROJECT_COLS.filter((c) => !new RegExp(c.replace(/_/g, "[ _]"), "i").test(head));
    if (miss.length) throw new Error(`WMJ projects report is missing [${miss.join(", ")}] — WMJ_PROJECTS_REPORTKEY is pointing at the wrong report`);
    rows = T.parseCSV(csv);
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
    if (c.name) idByName.set(normName(c.name), c.id);
    if (c.wmjName) idByName.set(normName(c.wmjName), c.id);
  });

  let updated = 0, projects = 0, failed = 0;
  const unmatched: string[] = [];

  for (const wc of wmjClients) {
    const cid = idByName.get(normName(wc.wmjName));
    if (!cid) { unmatched.push(wc.wmjName); continue; }

    const { data: row, error: rerr } = await svc.from("app_state").select("data")
      .eq("client_id", cid).eq("scope", "dashboard").maybeSingle();
    if (rerr || !row) { failed++; continue; }

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
    state.engagements.projects = manual.concat(wmjProjects);

    const { error: werr } = await svc.from("app_state")
      .update({ data: state }).eq("client_id", cid).eq("scope", "dashboard");
    if (werr) { failed++; continue; }
    updated++; projects += wmjProjects.length;
  }

  const result = { ok: true, clientsInReport: wmjClients.length, updated, projects, failed,
    unmatched: unmatched.length, unmatchedNames: unmatched.slice(0, 30) };
  await reportHealth("sync-projects", result);
  return json(req, 200, result);
});
