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
  // The dashboard scope is admin-writable ONLY (RLS). Clients/creatives still hit
  // saveState() through boot self-heals (PR refresh, discipline seeding) — their
  // localStorage copy updates, but pushing would just be an RLS-rejected write.
  if (window.SUPA && window.SUPA.enabled && (typeof isAdmin !== "function" || isAdmin()))
    window.SUPA.pushScope(clientId(), "dashboard", STATE);
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
// Scoped per client (not a single global key) — otherwise an admin's mode carries over when
// switching clients in the same tab (e.g. leaving a retainer client landed you back on Monthly
// Services for a project-only client, since the browser had no idea the client had changed).
let engMode = sessionStorage.getItem("tja_eng_mode_" + clientId());
if (!engMode) {   // no explicit choice yet for this client — default to whichever engagement has
  // real data (a client can be rostered "project" but still have live retainer billing, or vice
  // versa, so the actual dashboard state is the reliable signal, not the roster's stamped kind)
  const hasProj = Array.isArray(STATE.engagements.projects) && STATE.engagements.projects.length > 0;
  engMode = (!retainerHasData() && hasProj) ? "project" : "retainer";
}
let selectedProjectId = sessionStorage.getItem("tja_proj_" + clientId()) || "";
function getAllProjects() { return STATE.engagements.projects || []; }        // includes archived — admin/internal use
function getProjects() {                                                      // client-facing list — archived hidden
  const all = getAllProjects();
  return (typeof canEdit === "function" && canEdit()) ? all : all.filter(p => !p.archived);
}
function isRetainer() { return engMode === "retainer"; }
function selectedProject() { return getProjects().find(p => p.id === selectedProjectId) || null; }
function setEngMode(m) { engMode = m; sessionStorage.setItem("tja_eng_mode_" + clientId(), m); }
function selectProject(id) { selectedProjectId = id || ""; sessionStorage.setItem("tja_proj_" + clientId(), selectedProjectId); }
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
// Public surface consumed by exec-summary.js — keep this list tight (only what's actually read).
window.DASH = { getEng, saveState, setPath, badge,
  // "← All projects" link, shown on a project's homepage when several projects exist (handled in exec-summary render so it survives rerender)
  projectBack: () => (!isRetainer() && getProjects().length > 1 && selectedProject()) ? `<button class="pp-back" data-allprojects>← All projects</button>` : "" };

