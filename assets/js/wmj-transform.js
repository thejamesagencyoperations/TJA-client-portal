/* ============================================================
   WMJ TRANSFORM  (pure, no side effects — Node-testable)
   Turns the Workamajig project export (CSV) into per-client
   PROJECT structures the portal can render.

   Sheet columns:
     Client_Name, Campaign_Name, Project_Name, Task_Full_Name,
     Allocated_Hours, Plan_Start_Date, Plan_Completion_Date,
     Project_Status, Service

   Hierarchy used:
     Client → Campaign (= a Project / SOW) → Project_Name (= phase)
            → Task_Full_Name (= task, with hours/dates/status/Service)

   Exposed as window.WMJ_TRANSFORM (browser) and module.exports (Node).
   ============================================================ */
(function (root) {
  "use strict";

  /* ---------- CSV parse (handles quotes, commas, CRLF) ---------- */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", i = 0, q = false;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else {
        if (c === '"') q = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else if (c === "\r") { /* ignore */ }
        else field += c;
      }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    // Normalize headers to underscore form — the WMJ export's header row flipped from
    // "Client_Name" to "Client Name" on 2026-07-17, which made every field read as
    // undefined and emptied the sync's output. Accept both spellings forever.
    const head = rows[0].map(h => h.trim().replace(/\s+/g, "_"));
    return rows.slice(1).filter(r => r.length && r.some(c => c.trim() !== ""))
      .map(r => { const o = {}; head.forEach((h, j) => o[h] = (r[j] || "").trim()); return o; });
  }

  /* ---------- helpers ---------- */
  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function num(s) { const v = parseFloat(s); return isFinite(v) ? v : 0; }

  /* ================================================================
     PROJECT RULES — the ONE place to tune what clients see across ALL
     current + future projects. Add new patterns to the right list:
       • DROP_ROW      — rows removed entirely (internal / non-billable)
       • INTERNAL_TASK — tasks hidden from clients (greyed for admins)
       • EXCLUDE_PHASE — labels that must NEVER be a pizza-tracker phase
                         (oversight / management / comms are not milestones)
     ================================================================ */
  const RULES = {
    DROP_ROW: r => {
      const cm = (r.Campaign_Name || "").toLowerCase(), cl = (r.Client_Name || "").toLowerCase(), pn = (r.Project_Name || "").toLowerCase();
      // junk guard: malformed sheet rows leak note text into Client_Name (e.g.
      // "10am-3:45pm (removed an hour for that lunch slot 12-1)") and would
      // auto-create a garbage client. No real client name contains a clock time.
      if (/\b\d{1,2}(:\d{2})?\s*(a|p)m\b/i.test(r.Client_Name || "")) return true;
      return !cm || !cl || cm.indexOf("non-billable") > -1 || pn.indexOf("non-billable") > -1 || cl.indexOf("the james agency") > -1;
    },
    INTERNAL_TASK: /(internal\b|internal revision|mech\b|mech\s*\/?\s*(check|mech)|admin time|huddle|collab time|final eyes|account management|project management|strategic oversight|account supervis|internal planning|internal meeting|internal kickoff|internal stakeholder|monday morning|1:1|q[1-4] quarterly|camp james|proofing|\bproof\b|kickoff question|non-billable|account ramp|account health|client communications)/i,
    EXCLUDE_PHASE: /(oversight|client communications|account leadership|account (management|supervis)|project management|ongoing client services|status meeting)/i,
  };
  function isNonBillable(r) { return RULES.DROP_ROW(r); }
  function isInternalTask(name) { return RULES.INTERNAL_TASK.test(name || ""); }
  function isExcludedPhase(label) { return RULES.EXCLUDE_PHASE.test(label || ""); }

  const NUM_PREFIX = /^[\d]+(\.[\d]+)*\s+/;        // "4.3 Key Page…" → strip "4.3 "
  function cleanTaskName(s) { return String(s || "").replace(NUM_PREFIX, "").trim(); }
  function taskOrder(s) {                          // numeric prefix → sortable
    const m = String(s || "").match(/^([\d]+(?:\.[\d]+)*)/);
    if (!m) return [9999];
    return m[1].split(".").map(x => parseInt(x, 10));
  }
  function cmpOrder(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

  // campaign label: drop the "(123.4)" contracted-hours suffix
  function campaignLabel(cm) { return String(cm || "").replace(/\s*\(\s*[\d.]+\s*\)\s*$/, "").trim(); }
  function contractedHours(cm) { const m = String(cm || "").match(/\(\s*([\d.]+)\s*\)\s*$/); return m ? parseFloat(m[1]) : null; }

  /* ---------- dates (M/D/YYYY) ---------- */
  function parseDate(s) {
    const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return { y: +m[3], mo: +m[1], d: +m[2], key: (+m[3]) * 10000 + (+m[1]) * 100 + (+m[2]) };
  }
  const MONS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function fmtDate(d) { return d ? `${MONS[d.mo]} ${d.d}, ${d.y}` : ""; }

  /* ---------- status rollup ---------- */
  // precedence for an "active" rollup: Production > On Hold > Completed
  function rollupStatus(statuses) {
    if (statuses.some(s => s === "Production")) return "Production";
    if (statuses.some(s => s === "On Hold")) return "On Hold";
    if (statuses.length && statuses.every(s => s === "Completed")) return "Completed";
    return statuses[0] || "Production";
  }

  /* ---------- main transform ---------- */
  function transform(rows) {
    const bill = rows.filter(r => !isNonBillable(r));

    // group: client → campaign → project_name → tasks(aggregated by clean name)
    const clients = new Map();
    bill.forEach(r => {
      const cl = r.Client_Name.trim();
      const key = normName(cl);
      if (!clients.has(key)) clients.set(key, { wmjName: cl, normName: key, code: "", _camps: new Map() });
      const C = clients.get(key);
      const cm = r.Campaign_Name.trim();
      if (!C.code) C.code = cm.split(/\s+/)[0] || "";   // client code = leading token of Campaign_Name
      if (!C._camps.has(cm)) C._camps.set(cm, new Map());
      const P = C._camps.get(cm);
      const pn = r.Project_Name.trim() || "General";
      if (!P.has(pn)) P.set(pn, new Map());
      const T = P.get(pn);
      const tname = cleanTaskName(r.Task_Full_Name) || r.Task_Full_Name.trim() || "Task";
      if (!T.has(tname)) T.set(tname, { name: tname, raw: r.Task_Full_Name.trim(), hours: 0, statuses: [], services: new Set(), start: null, end: null, internal: isInternalTask(r.Task_Full_Name) });
      const t = T.get(tname);
      t.hours += num(r.Allocated_Hours);
      t.statuses.push(r.Project_Status);
      if (r.Service) t.services.add(r.Service);
      const ps = parseDate(r.Plan_Start_Date), pe = parseDate(r.Plan_Completion_Date);
      if (ps && (!t.start || ps.key < t.start.key)) t.start = ps;
      if (pe && (!t.end || pe.key > t.end.key)) t.end = pe;
    });

    // build output
    const out = [];
    clients.forEach(C => {
      const projects = [];
      C._camps.forEach((P, cm) => {
        // A campaign whose name says "retainer" is Monthly-Services work, not a project — its
        // hours flow to the retainer/burn via the retainer sheet, so don't spin up a project
        // folder for it (Cameron 2026-07-22, e.g. AHS "Web Maintenance Retainer").
        if (/retainer/i.test(cm)) return;
        // phases = project_names; tasks under each
        const phases = [];
        const tasks = [];
        let allTaskStatuses = [];
        let firstStart = null, lastEnd = null;
        P.forEach((T, pn) => {
          const ptasks = [...T.values()].sort((a, b) => cmpOrder(taskOrder(a.raw), taskOrder(b.raw)));
          const phaseStatuses = [];
          ptasks.forEach(t => {
            const st = rollupStatus(t.statuses);
            phaseStatuses.push(st); allTaskStatuses.push(st);
            if (t.start && (!firstStart || t.start.key < firstStart.key)) firstStart = t.start;
            if (t.end && (!lastEnd || t.end.key > lastEnd.key)) lastEnd = t.end;
            tasks.push({
              name: t.name, raw: t.raw, phase: pn,
              hours: Math.round(t.hours * 100) / 100,
              service: [...t.services][0] || "",
              status: st, internal: t.internal,
              start: fmtDate(t.start), end: fmtDate(t.end), endKey: t.end ? t.end.key : 0,
            });
          });
          const pst = rollupStatus(phaseStatuses);
          phases.push({ label: pn, status: pst, done: phaseStatuses.length > 0 && phaseStatuses.every(s => s === "Completed"),
            _startKey: ptasks.reduce((m, t) => Math.min(m, t.start ? t.start.key : Infinity), Infinity) });
        });
        phases.sort((a, b) => a._startKey - b._startKey).forEach(p => delete p._startKey);

        // Single-workstream campaigns (e.g. website builds) put ALL work under one
        // Project_Name → the tracker would show a single useless dot. Derive phases
        // from the tasks' top-level numbering (1, 2, 3 … = the real sequence).
        let displayPhases = phases;
        if (phases.length <= 1) {
          const byNum = new Map();
          tasks.filter(t => !t.internal).forEach(t => {
            const top = taskOrder(t.raw)[0];
            if (!isFinite(top) || top >= 9999) return;
            if (!byNum.has(top)) byNum.set(top, []);
            byNum.get(top).push(t);
          });
          if (byNum.size >= 2) {
            displayPhases = [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(([top, ts]) => {
              const bare = ts.find(t => taskOrder(t.raw).length === 1);   // the plain "N …" task
              return { label: (bare || ts[0]).name, done: ts.every(t => t.status === "Completed"), status: rollupStatus(ts.map(t => t.status)) };
            });
          }
        }
        // RULES.EXCLUDE_PHASE — oversight / management / comms are never pizza phases
        displayPhases = displayPhases.filter(p => !isExcludedPhase(p.label));

        const clientTasks = tasks.filter(t => !t.internal);
        const allocated = Math.round(tasks.reduce((s, t) => s + t.hours, 0) * 100) / 100;
        const contracted = contractedHours(cm);
        const doneCount = displayPhases.filter(p => p.done).length;
        const progressPct = displayPhases.length ? Math.round(doneCount / displayPhases.length * 100) : 0;
        const status = rollupStatus(allTaskStatuses);

        projects.push({
          id: "wmj_" + normName(cm),
          source: "wmj",
          campaign: cm,
          label: campaignLabel(cm),
          name: C.wmjName + " — " + campaignLabel(cm),
          status,
          contractedHours: contracted,
          allocatedHours: allocated,
          dueDate: fmtDate(lastEnd),
          startDate: fmtDate(firstStart),
          progressPct,
          phases: displayPhases,
          tasks: tasks,                 // includes internal (UI hides for clients)
          taskCount: tasks.length,
          clientTaskCount: clientTasks.length,
        });
      });
      // most recently-active projects first (by latest task end date)
      projects.sort((a, b) => {
        const ae = Math.max(0, ...a.tasks.map(t => t.endKey || 0)), be = Math.max(0, ...b.tasks.map(t => t.endKey || 0));
        return be - ae;
      });
      out.push({ wmjName: C.wmjName, normName: C.normName, code: C.code || "", projects });
    });

    out.sort((a, b) => a.wmjName.localeCompare(b.wmjName));
    return out;
  }

  const api = { parseCSV, transform, normName, campaignLabel, contractedHours, isInternalTask, cleanTaskName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WMJ_TRANSFORM = api;
})(typeof window !== "undefined" ? window : globalThis);
