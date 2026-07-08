/* ============================================================
   WMJ SYNC  (Option A — client-side fetch of the published CSV)
   Pulls the Workamajig project export, transforms it, links each
   row's Client_Name to a portal client (auto-creating any that
   don't exist), and writes the projects into each client's
   workspace. Runs on demand (admin "Sync") and hourly.

   WMJ owns: project list, phases, tasks, hours, due dates, status.
   Manual/portal-owned fields are preserved across syncs:
     North Star, condition note, milestones, to-dos, KPIs, layout.

   Exposed as window.WMJ_SYNC.
   ============================================================ */
window.WMJ_SYNC = (function () {
  "use strict";
  const SHEET_ID = "1UpX-3ddqVsKpRXYENCARUXBTgU4QexZviO2XM2RyFio";        // PROJECTS sheet
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;
  const RET_SHEET_ID = "1d-iwYnkA_rmdZyysRPz_b1X7zSucBBviIBwhzdlrj00";    // RETAINERS sheet (separate)
  const RET_CSV_URL = `https://docs.google.com/spreadsheets/d/${RET_SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;
  const LAST_KEY = "tja_wmj_last_sync";
  const HOUR = 3600 * 1000;
  const T = () => window.WMJ_TRANSFORM;
  const RT = () => window.WMJ_RETAINER_TRANSFORM;

  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

  // email/password convention: <name, lowercased, alphanumeric>@thejamesagency.com
  function creds(wmjName) {
    const local = normName(wmjName);
    return { email: local + "@thejamesagency.com", password: local };
  }

  function loadState(clientId) {
    try { const s = JSON.parse(localStorage.getItem("tja_dashboard_" + clientId)); if (s && s.engagements) return s; } catch (e) {}
    const d = window.makeClientData({ name: clientId, kind: "project" });
    return { engagements: d.engagements };
  }
  function saveState(clientId, state) {
    try { localStorage.setItem("tja_dashboard_" + clientId, JSON.stringify(state)); } catch (e) { console.warn("wmj save", e); }
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(clientId, "dashboard", state);
  }

  function projectShell(id) {
    const refLay = (window.TJA_STORE && window.TJA_STORE.referenceProjectLayout) ? window.TJA_STORE.referenceProjectLayout() : null;
    return {
      id, type: "project", source: "wmj", label: "Project", name: "Project",
      northStar: "", dueDate: "",
      pizza: { phases: [] },
      condition: { level: "green", note: "" },
      serviceLines: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
      wmjTasks: [], status: { groups: [] },
      projectPlan: { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] },
      layout: refLay || undefined,
    };
  }

  // fold one WMJ project onto an existing portal project (preserving manual fields)
  function mergeProject(existing, w) {
    const p = existing || projectShell(w.id);
    p.id = w.id; p.type = "project"; p.source = "wmj";
    p.label = w.label; p.name = w.name;
    p.dueDate = w.dueDate || p.dueDate || "";
    p.pizza = { phases: w.phases.map(ph => ({ label: ph.label, done: !!ph.done, status: ph.status })) };
    p.wmjTasks = w.tasks;
    p.contractedHours = w.contractedHours;
    p.allocatedHours = w.allocatedHours;
    p.progressPct = w.progressPct;
    p.wmjStatus = w.status;
    p.condition = p.condition || { level: "green", note: "" };
    p.condition.level = w.status === "On Hold" ? "yellow" : "green";
    if (!p.layout && window.TJA_STORE && window.TJA_STORE.referenceProjectLayout) p.layout = window.TJA_STORE.referenceProjectLayout();
    return p;
  }

  // map WMJ clients onto portal clients; create the missing ones
  function resolveClientId(wmjName) {
    const target = normName(wmjName);
    const found = (window.TJA_STORE.list() || []).find(c => normName(c.name) === target || normName(c.wmjName) === target);
    if (found) return { id: found.id, created: false };
    const c = creds(wmjName);
    const entry = window.TJA_STORE.add({ name: wmjName, kind: "project", login: c, tagline: "" });
    window.TJA_STORE.seedWorkspace(entry);
    // drop the blank placeholder project — WMJ will populate the real ones
    try { const s = JSON.parse(localStorage.getItem("tja_dashboard_" + entry.id)); if (s && s.engagements) { s.engagements.projects = []; localStorage.setItem("tja_dashboard_" + entry.id, JSON.stringify(s)); } } catch (e) {}
    return { id: entry.id, created: true, login: c };
  }

  async function fetchCSV() {
    const res = await fetch(CSV_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("WMJ fetch failed: " + res.status);
    return res.text();
  }

  // main entry — returns a summary
  async function sync() {
    if (!T()) throw new Error("wmj-transform not loaded");
    const csv = await fetchCSV();
    const data = T().transform(T().parseCSV(csv));
    let created = 0, updated = 0, projectCount = 0;
    const createdClients = [];
    data.forEach(wc => {
      const r = resolveClientId(wc.wmjName);
      if (r.created) { created++; createdClients.push({ name: wc.wmjName, id: r.id, login: r.login }); }
      // set/refresh the website logo, but never overwrite an uploaded one
      if (window.CLIENT_LOGOS) {
        const ent = window.TJA_STORE.get(r.id);
        const url = window.CLIENT_LOGOS.logoUrlFor(wc.wmjName);
        const isAuto = ent && (!ent.logo || /icon\.horse|duckduckgo\.com|s2\/favicons/.test(ent.logo));
        if (ent && url && isAuto && ent.logo !== url) window.TJA_STORE.update(r.id, { logo: url });
      }
      const state = loadState(r.id);
      state.engagements = state.engagements || {};
      const existing = Array.isArray(state.engagements.projects) ? state.engagements.projects : [];
      const byId = new Map(existing.map(p => [p.id, p]));
      // keep manual (non-wmj) projects, refresh/insert wmj ones
      const manual = existing.filter(p => p.source !== "wmj");
      const wmjProjects = wc.projects.map(w => mergeProject(byId.get(w.id), w));
      state.engagements.projects = manual.concat(wmjProjects);
      projectCount += wmjProjects.length;
      saveState(r.id, state);
      if (!r.created) updated++;
    });
    try { localStorage.setItem(LAST_KEY, new Date().toISOString()); } catch (e) {}
    return { clients: data.length, created, updated, projects: projectCount, createdClients, at: lastSync() };
  }

  /* ---------- RETAINERS (separate sheet → Monthly Services engagement) ---------- */
  async function fetchRetCSV() {
    const res = await fetch(RET_CSV_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("WMJ retainer fetch failed: " + res.status);
    return res.text();
  }
  // fold retainer data onto a client's retainer engagement (WMJ owns service-line
  // hours + burn; manual fields — North Star, condition note, milestones, to-dos,
  // dependencies, KPIs, layout — are preserved).
  function applyRetainer(state, rc) {
    const eng = state.engagements || (state.engagements = {});
    const e = eng.retainer || (eng.retainer = {});
    e.type = "retainer"; e.label = e.label || "Retainer"; e.name = e.name || (rc.wmjName + " — Retainer");
    e.source = "wmj";
    e.wmjServiceLines = rc.serviceLines;                     // [{name, allocated, billable, sharePct, utilPct}]
    e.burn = e.burn || {};
    e.burn.usedHours = rc.totalBillable;                     // billable hours worked
    e.burn.contractedHours = rc.totalAllocated;              // allocated hours (denominator)
    if (e.burn.periodLabel == null) e.burn.periodLabel = "";
    e.condition = e.condition || { level: "green", note: "" };
    e.milestones = e.milestones || []; e.todos = e.todos || []; e.dependencies = e.dependencies || [];
    e.kpis = e.kpis || []; e.mom = e.mom || []; e.prCoverage = e.prCoverage || []; e.serviceLines = e.serviceLines || [];
    e.svcUtil = e.svcUtil || {};     // admin manual overrides of the shown utilization %, keyed by service-line name (preserved across sync)
    e.status = e.status || { groups: [] };
    e.projectPlan = e.projectPlan || { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] };
    if (typeof e.northStar !== "string") e.northStar = "";
    return e;
  }
  async function syncRetainers() {
    if (!RT()) throw new Error("retainer-transform not loaded");
    const data = RT().transform(RT().parseCSV(await fetchRetCSV()));
    let created = 0, updated = 0; const createdClients = [];
    data.forEach(rc => {
      const r = resolveClientId(rc.wmjName);
      if (r.created) { created++; createdClients.push({ name: rc.wmjName, id: r.id, login: r.login }); }
      if (window.CLIENT_LOGOS) {
        const ent = window.TJA_STORE.get(r.id), url = window.CLIENT_LOGOS.logoUrlFor(rc.wmjName);
        const isAuto = ent && (!ent.logo || /icon\.horse|duckduckgo\.com|s2\/favicons/.test(ent.logo));
        if (ent && url && isAuto && ent.logo !== url) window.TJA_STORE.update(r.id, { logo: url });
      }
      const state = loadState(r.id);
      applyRetainer(state, rc);
      saveState(r.id, state);
      if (!r.created) updated++;
    });
    return { clients: data.length, created, updated, createdClients };
  }

  function lastSync() { try { return localStorage.getItem(LAST_KEY) || null; } catch (e) { return null; } }

  // auto-sync: once on load (always fresh when the page opens) + hourly while open.
  // onDone(result) fires after each successful sync so the UI can re-render.
  let timer = null;
  function startAuto(onDone) {
    // Sequential on purpose: projects first, then retainers. A client can appear in
    // BOTH sheets; each sync loadState→saveState the whole client doc. Running them
    // sequentially guarantees the retainer write lands last for shared clients, so the
    // projects write can never clobber the retainer's wmjServiceLines with a stale copy.
    const run = () =>
      sync()
        .then(pv => { window.__wmjProjResult = pv; })
        .catch(err => { console.warn("WMJ projects sync", err); })
        .then(() => syncRetainers())
        .catch(err => { console.warn("WMJ retainers sync", err); })
        .then(() => {
          try { localStorage.setItem(LAST_KEY, new Date().toISOString()); } catch (e) {}
          if (onDone) { try { onDone(window.__wmjProjResult || null); } catch (e) {} }
        });
    run();
    if (!timer) timer = setInterval(run, HOUR);
  }

  return { sync, syncRetainers, fetchCSV, lastSync, startAuto, CSV_URL, RET_CSV_URL };
})();