/* ---------- Projects folder (tiles + archive + two-step delete) ---------- */
const ppAdmin = () => (typeof canEdit === "function" ? canEdit() : true);

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
let projBucket = "current";   // admin-only Current/Archived folder toggle (clients never see archived)
// Projects landing — a folder of project tiles (Projects is a top-mode, not a left-nav tab).
function renderProjectFolder() {
  const admin = ppAdmin();
  const all = admin ? getAllProjects() : getProjects();
  const bucket = admin ? projBucket : "current";
  const projects = all.filter(p => !!p.archived === (bucket === "archived"));
  const nCurrent = all.filter(p => !p.archived).length, nArchived = all.length - nCurrent;
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
    const actions = admin ? `
        <button class="ct-act" data-pparch="${esc(p.id)}" title="${p.archived ? "Move to Current" : "Move to Archived"}">${p.archived ? "↩" : "📁"}</button>
        <button class="ct-act ct-del" data-ppdel="${esc(p.id)}" title="Delete project">🗑</button>` : "";
    return `<div class="proj-tile client-tile" data-ppopen="${esc(p.id)}">
        ${admin ? `<div class="client-tile-actions">${actions}</div>` : ""}
        <div class="proj-tile-top"><span class="ryg-dot ${lvl}"></span><span class="proj-tile-name">${esc(p.label || p.name)}</span></div>
        <div class="proj-tile-sub">${esc(p.name)}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="proj-tile-foot">${pct}% complete</div>
      </div>`;
  }).join("");
  const tabs = admin ? `
    <div class="cl-tabs" id="ppTabs">
      <button class="cl-tab ${bucket === "current" ? "active" : ""}" data-ppbucket="current">Current <span class="cl-tab-n">${nCurrent}</span></button>
      <button class="cl-tab ${bucket === "archived" ? "active" : ""}" data-ppbucket="archived">Archived <span class="cl-tab-n">${nArchived}</span></button>
    </div>` : "";
  return `
  ${admin ? `<div class="admin-hint">✎ Admin — click a project to open it · ＋ adds a project · 📁 archives (hides from the client) · 🗑 then confirm to delete</div>` : ""}
  <div class="page-head page-head-row">
    <div>
      <div class="page-title">Projects</div>
      <div class="page-desc">${projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}${bucket === "current" ? " — choose one to open." : " archived — hidden from the client."}` : (bucket === "archived" ? "No archived projects." : "No projects yet — add your first one.")}</div>
    </div>
    ${tabs}
  </div>
  <div class="proj-grid">${tiles}${admin && bucket === "current" ? `<button class="proj-tile proj-tile-add" data-ppaddproject><span class="pta-plus">＋</span> New Project</button>` : ""}</div>`;
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
    const arch = e.target.closest("[data-pparch]");
    if (arch) { const p = getAllProjects().find(x => x.id === arch.dataset.pparch); if (p) p.archived = !p.archived; saveState(); repaint("projectplan"); return; }
    const bucket = e.target.closest("[data-ppbucket]");
    if (bucket) { projBucket = bucket.dataset.ppbucket; repaint("projectplan"); return; }
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
  if (!all.length) {   // graceful empty state (every other tab has one)
    body.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint);padding:18px 16px">No files yet — drop agreements, working files and final deliverables here.</td></tr>`;
    return;
  }
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
  // NOTE "projectplan" is the projects FOLDER (the tile picker), not a plan — historic name.
  // The actual plan is "plan" below.
  projectplan: renderProjectFolder, status: renderStatus, plan: renderPlan,
  docs: () => (window.PresentDocs ? window.PresentDocs.render() : ""),
  reporting: renderReporting,
  files: renderFiles, backlog: renderBacklog,
};

/* ---------- Project Plan (projects only) ----------
   The full-page view of a project's plan: phases + tasks + progress, fed by Workamajig.
   Sits under Status and may later replace it. Tasks are read-only here (WMJ is the source of
   truth); only the outcome is admin-editable. */
