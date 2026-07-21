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
  // The dashboard scope is writable by the agency account + AM/PMs only (RLS).
  // Clients/creatives still hit saveState() through boot self-heals (PR refresh,
  // discipline seeding) — their localStorage copy updates, but pushing would just
  // be an RLS-rejected write.
  // GUARDED push: if someone else wrote this client since our last pull, the CAS
  // fails and onDashboardConflict re-pulls + warns instead of silently clobbering.
  if (window.SUPA && window.SUPA.enabled && (typeof isAdminOrManager !== "function" || isAdminOrManager())) {
    if (window.SUPA.pushScopeGuarded) window.SUPA.pushScopeGuarded(clientId(), "dashboard", STATE, onDashboardConflict);
    else window.SUPA.pushScope(clientId(), "dashboard", STATE);
  }
}
// Another admin's write beat ours: show THEIR version (the truth on the server) and
// tell the user their last edit didn't stick. No merge — re-apply the edit by hand.
function onDashboardConflict(remoteData) {
  if (!remoteData || !remoteData.engagements) return;
  STATE = migrate(remoteData);
  lastSnapshot = clone(STATE);
  try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch (e) {}
  applyEngagement();
  repaintAll();
  showConflictBanner();
}
function showConflictBanner() {
  let b = el("#conflictBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "conflictBanner";
    b.className = "conflict-banner";
    b.innerHTML = `<span>⚠ This client was just updated by someone else — the page now shows their version; your last edit was not saved.</span><button id="conflictDismiss">Dismiss</button>`;
    const anchor = el("#previewBanner");
    anchor.parentNode.insertBefore(b, anchor.nextSibling);
    b.querySelector("#conflictDismiss").addEventListener("click", () => { b.style.display = "none"; });
  }
  b.style.display = "";
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

// Pull the team's PR sheet (a per-client Google Sheet, "Anyone with the link – Viewer")
// and mirror it into prCoverage. `cfg` is {sheetId, gid} — resolved by the caller from
// either an admin-pasted link (eng.prSheetUrl) or the legacy hardcoded registry, so this
// one fetch/parse path works for both. Returns a promise; never throws (fails soft).
function refreshPRSheet(ret, cfg) {
  const reg = window.CLIENT_PR_SHEETS;
  if (!reg || !cfg || !ret) return Promise.resolve(false);
  return fetch(reg.csvUrl(cfg), { cache: "no-store" })
    .then(r => (r.ok ? r.text() : null))
    .then(text => {
      if (!text) return false;
      ret.prCoverage = reg.parseHits(text);
      ret.prSource = "sheet";
      ret.prHits = reg.hitCount(text, ret.prCoverage.length);
      return true;
    })
    .catch(() => false);
}

// shared with exec-summary.js
// Public surface consumed by exec-summary.js — keep this list tight (only what's actually read).
window.DASH = { getEng, saveState, setPath, badge, refreshPRSheet,
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
// Sheet columns, in order: Service Line | Effort | Update & Next Steps | Status | Deadline
// (matches this tab's own displayed fields exactly — see the <thead> below). A row repeats
// its Service Line to stay grouped with the row above it; leave it blank to continue the
// current group. NOTE: this mapping was designed against the app's own field list, not a
// live example sheet — verify a real import once before trusting it in front of a client.
const STATUS_KEY = { complete: "complete", done: "complete", "in progress": "in-progress", "not started": "not-started",
  pending: "pending", "on hold": "on-hold", blocked: "blocked" };
function normalizeStatusKey(s) { return STATUS_KEY[String(s || "").trim().toLowerCase()] || "in-progress"; }
function parseStatusSheet(text) {
  const reg = window.CLIENT_PR_SHEETS; if (!reg) return null;
  const rows = reg.parseRows(text);
  const groups = []; let cur = null;
  rows.forEach(r => {
    const line = (r[0] || "").trim(), effort = (r[1] || "").trim();
    if (!line && !effort) return;                                   // blank/spacer row
    if (/^service ?line$/i.test(line) && /^effort$/i.test(effort)) return;   // header row
    if (line) { cur = { line, rows: [] }; groups.push(cur); }
    if (!cur) { cur = { line: "Service line", rows: [] }; groups.push(cur); }  // sheet started with no group label
    if (effort) cur.rows.push({ effort, update: (r[2] || "").trim(), status: normalizeStatusKey(r[3]), deadline: (r[4] || "").trim() });
  });
  return { groups };
}
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
    ${admin ? `<button class="btn btn-ghost" data-statusconnect title="${esc(e.statusSheetUrl || "")}">${e.statusSheetUrl ? "✎ Change sheet" : "🔗 Upload / connect Status Report"}</button>` : ""}
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
  page.addEventListener("click", async e => {
    const eng = getEng(); const st = eng.status || (eng.status = { groups: [] });
    const cyc = e.target.closest("[data-ststatus]");
    if (cyc) { const order = ["pending", "in-progress", "complete", "blocked"]; const cur = getPath(eng, cyc.dataset.ststatus); setPath(eng, cyc.dataset.ststatus, order[(order.indexOf(cur) + 1) % 4]); saveState(); repaint("status"); return; }
    const ar = e.target.closest("[data-staddrow]");
    if (ar) { st.groups[+ar.dataset.staddrow].rows.push({ effort: "New effort", update: "", status: "in-progress", deadline: "" }); saveState(); repaint("status"); return; }
    const ag = e.target.closest("[data-staddgroup]");
    if (ag) { st.groups.push({ line: "New service line", rows: [] }); saveState(); repaint("status"); return; }
    const del = e.target.closest("[data-stdel]");
    if (del) { const p = del.dataset.stdel.split("."); if (p[0] === "group") st.groups.splice(+p[1], 1); else st.groups[+p[1]].rows.splice(+p[2], 1); saveState(); repaint("status"); return; }
    const conn = e.target.closest("[data-statusconnect]");
    if (conn) {
      const raw = await window.TJA_UI.prompt(
        "Paste the Status Report sheet's share link (must be shared “Anyone with the link – Viewer”).\n\nColumns, in order: Service Line, Effort, Update & Next Steps, Status, Deadline. Repeat the Service Line on its first row, then leave it blank for the rows under it.",
        { title: "Connect Status Report sheet", value: eng.statusSheetUrl || "", okText: "Connect" });
      if (raw == null) return;
      const reg = window.CLIENT_PR_SHEETS;
      if (!raw.trim()) { delete eng.statusSheetUrl; saveState(); repaint("status"); return; }
      const cfg = reg && reg.parseSheetUrl(raw);
      if (!cfg) { window.TJA_UI.alert("That doesn't look like a Google Sheets link. Paste the full share URL."); return; }
      conn.disabled = true; conn.textContent = "Connecting…";
      fetch(reg.csvUrl(cfg), { cache: "no-store" }).then(r => r.ok ? r.text() : null).then(text => {
        const parsed = text && parseStatusSheet(text);
        if (!parsed || !parsed.groups.length) { window.TJA_UI.alert("Couldn't read any rows from that sheet — check the link is shared and the columns match Service Line, Effort, Update & Next Steps, Status, Deadline."); repaint("status"); return; }
        eng.status = parsed; eng.statusSheetUrl = raw.trim();
        saveState(); repaint("status");
      }).catch(() => { window.TJA_UI.alert("Couldn't reach that sheet."); repaint("status"); });
      return;
    }
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
    const cls = f.status === "Uploading…" ? "pending" : f.status === "Signed" ? "complete" : (f.status === "Awaiting Signature" ? "on-hold" : "in-progress");
    const del = f.seed ? '<span class="stat-sub">—</span>' : `<button class="btn btn-ghost admin-only" data-filedel="${f.id}">Remove</button>`;
    // files pushed to Drive render their name as the Drive link
    const name = f.driveLink
      ? `<a href="${esc(f.driveLink)}" target="_blank" rel="noopener" class="file-drive-link">${esc(f.name)} ↗</a>`
      : esc(f.name);
    return `<tr><td style="font-weight:600">${name}</td><td>${esc(f.type)}</td>
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
  el("#filesInput").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = "";
    if (f.size > 10 * 1024 * 1024) { window.TJA_UI.alert("Files over 10 MB can't be uploaded here yet — share big files via your Drive folder directly."); return; }
    const row = { id: "f_" + Date.now(), name: f.name, type: (f.name.split(".").pop() || "file").toUpperCase(),
      status: "Uploaded", date: new Date().toLocaleDateString(), size: fmtSize(f.size),
      by: (typeof effectiveRole === "function" && effectiveRole() === "client") ? D.client.name : "TJA Team" };
    // Push the actual bytes to the client's Drive folder via the Edge Function — Drive
    // is the store of record; the portal row keeps metadata + the link. EVERY failure
    // path (no function deployed, no folder configured, no session, network) degrades
    // to today's metadata-only row: the upload never blocks on Drive.
    const arr = loadFiles();
    if (window.TJA_DRIVE && window.TJA_DRIVE.enabled()) {
      row.status = "Uploading…";
      arr.push(row); saveFiles(arr); renderFilesBody();
      const r = await window.TJA_DRIVE.upload(f, clientId());
      row.status = "Uploaded";
      if (r.ok) { row.driveLink = r.driveLink; row.driveId = r.driveId; }
      saveFiles(arr); renderFilesBody();
      return;
    }
    arr.push(row); saveFiles(arr); renderFilesBody();
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
// admin-only "connect / change" button for the project-plan sheet (shown in both views)
const planConnectBtn = (e, admin) => admin
  ? `<button class="btn btn-ghost" data-planconnect title="${esc(e.projectPlanSheetUrl || "")}">${e.projectPlanSheetUrl ? "✎ Change / refresh plan sheet" : "🔗 Connect project-plan sheet"}</button>`
  : "";

function renderPlan() {
  const e = getEng();
  const admin = ppAdmin();
  // A connected Google Sheet is the source of truth when present (the Gantt-plan view);
  // otherwise fall back to the Workamajig-derived task list below.
  if (e.projectPlanSheet && e.projectPlanSheet.groups && e.projectPlanSheet.groups.length) return renderPlanSheet(e, admin);
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
    ${planConnectBtn(e, admin)}
  </div>
  <div class="plan-card">
    <div class="plan-row"><span class="plan-lbl">Outcome</span><span class="plan-outcome">${outcome}</span></div>
    <div class="plan-row"><span class="plan-lbl">Progress</span>
      <div class="bar plan-bar"><span style="width:${pct}%"></span></div><span class="plan-pct">${pct}%</span></div>
  </div>
  <div class="plan-phases">${body || `<div class="placeholder-note" style="margin-top:10px">No tasks yet — this plan fills in from Workamajig${admin ? `, or connect a project-plan Google Sheet above` : ""}.</div>`}</div>`;
}

/* ---------- Project Plan from a connected Google Sheet (the Gantt-plan view) ----------
   Reads columns A-H of a TJA project-plan sheet (see CLIENT_PR_SHEETS.parseProjectPlan).
   Phase-grouped like the Status page; each task shows owner (WHO), date range, % and a
   status badge. The connected sheet is client-facing — project plans are shared work. */
function renderPlanSheet(e, admin) {
  const p = e.projectPlanSheet, m = p.meta || {};
  const whoClass = (w) => { const s = (w || "").toLowerCase(); return /tja/.test(s) ? "tja" : (/both/.test(s) ? "both" : (w ? "client" : "")); };
  let done = 0, total = 0;
  p.groups.forEach(g => g.tasks.forEach(t => { total++; if (t.status === "complete") done++; }));
  const pct = (m.condition && m.condition.pct != null) ? m.condition.pct : (total ? Math.round(done / total * 100) : 0);
  const lvl = (m.condition && m.condition.level) || "green";
  const body = p.groups.map(g => {
    const gdone = g.tasks.filter(t => t.status === "complete").length;
    return `<div class="plan-phase">
      <div class="plan-phase-head">
        <span class="plan-phase-name">${g.num ? `<span class="plan-gnum">${esc(g.num)}</span> ` : ""}${esc(g.name)}</span>
        <span class="grp-count">${gdone}/${g.tasks.length} complete</span>
      </div>
      ${g.tasks.map(t => `
        <div class="plan-task"${t.dep ? ` title="Depends on ${esc(t.dep)}"` : ""}>
          <span class="task-dot ${t.status}"></span>
          <span class="plan-task-name">${t.num ? `<span class="plan-tnum">${esc(t.num)}</span> ` : ""}${esc(t.task)}${(t.notes && !/complet|progress/i.test(t.notes)) ? ` <span class="task-note">${esc(t.notes)}</span>` : ""}</span>
          ${t.who ? `<span class="plan-who ${whoClass(t.who)}">${esc(t.who)}</span>` : ""}
          ${(t.start || t.end) ? `<span class="plan-dates">${esc(t.start || "")}${(t.end && t.end !== t.start) ? " – " + esc(t.end) : ""}</span>` : ""}
          <span class="plan-task-status">${badge(t.status)}</span>
        </div>`).join("")}
    </div>`;
  }).join("");
  return `
  ${admin ? `<div class="admin-hint">✎ Admin — this plan is read from the connected Google Sheet. Edit the sheet, then hit “Change / refresh” to re-pull.</div>` : ""}
  <div class="page-head">
    <div class="page-title">Project Plan</div>
    <div class="page-desc">${esc(m.title || e.label || e.name || "Project")}</div>
    ${planConnectBtn(e, admin)}
  </div>
  <div class="plan-card plan-sheet-summary">
    ${m.outcome ? `<div class="plan-row"><span class="plan-lbl">Outcome</span><span class="plan-outcome">${esc(m.outcome)}</span></div>` : ""}
    ${m.deliverables ? `<div class="plan-row"><span class="plan-lbl">Deliverables</span><span>${esc(m.deliverables)}</span></div>` : ""}
    ${(m.startDate || m.endDate) ? `<div class="plan-row"><span class="plan-lbl">Timeline</span><span>${esc(m.startDate || "?")} → ${esc(m.endDate || "?")}${m.weeks ? ` · ${esc(m.weeks)} weeks` : ""}</span></div>` : ""}
    <div class="plan-row"><span class="plan-lbl">Condition</span>
      <span class="plan-cond ${lvl}">${esc(lvl.toUpperCase())}</span>
      <div class="bar plan-bar"><span style="width:${pct}%"></span></div><span class="plan-pct">${pct}%</span></div>
  </div>
  <div class="plan-phases">${body}</div>`;
}
let planWired = false;
function initPlan() {
  if (planWired) return; planWired = true;
  const page = document.querySelector('.page[data-page="plan"]');
  page.addEventListener("focusout", e => {
    const f = e.target.closest("[data-plan]"); if (!f) return;
    setPath(getEng(), f.dataset.plan, f.textContent.trim()); saveState();
  });
  page.addEventListener("click", async ev => {
    const conn = ev.target.closest("[data-planconnect]"); if (!conn) return;
    const raw = await window.TJA_UI.prompt(
      "Paste the project-plan link.\n\n• A PRIVATE Drive file (.xlsx or Google Sheet) is read securely by the portal's backend — share it with the service account first.\n• A public Google Sheet (“Anyone with the link – Viewer”) is read directly.\n\nWe read columns A–H: #, Task, Who, Dependency, Start, End, % Done, Notes. The timeline grid (columns I onward) is ignored.\n\n⚠ The plan renders CLIENT-FACING — everything in those columns (including Notes) is visible to the client.",
      { title: "Connect project-plan sheet", value: (getEng().projectPlanSheetUrl) || "", okText: "Connect" });
    if (raw == null) return;
    const reg = window.CLIENT_PR_SHEETS;
    // Re-resolve the engagement AFTER every await — the auto-refresh can adopt a new
    // STATE while the prompt/fetch is in flight, and writing to the old (detached)
    // object would silently discard the connect.
    if (!raw.trim()) { const eng = getEng(); delete eng.projectPlanSheet; delete eng.projectPlanSheetUrl; saveState(); repaint("plan"); return; }
    conn.disabled = true; conn.textContent = "Connecting…";
    const store = (parsed) => { const eng = getEng(); eng.projectPlanSheet = parsed; eng.projectPlanSheetUrl = raw.trim(); saveState(); repaint("plan"); };

    // 1) A public native Google Sheet → read the CSV directly in the browser (no backend needed).
    const cfg = reg && reg.parseSheetUrl(raw);
    if (cfg && /docs\.google\.com\/spreadsheets/.test(raw)) {
      try {
        const res = await fetch(reg.csvUrl(cfg), { cache: "no-store" });
        if (res.ok) {
          const parsed = reg.parseProjectPlan(await res.text());
          if (parsed && parsed.groups.length) { store(parsed); return; }
        }
      } catch (e) { /* fall through to the backend */ }
    }
    // 2) A private file (.xlsx or private Sheet) → the backend reads it via the Drive service account.
    const srv = await planServerFetch(raw, clientId());
    if (srv.ok && srv.plan && srv.plan.groups && srv.plan.groups.length) { store(srv.plan); return; }
    repaint("plan");
    if (srv.status === 503) window.TJA_UI.alert("That looks like a private file. Reading private plans needs the Google Drive service account configured (GOOGLE_SA_KEY) — not set up yet. For now a public Google Sheet link works, or finish the service-account setup.");
    else if (srv.status === 404) window.TJA_UI.alert("The portal's service account can't see that file yet. Share the file (or its Drive folder) with the service account's email as Viewer, then try again.");
    else if (srv.status === 403) window.TJA_UI.alert("Only staff can connect a project-plan sheet.");
    else window.TJA_UI.alert(srv.error || "Couldn't read a project plan from that link — check it has the #, Task, Who, Dependency, Start, End, % Done, Notes columns.");
  });
}

// Ask the plan-fetch Edge Function to read a PRIVATE plan file from Drive (via the
// service account) and return it parsed. Used as the fallback when the browser can't
// read the file itself (uploaded .xlsx, or a Sheet that isn't publicly shared).
async function planServerFetch(fileUrl, cid) {
  try {
    const cfg = window.SUPABASE_CONFIG || {};
    const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
    if (!base || !(window.SUPA && window.SUPA.enabled && window.SUPA.client)) return { ok: false, status: 0, error: "backend unavailable" };
    const { data } = await window.SUPA.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) return { ok: false, status: 401, error: "not signed in" };
    const r = await fetch(base + "/plan-fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ fileUrl, clientId: cid }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, plan: j.plan, error: j.error };
  } catch (e) { return { ok: false, status: 0, error: String(e) }; }
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
  // "All clients" / "My clients" is a staff nav — hide it in client view (incl. staff
  // previewing as client). Managers were missing here (added when schema-v7 introduced
  // the role) — an AM/PM had no way back to the picker once inside a client.
  const staffRole = effRole === "admin" || effRole === "manager" || effRole === "creative";
  const cb = el("#clientsBack");
  if (cb) {
    cb.style.display = staffRole ? "" : "none";
    cb.textContent = effRole === "manager" ? "My clients" : "All clients";
  }
  const rc = el("#roleControls");
  if (typeof isStaff === "function" && isStaff()) {
    const prev = isPreviewing();
    const admin = isAdminOrManager();
    const pillBase = (typeof roleLabel === "function") ? roleLabel(getSession() && getSession().role) : "Admin";
    // Undo drives saveState() → dashboard-scope writes that RLS rejects for creatives,
    // so only the agency account + AM/PMs get the button.
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

// Monthly Services is now opt-IN (an explicit "+ Add" click), not implied by the
// engagement's registry "kind" — a client can be rostered "project" but still pick this
// up later. `tabAdded` is set the moment someone clicks Add (even before any real data
// exists, so the tab doesn't vanish again while they're still filling it in). `tabHidden`
// is a pure UI hide — set by "Hide Monthly Services tab"; nothing underneath is touched,
// so un-hiding brings everything back exactly as it was.
function retainerEnabled() {
  const r = STATE.engagements.retainer;
  return !!(r && (r.tabAdded || retainerHasData()));
}
function retainerHidden() {
  const r = STATE.engagements.retainer;
  return !!(r && r.tabHidden);
}

function applyEngagement() {
  const tog = el("#engToggle");
  const actions = el("#engActions");
  // Admin AND manager (full editors — see auth.js canEdit) always see both toggles so
  // they can set either one up; creatives/clients only see an engagement that actually
  // has data — no empty Monthly Services / Projects.
  const canManage = (typeof isAdminOrManager === "function") ? isAdminOrManager() : true;
  const hidden = retainerHidden();
  const enabled = retainerEnabled();
  const hasRet = !hidden && (canManage ? enabled : retainerHasData());
  const hasProj = canManage || getProjects().length > 0;

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

  if (actions) {
    if (!canManage) actions.innerHTML = "";
    else if (!enabled) actions.innerHTML = `<button class="btn btn-ghost" id="addRetainerBtn">＋ Add Monthly Services</button>`;
    else if (hidden) actions.innerHTML = `<button class="btn btn-ghost" id="showRetainerBtn">Show Monthly Services tab</button>`;
    else if (isRetainer()) actions.innerHTML = `<button class="btn btn-ghost" id="hideRetainerBtn" title="Hides the tab only — nothing is deleted">Hide Monthly Services tab</button>`;
    else actions.innerHTML = "";
  }

  // topbar identity: client name (set once) + engagement label. The headline goal lives in its own
  // full-width banner at the top of the Executive Summary, and only on projects — retainers carry
  // their direction in the Sprint Goals tile instead (see exec-summary.js goalBanner).
  const eng = getEng();
  const onFolder = !isRetainer() && !selectedProject();
  el("#clientMeta").textContent = "· " + (isRetainer() ? "Monthly Services" : (onFolder ? "Projects" : (eng.label || eng.name)));
  const ns = el("#clientNorthstar");
  if (ns) ns.innerHTML = "";
  el("#navBacklog").style.display = isRetainer() ? "" : "none";   // Backlog = Monthly-Services-only
  // Project Plan lives on any project-type client with at least one project — including
  // the folder/tile-picker view, not just once a specific project is open.
  const planOk = !isRetainer() && getProjects().length > 0;
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

  // Monthly Services add/hide (admin + manager) — see applyEngagement() for the state machine.
  document.getElementById("engActions").addEventListener("click", async e => {
    const addBtn = e.target.closest("#addRetainerBtn, #showRetainerBtn");
    if (addBtn) {
      const r = STATE.engagements.retainer || (STATE.engagements.retainer = clone(D.engagements.retainer));
      r.tabAdded = true; r.tabHidden = false;
      setEngMode("retainer");
      saveState();
      applyEngagement();
      document.querySelectorAll(".page").forEach(p => { p.dataset.painted = ""; p.innerHTML = ""; });
      activate("exec");
      return;
    }
    const hideBtn = e.target.closest("#hideRetainerBtn");
    if (hideBtn) {
      if (!(await window.TJA_UI.confirm("Hide the Monthly Services tab? Nothing is deleted — bring it back anytime with “Show Monthly Services tab.”", { title: "Hide Monthly Services", okText: "Hide tab" }))) return;
      const r = STATE.engagements.retainer; if (!r) return;
      r.tabHidden = true;
      saveState();
      applyEngagement();
      document.querySelectorAll(".page").forEach(p => { p.dataset.painted = ""; p.innerHTML = ""; });
      activate("exec");
    }
  });

  // North Star / due-date edits made in the topbar
  el("#clientNorthstar").addEventListener("focusout", e => {
    const f = e.target.closest("[data-tbpath]"); if (!f) return;
    setPath(getEng(), f.dataset.tbpath, f.textContent.trim()); saveState();
  });

  // Ghost-session guard BEFORE the pulls: a per-tab session whose Supabase auth has
  // died reads zero rows through RLS with no error, so without this check the page
  // silently renders this device's cached copy as if it were live. Force a re-login
  // instead — the login page rebuilds honestly (or actually asks for the password).
  const liveSession = (typeof ensureLiveSession === "function") ? await ensureLiveSession() : "ok";
  if (liveSession === "ghost") { await logout(); return; }

  // Live data: pull from Supabase when configured (otherwise stay on localStorage).
  // The scopes pull IN PARALLEL (each self-times-out in the sync layer), so a slow
  // or unreachable backend delays boot by at most one timeout, never the sum.
  // The waiting-room scope is STAFF-ONLY: a client's pull would be an RLS-guaranteed
  // null (they can't read the row), so don't even ask.
  let dashPulled = false;
  if (window.SUPA && window.SUPA.enabled) {
    try {
      const cid = clientId();
      const staff = (typeof isStaff === "function") && isStaff();
      const [dashFull, files, dels, drafts] = await Promise.all([
        // FULL pull for the dashboard: seeds the guarded-write baseline (updated_at)
        window.SUPA.pullScopeFull ? window.SUPA.pullScopeFull(cid, "dashboard") : window.SUPA.pullScope(cid, "dashboard").then(d => d && { data: d }),
        window.SUPA.pullScope(cid, "files"),
        window.SUPA.pullScope(cid, "deliverables"),
        staff ? window.SUPA.pullScope(cid, "deliverables_draft") : Promise.resolve(null),
      ]);
      const dash = dashFull && dashFull.data;
      if (dash && dash.engagements) { STATE = migrate(dash); lastSnapshot = clone(STATE); dashPulled = true; try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch {} }
      if (files) { try { localStorage.setItem(FILES_KEY, JSON.stringify(files)); } catch {} }
      if (dels) { try { localStorage.setItem("tja_deliverables_" + cid, JSON.stringify(dels)); } catch {} }
      if (drafts) { try { localStorage.setItem("tja_deliverables_draft_" + cid, JSON.stringify(drafts)); } catch {} }
    } catch (e) { console.warn("Supabase boot sync failed; using local data.", e); }
  }
  // If live data did NOT land (library never loaded, pull timed out, or a genuinely
  // missing row), say so on screen — silently presenting the cached copy as current
  // is how a whole afternoon got lost to "why does her machine show 0%".
  if (liveSession === "nolib" || (window.SUPA && window.SUPA.enabled && !dashPulled)) {
    const warn = document.createElement("div");
    warn.className = "presence-banner";
    warn.innerHTML = liveSession === "nolib"
      ? "⚠ The live-sync library couldn't load (network filter or offline?) — this is <b>this device's cached copy</b>, and nothing viewed or edited here is syncing."
      : "⚠ Couldn't load this client's live data — showing <b>this device's cached copy</b>. Check your connection and refresh to retry.";
    const anchor = el("#previewBanner");
    if (anchor) anchor.parentNode.insertBefore(warn, anchor);
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
  // Prefers an admin-pasted link (eng.prSheetUrl, set from the PR Coverage tile's "Connect
  // sheet" button); falls back to the legacy hardcoded registry for clients set up before that.
  (function refreshPRForCurrent() {
    try {
      const reg = window.CLIENT_PR_SHEETS;
      const ret = STATE.engagements && STATE.engagements.retainer;
      if (!reg || !ret) return;
      const cfg = (ret.prSheetUrl && reg.parseSheetUrl(ret.prSheetUrl)) || reg.forClient(clientId());
      if (!cfg) return;
      refreshPRSheet(ret, cfg).then(changed => {
        if (!changed) return;
        saveState();
        if (currentPage() === "exec") repaint("exec");
      });
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
  // deep-link: a notification-center click or the deliverable email asks to land on a
  // specific page (e.g. Present Docs), optionally on a specific deliverable (?open=docs&doc=<id>).
  let openHint = null, openDocId = null;
  try {
    openHint = sessionStorage.getItem("tja_open_page"); sessionStorage.removeItem("tja_open_page");
    openDocId = sessionStorage.getItem("tja_open_doc"); sessionStorage.removeItem("tja_open_doc");
  } catch (e) {}
  const landOn = openHint && document.querySelector(`.page[data-page="${openHint}"]`) ? openHint : bootPage;
  activate(landOn);
  // If the email deep-linked to a specific deliverable, open it once Present Docs is painted.
  if (openDocId && landOn === "docs" && window.PresentDocs && window.PresentDocs.openDoc) {
    window.PresentDocs.openDoc(openDocId);
  }

  /* ---------- live auto-refresh ----------
     Open tabs go stale: someone else edits this client (or a sync/snapshot runs), and your
     tab keeps showing the version it loaded — the exact thing behind "her machine still shows
     0%". PRIMARY path is a Realtime websocket (SUPA.subscribeScope): the instant the row
     changes, we pull + adopt the new version and repaint, so tabs converge in ~1-2s without a
     manual refresh. A slow 30s poll is the FALLBACK that still converges if the socket drops or
     reconnects. It NEVER interrupts an in-progress edit (defers while a field is focused), and
     it only adopts when the tab is visible (plus an immediate catch-up the moment you refocus a
     backgrounded tab). The guarded write still protects the rare simultaneous-save; this just
     makes staleness the exception. (Dashboard scope only — Present Docs/Files own their own
     state + sync on action.) */
  (function startAutoRefresh() {
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.pollScope)) return;
    const cid = clientId();
    let busy = false, pending = false;
    const editingNow = () => {
      const a = document.activeElement;
      return !!(a && (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA"));
    };
    // repaintAll() rebuilds every page's innerHTML — including the Present Docs modal,
    // the upload brief, a TJA_UI dialog, or the burn popup if one is open. Adopting mid-
    // interaction would destroy unsaved annotations/uploads, so any open overlay defers
    // the adopt (the 30s poll / refocus catches up after it closes).
    const overlayOpen = () => {
      if (document.querySelector("#pdModal.open, #tjaDialog, #burnPop")) return true;
      const up = document.getElementById("pdUpOverlay");
      return !!(up && up.style.display !== "none");
    };
    async function tick() {
      // if a change arrives mid-edit, remember it and re-run once the edit ends (on blur)
      if (busy) return;
      if (document.hidden || editingNow() || overlayOpen()) { pending = true; return; }
      // NEVER adopt while our own write is queued/in-flight: adopting advances lastKnown,
      // which would let the queued guarded write CAS-succeed and silently clobber the
      // remote change. Deferring lets the CAS fail → conflict banner (the designed path).
      if (window.SUPA.hasPendingWrite && window.SUPA.hasPendingWrite(cid, "dashboard")) { pending = true; return; }
      busy = true; pending = false;
      try {
        const d = await window.SUPA.pollScope(cid, "dashboard");
        if (d.changed && d.data && d.data.engagements) {
          STATE = migrate(d.data);
          lastSnapshot = clone(STATE);
          try { localStorage.setItem(STATE_KEY, JSON.stringify(STATE)); } catch (e) {}
          window.SUPA.markScopeSeen(cid, "dashboard", d.updated_at);
          applyEngagement();
          repaintAll();
          flashRefreshed();
        }
      } catch (e) { /* transient — next tick */ }
      finally { busy = false; }
    }
    // INSTANT: a Realtime websocket event on this client fires an immediate pull.
    if (window.SUPA.subscribeScope) {
      window.SUPA.subscribeScope(cid, (payload) => {
        if (!payload || !payload.new || payload.new.scope === "dashboard") tick();
      });
    }
    // FALLBACK: a slow poll (30s) still converges if the websocket drops/reconnects, plus an
    // immediate catch-up when a field blurs or a backgrounded tab is refocused.
    setInterval(tick, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
    window.addEventListener("focus", tick);
    document.addEventListener("focusout", () => { if (pending) setTimeout(tick, 150); });
  })();
})();

// subtle, non-blocking "just refreshed" pill (auto-fades) so a live repaint isn't mysterious
let refreshPill = null, refreshPillTimer = null;
function flashRefreshed() {
  if (!refreshPill) {
    refreshPill = document.createElement("div");
    refreshPill.className = "refresh-pill";
    refreshPill.textContent = "↻ Updated with the latest changes";
    document.body.appendChild(refreshPill);
  }
  refreshPill.classList.add("show");
  clearTimeout(refreshPillTimer);
  refreshPillTimer = setTimeout(() => refreshPill.classList.remove("show"), 2600);
}
