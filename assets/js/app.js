/* ============================================================
   TJA CLIENT PORTAL — app shell (V1, v1.7)
   - Engagement model (retainer / project) with a top toggle
   - Editable STATE persisted to localStorage (admin edits)
   - Role-aware UI (admin edit / client read-only + preview)
   - Tab renderers: Project Plan, Status, Backlog, Files
   - Executive Summary lives in exec-summary.js
   ============================================================ */

const D = window.CLIENT_DATA;
const el = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));

const STATUS = {
  complete: "Complete", "in-progress": "In Progress", "not-started": "Not Started",
  pending: "Pending", "on-hold": "On Hold", blocked: "Blocked",
};
const STATUS_CLASS = { complete: "complete", "in-progress": "in-progress", "not-started": "pending", pending: "pending", "on-hold": "on-hold", blocked: "blocked" };
const badge = (k) => `<span class="badge ${STATUS_CLASS[k] || "pending"}">${esc(STATUS[k] || k)}</span>`;

/* ---------- editable state ---------- */
const clientId = () => ((typeof getSession === "function" && getSession() && getSession().client) || "demo");
const STATE_KEY = "tja_dashboard_" + clientId();
function clone(o) { return JSON.parse(JSON.stringify(o)); }
// migrate older saved data forward (e.g. pre-v1.11 single `project` → `projects[]`)
function migrate(s) {
  const e = s.engagements || (s.engagements = {});
  if (!Array.isArray(e.projects)) {
    if (e.project) { e.project.id = e.project.id || "p_web"; e.project.label = e.project.label || "Project"; e.projects = [e.project]; delete e.project; }
    else e.projects = clone(D.engagements.projects);
  }
  if (!e.retainer) e.retainer = clone(D.engagements.retainer);
  return s;
}
function loadState() {
  try { const s = JSON.parse(localStorage.getItem(STATE_KEY)); if (s && s.engagements) return migrate(s); } catch {}
  return { engagements: clone(D.engagements) };
}
let STATE = loadState();

/* ---- undo stack (admin) — every state edit funnels through saveState ---- */
let undoStack = [];
let lastSnapshot = clone(STATE);
function persistState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch (e) { console.warn("state storage full", e); }
  if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(clientId(), "dashboard", STATE);
}
function saveState() {
  undoStack.push(lastSnapshot);
  if (undoStack.length > 80) undoStack.shift();
  lastSnapshot = clone(STATE);
  persistState();
  updateUndoBtn();
}
function undo() {
  if (!undoStack.length) return;
  STATE = undoStack.pop();
  lastSnapshot = clone(STATE);
  persistState();
  applyEngagement();
  repaintAll();
  updateUndoBtn();
}
function updateUndoBtn() {
  const b = el("#undoBtn"); if (!b) return;
  b.disabled = undoStack.length === 0;
  b.textContent = undoStack.length ? `↶ Undo (${undoStack.length})` : "↶ Undo";
}

// Engagement context = a MODE (retainer | project) + which project is open.
let engMode = sessionStorage.getItem("tja_eng_mode");
let selectedProjectId = sessionStorage.getItem("tja_proj") || "";
if (!engMode) {                                   // migrate older "tja_eng" key (retainer | project:<id>)
  const old = sessionStorage.getItem("tja_eng") || "retainer";
  if (old.indexOf("project:") === 0) { engMode = "project"; selectedProjectId = old.slice(8); }
  else engMode = "retainer";
}
function getProjects() { return STATE.engagements.projects || []; }
function isRetainer() { return engMode === "retainer"; }
function selectedProject() { return getProjects().find(p => p.id === selectedProjectId) || null; }
function setEngMode(m) { engMode = m; sessionStorage.setItem("tja_eng_mode", m); }
function selectProject(id) { selectedProjectId = id || ""; sessionStorage.setItem("tja_proj", selectedProjectId); }
function getEng() {
  if (isRetainer() && STATE.engagements.retainer) return STATE.engagements.retainer;
  return selectedProject() || getProjects()[0] || STATE.engagements.retainer;
}
function newProjectTemplate(id) {
  return {
    id, type: "project", label: "New Project", name: "New Project — rename me",
    northStar: "", dueDate: "",
    pizza: { phases: [{ label: "Discovery", done: false }, { label: "Strategy", done: false }, { label: "Design", done: false }, { label: "Build", done: false }, { label: "Launch", done: false }] },
    condition: { level: "green", note: "" },
    serviceLines: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
    status: { groups: [] },
    projectPlan: {
      outcome: "", startDate: "", endDate: "",
      status: { level: "green", pct: 0, note: "" },
      criticalPath: [],
      phases: [
        { name: "1 Discovery", tasks: [] }, { name: "2 Strategy", tasks: [] },
        { name: "3 Design", tasks: [] }, { name: "4 Build", tasks: [] }, { name: "5 Launch", tasks: [] },
      ],
      risks: [],
    },
  };
}

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
  const keys = path.split("."); const last = keys.pop();
  const tgt = keys.reduce((o, k) => (o[k] = o[k] ?? {}), obj);
  tgt[last] = val;
}