function renderPlan() {
  const e = getEng();
  const admin = ppAdmin();
  const pp = e.projectPlan || {};
  const all = Array.isArray(e.wmjTasks) ? e.wmjTasks : [];
  // Client visibility is ONE rule, owned by exec-summary. Reuse it — never re-implement a
  // permissions predicate in a second place, or the two drift and a client sees internal work.
  const isInternal = (t) => window.ExecSummary.taskInternal(e, t);
  const tasks = admin ? all : all.filter(t => !isInternal(t));

  const order = (e.pizza && e.pizza.phases) ? e.pizza.phases.map(p => p.label) : [];
  const groups = {};
  tasks.forEach(t => { (groups[t.phase] = groups[t.phase] || []).push(t); });
  const names = Object.keys(groups)
    .sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });

  const stCls = { Completed: "complete", Production: "in-progress", "On Hold": "on-hold" };
  const pct = projectPct(e);
  const body = names.map(pn => {
    const rows = groups[pn];
    const done = rows.filter(t => t.status === "Completed").length;
    return `<div class="plan-phase">
      <div class="plan-phase-head">
        <span class="plan-phase-name">${esc(pn || "Unphased")}</span>
        <span class="grp-count">${done}/${rows.length} complete</span>
      </div>
      ${rows.map(t => { const internal = isInternal(t); return `
        <div class="plan-task${internal ? " is-internal" : ""}">
          <span class="task-dot ${stCls[t.status] || "pending"}" title="${esc(t.status || "")}"></span>
          <span class="plan-task-name">${esc(t.name)}${internal ? ` <span class="task-int">internal</span>` : ""}</span>
          ${t.service ? `<span class="task-svc">${esc(t.service)}</span>` : ""}
          <span class="plan-task-status">${esc(t.status || "")}</span>
        </div>`; }).join("")}
    </div>`;
  }).join("");

  const outcome = admin
    ? `<span class="ed" contenteditable="true" data-plan="projectPlan.outcome">${esc(pp.outcome || "")}</span>`
    : esc(pp.outcome || "");
  return `
  ${admin ? `<div class="admin-hint">✎ Admin — the outcome is editable here. Phases &amp; tasks come from Workamajig; set task visibility on the Executive Summary.</div>` : ""}
  <div class="page-head">
    <div class="page-title">Project Plan</div>
    <div class="page-desc">${esc(e.label || e.name || "Project")} — phases, tasks and progress.</div>
  </div>
  <div class="plan-card">
    <div class="plan-row"><span class="plan-lbl">Outcome</span><span class="plan-outcome">${outcome}</span></div>
    <div class="plan-row"><span class="plan-lbl">Progress</span>
      <div class="bar plan-bar"><span style="width:${pct}%"></span></div><span class="plan-pct">${pct}%</span></div>
  </div>
  <div class="plan-phases">${body || `<div class="placeholder-note" style="margin-top:10px">No tasks yet — this plan fills in from Workamajig.</div>`}</div>`;
}
let planWired = false;
function initPlan() {
  if (planWired) return; planWired = true;
  document.querySelector('.page[data-page="plan"]').addEventListener("focusout", e => {
    const f = e.target.closest("[data-plan]"); if (!f) return;
    setPath(getEng(), f.dataset.plan, f.textContent.trim()); saveState();
  });
}
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
    if (page === "plan") initPlan();
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
  // "All clients" is a staff nav — hide it in client view (incl. staff previewing as client)
  const staffRole = effRole === "admin" || effRole === "creative";
  const cb = el("#clientsBack"); if (cb) cb.style.display = staffRole ? "" : "none";
  const rc = el("#roleControls");
  if (typeof isStaff === "function" && isStaff()) {
    const prev = isPreviewing();
    const admin = isAdmin();
    const pillBase = admin ? "Admin" : "Creative";
    // Undo drives saveState() → dashboard-scope writes that RLS rejects for creatives,
    // so only admins get the button.
    rc.innerHTML = `${!prev && admin ? `<button class="btn btn-ghost undo-btn" id="undoBtn" title="Undo last action (⌘Z)" disabled>↶ Undo</button>` : ""}
      <span class="role-pill">${prev ? pillBase + " · previewing" : pillBase}</span>
      <div class="role-switch">
        <button class="role-seg ${!prev ? "active" : ""}" id="modeAdmin">${pillBase}</button>
        <button class="role-seg ${prev ? "active" : ""}" id="modeClient">Client view</button>
      </div>`;
    // applyEngagement() must re-run on a role switch: a client only sees engagements with
    // data, so toggling Client view has to re-gate the Monthly Services / Projects toggle
    // (e.g. Celtic's empty retainer must disappear in the client preview).
    el("#modeAdmin").addEventListener("click", () => { setPreview(false); applyRole(); applyEngagement(); repaintAll(); });
    el("#modeClient").addEventListener("click", () => { setPreview(true); applyRole(); applyEngagement(); repaintAll(); });
    if (!prev && admin) { const ub = el("#undoBtn"); if (ub) ub.addEventListener("click", undo); updateUndoBtn(); }
  } else { rc.innerHTML = ""; }
  const banner = el("#previewBanner");
  const show = (typeof isPreviewing === "function") && isPreviewing();
  banner.style.display = show ? "" : "none";
  if (show) el("#previewClientName").textContent = D.client.name;
}

/* ---------- engagement toggle (Monthly Services ⇄ Projects) ---------- */
/* Does this client actually have Monthly-Services (retainer) data worth showing? */
function retainerHasData() {
  const r = STATE.engagements.retainer;
  if (!r) return false;
  return r.source === "wmj"
    || (Array.isArray(r.wmjServiceLines) && r.wmjServiceLines.length > 0)
    || (r.burn && Number(r.burn.contractedHours) > 0)
    || (Array.isArray(r.serviceLines) && r.serviceLines.length > 0)
    || (Array.isArray(r.milestones) && r.milestones.length > 0)
    || (Array.isArray(r.todos) && r.todos.length > 0)
    || (r.northStar && String(r.northStar).trim() !== "");
}

