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
  /* ---- WHERE WMJ DATA COMES FROM (browser side) ----------------------------------
     PREFERRED: the wmj-report Edge Function, which calls the Workamajig Report Endpoint
     with server-held tokens. FALLBACK: the published Google Sheets above.

     Why this changed (2026-08-26): the sheets are fed by an =IMPORTDATA(...linkKey=...)
     formula whose linkKey EXPIRES, and they also mangle rows whose Comments contain a
     comma — measured, A New Leaf read 98.8h from the sheet against 100.1h from the API
     because a column-shifted row lost 1.25 billable hours. snapshot-months had already
     moved to the API, so the browser reading the sheet meant TWO writers disagreeing about
     the same numbers, with whoever ran last winning.

     The fallback is kept deliberately, and ONLY for "the proxy isn't available" (it is not
     deployed, or the browser has no session) — never for a proxy that answered and said the
     feed is broken. A 502 means the guard caught #N/A or a JSON error envelope, and quietly
     reading the sheet instead would restore exactly the silent-wrong-data behaviour this
     work exists to remove, so that case throws. */
  /* WHICH FEEDS ARE ON THE DIRECT API YET.
     retainer: YES — verified client-by-client against the sheet (21 clients, 20 totals
       identical, the one difference being a sheet row the API gets RIGHT), and running in
       production via snapshot-months.
     projects: NOT YET. Switching it on 2026-08-27 broke the manual sync with
       "Cannot read properties of undefined (reading 'trim')": the projects report returns
       at least one column under a different name than the sheet does (the retainer report,
       for instance, calls it Task_Name where the sheet says "Task Full Name"), and
       wmj-transform reads r.Task_Full_Name / r.Client_Name unguarded.
     Flipped back to the sheet rather than guessed at, because this portal is live for
     clients and the projects feed drives every project page. Flip to true once the report's
     real header has been read and wmj-transform maps it. */
  const PROXY_REPORTS = { retainer: true, projects: true };

  /* The projects report must carry every column the transform reads. The FIRST reportKey
     supplied for this feed was the timesheet report, which is missing five of them and broke
     every project page — so the response is checked rather than the key trusted.

     A shortfall THROWS; it does not fall back to the sheet. Verified 2026-08-27 against the
     live feeds: identical column sets, and all 38 clients the sheet contains produce
     identical projects and hours through the API (which additionally carries 4 clients the
     sheet had gone stale on). With the API confirmed correct, a quiet drop back to the sheet
     would only hide a regression behind the very feed this work exists to retire — the same
     reasoning already applied to the retainer. */
  const PROJECT_COLS = ["Client_Name", "Campaign_Name", "Project_Name", "Task_Full_Name",
    "Allocated_Hours", "Project_Status", "Plan_Start_Date", "Plan_Completion_Date", "Service"];
  function missingProjectCols(csv) {
    const head = (csv.split(/\r?\n/)[0] || "");
    // headers arrive space-separated from the sheet and underscore-separated from the API
    return PROJECT_COLS.filter((c) => !new RegExp(c.replace(/_/g, "[ _]"), "i").test(head));
  }

  /* ONE FETCH PER REPORT PER RUN.
     A sync run asks for each report TWICE — once for its own step, once more for the
     account-manager derivation. That was nearly free when both were published-CSV reads;
     since the move to the API each is a real WMJ round-trip (~0.8MB retainer, ~1.7MB
     projects), so the run was pulling ~5MB and doing four API calls to get two reports.
     The in-flight promise is reused for the duration of a run, which halves both. Cleared
     by startAuto at the start of every run, so a sync never serves the previous run's data. */
  let csvRun = {};
  function resetCsvCache() { csvRun = {}; }

  async function wmjCsv(report, sheetUrl) {
    if (csvRun[report]) return csvRun[report];
    const p = wmjCsvUncached(report, sheetUrl);
    csvRun[report] = p;
    // a failed fetch must not be cached as the answer for the rest of the run
    p.catch(() => { if (csvRun[report] === p) delete csvRun[report]; });
    return p;
  }

  async function wmjCsvUncached(report, sheetUrl) {
    const sheet = async () => {
      const legacy = await fetch(sheetUrl, { cache: "no-store" });
      if (!legacy.ok) throw new Error("WMJ sheet fetch failed: " + legacy.status);
      return legacy.text();
    };
    if (!PROXY_REPORTS[report]) return sheet();
    try {
      const cfg = window.SUPABASE_CONFIG || {};
      const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
      if (base && window.SUPA && window.SUPA.enabled && window.SUPA.client) {
        const { data } = await window.SUPA.client.auth.getSession();
        const token = data && data.session ? data.session.access_token : null;
        if (token) {
          const r = await fetch(base + "/wmj-report", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
            body: JSON.stringify({ report }),
          });
          if (r.ok) {
            const csv = await r.text();
            if (report === "projects") {
              const miss = missingProjectCols(csv);
              if (miss.length) throw new Error("wmj-report (projects): report is missing ["
                + miss.join(", ") + "] — WMJ_PROJECTS_REPORTKEY is pointing at the wrong report.");
            }
            return csv;
          }
          // 503 = not configured yet → fall through to the sheet. Anything else is the feed
          // actually being broken, and must be loud.
          if (r.status !== 503) {
            const j = await r.json().catch(() => ({}));
            throw new Error("wmj-report (" + report + "): " + (j.error || ("HTTP " + r.status)));
          }
          console.warn("wmj-report not configured; using the legacy sheet for " + report);
        }
      }
    } catch (e) {
      if (String(e && e.message).indexOf("wmj-report (") === 0) throw e;   // a real feed failure
      console.warn("wmj-report unreachable; using the legacy sheet for " + report, e);
    }
    return sheet();
  }

  /* WHY FAILURES ARE RECORDED, NOT JUST LOGGED (2026-08-27)
     Every step below used to end in `.catch(err => console.warn(...))`, and the chain then
     stamped LAST_KEY regardless — so a sync where every step failed looked exactly like a
     sync that worked, and the only evidence was a console nobody has open. Cameron hit this
     precisely: a failed run showed a stale "Projects synced <yesterday>" and said nothing.
     Errors now survive the run so the UI can show them. */
  let lastErrors = [];
  function syncErrors() { return lastErrors.slice(); }
  const noteErr = (where, err) => {
    const msg = (err && err.message) ? err.message : String(err);
    lastErrors.push(where + ": " + msg);
    console.warn("WMJ " + where, err);
  };

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
    return wmjCsv("projects", CSV_URL);
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
    return wmjCsv("retainer", RET_CSV_URL);
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
    // round to 2dp so this writer and the server snapshot store identical values
    const used = Math.round((+e.burn.usedHours || 0) * 100) / 100;
    const total = Math.round((+e.burn.contractedHours || 0) * 100) / 100;
    const lines = snapshotLines(e);
    // Match the current month's entry by (month, year) ANYWHERE in the array — not just
    // the last entry — so a boundary race with the server snapshot (which may append the
    // new month while this tab is still in the old one, or vice versa) updates in place
    // instead of pushing a duplicate. A legacy no-year entry is only adopted when it's
    // the LAST entry (an old same-name month must never be mistaken for this one).
    // KEEP IN SYNC with snapshot-months/index.ts and exec-summary.js syncCurrentMonth.
    let idx = e.mom.findIndex(m => m && m.month === short && m.year === yr);
    if (idx < 0) {
      const last = e.mom[e.mom.length - 1];
      if (last && last.month === short && last.year == null) idx = e.mom.length - 1;
    }
    if (idx >= 0) {
      const m = e.mom[idx];
      m.year = yr; m.usedHours = used; m.contractedHours = total; m.lines = lines;
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
      // Same source as the syncs above — reading the sheet here would put the account-manager
      // derivation back on the feed everything else just moved off. Soft-failing (→ "") is
      // deliberate and pre-existing: this only annotates, so no data is written on failure.
      const [pc, rc] = await Promise.all([
        wmjCsv("projects", CSV_URL).catch(() => ""),
        wmjCsv("retainer", RET_CSV_URL).catch(() => ""),
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
    // The audit trail is for HUMAN edits. A sync run rewrites many clients' dashboards in one
    // burst, which would bury the history in machine noise — so mute per-write auditing for the
    // duration and log ONE summary row at the end instead.
    const muteAudit = (on) => { try { if (window.SUPA && window.SUPA.setAuditMuted) window.SUPA.setAuditMuted(on); } catch (e) {} };
    const run = () =>
      Promise.resolve(muteAudit(true))
        .then(() => { lastErrors = []; resetCsvCache(); })
        .then(() => sync())
        .then(pv => { window.__wmjProjResult = pv; })
        .catch(err => { noteErr("projects sync", err); })
        .then(() => syncRetainers())
        .catch(err => { noteErr("retainers sync", err); })
        .then(() => syncPR())
        .catch(err => { noteErr("PR sync", err); })
        .then(() => syncRetainerValue())
        .catch(err => { noteErr("retainer-value sync", err); })
        .then(() => syncAccountManagers())
        .catch(err => { noteErr("account-manager sync", err); })
        // the AM/PM assignment sheet runs LAST so its manager tags win over the
        // WMJ-derived seed for any client it names (it's the team-owned truth)
        .then(() => (window.MGR_SHEET ? window.MGR_SHEET.sync() : null))
        .catch(err => { noteErr("mgr-sheet sync", err); })
        .then(() => {
          // Only stamp "synced at" when the run actually brought data in. Stamping after a
          // total failure is what made a broken sync indistinguishable from a working one.
          if (!lastErrors.length) { try { localStorage.setItem(LAST_KEY, new Date().toISOString()); } catch (e) {} }
          muteAudit(false);
          // one line on the record that the machine sync ran (not 50 per-client diffs)
          try {
            const n = (window.__wmjProjResult && window.__wmjProjResult.clients) || 0;
            if (window.SUPA && window.SUPA.auditEvent)
              window.SUPA.auditEvent("_registry", "wmj.sync", "Workamajig sync ran" + (n ? ` — ${n} client${n === 1 ? "" : "s"} updated` : ""));
          } catch (e) {}
          if (onDone) { try { onDone(window.__wmjProjResult || null); } catch (e) {} }
        })
        .catch(err => { muteAudit(false); noteErr("sync chain", err); if (onDone) { try { onDone(null); } catch (e) {} } });
    run();
    if (!timer) timer = setInterval(run, HOUR);
  }

  return { sync, syncRetainers, syncPR, syncRetainerValue, syncAccountManagers, fetchCSV, lastSync, syncErrors, startAuto, CSV_URL, RET_CSV_URL };
})();
