/* ============================================================
   EXECUTIVE SUMMARY — the homepage (V1, v1.7)

   The one screen a CEO/CMO opens to understand their engagement.
   Modules: header + North Star, Burn (speedometer / pizza tracker),
   Condition, Service Lines (+ MoM), Milestones, To-Do's,
   Dependencies, KPIs, PR Coverage.

   Every field is admin-editable (inline) and read-only in client
   view. Edits persist via window.DASH (state in localStorage).
   ============================================================ */

window.ExecSummary = (function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const canAdmin = () => (typeof canEdit === "function" ? canEdit() : true);
  const section = () => document.querySelector('.page[data-page="exec"]');
  let viewMonthIdx = null;   // retainer MoM view (null = current)
  let burnPreviewPct = null; // transient dial position while dragging the burn (before the distribute popup)
  let unallocOpen = false;   // admin: is the Unallocated drill-down expanded?

  /* ---- line icons (brand: custom vector icons + bolt motif) ---- */
  const svg = (p, o) => `<svg viewBox="0 0 24 24" fill="${o ? "currentColor" : "none"}" stroke="${o ? "none" : "currentColor"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const IC = {
    burn:   svg('<path d="M3 13a9 9 0 0 1 18 0"/><path d="M12 13l4-2.5"/><circle cx="12" cy="13" r="1.4"/>'),
    cond:   svg('<path d="M3 12h4l2.5 7 5-14 2.5 7h4"/>'),
    svc:    svg('<path d="M12 3l8.5 4.5L12 12 3.5 7.5 12 3z"/><path d="M3.5 12L12 16.5 20.5 12"/>'),
    flag:   svg('<path d="M5 21V4M5 4h11l-2 3.5L16 11H5"/>'),
    todo:   svg('<path d="M9 11l2.5 2.5L21 4"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10"/>'),
    dep:    svg('<path d="M10.5 13a4 4 0 0 0 5.5 0l2-2a4 4 0 0 0-5.5-5.5l-1 1"/><path d="M13.5 11a4 4 0 0 0-5.5 0l-2 2a4 4 0 0 0 5.5 5.5l1-1"/>'),
    kpi:    svg('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>'),
    pr:     svg('<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M16 9a4 4 0 0 1 0 6"/>'),
    bolt:   svg('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>', true),
    cal:    svg('<rect x="3" y="4.5" width="18" height="16" rx="2"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>'),
  };

  /* ---- inline editable field ---- */
  function ed(val, path, opts = {}) {
    const cls = "ed" + (opts.cls ? " " + opts.cls : "");
    if (canAdmin()) {
      return `<${opts.block ? "div" : "span"} class="${cls}" contenteditable="true" data-path="${path}"` +
        `${opts.num ? ' data-num="1"' : ""}${opts.rerender ? ' data-rerender="1"' : ""}>${esc(val)}</${opts.block ? "div" : "span"}>`;
    }
    return `<${opts.block ? "div" : "span"} class="${cls}">${esc(val)}</${opts.block ? "div" : "span"}>`;
  }

  /* ---- speedometer gauge ---- */
  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; }
  function arc(cx, cy, r, s, e) { const a = polar(cx, cy, r, e), b = polar(cx, cy, r, s); return `M ${a.x} ${a.y} A ${r} ${r} 0 ${e - s <= 180 ? 0 : 1} 0 ${b.x} ${b.y}`; }
  function gauge(pct, interactive) {
    const p = Math.max(0, Math.min(100, pct)), cx = 130, cy = 140, r = 100, S = -120, E = 120, S2 = E - S;
    const nd = S + p / 100 * S2, tip = polar(cx, cy, r - 20, nd), back = polar(cx, cy, 14, nd + 180);
    let ticks = "";
    for (let i = 0; i <= 10; i++) {
      const d = S + i / 10 * S2, o = polar(cx, cy, r, d), inn = polar(cx, cy, r - (i % 5 === 0 ? 15 : 9), d);
      ticks += `<line x1="${o.x}" y1="${o.y}" x2="${inn.x}" y2="${inn.y}" stroke="${i % 5 === 0 ? "#9a9a9f" : "#48484e"}" stroke-width="${i % 5 === 0 ? 2.2 : 1.4}"/>`;
    }
    return `<svg viewBox="0 25 260 180" width="100%" style="max-width:180px${interactive ? ";cursor:grab;touch-action:none" : ""}" class="gauge-svg${interactive ? " gauge-drag" : ""}">
      <defs><linearGradient id="gz2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#EFAE41"/><stop offset="0.55" stop-color="#EC9C39"/><stop offset="1" stop-color="#DA662A"/></linearGradient></defs>
      <path d="${arc(cx, cy, r, S, E)}" fill="none" stroke="rgba(130,130,140,.22)" stroke-width="14" stroke-linecap="round"/>
      <path d="${arc(cx, cy, r, S, nd)}" fill="none" stroke="url(#gz2)" stroke-width="14" stroke-linecap="round"/>
      ${ticks}
      ${interactive ? `<path d="${arc(cx, cy, r, S, E)}" fill="none" stroke="transparent" stroke-width="34" class="gauge-hit"/>` : ""}
      <line x1="${back.x}" y1="${back.y}" x2="${tip.x}" y2="${tip.y}" stroke="#F68E21" stroke-width="3.5" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="9" fill="#F68E21" stroke="rgba(128,128,128,.35)" stroke-width="2"/>
    </svg>`;
  }

  /* ---- condition (merged into the burn tile) ---- */
  // due date ⇄ ISO (<input type="date"> needs YYYY-MM-DD; we store "MMM D, YYYY")
  function dueToISO(s) {
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s); if (isNaN(d)) return "";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function isoToDue(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return iso || "";
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  function conditionInline(e) {
    const c = e.condition || { level: "green", note: "" }, lvl = c.level;
    const labels = { green: "On Track", yellow: "Needs Attention", red: "Off Track" };
    const dot = (col) => `<span class="cond-dot ${col} ${lvl === col ? "on" : ""} ${canAdmin() ? "admin-edit" : ""}" data-cond="${col}" ${canAdmin() ? `title="Set to ${col}"` : ""}></span>`;
    // projects show their due date prominently right in the condition area —
    // admins get a calendar picker; clients see the formatted date
    const dueVal = canAdmin()
      ? `<input type="date" class="proj-due-input" data-projdue value="${dueToISO(e.dueDate)}" title="Set the due date">`
      : `<span class="proj-due-date">${esc(e.dueDate || "—")}</span>`;
    const due = (e.type === "project")
      ? `<div class="proj-due"><span class="proj-due-cal">${IC.cal}</span><span class="proj-due-label">Due date</span>${dueVal}</div>`
      : "";
    return `<div class="burn-cond">
      ${due}
      <div class="burn-cond-row"><span class="bc-label">${IC.cond}Condition</span><span class="cond-label ${lvl}">${labels[lvl] || "—"}</span><span class="cond-dots">${dot("green")}${dot("yellow")}${dot("red")}</span></div>
      <div class="cond-note">${ed(c.note, "condition.note")}</div>
    </div>`;
  }

  /* ---- monthly history (retainer) — keep every past month so nothing is lost ---- */
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function syncCurrentMonth(eng) {           // mirror the live burn into the persisted month-history array
    if (!eng || !eng.burn) return;
    eng.mom = eng.mom || [];
    // for disciplines-driven retainers, the live burn = Σ used across disciplines
    const usedNow = (eng.serviceDisciplines && eng.serviceDisciplines.length) ? round2(retainerUsed(eng)) : eng.burn.usedHours;
    const totalNow = retainerTotalContracted(eng);
    eng.burn.usedHours = usedNow; eng.burn.contractedHours = totalNow;
    const cur = (eng.burn.periodLabel || "").trim().slice(0, 3);
    const last = eng.mom[eng.mom.length - 1];
    if (last && last.month === cur) { last.usedHours = usedNow; last.contractedHours = totalNow; }
    else eng.mom.push({ month: cur, usedHours: usedNow, contractedHours: totalNow });
  }
  function nextMonthLabel(periodLabel) {
    const parts = (periodLabel || "").trim().split(/\s+/);
    let mi = MONTHS.findIndex(m => m.toLowerCase() === (parts[0] || "").toLowerCase());
    let year = parseInt(parts[1], 10);
    if (mi < 0) mi = 0;
    if (isNaN(year)) year = 2026;
    mi += 1; if (mi > 11) { mi = 0; year += 1; }
    return { full: `${MONTHS[mi]} ${year}`, short: MONTHS[mi].slice(0, 3) };
  }

  /* ---- list helpers ---- */
  const owners = (o) => (o === "TJA" ? "tja" : "client");
  function listDel(list, i) { return canAdmin() ? `<button class="row-del" data-listdel="${list}" data-idx="${i}" title="Remove">✕</button>` : ""; }
  function listAdd(list, label) { return canAdmin() ? `<button class="row-add" data-listadd="${list}">＋ ${esc(label)}</button>` : ""; }

  /* ---- modules ---- */
  function burnModule(e) {
    if (e.type === "project") {
      const admin = canAdmin();
      const manual = !!(e.pizza && e.pizza.manual);   // editable tracker (not-completed); completed = WMJ, read-only
      const cap = manual ? 24 : 8;
      const allPhases = e.pizza.phases || [];
      const ph = allPhases.slice(0, cap);
      const cur = ph.findIndex(p => !p.done);
      const steps = ph.map((p, i) => {
        const state = p.done ? "done" : (i === cur ? "current" : "");
        const label = (admin && manual)
          ? ed(p.label, "pizza.phases." + i + ".label", { rerender: false })   // editable step name
          : esc(p.label);
        const del = (admin && manual && allPhases.length > 1)
          ? `<button class="pizza-del" data-delstep="${i}" title="Remove this step">✕</button>` : "";
        return `<div class="pizza-step ${state}"><div class="pizza-dot ${admin ? "admin-edit" : ""}" data-phase="${i}" ${admin ? `title="Toggle complete"` : ""}>${p.done ? "✓" : i + 1}</div><div class="pizza-label">${label}${del}</div></div>`;
      }).join("");
      const pct = allPhases.length ? Math.round(allPhases.filter(p => p.done).length / allPhases.length * 100) : (e.progressPct || 0);
      return `<div class="module">
        <div class="module-head"><span class="module-title">${IC.burn}Project Progress · ${pct}%</span></div>
        <div class="pizza">${steps}</div>
        ${(admin && manual) ? `<div class="pizza-controls"><button class="row-add" data-addstep>＋ Add step</button></div>` : ""}
        ${admin ? `<div class="burn-edit">${manual ? "Click a dot to mark it complete · edit the names · ✕ removes a step" : "Click a phase to mark it complete."}</div>` : ""}
        ${conditionInline(e)}
      </div>`;
    }
    // retainer speedometer. Contracted hours = sum of the disciplines; hours used come from the
    // WMJ timesheet. Admins can DRAG the dial to override the shown total % for a presentation;
    // the real hours stay in the subtext, and "Reset to actuals" (Service Lines) clears it.
    const b = (viewMonthIdx == null) ? e.burn : e.mom[viewMonthIdx];
    const total = (viewMonthIdx == null) ? retainerTotalContracted(e) : b.contractedHours;
    const used = (viewMonthIdx == null) ? round2(retainerUsed(e)) : b.usedHours;   // burn = SUM of the disciplines' used hrs
    const realPct = total > 0 ? Math.round(used / total * 100) : 0;
    const hasOv = viewMonthIdx == null && !!(e.svcUtilOverride && Object.keys(e.svcUtilOverride).length);
    const pct = (burnPreviewPct != null && viewMonthIdx == null) ? burnPreviewPct : realPct;   // needle follows the drag
    const actualUsed = round2(retainerActualUsed(e));
    const mom = (e.mom || []).map((m, i) => {
      const active = (viewMonthIdx == null) ? (i === e.mom.length - 1) : (i === viewMonthIdx);
      const mp = m.contractedHours > 0 ? Math.round(m.usedHours / m.contractedHours * 100) : 0;
      return `<div class="mom-chip ${active ? "active" : ""}" data-mom="${i}" title="View ${esc(m.month)}"><div class="m">${esc(m.month)}</div><div class="v">${mp}%</div></div>`;
    }).join("");
    const unset = viewMonthIdx == null && total <= 0;   // no contracted hours entered yet
    const interactive = canAdmin() && viewMonthIdx == null && !unset;
    const bigPct = unset ? `—`
      : canAdmin() ? `<span class="ed burn-pct" contenteditable="true" data-burnpct="1">${pct}</span>%`
      : `${pct}%`;
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.burn}Retainer Burn${e.burn.periodLabel ? " · " + esc(e.burn.periodLabel) : ""}</span></div>
      <div class="burn-wrap">
        ${gauge(unset ? 0 : pct, interactive)}
        <div class="burn-readout">
          <div class="big">${bigPct}${canAdmin() && hasOv ? ` <span class="rsvc-adj">adj</span>` : ""}</div>
          ${unset
            ? `<div class="sub">${used} hrs billable${canAdmin() ? " · set contracted hours below" : ""}</div>
               ${(canAdmin() && e.retainerValueHasPending) ? `<div class="burn-hint">a pending (unsigned) SOW exists — it isn't counted until signed</div>` : ""}`
            : canAdmin()
            ? `<div class="sub">${used} of ${total} hrs used${hasOv ? ` · actual ${actualUsed}` : ""}</div>`
            : `<div class="sub">${pct}% of contracted hours used</div>`}
        </div>
      </div>
      ${mom ? `<div class="mom-strip">${mom}</div>` : ""}
      ${canAdmin() ? `<button class="row-add mom-newmonth" data-newmonth title="Save this month to history and roll into the next">＋ New month</button>` : ""}
      ${conditionInline(e)}
    </div>`;
  }

  function conditionModule(e) {
    const c = e.condition, lvl = c.level;
    const labels = { green: "On Track", yellow: "Needs Attention", red: "Off Track" };
    const dot = (col) => `<div class="cond-dot ${col} ${lvl === col ? "on" : ""} ${canAdmin() ? "admin-edit" : ""}" data-cond="${col}" ${canAdmin() ? `title="Set to ${col}"` : ""}></div>`;
    return `<div class="module cond-module">
      <div class="module-head"><span class="module-title">${IC.cond}${e.type === "project" ? "Project" : "Engagement"} Condition</span></div>
      <div class="condition">
        <div class="cond-dots">${dot("green")}${dot("yellow")}${dot("red")}</div>
        <div class="cond-label ${lvl}">${labels[lvl] || "—"}</div>
      </div>
      <div class="cond-note">${ed(c.note, "condition.note")}</div>
    </div>`;
  }

  // stable key for a WMJ task (survives re-sync); admin visibility overrides are stored by it
  const taskKey = (t) => (t.phase || "") + "|" + (t.name || "");
  // effective "internal" = admin override if set, else the rule-based flag from the transform
  function taskInternal(e, t) {
    const ov = (e.taskInternalOverride || {})[taskKey(t)];
    return (ov === true || ov === false) ? ov : !!t.internal;
  }
  // Projects show a WMJ-fed "Tasks" module (grouped by phase) instead of Service Lines.
  function tasksModule(e) {
    const admin = canAdmin();
    const all = Array.isArray(e.wmjTasks) ? e.wmjTasks : [];
    const tasks = admin ? all : all.filter(t => !taskInternal(e, t));
    const order = (e.pizza && e.pizza.phases) ? e.pizza.phases.map(p => p.label) : [];
    const groups = {};
    tasks.forEach(t => { (groups[t.phase] = groups[t.phase] || []).push(t); });
    const names = Object.keys(groups).sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); });
    const stCls = { Completed: "complete", Production: "in-progress", "On Hold": "on-hold" };
    const body = names.map(pn => `
      <div class="task-group">
        <div class="task-group-head">${esc(pn)}</div>
        ${groups[pn].map(t => { const internal = taskInternal(e, t); return `
          <div class="task-row${internal ? " is-internal" : ""}">
            <span class="task-dot ${stCls[t.status] || "pending"}" title="${esc(t.status)}"></span>
            <span class="task-name">${esc(t.name)}${internal ? ` <span class="task-int">internal</span>` : ""}</span>
            ${t.service ? `<span class="task-svc">${esc(t.service)}</span>` : ""}
            ${admin ? `<button class="task-vis" data-taskvis="${esc(taskKey(t))}" title="${internal ? "Internal — click to show the client" : "Client-visible — click to make internal"}">${internal ? "🔒 Internal" : "👁 Client"}</button>` : ""}
          </div>`; }).join("")}
      </div>`).join("");
    return `<div class="module module--tasks">
      <div class="module-head"><span class="module-title">${IC.svc}Tasks</span><span class="module-link" data-go="status">View status →</span></div>
      <div class="task-list-wrap">${body || `<div class="pr-date">No tasks yet.</div>`}</div>
    </div>`;
  }

  // Retainer service lines fed from WMJ: name = User_Department, a share-of-retainer
  // % (allocated ÷ total allocated, sums to 100) and a utilization bar (billable ÷
  // allocated for that line — how much of its hours are used up).
  const canon = (s) => (window.tjaCanonDiscipline ? window.tjaCanonDiscipline(s) : String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  const round2 = (n) => Math.round((+n || 0) * 100) / 100;
  // total monthly contracted hours: the admin's per-discipline budgets when entered; otherwise
  // fall back to the SOW-derived total from the retainer-value feed (signed retainer $ ÷ rate ÷ 12).
  // The TOTAL is real contract data — only the per-discipline SPLIT stays manual (never guessed).
  // A stored SOW value is only usable if it came from the ACTIVE-MONTH formula
  // (retainerValueMonthly). Stale ÷12 estimates persisted by older builds are ignored
  // outright — a client renders "—" for a few seconds and then the exact number lands,
  // but a wrong number is never shown.
  function sowTargetUsable(e) {
    return e.retainerValueMonthly === true && e.retainerValueTarget != null && +e.retainerValueTarget > 0;
  }
  function retainerTotalContracted(e) {
    const d = e.serviceDisciplines;
    const disc = (Array.isArray(d) && d.length) ? d.reduce((s, x) => s + (+x.contracted || 0), 0) : 0;
    if (disc > 0) return disc;
    if (sowTargetUsable(e)) return +e.retainerValueTarget;
    return (e.burn && +e.burn.contractedHours) || 0;
  }
  // is the total currently coming from the SOW feed (no discipline hours entered yet)?
  function usingSowTotal(e) {
    const d = e.serviceDisciplines;
    const disc = (Array.isArray(d) && d.length) ? d.reduce((s, x) => s + (+x.contracted || 0), 0) : 0;
    return disc <= 0 && sowTargetUsable(e);
  }
  // keep the burn denominator in step with the disciplines (total contracted = their sum)
  function syncContracted(e) { e.burn = e.burn || {}; e.burn.contractedHours = retainerTotalContracted(e); }
  // set the shown burn %: WMJ retainers store a manual OVERRIDE (real used hrs stay from the
  // timesheet, cleared by "Reset to actuals"); manual retainers set used hours directly.
  function setBurnPct(e, pct) {
    e.burn = e.burn || {};
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    if (e.source === "wmj") e.burn.pctOverride = pct;
    else e.burn.usedHours = Math.round(pct / 100 * (e.burn.contractedHours || 0));
  }
  // actual billable hours worked per discipline, from the WMJ timesheet (matched by canon key)
  function actualByDiscipline(e) {
    const map = {};
    (e.wmjServiceLines || []).forEach(l => { const k = canon(l.name); map[k] = (map[k] || 0) + (+l.billable || 0); });
    return map;
  }
  // effective USED hours for a discipline = manual override (% of contracted) if set, else WMJ actual.
  // The retainer burn is the SUM of these, so a slider move flows straight into the burn (linked),
  // and the burn dial distributes back into the disciplines via the popup.
  function discUsed(e, d, actMap) {
    const act = (actMap || actualByDiscipline(e))[canon(d.name)] || 0;
    const ov = (e.svcUtilOverride || {})[d.name];
    return (typeof ov === "number") ? (ov / 100 * (+d.contracted || 0)) : act;
  }
  // billable hours in WMJ departments that DON'T match any defined discipline ("misc"/unallocated).
  // These still count toward the burn (it must reflect ALL billable hours) and are surfaced to
  // admins as an "Unallocated" line so the PM team can categorize them.
  function unmatchedBillable(e) {
    const keys = new Set((e.serviceDisciplines || []).map(d => canon(d.name)));
    return (e.wmjServiceLines || []).reduce((s, l) => s + (keys.has(canon(l.name)) ? 0 : (+l.billable || 0)), 0);
  }
  // the projects (name + billable hrs) behind the unallocated hours — for the admin drill-down
  function unmatchedProjects(e) {
    const keys = new Set((e.serviceDisciplines || []).map(d => canon(d.name)));
    const acc = {};
    (e.wmjServiceLines || []).forEach(l => {
      if (keys.has(canon(l.name))) return;
      (l.projects || []).forEach(p => { acc[p.name] = (acc[p.name] || 0) + (+p.billable || 0); });
    });
    return Object.keys(acc).map(name => ({ name, billable: round2(acc[name]) }))
      .filter(p => p.billable > 0).sort((a, b) => b.billable - a.billable);
  }
  function retainerUsed(e) {   // burn numerator = Σ disciplines' used + unallocated billable
    const m = actualByDiscipline(e);
    return (e.serviceDisciplines || []).reduce((s, d) => s + discUsed(e, d, m), 0) + unmatchedBillable(e);
  }
  function retainerActualUsed(e) {   // true WMJ total billable (all depts, ignoring overrides)
    return (e.wmjServiceLines || []).reduce((s, l) => s + (+l.billable || 0), 0);
  }
  function retainerServiceModule(e) {
    const admin = canAdmin();
    const disc = Array.isArray(e.serviceDisciplines) ? e.serviceDisciplines : [];
    const actual = actualByDiscipline(e);
    const total = retainerTotalContracted(e);
    const ov = e.svcUtilOverride || {};   // admin manual % overrides, keyed by discipline name
    // "needs setup" keys off the DISCIPLINES (not the total, which may come from the SOW feed):
    // until the admin splits hours across disciplines, rows stay neutral and the note shows.
    const unset = disc.reduce((s, d2) => s + (+d2.contracted || 0), 0) <= 0;
    const rows = disc.map((d, i) => {
      const contracted = +d.contracted || 0;
      const act = actual[canon(d.name)] || 0;
      const share = total > 0 ? Math.round(contracted / total * 100) : 0;
      const realUtil = contracted > 0 ? (act / contracted * 100) : 0;   // 0 contracted → no util yet (not "over")
      const hasOv = typeof ov[d.name] === "number";
      const dispUtil = hasOv ? ov[d.name] : realUtil;   // the bar/status follow the shown (maybe overridden) %
      const fill = Math.max(0, Math.min(100, dispUtil));
      // status: 0% → not started; >0 & <100% → in progress; ≥100% → completed;
      // >120% (20% past budget) → the completed chip turns vibrant red "Over"
      let st = "not-started", lbl = "Not started";
      if (contracted <= 0 && !hasOv) { st = "not-started"; lbl = "—"; }
      else if (dispUtil > 120) { st = "over"; lbl = "Over"; }
      else if (dispUtil >= 100) { st = "complete"; lbl = "Completed"; }
      else if (dispUtil > 0) { st = "in-progress"; lbl = "In progress"; }
      const nameCell = admin ? ed(d.name, "serviceDisciplines." + i + ".name") : esc(d.name);
      // admin caption = the REAL actual/contracted + real % (ground truth); client sees only the shown %
      const hrsCell = admin
        ? `${round2(act)} of <input type="number" class="rsvc-hrs" data-dischrs="${i}" value="${contracted}" min="0" step="any" title="Contracted hours / month (arrows step by 1)"> hrs${contracted > 0 ? ` · ${Math.round(realUtil)}%` : ""}`
        : `${contracted > 0 ? Math.round(dispUtil) + "% of hours used" : ""}`;
      const handle = admin ? `<button class="rsvc-handle" data-svcutil="${i}" style="left:${fill}%" title="Drag to adjust the shown %"></button>` : "";
      return `<div class="rsvc-row">
        <div class="rsvc-top">
          <span class="rsvc-name">${nameCell}${admin && hasOv ? ` <span class="rsvc-adj">adj</span>` : ""}</span>
          <span class="rsvc-right"><span class="rsvc-status is-${st}">${lbl}</span><span class="rsvc-share">${share}%</span>${admin ? listDel("serviceDisciplines", i) : ""}</span>
        </div>
        <div class="rsvc-bar${st === "over" ? " over" : ""}${admin ? " rsvc-bar--drag" : ""}"><span style="width:${fill}%"></span>${handle}</div>
        <div class="rsvc-cap">${hrsCell}</div>
      </div>`;
    }).join("");
    // Unallocated: WMJ billable in departments with no matching discipline (admin-only flag)
    const misc = round2(unmatchedBillable(e));
    const miscRow = (admin && misc > 0)
      ? `<div class="rsvc-row rsvc-unalloc" data-unalloctoggle title="Click to see the projects behind these hours">
           <div class="rsvc-top"><span class="rsvc-name">Unallocated <span class="rsvc-caret">view ›</span></span><span class="rsvc-right"><span class="rsvc-status is-unalloc">In burn</span></span></div>
           <div class="rsvc-cap">${misc} hrs billable · not in a discipline</div>
         </div>` : "";
    const setupNote = (admin && unset && !e.projectOnly)
      ? `<div class="rsvc-setup-note">${e.retainerValueTarget != null && +e.retainerValueTarget > 0
            ? `The burn total (~${e.retainerValueTarget} hrs/mo) comes from the signed SOW — enter each discipline's hours here to split it (they should add up to that total).`
            : `No contracted hours yet — set them per discipline.`}</div>` : "";
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.svc}Service Lines</span><span style="display:flex;align-items:center;gap:10px"><span class="module-link" data-go="status">View status →</span><span class="rsvc-legend">% of retainer</span></span></div>
      <div class="rsvc-list">${rows || `<div class="pr-date">No service disciplines yet.${admin ? " Add one below." : ""}</div>`}${miscRow}</div>
      ${setupNote}
      ${admin ? listAdd("serviceDisciplines", "Add discipline") : ""}
    </div>`;
  }
  // any manual % override active (service-line sliders)? → show the Reset-to-actuals control
  function hasActualsOverride(e) {
    return e && e.type === "retainer" && e.svcUtilOverride && Object.keys(e.svcUtilOverride).length > 0;
  }

  function serviceModule(e) {
    if (e.type === "project" && Array.isArray(e.wmjTasks)) return tasksModule(e);
    // Retainers always use the disciplines view — driven by the admin-set contracted hours,
    // NOT gated on WMJ actuals (actuals just fill the bars; missing actuals → 0%, never a blank tile).
    if (e.type === "retainer") return retainerServiceModule(e);
    const seg = (i, status) => {
      const opt = (val, label) => `<button class="svc-seg-btn is-${val} ${status === val ? "active" : ""}" data-svcset="${i}:${val}" title="${label}">${label}</button>`;
      return `<div class="svc-seg">${opt("not-started", "Not started")}${opt("in-progress", "In progress")}${opt("complete", "Complete")}</div>`;
    };
    const alloc = (s, i) => canAdmin()
      ? `<div class="svc-alloc"><input type="range" min="0" max="100" step="1" value="${s.allocationPct}" class="svc-slider" data-svcalloc="${i}" style="--val:${s.allocationPct}%" title="Drag to set allocation"><span class="pct" data-svcpct="${i}">${s.allocationPct}%</span></div>`
      : `<div class="svc-alloc"><div class="bar" style="flex:1"><span style="width:${s.allocationPct}%"></span></div><span class="pct">${s.allocationPct}%</span></div>`;
    const rows = (e.serviceLines || []).map((s, i) => `
      <div class="svc-row" data-svcrow="${i}">
        <div class="svc-name ed-host">${ed(s.name, "serviceLines." + i + ".name")}</div>
        ${alloc(s, i)}
        <div class="svc-statuswrap">
          ${canAdmin() ? seg(i, s.status) : window.DASH.badge(s.status)}
          ${listDel("serviceLines", i)}
        </div>
      </div>`).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.svc}Service Lines</span><span class="module-link" data-go="status">View status →</span></div>
      ${rows}
      ${listAdd("serviceLines", "Add service line")}
    </div>`;
  }

  function milestoneModule(e) {
    const items = (e.milestones || []).map((m, i) => `
      <div class="ms-item ${m.done ? "done" : ""}">
        <button class="ms-check ${m.done ? "done" : ""}" ${canAdmin() ? `data-mstoggle="${i}"` : "disabled"} title="${m.done ? "Mark not done" : "Mark done"}"></button>
        <div class="ms-body">
          <div class="tl-label">${ed(m.label, "milestones." + i + ".label")}</div>
          <div class="tl-date">${ed(m.date, "milestones." + i + ".date")}</div>
        </div>
        ${canAdmin() ? `<button class="ms-del" data-listdel="milestones" data-idx="${i}" title="Remove milestone">✕</button>` : ""}
      </div>`).join("");
    // Projects: header links to the full Project Plan. Retainers have no project-plan
    // page (it force-redirects to exec), so the link only shows for projects.
    const planLink = e.type === "project" ? `<span class="module-link" data-go="projectplan">View plan →</span>` : "";
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.flag}Milestones</span>${planLink}</div>
      <div class="ms-list">${items}</div>
      ${listAdd("milestones", "Add milestone")}
    </div>`;
  }

  function hexToRgba(hex, a) {
    const h = String(hex || "").replace("#", "");
    if (h.length !== 6) return `rgba(106,166,255,${a})`;
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  /* ---- client accent colour, auto-matched to the logo ----
     Dominant brand colour is precomputed per client in client-logos.js (COLORS map),
     because the colourful icon services don't send CORS headers so a browser canvas
     can't sample them at runtime. Used as the DEFAULT "Client" to-do colour; an admin
     colour override (e.todoClientColor) always wins. */
  function logoAccent() {
    try {
      const name = window.CLIENT_DATA && window.CLIENT_DATA.client && window.CLIENT_DATA.client.name;
      return (window.CLIENT_LOGOS && name) ? window.CLIENT_LOGOS.logoColorFor(name) : null;
    } catch (e) { return null; }
  }
  function todosModule(e) {
    const cc = e.todoClientColor || logoAccent() || "#6aa6ff";   // TJA = always orange; Client = logo colour (admin can override)
    const tag = (t, i) => {
      const style = t.owner === "TJA" ? "" : ` style="background:${hexToRgba(cc, 0.16)};color:${cc}"`;
      return `<span class="owner-tag ${owners(t.owner)} ${canAdmin() ? "admin-edit" : ""}" data-owner="${i}"${style} ${canAdmin() ? `title="Toggle owner (Client / TJA)"` : ""}>${esc(t.owner)}</span>`;
    };
    const rows = (e.todos || []).map((t, i) => `
      <div class="tile-item">
        ${tag(t, i)}
        <span class="ed-host" style="flex:1">${ed(t.text, "todos." + i + ".text")}</span>
        ${listDel("todos", i)}
      </div>`).join("");
    const colorPick = canAdmin()
      ? `<label class="todo-colorpick" title="Set the colour used for Client tasks"><input type="color" data-todocolor value="${cc}"><span>Client</span></label>`
      : "";
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.todo}To-Do's</span>${colorPick}</div>
      <div class="tile-list">${rows || `<div class="pr-date">Nothing outstanding.</div>`}</div>
      ${listAdd("todos", "Add to-do")}
    </div>`;
  }

  function dependencyModule(e) {
    const rows = (e.dependencies || []).map((d, i) => `
      <div class="tile-item"><span class="dep-mark">▴</span><span style="flex:1">${ed(d.text, "dependencies." + i + ".text")}</span>${listDel("dependencies", i)}</div>`).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.dep}Dependencies</span></div>
      <div class="tile-list">${rows || `<div class="pr-date">No open dependencies.</div>`}</div>
      ${listAdd("dependencies", "Add dependency")}
    </div>`;
  }

  function kpiModule(e) {
    const rows = (e.kpis || []).map((k, i) => `
      <div class="kpi-row">
        <span class="kpi-label">${ed(k.label, "kpis." + i + ".label")}</span>
        <span class="kpi-val"><b>${ed(k.current, "kpis." + i + ".current")}</b> <span class="t">/ ${ed(k.target, "kpis." + i + ".target")}</span> ${listDel("kpis", i)}</span>
      </div>`).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.kpi}KPIs / Goals</span></div>
      <div>${rows || `<div class="pr-date">No KPIs set.</div>`}</div>
      ${listAdd("kpis", "Add KPI")}
    </div>`;
  }

  function prModule(e) {
    const list = e.prCoverage || [];
    const sheet = e.prSource === "sheet";   // team-maintained Google Sheet → read-only mirror
    if (!list.length && !canAdmin()) return "";
    const fmtNum = (n) => { const v = String(n == null ? "" : n).replace(/[^0-9.]/g, ""); return v ? Number(v).toLocaleString() : String(n || ""); };

    if (sheet) {
      // admin-only, curated Slack send: the team picks which hits go to the wins channel
      const slackOn = canAdmin() && window.SLACK_WINS && window.SLACK_WINS.enabled();
      const sent = e.prSlackSent || {};
      const rows = list.map((p, i) => {
        const wasSent = slackOn && sent[window.SLACK_WINS.keyFor(p)];
        const slackBtn = slackOn
          ? (wasSent
              ? `<span class="pr-slack sent" title="Already posted to the wins channel">✓ Sent</span>`
              : `<button class="pr-slack" data-prslack="${i}" title="Post this hit to the Slack wins channel">→ Slack</button>`)
          : "";
        return `
        <div class="pr-item">
          <div class="pr-main">
            <div class="pr-top"><span class="pr-outlet">${esc(p.outlet || "")}</span><span class="pr-date">${esc(p.date || "")}</span></div>
            ${p.link ? `<a class="pr-head pr-link" href="${esc(p.link)}" target="_blank" rel="noopener">View coverage →</a>` : ""}
          </div>
          <div class="pr-stats">
            ${p.impressions ? `<span class="pr-metric" title="Estimated impressions">${esc(fmtNum(p.impressions))} impressions</span>` : ""}
            ${p.adValue ? `<span class="pr-metric pr-av" title="Ad value equivalent">${esc(String(p.adValue))} AVE</span>` : ""}
            ${slackBtn}
          </div>
        </div>`;
      }).join("");
      const n = e.prHits != null ? e.prHits : list.length;
      return `<div class="module">
        <div class="module-head"><span class="module-title">${IC.pr}PR Coverage · Recent Wins</span><span class="rsvc-legend">${n} hits YTD</span></div>
        <div class="pr-scroll">${rows || `<div class="pr-date">No coverage logged yet.</div>`}</div>
      </div>`;
    }

    // manual (editable) coverage — original behavior for non-synced clients
    const rows = list.map((p, i) => `
      <div class="pr-item">
        <div class="pr-main">
          <div class="pr-top"><span class="pr-outlet">${ed(p.outlet, "prCoverage." + i + ".outlet")}</span><span class="pr-date">${ed(p.date, "prCoverage." + i + ".date")}</span></div>
          <div class="pr-head">${ed(p.headline, "prCoverage." + i + ".headline")}</div>
        </div>
        <div class="pr-stats">
          <span class="pr-metric" title="Estimated impressions">${ed(p.impressions, "prCoverage." + i + ".impressions")} est. impressions</span>
        </div>
        ${listDel("prCoverage", i)}
      </div>`).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.pr}PR Coverage · Recent Wins</span></div>
      <div class="pr-scroll">${rows || `<div class="pr-date">No coverage logged yet.</div>`}</div>
      ${listAdd("prCoverage", "Add hit")}
    </div>`;
  }

  /* ---- module registry + kanban layout ---- */
  const MODULES = {
    burn:         { label: "Burn",          fn: burnModule },
    service:      { label: "Service Lines", fn: serviceModule },
    milestones:   { label: "Milestones",    fn: milestoneModule },
    todos:        { label: "To-Do's",       fn: todosModule },
    dependencies: { label: "Dependencies",  fn: dependencyModule },
    kpis:         { label: "KPIs",          fn: kpiModule },
    pr:           { label: "PR Coverage",   fn: prModule },
  };
  const LAYOUT_V = 4;        // free-canvas layout: tiles are absolutely positioned and drag anywhere
  const SNAP = 9, GRID_GAP = 16, DEF_W = 360;   // snap distance (px), default gap + tile width
  // FIXED, LOCKED layouts — Cameron's final arrangement (copied from his browser on 2026-07-09
  // via the Copy-layout button). Single source of truth; changed only here in code, and only
  // when Cameron specifically asks. Tiles scroll internally if content exceeds their height.
  const DEFAULT_RETAINER_FREE = {
    burn:         { x: 0,    y: 0,   w: 491, h: 377 },
    service:      { x: 506,  y: 0,   w: 704, h: 451 },
    milestones:   { x: 1226, y: 0,   w: 405, h: 285 },
    todos:        { x: 1226, y: 300, w: 406, h: 222 },
    dependencies: { x: 0,    y: 393, w: 489, h: 368 },
    kpis:         { x: 1226, y: 537, w: 407, h: 225 },
    pr:           { x: 507,  y: 467, w: 703, h: 293 },
  };
  const PROJECT_HIDDEN = ["pr", "kpis"];   // PR Coverage + KPIs hidden on projects
  const DEFAULT_PROJECT_FREE = {
    burn:         { x: 0,    y: 0,   w: 809, h: 306 },
    service:      { x: 0,    y: 322, w: 808, h: 434 },
    dependencies: { x: 823,  y: 0,   w: 424, h: 362 },
    todos:        { x: 823,  y: 378, w: 424, h: 380 },
    milestones:   { x: 1263, y: 0,   w: 363, h: 760 },
  };
  function defaultLayout(e) {
    return (e.type === "project")
      ? { v: LAYOUT_V, free: JSON.parse(JSON.stringify(DEFAULT_PROJECT_FREE)), hidden: PROJECT_HIDDEN.slice(), locked: true }
      : { v: LAYOUT_V, free: JSON.parse(JSON.stringify(DEFAULT_RETAINER_FREE)), hidden: [], locked: true };
  }
  // Always return the fixed layout — stored/Supabase layouts are ignored entirely, so nothing
  // can drift or be changed by saved state. Layout changes happen in code only, on request.
  function getLayout(e) {
    const L = defaultLayout(e);
    const valid = Object.keys(MODULES);
    L.hidden = L.hidden.filter(k => valid.includes(k));
    Object.keys(L.free).forEach(k => { if (!valid.includes(k) || L.hidden.includes(k)) delete L.free[k]; });
    return L;
  }
  const TILEBAR = (key) => !canAdmin() ? "" : `<button class="tile-remove" data-tileremove="${key}" title="Remove tile">✕</button>`;

  /* ---- North Star banner (full-width strip across all 3 columns) ---- */
  function northStarBanner(e) {
    // Projects call it "Goal"; the due date lives only in the Project Progress tile.
    const label = e.type === "project" ? "Goal" : "North Star";
    return `<div class="ns-banner">
      <span class="ns-banner-bolt">${IC.bolt}</span>
      <span class="ns-banner-label">${label}</span>
      <span class="ns-banner-text">${ed(e.northStar, "northStar")}</span>
    </div>`;
  }

  /* ---- assemble (free canvas: tiles absolutely positioned, drag anywhere) ---- */
  function render(e) {
    // Layout is FIXED and locked — no drag / resize / add / remove / lock / copy controls.
    // The only control is "Reset to actuals" (data overrides, not layout). Code-only changes.
    const lay = getLayout(e);
    const visible = Object.keys(MODULES).filter(k => !lay.hidden.includes(k));
    const tiles = visible.map(k => {
      const p = lay.free[k];
      const style = p
        ? `left:${p.x}px;top:${p.y}px;width:${p.w}px;${p.h ? `height:${p.h}px;` : ""}`
        : `width:${DEF_W}px;`;
      return `<div class="exec-tile${p ? "" : " unplaced"}" data-key="${k}" style="${style}">${MODULES[k].fn(e)}</div>`;
    }).join("");
    const actualsBtn = (canAdmin() && hasActualsOverride(e))
      ? `<div class="exec-controls"><button class="exec-actuals-btn" data-resetactuals title="Clear manual % adjustments and show the real WMJ actuals">↺ Reset to actuals</button></div>` : "";
    return `
    ${window.DASH.projectBack ? window.DASH.projectBack() : ""}
    ${northStarBanner(e)}
    ${actualsBtn}
    <div class="exec-canvas locked">${tiles}</div>`;
  }
  function rerender() {
    const s = section(); if (!s) return;
    s.innerHTML = render(window.DASH.getEng());
    ensurePositions(); setupFreeDrag(); fitCanvas();
  }

  /* ---- burn → disciplines distribution popup ----
     When an admin changes the total burn, ask which disciplines absorb the change; the delta
     is split evenly across the checked ones (writes each one's shown-% override). */
  function openBurnPopup(targetPct) {
    const eng = window.DASH.getEng();
    const disc = eng.serviceDisciplines || [];
    if (!disc.length) { burnPreviewPct = null; rerender(); return; }
    const total = retainerTotalContracted(eng);
    const actMap = actualByDiscipline(eng);
    const currentUsed = round2(retainerUsed(eng));
    const targetUsed = round2(Math.max(0, Math.min(100, targetPct)) / 100 * total);
    const delta = round2(targetUsed - currentUsed);
    const old = document.getElementById("burnPop"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "burnPop"; ov.className = "burn-pop-overlay";
    const rowsHtml = disc.map((d, i) => {
      const used = round2(discUsed(eng, d, actMap));
      return `<label class="bp-row"><input type="checkbox" class="bp-ck" data-i="${i}" checked>
        <span class="bp-name">${esc(d.name)}</span><span class="bp-cur">${used} / ${(+d.contracted || 0)} hrs</span></label>`;
    }).join("");
    ov.innerHTML = `<div class="burn-pop" role="dialog" aria-modal="true">
      <div class="bp-head">Adjust retainer burn</div>
      <p class="bp-lead">Total used <b>${currentUsed}</b> → <b>${targetUsed}</b> hrs (<b>${delta >= 0 ? "+" : ""}${delta}</b> hr${Math.abs(delta) === 1 ? "" : "s"}). Choose which disciplines absorb it — the change is split evenly across the ones you check.</p>
      <div class="bp-rows">${rowsHtml}</div>
      <div class="bp-actions"><button type="button" class="btn btn-ghost" data-bpcancel>Cancel</button><button type="button" class="btn btn-primary" data-bpapply>Apply</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = (commit) => {
      if (commit) {
        const sel = [...ov.querySelectorAll(".bp-ck:checked")].map(c => +c.dataset.i);
        const targets = sel.length ? sel : disc.map((_, i) => i);
        const per = delta / targets.length;
        eng.svcUtilOverride = eng.svcUtilOverride || {};
        targets.forEach(i => {
          const d = disc[i], c = +d.contracted || 0;
          const newUsed = Math.max(0, round2(discUsed(eng, d, actMap) + per));
          eng.svcUtilOverride[d.name] = c > 0 ? Math.round(newUsed / c * 100) : 0;
        });
        window.DASH.saveState();
      }
      burnPreviewPct = null; ov.remove(); rerender();
    };
    ov.querySelector("[data-bpcancel]").addEventListener("click", () => close(false));
    ov.querySelector("[data-bpapply]").addEventListener("click", () => close(true));
    ov.addEventListener("click", e => { if (e.target === ov) close(false); });
  }

  /* ---- Unallocated drill-down popup: projects behind the misc (out-of-discipline) hours ---- */
  function openUnallocPopup(e) {
    const projects = unmatchedProjects(e);
    const misc = round2(unmatchedBillable(e));
    const old = document.getElementById("burnPop"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "burnPop"; ov.className = "burn-pop-overlay";
    const rows = projects.map(p => `<div class="up-row"><span class="up-name">${esc(p.name)}</span><span class="up-hrs">${p.billable} hrs</span></div>`).join("")
      || `<div class="up-row">No project detail available.</div>`;
    ov.innerHTML = `<div class="burn-pop" role="dialog" aria-modal="true">
      <div class="bp-head">Unallocated hours <span class="up-total">${misc} hrs</span></div>
      <p class="bp-lead">Billable work in WMJ departments with no matching discipline. It still counts toward the burn — add a discipline to categorize it.</p>
      <div class="up-rows">${rows}</div>
      <div class="bp-actions"><button type="button" class="btn btn-primary" data-bpclose>Close</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("[data-bpclose]").addEventListener("click", close);
    ov.addEventListener("click", e2 => { if (e2.target === ov) close(); });
  }

  /* ---- tile remove / restore ---- */
  function tileAction(action, key) {
    const e = window.DASH.getEng(); const lay = getLayout(e);
    if (action === "remove") {
      delete lay.free[key];
      if (!lay.hidden.includes(key)) lay.hidden.push(key);
    } else if (action === "restore") {
      lay.hidden = lay.hidden.filter(k => k !== key);   // re-placed by ensurePositions on next render
    }
    window.DASH.saveState(); rerender();
  }

  /* ---- lock layout: snapshot exact current positions/sizes, then freeze drag+resize ---- */
  function snapshotPositions() {
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    const lay = getLayout(window.DASH.getEng());
    canvas.querySelectorAll(".exec-tile[data-key]").forEach(t => {
      lay.free[t.dataset.key] = {
        x: Math.round(t.offsetLeft), y: Math.round(t.offsetTop),
        w: Math.round(t.offsetWidth), h: Math.round(t.offsetHeight)
      };
    });
  }
  function toggleLock() {
    const lay = getLayout(window.DASH.getEng());
    if (!lay.locked) snapshotPositions();   // pin everything exactly where it sits before freezing
    lay.locked = !lay.locked;
    window.DASH.saveState(); rerender();
  }
  // Reset this engagement's tiles to the default monthly-services layout — a clone
  // of the team's Celtic layout (matched box sizes) when available, else the baked default.
  function resetLayout() {
    const e = window.DASH.getEng();
    if (!confirm("Reset this Executive Summary to the standard layout? Your current tile arrangement here will be replaced.")) return;
    e.layout = defaultLayout(e);
    window.DASH.saveState(); rerender();
  }

  /* ---- default placement: the curated 3-column arrangement we like for monthly
     services (Celtic's layout) — every fresh client starts here. Tiles not named in
     the template, or any leftovers, fall to the shortest column. Hidden tiles (e.g.
     PR on projects) are simply skipped. ---- */
  const DEFAULT_COLS = [
    ["burn", "pr"],                       // left:   burn / pizza, then PR coverage
    ["service", "dependencies"],          // middle: service lines, then dependencies
    ["milestones", "todos", "kpis"],      // right:  milestones, to-do's, KPIs
  ];
  function templateCol(key) { for (let i = 0; i < DEFAULT_COLS.length; i++) if (DEFAULT_COLS[i].includes(key)) return i; return -1; }
  function nearestCol(x, colX) { let b = 0, bd = Infinity; colX.forEach((cx, i) => { const d = Math.abs(x - cx); if (d < bd) { bd = d; b = i; } }); return b; }
  function applyPos(t, p) { t.style.left = p.x + "px"; t.style.top = p.y + "px"; t.style.width = p.w + "px"; if (p.h) t.style.height = p.h + "px"; }
  function ensurePositions() {
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    const lay = getLayout(window.DASH.getEng());
    // lay the template out at design width (3 columns); fitCanvas() scales it down to
    // fit narrower windows, exactly like a saved 3-column layout
    const ncols = DEFAULT_COLS.length, colW = DEF_W;
    const colX = []; for (let i = 0; i < ncols; i++) colX.push(Math.round(i * (colW + GRID_GAP)));
    const colH = new Array(ncols).fill(0);
    // existing placed tiles set each column's running height so restored/added tiles stack below
    canvas.querySelectorAll(".exec-tile:not(.unplaced)").forEach(t => {
      const ci = nearestCol(t.offsetLeft, colX);
      colH[ci] = Math.max(colH[ci], t.offsetTop + t.offsetHeight + GRID_GAP);
    });
    // place unplaced tiles in template order: by column, then by position within the column
    const unplaced = [...canvas.querySelectorAll(".exec-tile.unplaced")].sort((a, b) => {
      const ca = templateCol(a.dataset.key), cb = templateCol(b.dataset.key);
      const ka = ca < 0 ? 99 : ca, kb = cb < 0 ? 99 : cb;
      if (ka !== kb) return ka - kb;
      const oa = ca < 0 ? 99 : DEFAULT_COLS[ca].indexOf(a.dataset.key);
      const ob = cb < 0 ? 99 : DEFAULT_COLS[cb].indexOf(b.dataset.key);
      return oa - ob;
    });
    let changed = false;
    unplaced.forEach(t => {
      t.style.width = colW + "px";
      const h = t.offsetHeight;
      let ci = templateCol(t.dataset.key);
      if (ci < 0 || ci >= ncols) ci = colH.indexOf(Math.min(...colH));   // leftover → shortest column
      const pos = { x: colX[ci], y: Math.round(colH[ci]), w: colW };
      colH[ci] += h + GRID_GAP;
      applyPos(t, pos); t.classList.remove("unplaced");
      lay.free[t.dataset.key] = pos; changed = true;
    });
    if (changed && canAdmin()) window.DASH.saveState();
  }
  let canvasScale = 1;
  function canvasExtent(canvas) {
    let maxR = 0, maxB = 120;
    canvas.querySelectorAll(".exec-tile").forEach(t => { maxR = Math.max(maxR, t.offsetLeft + t.offsetWidth); maxB = Math.max(maxB, t.offsetTop + t.offsetHeight); });
    return { maxR, maxB };
  }
  function updateCanvasHeight() {                 // height only — cheap, safe to call mid-drag
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    canvas.style.height = (canvasExtent(canvas).maxB + 8) + "px";
  }
  // scale the whole tile canvas down to fit narrower windows so the right-hand
  // tiles are never cut off / forced into horizontal scroll (arrangement preserved)
  function fitCanvas() {
    // UNIFORM PROPORTIONAL SCALING: the layout is a fixed design canvas (built at ~1633px wide);
    // scale the WHOLE canvas — tiles, gaps, and text together — so it exactly fills the content
    // width on every screen. Ratios/spacing/layout are identical everywhere (like a slide deck):
    // Cameron's screen ≈ 1:1, smaller laptops scale down, wider monitors scale up.
    // Phones (≤760px) use the stacked single-column mode instead.
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    const wrap = canvas.parentElement;
    const avail = (wrap && wrap.clientWidth) || canvas.clientWidth;
    if (!avail) return;   // page hidden (another tab active) — measuring now would corrupt the fit
    const stacked = window.innerWidth <= 760;
    const lay = getLayout(window.DASH.getEng());
    let baseR = 0, baseB = 0;
    Object.values(lay.free).forEach(p => { baseR = Math.max(baseR, p.x + p.w); baseB = Math.max(baseB, p.y + (p.h || 0)); });
    if (stacked) {   // mobile: static stacked layout (media query) — no transform, natural sizing
      canvas.style.width = ""; canvas.style.height = ""; canvas.style.transform = ""; canvas.style.transformOrigin = ""; canvas.style.marginBottom = "";
      canvasScale = 1; return;
    }
    const sc = Math.max(0.4, Math.min(2, baseR ? avail / baseR : 1));
    // VERTICAL FILL: stretch tile heights + row positions (only — no font/width change, no
    // reordering) so the grid's bottom row lands exactly on the bottom of the viewport.
    // Boxes get longer/shorter; content scrolls inside tiles when shorter.
    const topDoc = canvas.getBoundingClientRect().top + window.scrollY;   // scroll-independent
    const availH = window.innerHeight - topDoc - 14;                      // breathing room at the bottom
    const fy = (baseB > 0 && availH > 200) ? Math.max(0.6, Math.min(2, (availH / sc - 8) / baseB)) : 1;
    canvas.querySelectorAll(".exec-tile[data-key]").forEach(t => {
      const p = lay.free[t.dataset.key]; if (!p) return;
      t.style.left = p.x + "px"; t.style.width = p.w + "px";
      t.style.top = Math.round(p.y * fy) + "px";
      if (p.h) t.style.height = Math.round(p.h * fy) + "px";
    });
    const { maxB } = canvasExtent(canvas), h = maxB + 8;
    canvas.style.height = h + "px";
    canvasScale = sc;
    canvas.style.width = baseR + "px";                       // design width; scaled it becomes exactly `avail`
    canvas.style.transform = `scale(${sc})`; canvas.style.transformOrigin = "top left";
    canvas.style.marginBottom = (h * (sc - 1)) + "px";       // compensate layout height for the visual scale
  }

  /* ---- free drag (pointer) with snap-to-align against the other tiles ---- */
  function snapPos(tile, x, y, others) {
    const w = tile.offsetWidth, h = tile.offsetHeight;
    let bx = { d: SNAP + 1, v: x, g: null }, by = { d: SNAP + 1, v: y, g: null };
    const tX = (dv, t) => { const d = Math.abs(dv - t); if (d <= SNAP && d < bx.d) bx = { d, v: x + (t - dv), g: t }; };
    const tY = (dv, t) => { const d = Math.abs(dv - t); if (d <= SNAP && d < by.d) by = { d, v: y + (t - dv), g: t }; };
    tX(x, 0);   // canvas left edge
    others.forEach(o => {
      const ol = o.offsetLeft, ot = o.offsetTop, ow = o.offsetWidth, oh = o.offsetHeight;
      tX(x, ol); tX(x + w, ol + ow); tX(x + w / 2, ol + ow / 2);      // align left / right / centre
      tX(x, ol + ow + GRID_GAP); tX(x + w, ol - GRID_GAP);           // sit beside (gap)
      tY(y, ot); tY(y + h, ot + oh); tY(y + h / 2, ot + oh / 2);
      tY(y, ot + oh + GRID_GAP); tY(y + h, ot - GRID_GAP);
    });
    return { x: bx.v, y: by.v, gx: bx.g, gy: by.g };
  }
  function clearGuides(canvas) { canvas.querySelectorAll(".snap-guide").forEach(g => g.remove()); }
  function drawGuides(canvas, gx, gy) {
    clearGuides(canvas);
    if (gx != null) { const d = document.createElement("div"); d.className = "snap-guide v"; d.style.left = gx + "px"; canvas.appendChild(d); }
    if (gy != null) { const d = document.createElement("div"); d.className = "snap-guide h"; d.style.top = gy + "px"; canvas.appendChild(d); }
  }
  function setupFreeDrag() {
    if (!canAdmin()) return;
    if (getLayout(window.DASH.getEng()).locked) return;   // layout frozen — no drag handles
    const s = section(); const canvas = s.querySelector(".exec-canvas"); if (!canvas) return;
    canvas.querySelectorAll(".exec-tile").forEach(tile => {
      const head = tile.querySelector(".module-head"); if (!head) return;
      head.classList.add("tile-drag-handle");
      head.addEventListener("pointerdown", ev => {
        if (ev.button !== 0 || ev.target.closest(".module-link, .tile-remove, .ed, input, button, a, textarea, select")) return;
        ev.preventDefault();
        const lay = getLayout(window.DASH.getEng());
        const pos = lay.free[tile.dataset.key]; if (!pos) return;
        const sx = ev.clientX, sy = ev.clientY, ox = pos.x, oy = pos.y;
        const others = [...canvas.querySelectorAll(".exec-tile")].filter(t => t !== tile);
        tile.classList.add("dragging"); let moved = false;
        // pointer capture → pointermove/up keep firing on the handle even as the cursor
        // passes over other tiles, and the native text/element drag can't hijack it
        try { head.setPointerCapture(ev.pointerId); } catch {}
        const move = (mv) => {
          moved = true;
          const nx = Math.max(0, ox + (mv.clientX - sx) / canvasScale), ny = Math.max(0, oy + (mv.clientY - sy) / canvasScale);
          const sn = snapPos(tile, nx, ny, others);
          tile.style.left = sn.x + "px"; tile.style.top = sn.y + "px";
          pos.x = Math.round(sn.x); pos.y = Math.round(sn.y);
          drawGuides(canvas, sn.gx, sn.gy); updateCanvasHeight();
        };
        const up = () => {
          head.removeEventListener("pointermove", move);
          head.removeEventListener("pointerup", up);
          head.removeEventListener("pointercancel", up);
          try { head.releasePointerCapture(ev.pointerId); } catch {}
          tile.classList.remove("dragging"); clearGuides(canvas);
          if (moved && canAdmin()) window.DASH.saveState();
          fitCanvas();
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
      });
    });
  }

  /* ---- wiring (delegated, attached once) ---- */
  const defaults = {
    serviceDisciplines: () => ({ name: "New discipline", contracted: 0 }),
    serviceLines: () => ({ name: "New service line", allocationPct: 0, status: "not-started" }),
    milestones: () => ({ label: "New milestone", date: "", done: false }),
    todos: () => ({ text: "New to-do", owner: "Client" }),
    dependencies: () => ({ text: "New dependency" }),
    kpis: () => ({ label: "New KPI", target: "", current: "" }),
    prCoverage: () => ({ outlet: "Outlet", headline: "Headline", date: "", impressions: "" }),
  };
  let wired = false;
  function init() {
    rerender();
    if (wired) return; wired = true;
    const s = section();

    // per-tile resize (CSS resize: both) — persist each tile's width/height on release.
    // GUARDS: only while the exec page is actually visible, and never persist a zero size —
    // a mouseup on another tab (exec display:none → offsetWidth 0) used to write w:0 into the
    // layout, which is why tiles "changed size" after visiting Status and coming back.
    document.addEventListener("mouseup", () => {
      if (!canAdmin()) return;
      const sec = section(); if (!sec || !sec.classList.contains("active")) return;
      const lay = getLayout(window.DASH.getEng()); if (!lay.free || lay.locked) return;
      let changed = false;
      sec.querySelectorAll(".exec-tile[data-key]").forEach(t => {
        const pos = lay.free[t.dataset.key]; if (!pos) return;
        const w = Math.round(t.offsetWidth), h = Math.round(t.offsetHeight);
        if (w < 50 || h < 30) return;   // hidden/collapsed reads — never persist
        if (pos.w !== w || (t.style.height && pos.h !== h)) { pos.w = w; if (t.style.height) pos.h = h; changed = true; }
      });
      if (changed) { window.DASH.saveState(); fitCanvas(); }
    });

    // keep the canvas scaled to the window — re-fit on window resize AND via a ResizeObserver
    // on the content container (more reliable: catches resizes/sidebar changes that don't
    // deliver a clean window resize event, and re-fits when the page becomes visible again)
    // debounced with setTimeout (NOT requestAnimationFrame — rAF never fires in a background
    // tab, which jammed the guard flag and killed every later re-fit)
    let fitTimer = null;
    const requestFit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { const sec = section(); if (sec && sec.querySelector(".exec-canvas")) fitCanvas(); }, 80);
    };
    window.addEventListener("resize", requestFit);
    if (window.ResizeObserver) {
      const target = document.querySelector(".content") || document.body;
      new ResizeObserver(requestFit).observe(target);
    }

    // service-line allocation sliders (admin): live-update while dragging, persist on release
    s.addEventListener("input", e => {
      const sl = e.target.closest("[data-svcalloc]"); if (!sl) return;
      const i = +sl.dataset.svcalloc, v = Math.max(0, Math.min(100, parseInt(sl.value, 10) || 0));
      window.DASH.getEng().serviceLines[i].allocationPct = v;
      sl.style.setProperty("--val", v + "%");
      const lbl = s.querySelector(`[data-svcpct="${i}"]`); if (lbl) lbl.textContent = v + "%";
    });
    s.addEventListener("change", e => {
      if (e.target.closest("[data-svcalloc]")) { window.DASH.saveState(); return; }
      const dd = e.target.closest("[data-projdue]");
      if (dd && canAdmin()) { window.DASH.getEng().dueDate = isoToDue(dd.value); window.DASH.saveState(); return; }
      const tc = e.target.closest("[data-todocolor]");
      if (tc) { window.DASH.getEng().todoClientColor = tc.value; window.DASH.saveState(); rerender(); return; }
    });

    // text edits persist on focusout
    s.addEventListener("focusout", e => {
      // burn % edit → derive used hours from % of the contract total
      const bp = e.target.closest("[data-burnpct]");
      if (bp) {
        let pct = parseFloat(bp.textContent.replace(/[^0-9.]/g, "")); pct = isNaN(pct) ? 0 : Math.max(0, Math.min(100, pct));
        const eng = window.DASH.getEng();
        if (eng.source === "wmj" || (eng.serviceDisciplines || []).length) { openBurnPopup(pct); return; }
        setBurnPct(eng, pct);
        viewMonthIdx = null; syncCurrentMonth(eng); window.DASH.saveState(); rerender(); return;
      }
      const f = e.target.closest("[data-path]"); if (!f) return;
      let v = f.textContent.trim();
      if (f.dataset.num) { const n = parseFloat(v.replace(/[^0-9.]/g, "")); v = isNaN(n) ? 0 : n; }
      const eng = window.DASH.getEng();
      window.DASH.setPath(eng, f.dataset.path, v);
      if (f.dataset.path.indexOf("burn.") === 0) { viewMonthIdx = null; syncCurrentMonth(eng); }  // keep month-history in step
      window.DASH.saveState();
      if (f.dataset.rerender) rerender();
    });

    // drag the speedometer needle to set burn
    let gaugeDragging = false, pendingEv = null, raf = null;
    function gaugePct(ev) {
      const svg = section().querySelector(".gauge-drag"); if (!svg) return null;
      const r = svg.getBoundingClientRect();
      const cx = r.left + (130 / 260) * r.width, cy = r.top + ((140 - 25) / 180) * r.height;
      let deg = Math.atan2(ev.clientX - cx, -(ev.clientY - cy)) * 180 / Math.PI;
      deg = Math.max(-120, Math.min(120, deg));
      return (deg + 120) / 240 * 100;
    }
    function gaugeApply() {
      raf = null; const ev = pendingEv; if (!ev) return;
      const pct = gaugePct(ev); if (pct == null) return;
      burnPreviewPct = Math.max(0, Math.min(100, Math.round(pct)));   // move the needle only; commit via popup
      rerender();
    }
    function gaugeMove(ev) { ev.preventDefault(); pendingEv = ev; if (!raf) raf = requestAnimationFrame(gaugeApply); }
    function gaugeUp() {
      if (!gaugeDragging) return; gaugeDragging = false;
      document.removeEventListener("pointermove", gaugeMove);
      document.removeEventListener("pointerup", gaugeUp);
      const eng = window.DASH.getEng();
      if (eng.source === "wmj" || (eng.serviceDisciplines || []).length) openBurnPopup(burnPreviewPct);   // distribute to disciplines
      else { setBurnPct(eng, burnPreviewPct); burnPreviewPct = null; syncCurrentMonth(eng); window.DASH.saveState(); rerender(); }
    }
    s.addEventListener("pointerdown", ev => {
      if (!canAdmin() || !ev.target.closest(".gauge-drag")) return;
      ev.preventDefault(); gaugeDragging = true; pendingEv = ev; gaugeApply();
      document.addEventListener("pointermove", gaugeMove);
      document.addEventListener("pointerup", gaugeUp);
    });

    // drag a service-discipline slider (admin) → override the shown utilization % for that line.
    // Persists as e.svcUtilOverride[name]; "Reset to actuals" clears it. Real hours stay in the cap.
    let svcHandle = null, svcName = null;
    function svcMove(ev) {
      if (!svcHandle) return; ev.preventDefault();
      const bar = svcHandle.closest(".rsvc-bar"); if (!bar) return;
      const r = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(100, Math.round((ev.clientX - r.left) / r.width * 100)));
      const eng = window.DASH.getEng();
      (eng.svcUtilOverride || (eng.svcUtilOverride = {}))[svcName] = pct;
      svcHandle.style.left = pct + "%";
      const fillSpan = bar.querySelector("span"); if (fillSpan) fillSpan.style.width = pct + "%";
    }
    function svcUp() {
      if (!svcHandle) return; svcHandle = null;
      document.removeEventListener("pointermove", svcMove);
      document.removeEventListener("pointerup", svcUp);
      window.DASH.saveState(); rerender();
    }
    s.addEventListener("pointerdown", ev => {
      const h = ev.target.closest(".rsvc-handle"); if (!h || !canAdmin()) return;
      ev.preventDefault();
      const line = (window.DASH.getEng().serviceDisciplines || [])[+h.dataset.svcutil]; if (!line) return;
      svcHandle = h; svcName = line.name;
      document.addEventListener("pointermove", svcMove);
      document.addEventListener("pointerup", svcUp);
    });

    // edit a discipline's monthly CONTRACTED hours (admin). Recomputes the total contracted
    // (= sum of disciplines) so the burn denominator + every share % update live.
    s.addEventListener("change", ev => {
      const hi = ev.target.closest("[data-dischrs]"); if (!hi || !canAdmin()) return;
      const eng = window.DASH.getEng(), d = (eng.serviceDisciplines || [])[+hi.dataset.dischrs]; if (!d) return;
      d.contracted = Math.max(0, parseFloat(hi.value) || 0);
      syncContracted(eng);
      window.DASH.saveState(); rerender();
    });

    // structural / toggle actions
    s.addEventListener("click", e => {
      const eng = window.DASH.getEng();

      // kanban tile controls
      const tm = e.target.closest("[data-tilemove]"); if (tm) { tileAction(tm.dataset.tilemove, tm.dataset.key); return; }
      const tr = e.target.closest("[data-tileremove]"); if (tr) { tileAction("remove", tr.dataset.tileremove); return; }
      const ts = e.target.closest("[data-tilerestore]"); if (ts) { tileAction("restore", ts.dataset.tilerestore); return; }
      const tl = e.target.closest("[data-tilelock]"); if (tl && canAdmin()) { toggleLock(); return; }
      const trs = e.target.closest("[data-tilereset]"); if (trs && canAdmin()) { resetLayout(); return; }

      const go = e.target.closest("[data-go]"); if (go) { window.DASH.activate(go.dataset.go); return; }

      // "Reset to actuals" — clear the manual % adjustments; the burn returns to Σ WMJ actuals
      const ra = e.target.closest("[data-resetactuals]");
      if (ra && canAdmin()) { delete eng.svcUtilOverride; if (eng.burn) delete eng.burn.pctOverride; window.DASH.saveState(); rerender(); return; }

      // "Copy layout" — copy this page's tile arrangement as JSON (paste to Claude to bake in)
      const cl = e.target.closest("[data-copylayout]");
      if (cl && canAdmin()) {
        const lay = getLayout(eng);
        const txt = JSON.stringify({ type: eng.type, free: lay.free, hidden: lay.hidden }, null, 1);
        const done = () => { cl.textContent = "✓ Copied — paste it to Claude"; setTimeout(rerender, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => prompt("Copy this layout JSON:", txt));
        else prompt("Copy this layout JSON:", txt);
        return;
      }

      // Unallocated drill-down → popup listing the projects behind the misc hours
      const ut = e.target.closest("[data-unalloctoggle]");
      if (ut && canAdmin()) { openUnallocPopup(window.DASH.getEng()); return; }

      // curated PR-wins Slack send (admin): post ONE chosen hit via the proxy, remember it
      const ps = e.target.closest("[data-prslack]");
      if (ps && canAdmin() && window.SLACK_WINS && window.SLACK_WINS.enabled()) {
        const hit = (eng.prCoverage || [])[+ps.dataset.prslack]; if (!hit) return;
        ps.disabled = true; ps.textContent = "Sending…";
        const clientName = (window.CLIENT_DATA && window.CLIENT_DATA.client && window.CLIENT_DATA.client.name) || "Client";
        window.SLACK_WINS.send(clientName, hit)
          .then(() => {
            (eng.prSlackSent || (eng.prSlackSent = {}))[window.SLACK_WINS.keyFor(hit)] = new Date().toISOString();
            window.DASH.saveState(); rerender();
          })
          .catch(err => { alert("Couldn't post to Slack: " + (err && err.message || err)); rerender(); });
        return;
      }

      const add = e.target.closest("[data-listadd]");
      if (add) { const k = add.dataset.listadd; (eng[k] || (eng[k] = [])).push(defaults[k]()); if (k === "serviceDisciplines") syncContracted(eng); window.DASH.saveState(); rerender(); return; }

      const del = e.target.closest("[data-listdel]");
      if (del) { const k = del.dataset.listdel; (eng[k] || []).splice(+del.dataset.idx, 1); if (k === "serviceDisciplines") syncContracted(eng); window.DASH.saveState(); rerender(); return; }

      const cond = e.target.closest("[data-cond]");
      if (cond && canAdmin()) { eng.condition.level = cond.dataset.cond; window.DASH.saveState(); rerender(); return; }

      const phase = e.target.closest("[data-phase]");
      if (phase && canAdmin()) {
        const i = +phase.dataset.phase, ph = eng.pizza.phases;
        if (eng.pizza.manual) { ph[i].done = !ph[i].done; }   // manual tracker → toggle just this step
        // WMJ tracker → sequential: clicking a done phase clears onward; clicking undone fills up to it
        else if (ph[i].done) { for (let j = i; j < ph.length; j++) ph[j].done = false; }
        else { for (let j = 0; j <= i; j++) ph[j].done = true; }
        window.DASH.saveState(); rerender(); return;
      }

      // manual pizza: add a step
      const addstep = e.target.closest("[data-addstep]");
      if (addstep && canAdmin()) { (eng.pizza.phases || (eng.pizza.phases = [])).push({ label: "", done: false }); window.DASH.saveState(); rerender(); return; }
      // manual pizza: remove a step
      const delstep = e.target.closest("[data-delstep]");
      if (delstep && canAdmin()) { eng.pizza.phases.splice(+delstep.dataset.delstep, 1); window.DASH.saveState(); rerender(); return; }
      // per-task internal/client visibility toggle (admin) — persisted override, survives re-sync
      const tv = e.target.closest("[data-taskvis]");
      if (tv && canAdmin()) {
        const key = tv.dataset.taskvis, ov = eng.taskInternalOverride || (eng.taskInternalOverride = {});
        const t = (eng.wmjTasks || []).find(x => ((x.phase || "") + "|" + (x.name || "")) === key);
        const currentlyInternal = typeof ov[key] === "boolean" ? ov[key] : !!(t && t.internal);
        ov[key] = !currentlyInternal;
        window.DASH.saveState(); rerender(); return;
      }

      const svcset = e.target.closest("[data-svcset]");
      if (svcset && canAdmin()) { const [idx, val] = svcset.dataset.svcset.split(":"); eng.serviceLines[+idx].status = val; window.DASH.saveState(); rerender(); return; }

      const own = e.target.closest("[data-owner]");
      if (own && canAdmin()) { const t = eng.todos[+own.dataset.owner]; t.owner = t.owner === "TJA" ? "Client" : "TJA"; window.DASH.saveState(); rerender(); return; }

      const ms = e.target.closest("[data-mstoggle]");
      if (ms && canAdmin()) { const m = eng.milestones[+ms.dataset.mstoggle]; m.done = !m.done; window.DASH.saveState(); rerender(); return; }

      const mom = e.target.closest("[data-mom]");
      if (mom) { viewMonthIdx = +mom.dataset.mom; rerender(); return; }

      const nm = e.target.closest("[data-newmonth]");
      if (nm && canAdmin()) {
        syncCurrentMonth(eng);                                   // bank the current month into history
        const nx = nextMonthLabel(eng.burn.periodLabel);
        eng.mom.push({ month: nx.short, usedHours: 0, contractedHours: eng.burn.contractedHours });
        eng.burn = { usedHours: 0, contractedHours: eng.burn.contractedHours, periodLabel: nx.full };
        viewMonthIdx = null; window.DASH.saveState(); rerender(); return;
      }

      // click a service row (not an editable / control) → status tab
      const row = e.target.closest(".svc-row");
      if (row && !e.target.closest(".ed,[data-svcset],[data-listdel],.svc-alloc")) window.DASH.activate("status");
    });
  }

  return { render, init };
})();