function applyEngagement() {
  const tog = el("#engToggle");
  // Admins (real, not previewing) always see both toggles so they can set either up.
  // Clients only see an engagement that actually has data — no empty Monthly Services / Projects.
  const adminRole = (typeof effectiveRole === "function") ? effectiveRole() === "admin" : true;
  const hasRet = adminRole || retainerHasData();
  const hasProj = adminRole || getProjects().length > 0;

  // Don't strand a client on an engagement that has no data.
  if (!hasRet && isRetainer()) {
    setEngMode("project");
    const ps = getProjects();
    if (ps.length === 1 && !selectedProject()) selectProject(ps[0].id);
  } else if (!hasProj && !isRetainer()) {
    setEngMode("retainer");
  }

  let segs = "";
  if (hasRet) segs += `<button class="eng-seg ${isRetainer() ? "active" : ""}" data-engmode="retainer">Monthly Services</button>`;
  if (hasProj) segs += `<button class="eng-seg ${!isRetainer() ? "active" : ""}" data-engmode="project">Projects</button>`;
  tog.innerHTML = segs;
  // Nothing to switch between (single engagement in client view) → hide the toggle entirely.
  tog.style.display = (hasRet && hasProj) ? "" : "none";
  // topbar identity: client name (set once) + engagement label. The headline goal lives in its own
  // full-width banner at the top of the Executive Summary, and only on projects — retainers carry
  // their direction in the Sprint Goals tile instead (see exec-summary.js goalBanner).
  const eng = getEng();
  const onFolder = !isRetainer() && !selectedProject();
  el("#clientMeta").textContent = "· " + (isRetainer() ? "Monthly Services" : (onFolder ? "Projects" : (eng.label || eng.name)));
  const ns = el("#clientNorthstar");
  if (ns) ns.innerHTML = "";
  el("#navBacklog").style.display = isRetainer() ? "" : "none";   // Backlog = Monthly-Services-only
  // Project Plan needs a project actually open — it's meaningless on a retainer or on the folder.
  const planOk = !isRetainer() && !onFolder;
  el("#navPlan").style.display = planOk ? "" : "none";
  if (!planOk && currentPage() === "plan") activate("exec");
  if (isRetainer() && currentPage() === "projectplan") activate("exec");
  if (!isRetainer() && currentPage() === "backlog") activate("exec");
}