// shared with exec-summary.js
window.DASH = { get D() { return D; }, get state() { return STATE; }, getEng, saveState, getPath, setPath, esc, badge, STATUS, STATUS_CLASS,
  // "← All projects" link, shown on a project's homepage when several projects exist (handled in exec-summary render so it survives rerender)
  projectBack: () => (!isRetainer() && getProjects().length > 1 && selectedProject()) ? `<button class="pp-back" data-allprojects>← All projects</button>` : "" };

/* ---------- Project Plan (multi-project folders + editable) ---------- */
const rygDot = (lvl) => `<span class="ryg-dot ${lvl}"></span>`;
const sicon = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;vertical-align:-2px;margin-right:6px;color:var(--accent-text)">${p}</svg>`;
const PP_IC = {
  flag: sicon('<path d="M5 21V4M5 4h11l-2 3.5L16 11H5"/>'),
  list: sicon('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  risk: sicon('<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 17h.01"/>'),
};
const ppAdmin = () => (typeof canEdit === "function" ? canEdit() : true);
function ppEd(val, path, opts = {}) {
  if (!ppAdmin()) return esc(val);
  return `<span class="ed" contenteditable="true" data-pp="${esc(path)}"${opts.num ? ' data-num="1"' : ""}${opts.rerender ? ' data-rerender="1"' : ""}>${esc(val)}</span>`;
}
function rygCell(path, lvl) {
  return `<span class="ryg-dot ${lvl} ${ppAdmin() ? "admin-edit" : ""}" ${ppAdmin() ? `data-ppryg="${esc(path)}" title="Cycle R/Y/G"` : ""}></span>`;
}
function taskStatusCell(status, path) {
  return ppAdmin() ? `<span class="svc-status admin-edit" data-ppstatus="${esc(path)}" title="Cycle status">${badge(status)}</span>` : badge(status);
}
const ppDel = (key) => `<button class="row-del" data-ppdel="${key}" title="Remove">✕</button>`;

function projectPct(p) {
  if (p.source === "wmj") {                                  // WMJ projects: trust the synced progress
    if (typeof p.progressPct === "number") return p.progressPct;
    const wph = (p.pizza && p.pizza.phases) || [];
    if (wph.length) return Math.round(wph.filter(x => x.done).length / wph.length * 100);
  }
  const pp = p.projectPlan || {};
  if (pp.status && pp.status.pct !== "" && pp.status.pct != null) return +pp.status.pct || 0;
  const tasks = (pp.phases || []).flatMap(ph => ph.tasks || []);
  if (tasks.length) return Math.round(tasks.reduce((s, t) => s + (+t.pct || 0), 0) / tasks.length);
  const ph = (p.pizza && p.pizza.phases) || [];
  if (ph.length) return Math.round(ph.filter(x => x.done).length / ph.length * 100);
  return 0;
}
// "completed" = WMJ says Completed, or 100% progress
function isProjComplete(p) { return (p.source === "wmj" && p.wmjStatus === "Completed") || projectPct(p) >= 100; }
let pendingDeleteId = null;   // project id awaiting delete-confirm (two-step, prevents accidental delete)
// Projects landing — a folder of project tiles (Projects is a top-mode, not a left-nav tab).
function renderProjectFolder() {
  const admin = ppAdmin();
  const projects = getProjects();
  const tiles = projects.map(p => {
    if (pendingDeleteId === p.id) {
      return `<div class="proj-tile proj-tile-confirm">
          <div class="ptc-q">Delete “${esc(p.label || p.name)}”?</div>
          <div class="ptc-sub">This removes the project and its data.</div>
          <div class="ptc-actions">
            <button class="ptc-del" data-ppdelconfirm="${esc(p.id)}">Delete project</button>
            <button class="ptc-cancel" data-ppdelcancel>Cancel</button>
          </div>
        </div>`;
    }
    const lvl = (p.projectPlan && p.projectPlan.status && p.projectPlan.status.level) || (p.condition && p.condition.level) || "green";
    const pct = projectPct(p);
    return `<div class="proj-tile" data-ppopen="${esc(p.id)}">
        <div class="proj-tile-top"><span class="ryg-dot ${lvl}"></span><span class="proj-tile-name">${esc(p.label || p.name)}</span>${admin ? `<button class="proj-del" data-ppdel="${esc(p.id)}" title="Delete project">✕</button>` : ""}</div>
        <div class="proj-tile-sub">${esc(p.name)}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="proj-tile-foot">${pct}% complete</div>
      </div>`;
  }).join("");
  return `
  ${admin ? `<div class="admin-hint">✎ Admin — click a project to open it · ＋ adds a project · ✕ then confirm to delete</div>` : ""}
  <div class="page-head">
    <div class="page-title">Projects</div>
    <div class="page-desc">${projects.length ? `${projects.length} active project${projects.length === 1 ? "" : "s"} — choose one to open.` : "No projects yet — add your first one."}</div>
  </div>
  <div class="proj-grid">${tiles}${admin ? `<button class="proj-tile proj-tile-add" data-ppaddproject><span class="pta-plus">＋</span> New Project</button>` : ""}</div>`;
}
function renderProjectPicker(projects, admin) {
  const tiles = projects.map(p => {
    const lvl = (p.projectPlan && p.projectPlan.status && p.projectPlan.status.level) || (p.condition && p.condition.level) || "green";
    const pct = projectPct(p);
    return `<button class="proj-tile" data-ppopen="${esc(p.id)}">
        <div class="proj-tile-top"><span class="ryg-dot ${lvl}"></span><span class="proj-tile-name">${esc(p.label || p.name)}</span></div>
        <div class="proj-tile-sub">${esc(p.name)}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="proj-tile-foot">${pct}% complete</div>
      </button>`;
  }).join("");
  return `
  ${admin ? `<div class="admin-hint">✎ Admin — click a project to open it · ＋ adds a new project</div>` : ""}
  <div class="page-head">
    <div class="page-title">Projects</div>
    <div class="page-desc">${projects.length} active project${projects.length === 1 ? "" : "s"} — choose one to open.</div>
  </div>
  <div class="proj-grid">${tiles}${admin ? `<button class="proj-tile proj-tile-add" data-ppnewproject><span class="pta-plus">＋</span> New Project</button>` : ""}</div>`;
}
function renderProjectsEmpty(admin) {
  return `
  <div class="page-head"><div class="page-title">Projects</div><div class="page-desc">No projects yet.</div></div>
  <div class="proj-grid">${admin ? `<button class="proj-tile proj-tile-add" data-ppnewproject><span class="pta-plus">＋</span> New Project</button>` : `<div class="placeholder-note">No projects to show.</div>`}</div>`;
}
function renderProjectPlan() {
  const admin = ppAdmin();
  // The Projects tab only applies in Project mode.
  if (isRetainer()) return `<div class="page-head"><div class="page-title">Projects</div><div class="page-desc">Switch the top toggle to <b>Project</b> to view and manage projects.</div></div>`;
  const projects = getProjects();
  if (projects.length === 0) return renderProjectsEmpty(admin);
  if (projects.length === 1 && !selectedProject()) selectProject(projects[0].id);            // one project → open it directly
  if (projects.length > 1 && !selectedProject()) return renderProjectPicker(projects, admin); // several → show tiles
  const e = selectedProject(); const pp = e.projectPlan || {};
  const st = pp.status || { level: "green", pct: 0, note: "" };
  const stLabel = { green: "On Track", yellow: "Needs Attention", red: "Off Track" }[st.level] || "—";
  const back = projects.length > 1 ? `<button class="pp-back" data-ppback>← All projects</button>` : "";

  const allTasks = (pp.phases || []).flatMap(ph => ph.tasks);
  const avg = allTasks.length ? Math.round(allTasks.reduce((s, t) => s + (+t.pct || 0), 0) / allTasks.length) : null;

  const cp = (pp.criticalPath || []).map((m, i) => `<tr>
      <td style="text-align:center">${rygCell("projectPlan.criticalPath." + i + ".ryg", m.ryg)}</td>
      <td style="font-weight:600">${ppEd(m.item, "projectPlan.criticalPath." + i + ".item")}</td>
      <td style="color:var(--accent-text);font-weight:700;white-space:nowrap">${ppEd(m.owner, "projectPlan.criticalPath." + i + ".owner")}</td>
      <td style="white-space:nowrap">${ppEd(m.window, "projectPlan.criticalPath." + i + ".window")}</td>
      <td style="color:var(--text-dim)">${ppEd(m.why, "projectPlan.criticalPath." + i + ".why")}</td>
      <td style="color:var(--text-dim)">${ppEd(m.action, "projectPlan.criticalPath." + i + ".action")}</td>
      ${admin ? `<td>${ppDel("cp." + i)}</td>` : ""}
    </tr>`).join("");

  let tasks = "";
  (pp.phases || []).forEach((ph, pi) => {
    tasks += `<tr class="group-row"><td colspan="${admin ? 8 : 7}">${ppEd(ph.name, "projectPlan.phases." + pi + ".name")} ${admin ? ppDel("phase." + pi) : ""}</td></tr>`;
    ph.tasks.forEach((t, ti) => {
      const base = "projectPlan.phases." + pi + ".tasks." + ti;
      tasks += `<tr>
        <td style="color:var(--text-faint)">${ppEd(t.id, base + ".id")}</td>
        <td style="font-weight:600">${ppEd(t.task, base + ".task")}</td>
        <td style="color:var(--accent-text);font-weight:700;white-space:nowrap">${ppEd(t.who, base + ".who")}</td>
        <td style="white-space:nowrap">${ppEd(t.start, base + ".start")}–${ppEd(t.end, base + ".end")}</td>
        <td style="min-width:74px"><div class="bar"><span style="width:${t.pct}%"></span></div><div class="pct-lbl">${ppEd(t.pct, base + ".pct", { num: true, rerender: true })}%</div></td>
        <td>${taskStatusCell(t.status, base + ".status")}</td>
        <td style="color:var(--text-dim)">${ppEd(t.notes, base + ".notes")}</td>
        ${admin ? `<td>${ppDel("task." + pi + "." + ti)}</td>` : ""}
      </tr>`;
    });
    if (admin) tasks += `<tr><td colspan="8"><button class="row-add" data-ppaddtask="${pi}">＋ Add task</button></td></tr>`;
  });

  const risks = (pp.risks || []).map((r, i) => `<tr>
      <td style="text-align:center">${rygCell("projectPlan.risks." + i + ".ryg", r.ryg)}</td>
      <td style="font-weight:600">${ppEd(r.risk, "projectPlan.risks." + i + ".risk")}</td>
      <td>${ppEd(r.impact, "projectPlan.risks." + i + ".impact")}</td>
      <td style="color:var(--accent-text);font-weight:700;white-space:nowrap">${ppEd(r.owner, "projectPlan.risks." + i + ".owner")}</td>
      <td style="color:var(--text-dim)">${ppEd(r.mitigation, "projectPlan.risks." + i + ".mitigation")}</td>
      ${admin ? `<td>${ppDel("risk." + i)}</td>` : ""}
    </tr>`).join("");

  return `
  ${admin ? `<div class="admin-hint">✎ Admin — click R/Y/G dots &amp; status badges to cycle; every field is editable; ＋ adds rows.</div>` : ""}
  ${back}
  <div class="page-head">
    <div class="page-title">${ppEd(e.name, "name")}</div>
    <div class="page-desc">${pp.startDate || admin ? `${ppEd(pp.startDate || "", "projectPlan.startDate")} → ${ppEd(pp.endDate || "", "projectPlan.endDate")}` : ""}${admin ? ` · <button class="pp-del-project" data-ppdelproject="${esc(e.id)}">Delete project</button>` : ""}</div>
  </div>
  <div class="exec-grid" style="margin-bottom:18px">
    <div class="module"><div class="module-title">Outcome</div><div style="font-size:.95rem;margin-top:8px;line-height:1.5">${ppEd(pp.outcome || "", "projectPlan.outcome")}</div></div>
    <div class="module">
      <div class="module-title">Status${avg != null ? ` <span class="stat-sub" style="text-transform:none;letter-spacing:0">· tasks avg ${avg}%</span>` : ""}</div>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">${rygCell("projectPlan.status.level", st.level)}<span class="cond-label ${st.level}" style="font-size:1.05rem">${stLabel}</span><span class="stat-sub">${ppEd(st.pct, "projectPlan.status.pct", { num: true, rerender: true })}% complete</span></div>
      <div class="bar" style="margin-top:10px"><span style="width:${st.pct}%"></span></div>
      <div class="cond-note">${ppEd(st.note || "", "projectPlan.status.note")}</div>
    </div>
  </div>
  <div class="section-title">${PP_IC.flag}Key Milestones${admin ? ` <button class="row-add" data-ppadd="cp">＋ Add milestone</button>` : ""}</div>
  <div class="card"><table class="table">
    <thead><tr><th></th><th>Critical Path Item</th><th>Owner</th><th>Target</th><th>Why It Matters</th><th>Action Needed</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${cp || `<tr><td colspan="${admin ? 7 : 6}" style="color:var(--text-faint)">No milestones yet.</td></tr>`}</tbody></table></div>
  <div class="section-title">${PP_IC.list}Detailed Plan${admin ? ` <button class="row-add" data-ppadd="phase">＋ Add phase</button>` : ""}</div>
  <div class="card"><table class="table">
    <thead><tr><th>#</th><th>Task</th><th>Who</th><th>Window</th><th>Progress</th><th>Status</th><th>Notes</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${tasks}</tbody></table></div>
  <div class="section-title">${PP_IC.risk}Risks &amp; Watch Items${admin ? ` <button class="row-add" data-ppadd="risk">＋ Add risk</button>` : ""}</div>
  <div class="card"><table class="table">
    <thead><tr><th></th><th>Risk</th><th>Impact</th><th>Owner</th><th>Mitigation</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${risks || `<tr><td colspan="${admin ? 6 : 5}" style="color:var(--text-faint)">No risks logged.</td></tr>`}</tbody></table></div>`;
}
let ppWired = false;
function initProjectPlan() {
  if (ppWired) return; ppWired = true;
  const page = document.querySelector('.page[data-page="projectplan"]');
  page.addEventListener("click", e => {
    // two-step delete: ✕ arms it, then an explicit confirm actually removes the project
    const delc = e.target.closest("[data-ppdelconfirm]");
    if (delc) { const id = delc.dataset.ppdelconfirm; STATE.engagements.projects = getProjects().filter(x => x.id !== id); if (selectedProjectId === id) selectProject(""); pendingDeleteId = null; saveState(); applyEngagement(); repaint("projectplan"); return; }
    const delx = e.target.closest("[data-ppdelcancel]");
    if (delx) { pendingDeleteId = null; repaint("projectplan"); return; }
    const del = e.target.closest("[data-ppdel]");
    if (del) { pendingDeleteId = del.dataset.ppdel; repaint("projectplan"); return; }
    const add = e.target.closest("[data-ppaddproject]");
    if (add) { const id = "p_" + Date.now().toString(36); getProjects().push(newProjectTemplate(id)); selectProject(id); saveState(); applyEngagement(); openFresh("exec"); return; }
    const open = e.target.closest("[data-ppopen]");
    if (open) { selectProject(open.dataset.ppopen); applyEngagement(); openFresh("exec"); return; }
  });
}
// activate a page with a guaranteed fresh repaint (engagement context just changed)
function openFresh(page) {
  document.querySelectorAll(".page").forEach(p => { p.dataset.painted = ""; p.innerHTML = ""; });
  activate(page);
}

/* ---------- Status (service-line detail) ---------- */
function renderStatus() {
  const e = getEng(); const st = e.status || { groups: [] };
  const admin = ppAdmin();
  const sEd = (val, path) => admin ? `<span class="ed" contenteditable="true" data-st="${esc(path)}">${esc(val)}</span>` : esc(val);
  const sStatus = (status, path) => admin ? `<span class="svc-status admin-edit" data-ststatus="${esc(path)}" title="Cycle status">${badge(status)}</span>` : badge(status);
  let body = "";
  (st.groups || []).forEach((g, gi) => {
    const done = g.rows.filter(r => r.status === "complete").length;
    body += `<tr class="group-row"><td colspan="${admin ? 5 : 4}">
        ${sEd(g.line, "status.groups." + gi + ".line")}
        <span class="grp-count">${done}/${g.rows.length} complete</span>
        ${admin ? `<button class="row-del" data-stdel="group.${gi}" title="Remove service line">✕</button>` : ""}
      </td></tr>`;
    g.rows.forEach((r, ri) => {
      const base = "status.groups." + gi + ".rows." + ri;
      body += `<tr>
        <td style="font-weight:600">${sEd(r.effort, base + ".effort")}</td>
        <td style="color:var(--text-dim)">${sEd(r.update, base + ".update")}</td>
        <td>${sStatus(r.status, base + ".status")}</td>
        <td>${sEd(r.deadline, base + ".deadline")}</td>
        ${admin ? `<td style="text-align:right"><button class="row-del" data-stdel="row.${gi}.${ri}" title="Remove effort">✕</button></td>` : ""}
      </tr>`;
    });
    if (admin) body += `<tr><td colspan="5"><button class="row-add" data-staddrow="${gi}">＋ Add effort</button></td></tr>`;
  });
  return `
  <div class="page-head">
    <div class="page-title">Status</div>
    <div class="page-desc">Service-line detail — completed &amp; in-progress efforts. <span style="color:var(--text-faint)">(SAP + Status merge lands here.)</span></div>
  </div>
  <div class="card"><table class="table">
    <thead><tr><th>Effort</th><th>Update &amp; Next Steps</th><th>Status</th><th>Deadline</th>${admin ? "<th></th>" : ""}</tr></thead>
    <tbody>${body || `<tr><td colspan="${admin ? 5 : 4}" style="color:var(--text-faint)">No efforts logged yet.</td></tr>`}</tbody>
  </table></div>
  ${admin ? `<button class="row-add" data-staddgroup="1" style="margin-top:14px">＋ Add service line</button>` : ""}`;
}
let statusWired = false;
function initStatus() {
  if (statusWired) return; statusWired = true;
  const page = document.querySelector('.page[data-page="status"]');
  page.addEventListener("focusout", e => {
    const f = e.target.closest("[data-st]"); if (!f) return;
    setPath(getEng(), f.dataset.st, f.textContent.trim()); saveState();
  });
  page.addEventListener("click", e => {
    const eng = getEng(); const st = eng.status || (eng.status = { groups: [] });
    const cyc = e.target.closest("[data-ststatus]");
    if (cyc) { const order = ["pending", "in-progress", "complete", "blocked"]; const cur = getPath(eng, cyc.dataset.ststatus); setPath(eng, cyc.dataset.ststatus, order[(order.indexOf(cur) + 1) % 4]); saveState(); repaint("status"); return; }
    const ar = e.target.closest("[data-staddrow]");
    if (ar) { st.groups[+ar.dataset.staddrow].rows.push({ effort: "New effort", update: "", status: "in-progress", deadline: "" }); saveState(); repaint("status"); return; }
    const ag = e.target.closest("[data-staddgroup]");
    if (ag) { st.groups.push({ line: "New service line", rows: [] }); saveState(); repaint("status"); return; }
    const del = e.target.closest("[data-stdel]");
    if (del) { const p = del.dataset.stdel.split("."); if (p[0] === "group") st.groups.splice(+p[1], 1); else st.groups[+p[1]].rows.splice(+p[2], 1); saveState(); repaint("status"); return; }
  });
}

/* ---------- Backlog (retainer only, editable) ---------- */
function renderBacklog() {
  const e = getEng();
  const items = e.backlog || [];
  const admin = (typeof canEdit === "function") && canEdit();
  const rows = items.map((b, i) => `
    <div class="card" style="margin-bottom:12px;display:flex;gap:14px;align-items:flex-start">
      <div style="flex:1">
        <div class="doc-title ed" ${admin ? `contenteditable="true" data-bl="backlog.${i}.title"` : ""}>${esc(b.title)}</div>
        <div class="doc-meta ed" style="margin-top:6px" ${admin ? `contenteditable="true" data-bl="backlog.${i}.note"` : ""}>${esc(b.note)}</div>
      </div>
      <div class="bl-est" title="Estimated hours to complete">
        <span class="bl-est-val ed" ${admin ? `contenteditable="true" data-bl="backlog.${i}.estHours" data-blnum="1"` : ""}>${b.estHours === "" || b.estHours == null ? (admin ? "" : "—") : esc(b.estHours)}</span>
        <span class="bl-est-lbl">est. hrs</span>
      </div>
      ${admin ? `<button class="row-del" data-bldel="${i}" title="Remove">✕</button>` : ""}
    </div>`).join("");
  return `
  <div class="page-head">
    <div class="page-title">Backlog</div>
    <div class="page-desc">Ideas &amp; efforts that don't fit the current retainer — SOW conversation starters.</div>
  </div>
  ${admin ? `<div class="admin-hint">✎ Admin — fields are editable</div>` : ""}
  <div id="backlogList">${rows || `<div class="placeholder-note">No backlog items yet.</div>`}</div>
  ${admin ? `<button class="row-add" id="backlogAdd">＋ Add backlog item</button>` : ""}`;
}
let backlogWired = false;
function initBacklog() {
  if (backlogWired) return; backlogWired = true;
  const page = document.querySelector('.page[data-page="backlog"]');
  page.addEventListener("focusout", e => {
    const ed = e.target.closest("[data-bl]"); if (!ed) return;
    let v = ed.textContent.trim();
    if (ed.dataset.blnum) { const n = parseFloat(v.replace(/[^0-9.]/g, "")); v = isNaN(n) ? "" : n; }
    setPath(getEng(), ed.dataset.bl, v); saveState();
  });
  page.addEventListener("click", e => {
    if (e.target.id === "backlogAdd") { getEng().backlog.push({ title: "New idea", note: "", estHours: "" }); saveState(); repaint("backlog"); return; }
    const del = e.target.closest("[data-bldel]");
    if (del) { getEng().backlog.splice(+del.dataset.bldel, 1); saveState(); repaint("backlog"); }
  });
}

/* ---------- Files (both roles upload; admin removes uploads) ---------- */
const FILES_KEY = "tja_files_" + ((typeof getSession === "function" && getSession() && getSession().client) || "demo");
function loadFiles() { try { return JSON.parse(localStorage.getItem(FILES_KEY)) || []; } catch { return []; } }
function saveFiles(a) {
  try { localStorage.setItem(FILES_KEY, JSON.stringify(a)); } catch (e) { console.warn(e); }
  if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(clientId(), "files", a);
}
function fmtSize(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
function renderFiles() {
  return `
  <div class="page-head">
    <div class="page-title">Files</div>
    <div class="page-desc">Signed agreements (MSA, SOW, proposals) and shared documents.</div>
  </div>
  <div class="pd-toolbar">
    <button class="btn btn-upload" id="filesUploadBtn">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>
      Upload File
    </button>
    <input type="file" id="filesInput" hidden>
    <span class="pd-hint">Your team and the client can both upload documents here.</span>
  </div>
  <div class="card"><table class="table">
    <thead><tr><th>Document</th><th>Type</th><th>Status</th><th>Date</th><th>Size</th><th>Source</th><th></th></tr></thead>
    <tbody id="filesBody"></tbody>
  </table></div>`;
}
function renderFilesBody() {
  const body = el("#filesBody"); if (!body) return;
  const seed = (D.files || []).map(f => ({ ...f, seed: true, by: "TJA" }));
  const all = seed.concat(loadFiles());
  body.innerHTML = all.map(f => {
    const cls = f.status === "Signed" ? "complete" : (f.status === "Awaiting Signature" ? "on-hold" : "in-progress");
    const del = f.seed ? '<span class="stat-sub">—</span>' : `<button class="btn btn-ghost admin-only" data-filedel="${f.id}">Remove</button>`;
    return `<tr><td style="font-weight:600">${esc(f.name)}</td><td>${esc(f.type)}</td>
      <td><span class="badge ${cls}">${esc(f.status)}</span></td><td>${esc(f.date)}</td>
      <td style="color:var(--text-dim)">${esc(f.size)}</td><td style="color:var(--text-dim)">${esc(f.by || "—")}</td>
      <td style="text-align:right">${del}</td></tr>`;
  }).join("");
}
let filesWired = false;
function initFiles() {
  renderFilesBody();
  if (filesWired) return; filesWired = true;
  el("#filesUploadBtn").addEventListener("click", () => el("#filesInput").click());
  el("#filesInput").addEventListener("change", e => {
    const f = e.target.files[0]; if (!f) return;
    const arr = loadFiles();
    arr.push({ id: "f_" + Date.now(), name: f.name, type: (f.name.split(".").pop() || "file").toUpperCase(),
      status: "Uploaded", date: new Date().toLocaleDateString(), size: fmtSize(f.size),
      by: (typeof effectiveRole === "function" && effectiveRole() === "client") ? D.client.name : "TJA Team" });
    saveFiles(arr); renderFilesBody(); e.target.value = "";
  });
  el("#filesBody").addEventListener("click", e => {
    const del = e.target.closest("[data-filedel]"); if (!del) return;
    saveFiles(loadFiles().filter(x => x.id !== del.dataset.filedel)); renderFilesBody();
  });
}

/* ---------- routing ---------- */
const RENDERERS = {
  exec: () => window.ExecSummary.render(getEng()),
  projectplan: renderProjectFolder, status: renderStatus,
  docs: () => (window.PresentDocs ? window.PresentDocs.render() : ""),
  reporting: renderReporting,
  files: renderFiles, backlog: renderBacklog,
};
function renderReporting() {
  return `
  <div class="page-head">
    <div class="page-title">Reporting</div>
    <div class="page-desc">Performance reporting &amp; analytics for this client.</div>
  </div>
  <div class="placeholder-note" style="margin-top:10px">📊 Reporting is coming soon — we'll build out the contents here.</div>`;
}
function paint(page) {
  const sec = document.querySelector(`.page[data-page="${page}"]`);
  if (sec && !sec.dataset.painted) {
    sec.innerHTML = RENDERERS[page]();
    sec.dataset.painted = "1";
    if (page === "exec" && window.ExecSummary) window.ExecSummary.init();
    if (page === "projectplan") initProjectPlan();
    if (page === "docs" && window.PresentDocs) window.PresentDocs.init();
    if (page === "files") initFiles();
    if (page === "status") initStatus();
    if (page === "backlog") initBacklog();
  }
}
function repaint(page) {
  const sec = document.querySelector(`.page[data-page="${page}"]`);
  if (sec) { sec.dataset.painted = ""; sec.innerHTML = ""; if (sec.classList.contains("active")) paint(page); }
}
function repaintAll() { document.querySelectorAll(".page").forEach(p => { p.dataset.painted = ""; p.innerHTML = ""; }); paint(currentPage()); }
function currentPage() { const a = document.querySelector(".page.active"); return a ? a.dataset.page : "exec"; }

function activate(page) {
  document.querySelectorAll(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.page === page));
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.dataset.page === page));
  paint(page);
  window.scrollTo(0, 0);
}
window.DASH.activate = activate;

