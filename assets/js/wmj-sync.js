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
  /* Server-first state for the SYNC's writes. The sync saves the WHOLE dashboard doc, so
     whatever it starts from becomes the new truth for every device. Basing that on THIS
     BROWSER's localStorage was the 2026-07-17 mass-wipe: a browser that had never opened
     a client fell back to the empty template, and the hourly sync pushed that template
     over 24 clients' real data. Rules now:
       • server row exists → that's the base (and heal localStorage from it);
       • server unreachable/errors → { ok:false } — the caller SKIPS this client, because
         "couldn't read" must never be treated as "doesn't exist";
       • genuinely no server row (new client) → localStorage, then template. */
  async function loadStateSafe(clientId) {
    if (window.SUPA && window.SUPA.enabled && window.SUPA.client) {
      try {
        const { data, error } = await window.SUPA.client.from("app_state")
          .select("data").eq("client_id", clientId).eq("scope", "dashboard").maybeSingle();
        if (error) throw new Error(error.message);
        if (data && data.data && data.data.engagements) {
          try { localStorage.setItem("tja_dashboard_" + clientId, JSON.stringify(data.data)); } catch (e) {}
          return { ok: true, state: data.data };
        }
        // no row — fall through to local/template (a truly new client)
      } catch (e) {
        console.warn("wmj sync: can't read server copy for", clientId, "— skipping this round.", (e && e.message) || e);
        return { ok: false, state: null };
      }
    }
    return { ok: true, state: loadState(clientId) };
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
    // Pizza tracker precedence:
    //  1. An admin-managed MANUAL tracker is sacrosanct — never overwritten (even once completed).
    //  2. COMPLETED projects that were never made manual keep their WMJ-derived phases as-is.
    //  3. NOT-completed projects get a manual, admin-editable tracker seeded with 3 empty steps.
    const completed = (w.status === "Completed") || (+w.progressPct >= 100);
    if (p.pizza && p.pizza.manual && Array.isArray(p.pizza.phases)) {
      /* keep the admin's tracker untouched */
    } else if (completed) {
      p.pizza = { phases: w.phases.map(ph => ({ label: ph.label, done: !!ph.done, status: ph.status })) };
    } else {
      p.pizza = { manual: true, phases: [{ label: "", done: false }, { label: "", done: false }, { label: "", done: false }] };
    }
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
    for (const wc of data) {
      const r = resolveClientId(wc.wmjName);
      if (r.created) { created++; createdClients.push({ name: wc.wmjName, id: r.id, login: r.login }); }
      // WMJ client code (leading token of Campaign_Name) → the client's code label
      if (wc.code) { const ent = window.TJA_STORE.get(r.id); if (ent && ent.code !== wc.code) window.TJA_STORE.update(r.id, { code: wc.code }); }
      // set/refresh the website logo, but never overwrite an uploaded one
      if (window.CLIENT_LOGOS) {
        const ent = window.TJA_STORE.get(r.id);
        const url = window.CLIENT_LOGOS.logoUrlFor(wc.wmjName);
        const isAuto = ent && (!ent.logo || /icon\.horse|duckduckgo\.com|s2\/favicons/.test(ent.logo));
        if (ent && url && isAuto && ent.logo !== url) window.TJA_STORE.update(r.id, { logo: url });
      }
      const ls = await loadStateSafe(r.id); if (!ls.ok) continue;
      const state = ls.state;
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
    }
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
    e.wmjServiceLines = rc.serviceLines;                     // WMJ ACTUALS by dept [{name(dept), billable, ...}]
    e.burn = e.burn || {};
    e.burn.usedHours = rc.totalBillable;                     // actual billable hours worked (WMJ owns this)
    // CONTRACTED hours are MANUAL now (admin-set per discipline). Seed the disciplines the
    // first time; the total contracted = sum of the disciplines. Never overwrite once set.
    if (!Array.isArray(e.serviceDisciplines) || !e.serviceDisciplines.length) {
      e.serviceDisciplines = (window.tjaSeedDisciplinesFor ? window.tjaSeedDisciplinesFor(rc.wmjName) : []);
    } else if (RT() && RT().normName && RT().normName(rc.wmjName) === "anewleaf") {
      // one-time correction: bump A New Leaf's Creative 33→34.63 (total 100→101.63) if still the
      // original unmodified seed. Guarded so a manual edit is never overwritten.
      const cr = e.serviceDisciplines.find(d => /creative/i.test(d.name));
      const tot = e.serviceDisciplines.reduce((s, d) => s + (+d.contracted || 0), 0);
      if (cr && +cr.contracted === 33 && tot === 100) cr.contracted = 34.63;
    }
    // Auto-ADD a discipline for any WMJ department with real billable hours that has no
    // matching discipline yet (e.g. Web -> "Web/SEO Management"), so real work stops
    // hiding in "Unallocated". ADDITIVE ONLY, and only ONCE per department (tracked in
    // e.autoDisciplines) so a manager who removes it is respected. We never auto-REMOVE:
    // a contracted discipline with no hours logged yet this month is still real, so an
    // absence of hours proves nothing.
    (function ensureDisciplinesForActuals() {
      const canon = window.tjaCanonDiscipline; if (!canon) return;
      const DEPT_LABEL = { web: "Web/SEO Management", pr: "Public Relations", media: "Paid Media", creative: "Creative", social: "Organic Social", oversight: "Strategic Oversight" };
      if (!Array.isArray(e.autoDisciplines)) e.autoDisciplines = [];
      const have = new Set((e.serviceDisciplines || []).map(d => canon(d.name)));
      (rc.serviceLines || []).forEach(sl => {
        if ((+sl.billable || 0) <= 0) return;                       // no real hours → nothing to surface
        const key = canon(sl.name || "");
        if (!key || have.has(key) || e.autoDisciplines.indexOf(key) > -1) return;
        const label = DEPT_LABEL[key]; if (!label) return;          // unknown dept → leave it in Unallocated
        e.serviceDisciplines.push({ name: label, contracted: 0 });  // 0 = admin still sets the budget
        e.autoDisciplines.push(key); have.add(key);
      });
    })();
    // DENOMINATOR: the SOW figure owns it (mirrors exec-summary's retainerTotalContracted).
    // Only fall back to the discipline sum when there's no usable SOW figure — the sum of
    // service lines must NEVER become the total.
    const sowOk = e.retainerValueMonthly === true && e.retainerValueTarget != null && +e.retainerValueTarget > 0;
    e.burn.contractedHours = sowOk ? +e.retainerValueTarget
      : e.serviceDisciplines.reduce((s, d) => s + (+d.contracted || 0), 0);
    if (e.burn.periodLabel == null) e.burn.periodLabel = "";
    e.condition = e.condition || { level: "green", note: "" };
    e.milestones = e.milestones || []; e.todos = e.todos || []; e.dependencies = e.dependencies || [];
    e.kpis = e.kpis || []; e.mom = e.mom || []; e.prCoverage = e.prCoverage || []; e.serviceLines = e.serviceLines || [];
    e.status = e.status || { groups: [] };
    e.projectPlan = e.projectPlan || { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] };
    if (typeof e.northStar !== "string") e.northStar = "";
    snapshotMonth(e);   // freeze the closing month + start the new one (see below)
    return e;
  }

  /* ---------- monthly snapshot / rollover ----------
     The retainer burn is CURRENT-period: when August's timesheet flows in, it
     overwrites July's actuals. Without a snapshot, July's closing numbers are lost.
     This runs inside the hourly retainer sync (so it covers EVERY client, not just
     ones someone opened) and keeps e.mom as a frozen month-by-month record:
       • upsert the CURRENT calendar month's entry with the real WMJ actuals;
       • past-month entries are never touched again — they're frozen at their
         last in-month value (which, synced hourly, is that month's near-final).
     Keyed by month+year so "Jul 2026" and "Jul 2027" never collide, and so the
     rollover to a new month starts a fresh entry instead of clobbering the last. */
  const SNAP_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const SNAP_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  // Per-discipline snapshot: {name, contracted, billable} for each service line, from the
  // manual contracted hours + the WMJ actuals matched by canon key. Used for the historical
  // "Service Lines" MoM view. KEEP IN SYNC with the server port in
  // supabase/functions/snapshot-months (same shape, same math).
  function snapshotLines(e) {
    const canon = window.tjaCanonDiscipline || ((s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
    const act = {};
    (e.wmjServiceLines || []).forEach((l) => { const k = canon(l.name); act[k] = (act[k] || 0) + (+l.billable || 0); });
    return (e.serviceDisciplines || []).map((d) => ({
      name: d.name,
      contracted: +d.contracted || 0,
      billable: Math.round((act[canon(d.name)] || 0) * 100) / 100,
    }));
  }
  function snapshotMonth(e) {
    if (!e || !e.burn) return;
    e.mom = e.mom || [];
    const now = new Date();
    const yr = now.getFullYear(), mi = now.getMonth();
    const short = SNAP_MONTHS[mi];
    e.burn.periodLabel = `${SNAP_FULL[mi]} ${yr}`;   // keep the tile's month label current
    const used = +e.burn.usedHours || 0;             // real WMJ actuals (not a presentation override)
    const total = +e.burn.contractedHours || 0;
    const lines = snapshotLines(e);
    const last = e.mom[e.mom.length - 1];
    // match the current month's entry: same short month AND (same year, or a legacy
    // entry with no year — assume it's this year's and adopt it).
    if (last && last.month === short && (last.year == null || last.year === yr)) {
      last.year = yr; last.usedHours = used; last.contractedHours = total; last.lines = lines;
    } else {
      e.mom.push({ month: short, year: yr, usedHours: used, contractedHours: total, lines });
    }
    // guard against unbounded growth — keep the trailing 24 months
    if (e.mom.length > 24) e.mom = e.mom.slice(-24);
  }
  async function syncRetainers() {
    if (!RT()) throw new Error("retainer-transform not loaded");
    const data = RT().transform(RT().parseCSV(await fetchRetCSV()));
    let created = 0, updated = 0; const createdClients = [];
    for (const rc of data) {
      const r = resolveClientId(rc.wmjName);
      if (r.created) { created++; createdClients.push({ name: rc.wmjName, id: r.id, login: r.login }); }
      if (rc.code) { const ent = window.TJA_STORE.get(r.id); if (ent && ent.code !== rc.code) window.TJA_STORE.update(r.id, { code: rc.code }); }
      if (window.CLIENT_LOGOS) {
        const ent = window.TJA_STORE.get(r.id), url = window.CLIENT_LOGOS.logoUrlFor(rc.wmjName);
        const isAuto = ent && (!ent.logo || /icon\.horse|duckduckgo\.com|s2\/favicons/.test(ent.logo));
        if (ent && url && isAuto && ent.logo !== url) window.TJA_STORE.update(r.id, { logo: url });
      }
      const ls = await loadStateSafe(r.id); if (!ls.ok) continue;
      const state = ls.state;
      applyRetainer(state, rc);
      saveState(r.id, state);
      if (!r.created) updated++;
    }
    return { clients: data.length, created, updated, createdClients };
  }

  /* ---------- PR COVERAGE (per-client Google Sheet → retainer.prCoverage) ---------- */
  // Team-maintained, one workbook per client (registry in client-pr-sheets.js). Read-only mirror.
  async function syncPR() {
    const reg = window.CLIENT_PR_SHEETS; if (!reg) return { clients: 0 };
    let done = 0;
    for (const id of Object.keys(reg.SHEETS)) {
      const cfg = reg.forClient(id); if (!cfg) continue;
      let text;
      try { const res = await fetch(reg.csvUrl(cfg), { cache: "no-store" }); if (!res.ok) throw new Error("PR fetch " + res.status); text = await res.text(); }
      catch (e) { console.warn("PR sync", id, e); continue; }
      const ls = await loadStateSafe(id); if (!ls.ok) continue;
      const state = ls.state;
      const e = state.engagements && state.engagements.retainer;
      if (!e) continue;                                  // PR lives on the Monthly Services engagement
      e.prCoverage = reg.parseHits(text);
      e.prSource = "sheet";
      e.prHits = reg.hitCount(text, e.prCoverage.length);
      saveState(id, state);
      done++;
    }
    return { clients: done };
  }

  /* ---------- RETAINER VALUE (SOW $ ÷ rate → advisory monthly-hours target) ----------
     Read-only Apps Script feed off the revenue-forecasting workbook. This ONLY sets
     retainer.retainerValueTarget (a reference number shown to the admin) — it never
     writes serviceDisciplines or burn.contractedHours, since the feed has no per-
     discipline breakdown and guessing one could show a client a fabricated split. */
  async function syncRetainerValue() {
    if (!window.WMJ_RETAINER_VALUE) return { clients: 0 };
    let done = 0;
    let byClient;
    try { byClient = await window.WMJ_RETAINER_VALUE.forRoster(window.TJA_STORE.list()); }
    catch (e) { console.warn("retainer-value sync", e); return { clients: 0 }; }
    for (const [id, entry] of byClient.entries()) {
      const ls = await loadStateSafe(id); if (!ls.ok) continue;
      const state = ls.state;
      const e = state.engagements && state.engagements.retainer;
      if (!e) continue;
      e.retainerValueTarget = entry.hrs;         // hrs/mo, or null if no signed $ figure yet
      e.retainerValueMonthly = !!entry.monthly;  // true = exact current-month $ ÷ rate; false = annual avg (÷12)
      e.retainerValueHasPending = entry.hasPending;
      saveState(id, state);
      done++;
    }
    return { clients: done };
  }

  // Derive each client's ACCOUNT MANAGER from WMJ and stamp it on the store entry.
  // Signal: the "Client Services" person with the most hours on the account (retainers
  // sheet has User_Department; projects sheet's account/client-services rows back it up).
  // Never creates clients — only annotates existing ones (match by normName).
  async function syncAccountManagers() {
    try {
      const [pc, rc] = await Promise.all([
        fetch(CSV_URL, { cache: "no-store" }).then(r => r.ok ? r.text() : "").catch(() => ""),
        fetch(RET_CSV_URL, { cache: "no-store" }).then(r => r.ok ? r.text() : "").catch(() => ""),
      ]);
      if (!T()) return { clients: 0 };
      const tally = {};   // normClient -> { userName: hours }
      const add = (client, user, hrs) => {
        if (!client || !user) return;
        const k = normName(client); (tally[k] || (tally[k] = {}));
        tally[k][user] = (tally[k][user] || 0) + (parseFloat(hrs) || 1);
      };
      // retainers: department = "Client Services"
      T().parseCSV(rc).forEach(r => {
        if (String(r.User_Department || "").toLowerCase().indexOf("client service") > -1)
          add((r.Client_Name || "").trim(), (r.User_Name || "").trim(), r.Actual_Hours_Worked);
      });
      // projects: account / client-services rows (no department column there)
      T().parseCSV(pc).forEach(r => {
        const svc = (r.Service || "").toLowerCase(), pn = (r.Project_Name || "").toLowerCase();
        if (svc.indexOf("client service") > -1 || pn.indexOf("account") > -1 || pn.indexOf("client service") > -1)
          add((r.Client_Name || "").trim(), (r.User_Full_Name || "").trim(), r.Allocated_Hours);
      });
      // pick the top person per client, stamp onto the matching store entry
      const roster = (window.TJA_STORE && window.TJA_STORE.list && window.TJA_STORE.list()) || [];
      const byNorm = {}; roster.forEach(c => { byNorm[normName(c.name)] = c; byNorm[normName(c.wmjName || "")] = byNorm[normName(c.wmjName || "")] || c; });
      let n = 0;
      Object.keys(tally).forEach(k => {
        const ent = byNorm[k]; if (!ent) return;
        const top = Object.keys(tally[k]).sort((a, b) => tally[k][b] - tally[k][a])[0];
        if (!top) return;
        const patch = {};
        if (ent.accountManager !== top) patch.accountManager = top;   // the WMJ suggestion
        // Seed the manual `managers` tags ONCE from the suggestion so the filter has data
        // out of the box. Never touch it again — the tags are admin-owned truth after that
        // (WMJ can't tell an account manager from a project manager).
        if (!Array.isArray(ent.managers)) patch.managers = [top];
        if (Object.keys(patch).length) { window.TJA_STORE.update(ent.id, patch); n++; }
      });
      return { clients: n };
    } catch (e) { console.warn("account-manager sync", e); return { clients: 0 }; }
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
        .then(() => syncPR())
        .catch(err => { console.warn("PR sync", err); })
        .then(() => syncRetainerValue())
        .catch(err => { console.warn("retainer-value sync", err); })
        .then(() => syncAccountManagers())
        .catch(err => { console.warn("account-manager sync", err); })
        // the AM/PM assignment sheet runs LAST so its manager tags win over the
        // WMJ-derived seed for any client it names (it's the team-owned truth)
        .then(() => (window.MGR_SHEET ? window.MGR_SHEET.sync() : null))
        .catch(err => { console.warn("mgr-sheet sync", err); })
        .then(() => {
          try { localStorage.setItem(LAST_KEY, new Date().toISOString()); } catch (e) {}
          if (onDone) { try { onDone(window.__wmjProjResult || null); } catch (e) {} }
        });
    run();
    if (!timer) timer = setInterval(run, HOUR);
  }

  return { sync, syncRetainers, syncPR, syncRetainerValue, syncAccountManagers, fetchCSV, lastSync, startAuto, CSV_URL, RET_CSV_URL };
})();