/* ---------- boot ---------- */
(async function init() {
  const av = el("#clientAvatar");
  // prefer the WMJ client code (from the store entry) over auto-initials for the avatar
  let clientCode = D.client.code || "";
  try { const m = (typeof getSession === "function" && window.TJA_STORE) ? window.TJA_STORE.get(getSession().client) : null; if (m && m.code) clientCode = m.code; } catch (e) {}
  if (D.client.logo) { av.innerHTML = `<img src="${D.client.logo}" alt="${esc(D.client.name)}">`; av.classList.add("has-logo"); }
  else { const label = clientCode || D.client.initials || "?"; av.textContent = label; if (label.length >= 4) av.classList.add("avatar-code-lg"); }
  el("#clientName").textContent = D.client.name;
  document.title = `${D.client.name} · TJA Portal`;

  document.getElementById("nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item"); if (item && item.dataset.page) activate(item.dataset.page);  // anchors (e.g. Notification Center) navigate on their own
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

  // Live data: pull from Supabase when configured (otherwise stay on localStorage).
  // The three scopes pull IN PARALLEL (each self-times-out in the sync layer), so a slow
  // or unreachable backend delays boot by at most one timeout, never the sum of three.
  if (window.SUPA && window.SUPA.enabled) {
    try {
      const cid = clientId();
      const [dash, files, dels] = await Promise.all([
        window.SUPA.pullScope(cid, "dashboard"),
        window.SUPA.pullScope(cid, "files"),
        window.SUPA.pullScope(cid, "deliverables"),
      ]);
      if (dash && dash.engagements) { STATE = migrate(dash); lastSnapshot = clone(STATE); try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch {} }
      if (files) { try { localStorage.setItem(FILES_KEY, JSON.stringify(files)); } catch {} }
      if (dels) { try { localStorage.setItem("tja_deliverables_" + cid, JSON.stringify(dels)); } catch {} }
    } catch (e) { console.warn("Supabase boot sync failed; using local data.", e); }
  }

  // self-heal: a retainer must always carry its service disciplines. If a stale/older state
  // (or a dropped sync write) leaves them empty, re-seed from the template so the Service Lines
  // tile is never blank — then persist so the fix propagates back to Supabase.
  (function ensureRetainerDisciplines() {
    const ret = STATE.engagements && STATE.engagements.retainer;
    if (!ret) return;
    if (ret.projectOnly) return;   // project-only clients (e.g. Celtic) have no monthly retainer — don't seed placeholders
    if (!Array.isArray(ret.serviceDisciplines) || !ret.serviceDisciplines.length) {
      ret.serviceDisciplines = (typeof window.tjaSeedDisciplinesFor === "function")
        ? window.tjaSeedDisciplinesFor(D.client.name) : [];
      ret.burn = ret.burn || {};
      ret.burn.contractedHours = ret.serviceDisciplines.reduce((s, d) => s + (+d.contracted || 0), 0);
      try { saveState(); } catch (e) {}
    }
  })();

  // Refresh PR coverage for THIS client on load. The dashboard doesn't run the full WMJ poll
  // (only the Clients page does), so pull the team's PR sheet directly here — otherwise PR only
  // shows after a Clients-page visit. Fire-and-forget; repaint the summary when it lands.
  (function refreshPRForCurrent() {
    try {
      const reg = window.CLIENT_PR_SHEETS, cfg = reg && reg.forClient(clientId());
      const ret = STATE.engagements && STATE.engagements.retainer;
      if (!cfg || !ret) return;
      fetch(reg.csvUrl(cfg), { cache: "no-store" })
        .then(r => (r.ok ? r.text() : null))
        .then(text => {
          if (!text) return;
          ret.prCoverage = reg.parseHits(text);
          ret.prSource = "sheet";
          ret.prHits = reg.hitCount(text, ret.prCoverage.length);
          saveState();
          if (currentPage() === "exec") repaint("exec");
        })
        .catch(() => {});
    } catch (e) {}
  })();

  // Refresh the SOW-derived retainer hours for THIS client on load, same reasoning as the PR
  // block above: syncRetainerValue only runs in the Clients-page poll, so a client dashboard
  // opened directly would never receive its SOW total (burn showed "—" despite signed $ in the
  // sheet). Fire-and-forget; repaint the summary when it lands.
  (function refreshRetainerValueForCurrent() {
    try {
      const rv = window.WMJ_RETAINER_VALUE;
      const ret = STATE.engagements && STATE.engagements.retainer;
      const me = window.TJA_STORE && window.TJA_STORE.get && window.TJA_STORE.get(clientId());
      if (!rv || !ret || !me) return;
      rv.forRoster([me])
        .then(map => {
          const entry = map.get(me.id); if (!entry) return;
          ret.retainerValueTarget = entry.hrs;
          ret.retainerValueMonthly = !!entry.monthly;
          ret.retainerValueHasPending = entry.hasPending;
          saveState();
          if (currentPage() === "exec") repaint("exec");
        })
        .catch(e => console.warn("retainer-value refresh", e));
    } catch (e) { console.warn("retainer-value refresh", e); }
  })();

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
  // deep-link: a notification-center click asks to land on a specific page (e.g. Present Docs)
  let openHint = null;
  try { openHint = sessionStorage.getItem("tja_open_page"); sessionStorage.removeItem("tja_open_page"); } catch (e) {}
  activate(openHint && document.querySelector(`.page[data-page="${openHint}"]`) ? openHint : bootPage);
})();