/* ---------- theme (light / dark) ---------- */
const ICON_SUN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`;
const ICON_MOON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`;
function currentTheme() { try { return localStorage.getItem("tja_theme") || "light"; } catch { return "light"; } }
function applyTheme(t) {
  if (t === "light") document.documentElement.setAttribute("data-theme", "light");
  else document.documentElement.removeAttribute("data-theme");
  const b = el("#themeToggle");
  if (b) { const light = t === "light"; b.innerHTML = light ? ICON_MOON : ICON_SUN; b.title = light ? "Switch to dark mode" : "Switch to light mode"; }
}
function toggleTheme() {
  const next = currentTheme() === "light" ? "dark" : "light";
  try { localStorage.setItem("tja_theme", next); } catch {}
  applyTheme(next);
}

/* ---------- role / mode ---------- */
function applyRole() {
  const effRole = (typeof effectiveRole === "function") ? effectiveRole() : "admin";
  document.body.dataset.role = effRole;
  // "All clients" is an admin nav — hide it in client view (incl. admin previewing as client)
  const cb = el("#clientsBack"); if (cb) cb.style.display = (effRole === "admin") ? "" : "none";
  const rc = el("#roleControls");
  if (typeof isAdmin === "function" && isAdmin()) {
    const prev = isPreviewing();
    rc.innerHTML = `${!prev ? `<button class="btn btn-ghost undo-btn" id="undoBtn" title="Undo last action (⌘Z)" disabled>↶ Undo</button>` : ""}
      <span class="role-pill">${prev ? "Admin · previewing" : "Admin"}</span>
      <div class="role-switch">
        <button class="role-seg ${!prev ? "active" : ""}" id="modeAdmin">Admin</button>
        <button class="role-seg ${prev ? "active" : ""}" id="modeClient">Client view</button>
      </div>`;
    el("#modeAdmin").addEventListener("click", () => { setPreview(false); applyRole(); repaintAll(); });
    el("#modeClient").addEventListener("click", () => { setPreview(true); applyRole(); repaintAll(); });
    if (!prev) { const ub = el("#undoBtn"); if (ub) ub.addEventListener("click", undo); updateUndoBtn(); }
  } else { rc.innerHTML = ""; }
  const banner = el("#previewBanner");
  const show = (typeof isPreviewing === "function") && isPreviewing();
  banner.style.display = show ? "" : "none";
  if (show) el("#previewClientName").textContent = D.client.name;
}

/* ---------- engagement toggle (Monthly Services ⇄ Projects) ---------- */
function applyEngagement() {
  const tog = el("#engToggle");
  tog.innerHTML =
    `<button class="eng-seg ${isRetainer() ? "active" : ""}" data-engmode="retainer">Monthly Services</button>` +
    `<button class="eng-seg ${!isRetainer() ? "active" : ""}" data-engmode="project">Projects</button>`;
  // topbar identity: client name (set once) + engagement label. North Star now lives in its own
  // full-width banner at the top of the Executive Summary (see exec-summary.js northStarBanner).
  const eng = getEng();
  const onFolder = !isRetainer() && !selectedProject();
  el("#clientMeta").textContent = "· " + (isRetainer() ? "Monthly Services" : (onFolder ? "Projects" : (eng.label || eng.name)));
  const ns = el("#clientNorthstar");
  if (ns) ns.innerHTML = "";
  el("#navBacklog").style.display = isRetainer() ? "" : "none";   // Backlog = Monthly-Services-only
  if (isRetainer() && currentPage() === "projectplan") activate("exec");
  if (!isRetainer() && currentPage() === "backlog") activate("exec");
}

/* ---------- boot ---------- */
(async function init() {
  const av = el("#clientAvatar");
  if (D.client.logo) { av.innerHTML = `<img src="${D.client.logo}" alt="${esc(D.client.name)}">`; av.classList.add("has-logo"); }
  else av.textContent = D.client.initials;
  el("#clientName").textContent = D.client.name;
  document.title = `${D.client.name} · TJA Portal`;

  document.getElementById("nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item"); if (item) activate(item.dataset.page);
  });
  document.getElementById("engToggle").addEventListener("click", e => {
    const seg = e.target.closest(".eng-seg"); if (!seg || !seg.dataset.engmode) return;
    const mode = seg.dataset.engmode;
    setEngMode(mode);
    let target = "exec";
    if (mode === "project") {
      const ps = getProjects();
      if (ps.length === 1) { selectProject(ps[0].id); target = "exec"; }   // one project → open its homepage
      else { selectProject(""); target = "projectplan"; }                  // none/several → projects folder
    }
    applyEngagement();
    document.querySelectorAll(".page").forEach(p => { p.dataset.painted = ""; p.innerHTML = ""; });
    activate(target);
  });

  // "← All projects" (shown on a project's homepage) returns to the folder
  document.addEventListener("click", e => {
    if (e.target.closest("[data-allprojects]")) { selectProject(""); applyEngagement(); openFresh("projectplan"); }
  });

  // North Star / due-date edits made in the topbar
  el("#clientNorthstar").addEventListener("focusout", e => {
    const f = e.target.closest("[data-tbpath]"); if (!f) return;
    setPath(getEng(), f.dataset.tbpath, f.textContent.trim()); saveState();
  });

  // Live data: pull from Supabase when configured (otherwise stay on localStorage)
  if (window.SUPA && window.SUPA.enabled) {
    try {
      const cid = clientId();
      const dash = await window.SUPA.pullScope(cid, "dashboard");
      if (dash && dash.engagements) { STATE = migrate(dash); lastSnapshot = clone(STATE); try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch {} }
      const files = await window.SUPA.pullScope(cid, "files");
      if (files) { try { localStorage.setItem(FILES_KEY, JSON.stringify(files)); } catch {} }
      const dels = await window.SUPA.pullScope(cid, "deliverables");
      if (dels) { try { localStorage.setItem("tja_deliverables_" + cid, JSON.stringify(dels)); } catch {} }
    } catch (e) { console.warn("Supabase boot sync failed; using local data.", e); }
  }

  // normalize a stale/invalid selection from older sessions
  if (engMode !== "retainer" && engMode !== "project") setEngMode("retainer");
  if (selectedProjectId && !getProjects().some(p => p.id === selectedProjectId)) selectProject("");

  applyTheme(currentTheme());
  const tt = el("#themeToggle");
  if (tt) tt.addEventListener("click", toggleTheme);

  applyRole();
  const exit = el("#exitPreview");
  if (exit) exit.addEventListener("click", () => { setPreview(false); applyRole(); repaintAll(); });

  // ⌘Z / Ctrl+Z → undo last action (admin only; let native undo win inside a field)
  document.addEventListener("keydown", e => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
    if (typeof canEdit !== "function" || !canEdit()) return;
    const ae = document.activeElement;
    if (ae && (ae.isContentEditable || ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) return;
    e.preventDefault(); undo();
  });

  applyEngagement();
  let bootPage = "exec";
  if (!isRetainer()) {
    const ps = getProjects();
    if (ps.length === 1) selectProject(ps[0].id);          // single project → straight to its homepage
    else if (!selectedProject()) bootPage = "projectplan"; // none chosen → projects folder
  }
  activate(bootPage);
})();
