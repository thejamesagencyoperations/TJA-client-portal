/* ============================================================
   EXECUTIVE SUMMARY — the homepage

   The one screen a CEO/CMO opens to understand their engagement.
   Modules: North Star banner, Burn (speedometer / pizza tracker,
   with Condition inline), Service Lines (+ MoM), Milestones,
   To-Do's, Dependencies, KPIs, PR Coverage. Tiles sit on a fixed,
   locked free-canvas layout (changed in code only).

   Every field is admin-editable (inline) and read-only in client
   view. Edits persist via window.DASH (state in localStorage).
   ============================================================ */

window.ExecSummary = (function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const canAdmin = () => (typeof canEdit === "function" ? canEdit() : true);
  const section = () => document.querySelector('.page[data-page="exec"]');
  let viewMonthIdx = null;   // retainer MoM view (null = current)
  let burnPreviewPct = null; // transient dial position while dragging the burn (before the distribute popup)

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
    // Admin edits the note in a roomy popup. The edit affordance is a compact button to
    // the RIGHT of the Condition label — the old full-width button sat BELOW the row and
    // in the project tile it fell out of view, so it was hard to reach. The note itself
    // renders read-only below for everyone (admin + client see it the same way).
    const editBtn = canAdmin()
      ? `<button class="cond-note-edit" data-condnote title="${c.note ? "Edit condition note" : "Add a condition note"}">${c.note ? "✎ Note" : "＋ Note"}</button>`
      : "";
    const noteHtml = c.note ? `<div class="cond-note">${esc(c.note)}</div>` : "";
    return `<div class="burn-cond">
      ${due}
      <div class="burn-cond-row"><span class="bc-label">${IC.cond}Condition</span>${editBtn}<span class="cond-label ${lvl}">${labels[lvl] || "—"}</span><span class="cond-dots">${dot("green")}${dot("yellow")}${dot("red")}</span></div>
      ${noteHtml}
    </div>`;
  }
  /* condition-note popup (admin) — roomy textarea instead of a squished inline field */
  function openConditionNote() {
    const eng = window.DASH.getEng();
    const cur = (eng.condition && eng.condition.note) || "";
    const old = document.getElementById("notePop"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "notePop"; ov.className = "burn-pop-overlay";
    ov.innerHTML = `<div class="burn-pop note-pop" role="dialog" aria-modal="true">
      <div class="bp-head">Condition note</div>
      <p class="bp-lead">A short line clients see with the status — e.g. "Moved to yellow — waiting on 2 interviews."</p>
      <textarea class="note-pop-ta" rows="4" placeholder="Write a note…">${esc(cur)}</textarea>
      <div class="bp-actions"><button type="button" class="btn btn-ghost" data-npcancel>Cancel</button><button type="button" class="btn btn-primary" data-npsave>Save note</button></div>
    </div>`;
    document.body.appendChild(ov);
    const ta = ov.querySelector(".note-pop-ta");
    ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    const close = () => ov.remove();
    ov.querySelector("[data-npcancel]").addEventListener("click", close);
    ov.querySelector("[data-npsave]").addEventListener("click", () => {
      eng.condition = eng.condition || {}; eng.condition.note = ta.value.trim();
      window.DASH.saveState(); close(); rerender();
    });
    // Shared helper: a bare click listener closed this popup while you were selecting
    // text in the textarea. It also carries Esc (the old listener was on `ov`, which
    // only fires when focus is inside — so Esc did nothing once you clicked away).
    window.TJA_UI.backdropClose(ov, close);
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
    // Key by the CALENDAR month+year — same scheme as wmj-sync's snapshotMonth, so an admin
    // touching the burn updates THIS month's entry rather than creating a mismatched one, and
    // a past (frozen) month is never overwritten.
    const now = new Date(), yr = now.getFullYear(), short = MONTHS[now.getMonth()].slice(0, 3);
    const actMap = actualByDiscipline(eng);
    const lines = (eng.serviceDisciplines || []).map((d) => ({
      name: d.name, contracted: +d.contracted || 0, billable: round2(actMap[canon(d.name)] || 0),
    }));
    // Match by (month, year) ANYWHERE (not just last) so a boundary race with another
    // writer updates in place instead of duplicating; no-year legacy adoption only for
    // the last entry. KEEP IN SYNC with wmj-sync.js snapshotMonth + snapshot-months fn.
    let idx = eng.mom.findIndex((m) => m && m.month === short && m.year === yr);
    if (idx < 0) {
      const last = eng.mom[eng.mom.length - 1];
      if (last && last.month === short && last.year == null) idx = eng.mom.length - 1;
    }
    if (idx >= 0) {
      const m = eng.mom[idx];
      m.year = yr; m.usedHours = usedNow; m.contractedHours = totalNow; m.lines = lines;
    } else {
      eng.mom.push({ month: short, year: yr, usedHours: usedNow, contractedHours: totalNow, lines });
    }
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

  // Projects: a compact "Project Plan" tile read from the CONNECTED plan sheet — phase
  // progress + condition, with a link to the full page. The old WMJ-fed "Tasks" module
  // (and its per-task internal/client visibility toggles) was retired 2026-07-20 along
  // with the plan page's WMJ view — the plan sheet is the single source of truth.
  function planSummaryModule(e) {
    const head = `<div class="module-head"><span class="module-title">${IC.svc}Project Plan</span><span class="module-link" data-go="plan">View full project plan →</span></div>`;
    const p = e.projectPlanSheet;
    if (!(p && p.groups && p.groups.length)) {
      const note = canAdmin()
        ? "No project plan connected yet — connect the plan sheet from the Project Plan page."
        : "Your project plan is being prepared — it will appear here soon.";
      return `<div class="module module--tasks">${head}<div class="pr-date">${esc(note)}</div></div>`;
    }
    const m = p.meta || {};
    let done = 0, total = 0;
    p.groups.forEach(g => g.tasks.forEach(t => { total++; if (t.status === "complete") done++; }));
    const pct = (m.condition && m.condition.pct != null) ? m.condition.pct : (total ? Math.round(done / total * 100) : 0);
    const lvl = (m.condition && m.condition.level) || "green";
    const rows = p.groups.map(g => {
      const gd = g.tasks.filter(t => t.status === "complete").length;
      const state = g.tasks.length && gd === g.tasks.length ? "complete"
        : (g.tasks.some(t => t.status === "in-progress" || t.status === "complete") ? "in-progress" : "pending");
      return `<div class="task-row">
          <span class="task-dot ${state}"></span>
          <span class="task-name">${g.num ? `<span class="plan-tnum">${esc(g.num)}</span> ` : ""}${esc(g.name)}</span>
          <span class="grp-count">${gd}/${g.tasks.length}</span>
        </div>`;
    }).join("");
    return `<div class="module module--tasks">
      ${head}
      <div class="plan-sum-top">
        <span class="plan-cond ${lvl}">${esc(lvl.toUpperCase())}</span>
        <div class="bar plan-bar"><span style="width:${pct}%"></span></div><span class="plan-pct">${pct}%</span>
        ${m.endDate ? `<span class="pr-date">ends ${esc(m.endDate)}</span>` : ""}
      </div>
      <div class="task-list-wrap">${rows}</div>
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
  // THE DENOMINATOR. The SOW/WMJ figure is the month's full allocated retainer hours and
  // ALWAYS wins — discipline hours are only the internal split *within* that total and must
  // never change it. A partial split is normal and expected: the shares simply won't add up
  // to 100% until every discipline is filled in.
  function retainerTotalContracted(e) {
    if (sowTargetUsable(e)) return +e.retainerValueTarget;
    // No SOW figure for this client/month (not in the revenue workbook, or not signed yet)
    // → fall back to the hand-entered disciplines, then to the last stored total.
    const d = e.serviceDisciplines;
    const disc = (Array.isArray(d) && d.length) ? d.reduce((s, x) => s + (+x.contracted || 0), 0) : 0;
    if (disc > 0) return disc;
    return (e.burn && +e.burn.contractedHours) || 0;
  }
  // keep the stored burn denominator in step with the source of truth above
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
  // Read-only Service Lines for a PAST month, from that month's snapshot (mom[i].lines).
  // Same %s as the live view — share = contracted / Σcontracted, util = billable / contracted.
  function historicalServiceModule(m) {
    const lines = (m && m.lines) || [];
    const totalC = lines.reduce((s, l) => s + (+l.contracted || 0), 0);
    if (!lines.length) {
      return `<div class="module">
        <div class="module-head"><span class="module-title">${IC.svc}Service Lines · ${esc(m.month)} ${m.year || ""}</span><span class="rsvc-legend">% of retainer</span></div>
        <div class="rsvc-list"><div class="pr-date">No service-line detail captured for this month.</div></div>
      </div>`;
    }
    const ordered = lines.map((l, i) => ({ l, i }))
      .sort((a, b) => (canon(a.l.name) === "oversight" ? 0 : 1) - (canon(b.l.name) === "oversight" ? 0 : 1));
    const rows = ordered.map(({ l }) => {
      const c = +l.contracted || 0, bill = +l.billable || 0;
      const share = totalC > 0 ? Math.round(c / totalC * 100) : 0;
      const util = c > 0 ? (bill / c * 100) : 0;
      const fill = Math.max(0, Math.min(100, util));
      let st = "not-started", lbl = "Not started";
      if (c <= 0) { st = "not-started"; lbl = "—"; }
      else if (util > 120) { st = "over"; lbl = "Over"; }
      else if (util >= 100) { st = "complete"; lbl = "Completed"; }
      else if (util > 0) { st = "in-progress"; lbl = "In progress"; }
      return `<div class="rsvc-row">
        <div class="rsvc-top"><span class="rsvc-name">${esc(l.name)}</span>
          <span class="rsvc-right"><span class="rsvc-status is-${st}">${lbl}</span><span class="rsvc-share">${share}%</span></span></div>
        <div class="rsvc-bar${st === "over" ? " over" : ""}"><span style="width:${fill}%"></span></div>
        <div class="rsvc-cap">${round2(bill)} of ${c} hrs${c > 0 ? ` · ${Math.round(util)}%` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.svc}Service Lines · ${esc(m.month)} ${m.year || ""}</span><span class="rsvc-legend">% of retainer</span></div>
      <div class="rsvc-list">${rows}</div>
    </div>`;
  }
  function retainerServiceModule(e) {
    // Viewing a frozen past month → show that month's snapshot, read-only.
    if (viewMonthIdx != null && e.mom && e.mom[viewMonthIdx]) return historicalServiceModule(e.mom[viewMonthIdx]);
    const admin = canAdmin();
    const disc = Array.isArray(e.serviceDisciplines) ? e.serviceDisciplines : [];
    const actual = actualByDiscipline(e);
    const total = retainerTotalContracted(e);
    const ov = e.svcUtilOverride || {};   // admin manual % overrides, keyed by discipline name
    // "needs setup" keys off the DISCIPLINES (not the total, which may come from the SOW feed):
    // until the admin splits hours across disciplines, rows stay neutral and the note shows.
    const unset = disc.reduce((s, d2) => s + (+d2.contracted || 0), 0) <= 0;
    // Strategic Oversight always sits at the top (Cameron's rule, 2026-07-17). Sort a VIEW
    // that carries each discipline's ORIGINAL index — the index drives inline edit, the drag
    // handle and delete, so it must stay bound to the real serviceDisciplines slot, not the
    // display position. Array.sort is stable, so every other discipline keeps its order.
    const discView = disc.map((d, i) => ({ d, i }))
      .sort((a, b) => (canon(a.d.name) === "oversight" ? 0 : 1) - (canon(b.d.name) === "oversight" ? 0 : 1));
    const rows = discView.map(({ d, i }) => {
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
    if (e.type === "project") return planSummaryModule(e);
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
    // Retainers run in two-week sprints, so the same list is "Sprint Goals" there and each
    // row carries a Sprint 1 / Sprint 2 ticker. Projects run to fixed dated milestones — no ticker.
    const isRet = e.type !== "project";
    const sprintOf = (m) => (+m.sprint === 2 ? 2 : 1);
    const sprintTag = (m, i) => {
      if (!isRet) return "";
      const n = sprintOf(m);
      return `<span class="owner-tag sprint${n} ${canAdmin() ? "admin-edit" : ""}" data-sprint="${i}" ${canAdmin() ? `title="Switch sprint (1 / 2)"` : ""}>Sprint ${n}</span>`;
    };
    const items = (e.milestones || []).map((m, i) => `
      <div class="ms-item ${m.done ? "done" : ""}">
        <button class="ms-check ${m.done ? "done" : ""}" ${canAdmin() ? `data-mstoggle="${i}"` : "disabled"} title="${m.done ? "Mark not done" : "Mark done"}"></button>
        <div class="ms-body">
          <div class="tl-label">${ed(m.label, "milestones." + i + ".label")}</div>
          <div class="ms-meta">${sprintTag(m, i)}<span class="tl-date">${ed(m.date, "milestones." + i + ".date")}</span></div>
        </div>
        ${canAdmin() ? `<button class="ms-del" data-listdel="milestones" data-idx="${i}" title="Remove milestone">✕</button>` : ""}
      </div>`).join("");
    // Projects: header links to the full Project Plan. Retainers have no project-plan
    // page (it force-redirects to exec), so the link only shows for projects.
    const planLink = e.type === "project" ? `<span class="module-link" data-go="plan">View plan →</span>` : "";
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.flag}${isRet ? "Sprint Goals" : "Milestones"}</span>${planLink}</div>
      <div class="ms-list">${items}</div>
      ${listAdd("milestones", isRet ? "Add sprint goal" : "Add milestone")}
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
      const connectBtn = canAdmin() ? `<button class="row-add pr-connect" data-prconnect title="${esc(e.prSheetUrl || "")}">✎ Change sheet</button>` : "";
      return `<div class="module">
        <div class="module-head"><span class="module-title">${IC.pr}PR Coverage · Recent Wins</span><span class="rsvc-legend">${n} hits YTD</span></div>
        <div class="pr-scroll">${rows || `<div class="pr-date">No coverage logged yet.</div>`}</div>
        ${connectBtn}
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
      ${canAdmin() ? `<button class="row-add pr-connect" data-prconnect>🔗 Connect Google Sheet</button>` : ""}
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
  // FIXED, LOCKED layouts — Cameron's final arrangement (captured 2026-07-09). Single source
  // of truth; changed only here in code, and only when Cameron specifically asks. Tiles are
  // absolutely positioned; they scroll internally if content exceeds their height.
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
  /* ---- Does this retainer carry PR? ----
     The signal is the SOW (contracted PR hours), NOT actuals — a PR client with nothing logged
     yet this month still has PR. Auto-detect is only the DEFAULT: an explicit admin choice
     (e.prTile true/false, set by the buttons) always wins, so the auto-rule can never undo it. */
  function prInSow(e) {
    const canon = window.tjaCanonDiscipline;
    const contracted = (e.serviceDisciplines || []).some(d => canon && canon(d.name) === "pr" && (+d.contracted || 0) > 0);
    return contracted || (e.prCoverage || []).length > 0;
  }
  function prTileOn(e) {
    if (e.prTile === true || e.prTile === false) return e.prTile;   // admin override
    return prInSow(e);
  }
  function defaultLayout(e) {
    if (e.type === "project") return { free: JSON.parse(JSON.stringify(DEFAULT_PROJECT_FREE)), hidden: PROJECT_HIDDEN.slice() };
    const free = JSON.parse(JSON.stringify(DEFAULT_RETAINER_FREE));
    if (!prTileOn(e)) {
      // No PR: drop the tile and let Service Lines take the whole middle column. Width is
      // untouched — only the height grows, down to the exact floor the PR tile used to reach,
      // so every other tile keeps its geometry and the canvas height is unchanged.
      const R = DEFAULT_RETAINER_FREE;
      free.service.h = R.pr.y + R.pr.h - R.service.y;   // 467 + 293 - 0 = 760
      return { free, hidden: ["pr"] };
    }
    return { free, hidden: [] };
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

  /* ---- Goal banner (full-width strip across all 3 columns) ----
     PROJECTS ONLY. Retainers don't carry a single headline goal — their direction lives in
     the Sprint Goals tile — so the banner is suppressed there and the canvas starts flush
     at the top (see render()). e.northStar is still stored on retainers, just not surfaced. */
  function goalBanner(e) {
    return `<div class="ns-banner">
      <span class="ns-banner-bolt">${IC.bolt}</span>
      <span class="ns-banner-label">Goal</span>
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
      const p = lay.free[k];   // every visible key is present in the fixed layout
      const style = `left:${p.x}px;top:${p.y}px;width:${p.w}px;${p.h ? `height:${p.h}px;` : ""}`;
      return `<div class="exec-tile" data-key="${k}" style="${style}">${MODULES[k].fn(e)}</div>`;
    }).join("");
    // Admin-only control bar. Both controls are data/visibility overrides, not layout drag.
    const ctl = [];
    if (canAdmin() && hasActualsOverride(e))
      ctl.push(`<button class="exec-actuals-btn" data-resetactuals title="Clear manual % adjustments and show the real WMJ actuals">↺ Reset to actuals</button>`);
    if (canAdmin() && e.type !== "project")
      ctl.push(prTileOn(e)
        ? `<button class="exec-actuals-btn" data-prtile="off" title="Hide the PR Coverage tile — Service Lines extends to fill the column">✕ Remove PR Coverage</button>`
        : `<button class="exec-actuals-btn" data-prtile="on" title="Show the PR Coverage tile — Service Lines shrinks back to make room">＋ Add PR Coverage</button>`);
    const controls = ctl.length ? `<div class="exec-controls">${ctl.join("")}</div>` : "";
    return `
    ${window.DASH.projectBack ? window.DASH.projectBack() : ""}
    ${e.type === "project" ? goalBanner(e) : ""}
    ${controls}
    <div class="exec-canvas locked">${tiles}</div>`;
  }
  function rerender() {
    const s = section(); if (!s) return;
    s.innerHTML = render(window.DASH.getEng());
    fitCanvas();
  }

  /* ---- burn → disciplines distribution popup ----
     When an admin changes the total burn, ask how the change is allocated across
     disciplines. Each row is independently editable — hours don't have to split evenly,
     but the rows must sum to EXACTLY the total change or Apply stays disabled (no silent
     rounding that leaves the real total drifted from what the gauge/field said). */
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
    // Even-split default, computed so the STARTING state already sums exactly (last row
    // absorbs the rounding remainder) — Apply is valid immediately, editing is optional.
    const evenBase = disc.length > 1 ? round2(delta / disc.length) : delta;
    const rowsHtml = disc.map((d, i) => {
      const used = round2(discUsed(eng, d, actMap));
      const rowDelta = i === disc.length - 1 ? round2(delta - evenBase * (disc.length - 1)) : evenBase;
      return `<div class="bp-row">
        <span class="bp-name">${esc(d.name)}</span><span class="bp-cur">${used} / ${(+d.contracted || 0)} hrs</span>
        <input type="number" step="0.1" class="bp-delta" data-i="${i}" data-used="${used}" data-contracted="${+d.contracted || 0}" value="${rowDelta}">
      </div>`;
    }).join("");
    ov.innerHTML = `<div class="burn-pop" role="dialog" aria-modal="true">
      <div class="bp-head">Adjust retainer burn</div>
      <p class="bp-lead">Total used <b>${currentUsed}</b> → <b>${targetUsed}</b> hrs (<b>${delta >= 0 ? "+" : ""}${delta}</b> hr${Math.abs(delta) === 1 ? "" : "s"}). Allocate the change across disciplines however it actually happened — the amounts must add up to the total.</p>
      <div class="bp-rows">${rowsHtml}</div>
      <div class="bp-total" data-bptotal></div>
      <div class="bp-actions"><button type="button" class="btn btn-ghost" data-bpcancel>Cancel</button><button type="button" class="btn btn-primary" data-bpapply>Apply</button></div>
    </div>`;
    document.body.appendChild(ov);
    const totalEl = ov.querySelector("[data-bptotal]");
    const applyBtn = ov.querySelector("[data-bpapply]");
    function checkValid() {
      const inputs = [...ov.querySelectorAll(".bp-delta")];
      const sum = round2(inputs.reduce((a, inp) => a + (parseFloat(inp.value) || 0), 0));
      const ok = Math.abs(sum - delta) < 0.01;
      totalEl.textContent = `Allocated: ${sum} / ${delta} hrs`;
      totalEl.classList.toggle("bp-total-bad", !ok);
      applyBtn.disabled = !ok;
      return ok;
    }
    ov.addEventListener("input", e => { if (e.target.closest(".bp-delta")) checkValid(); });
    checkValid();
    const close = (commit) => {
      if (commit && checkValid()) {
        eng.svcUtilOverride = eng.svcUtilOverride || {};
        ov.querySelectorAll(".bp-delta").forEach(inp => {
          const i = +inp.dataset.i, d = disc[i], c = +d.contracted || 0;
          const rowDelta = parseFloat(inp.value) || 0;
          const newUsed = Math.max(0, round2(discUsed(eng, d, actMap) + rowDelta));
          eng.svcUtilOverride[d.name] = c > 0 ? Math.round(newUsed / c * 100) : 0;
        });
        window.DASH.saveState();
      } else if (commit) { return; }   // invalid — Apply is disabled anyway, but guard direct calls
      burnPreviewPct = null; ov.remove(); rerender();
    };
    ov.querySelector("[data-bpcancel]").addEventListener("click", () => close(false));
    applyBtn.addEventListener("click", () => close(true));
    window.TJA_UI.backdropClose(ov, () => close(false));
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

  function canvasExtent(canvas) {
    let maxR = 0, maxB = 120;
    canvas.querySelectorAll(".exec-tile").forEach(t => { maxR = Math.max(maxR, t.offsetLeft + t.offsetWidth); maxB = Math.max(maxB, t.offsetTop + t.offsetHeight); });
    return { maxR, maxB };
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
      return;
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
    canvas.style.width = baseR + "px";                       // design width; scaled it becomes exactly `avail`
    canvas.style.transform = `scale(${sc})`; canvas.style.transformOrigin = "top left";
    canvas.style.marginBottom = (h * (sc - 1)) + "px";       // compensate layout height for the visual scale
  }

  /* ---- wiring (delegated, attached once) ---- */
  const defaults = {
    serviceDisciplines: () => ({ name: "New discipline", contracted: 0 }),
    serviceLines: () => ({ name: "New service line", allocationPct: 0, status: "not-started" }),
    // the only default that cares about engagement type — retainers call these Sprint Goals
    milestones: (e) => ({ label: (e && e.type !== "project") ? "New sprint goal" : "New milestone", date: "", done: false, sprint: 1 }),
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
    // The gauge reads retainerUsed(), which sums every discipline's override — so a full rerender
    // on each move (throttled via rAF, same pattern as the gauge's own drag below) makes the
    // speedometer track live instead of only jumping on release. Re-query the handle by index on
    // every move rather than keeping the original DOM reference — rerender() replaces the whole
    // tile's innerHTML, so a cached node reference would go stale/detached after the first frame
    // (same reason gaugePct() below re-queries `.gauge-drag` fresh on every call instead of caching it).
    let svcIdx = null, svcName = null, svcPendingPct = null, svcRaf = null;
    function svcApply() {
      svcRaf = null;
      if (svcPendingPct == null || svcName == null) return;
      const eng = window.DASH.getEng();
      (eng.svcUtilOverride || (eng.svcUtilOverride = {}))[svcName] = svcPendingPct;
      rerender();
    }
    function svcMove(ev) {
      if (svcIdx == null) return; ev.preventDefault();
      const h = section().querySelector(`.rsvc-handle[data-svcutil="${svcIdx}"]`);
      const bar = h && h.closest(".rsvc-bar"); if (!bar) return;
      const r = bar.getBoundingClientRect();
      svcPendingPct = Math.max(0, Math.min(100, Math.round((ev.clientX - r.left) / r.width * 100)));
      if (!svcRaf) svcRaf = requestAnimationFrame(svcApply);
    }
    function svcUp() {
      if (svcIdx == null) return; svcIdx = null; svcName = null; svcPendingPct = null;
      document.removeEventListener("pointermove", svcMove);
      document.removeEventListener("pointerup", svcUp);
      window.DASH.saveState(); rerender();
    }
    s.addEventListener("pointerdown", ev => {
      const h = ev.target.closest(".rsvc-handle"); if (!h || !canAdmin()) return;
      ev.preventDefault();
      const line = (window.DASH.getEng().serviceDisciplines || [])[+h.dataset.svcutil]; if (!line) return;
      svcIdx = h.dataset.svcutil; svcName = line.name;
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
    s.addEventListener("click", async e => {
      const eng = window.DASH.getEng();

      const go = e.target.closest("[data-go]"); if (go) { window.DASH.activate(go.dataset.go); return; }

      // condition note → roomy popup editor (admin)
      const cn = e.target.closest("[data-condnote]");
      if (cn && canAdmin()) { openConditionNote(); return; }

      // "Reset to actuals" — clear the manual % adjustments; the burn returns to Σ WMJ actuals
      const ra = e.target.closest("[data-resetactuals]");
      if (ra && canAdmin()) { delete eng.svcUtilOverride; if (eng.burn) delete eng.burn.pctOverride; window.DASH.saveState(); rerender(); return; }

      // Unallocated drill-down → popup listing the projects behind the misc hours
      const ut = e.target.closest("[data-unalloctoggle]");
      if (ut && canAdmin()) { openUnallocPopup(window.DASH.getEng()); return; }

      // PR Coverage → connect/change the team's Google Sheet (admin/AM-PM)
      const pc = e.target.closest("[data-prconnect]");
      if (pc && canAdmin()) {
        const cur = eng.prSheetUrl || "";
        const raw = await window.TJA_UI.prompt("Paste the PR sheet's share link (must be shared “Anyone with the link – Viewer”):",
          { title: "Connect PR sheet", value: cur, okText: "Connect" });
        if (raw == null) return;   // cancelled
        const reg = window.CLIENT_PR_SHEETS;
        if (!raw.trim()) { delete eng.prSheetUrl; eng.prSource = "manual"; window.DASH.saveState(); rerender(); return; }
        const cfg = reg && reg.parseSheetUrl(raw);
        if (!cfg) { window.TJA_UI.alert("That doesn't look like a Google Sheets link. Paste the full share URL."); return; }
        eng.prSheetUrl = raw.trim();
        pc.disabled = true; pc.textContent = "Connecting…";
        window.DASH.refreshPRSheet(eng, cfg).then(ok => {
          if (!ok) window.TJA_UI.alert("Couldn't read that sheet — check it's shared “Anyone with the link – Viewer” and try again.");
          window.DASH.saveState(); rerender();
        });
        return;
      }

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
          .catch(err => { window.TJA_UI.alert("Couldn't post to Slack: " + (err && err.message || err)); rerender(); });
        return;
      }

      const add = e.target.closest("[data-listadd]");
      if (add) { const k = add.dataset.listadd; (eng[k] || (eng[k] = [])).push(defaults[k](eng)); if (k === "serviceDisciplines") syncContracted(eng); window.DASH.saveState(); rerender(); return; }

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
      const svcset = e.target.closest("[data-svcset]");
      if (svcset && canAdmin()) { const [idx, val] = svcset.dataset.svcset.split(":"); eng.serviceLines[+idx].status = val; window.DASH.saveState(); rerender(); return; }

      const own = e.target.closest("[data-owner]");
      if (own && canAdmin()) { const t = eng.todos[+own.dataset.owner]; t.owner = t.owner === "TJA" ? "Client" : "TJA"; window.DASH.saveState(); rerender(); return; }
      const spr = e.target.closest("[data-sprint]");
      if (spr && canAdmin()) { const m = eng.milestones[+spr.dataset.sprint]; m.sprint = (+m.sprint === 2) ? 1 : 2; window.DASH.saveState(); rerender(); return; }
      const prT = e.target.closest("[data-prtile]");
      if (prT && canAdmin()) { eng.prTile = prT.dataset.prtile === "on"; window.DASH.saveState(); rerender(); return; }

      const ms = e.target.closest("[data-mstoggle]");
      if (ms && canAdmin()) { const m = eng.milestones[+ms.dataset.mstoggle]; m.done = !m.done; window.DASH.saveState(); rerender(); return; }

      const mom = e.target.closest("[data-mom]");
      if (mom) {
        const idx = +mom.dataset.mom;
        const eng2 = window.DASH.getEng();
        // clicking the CURRENT (last) month returns to the live, editable view;
        // clicking a past month shows its frozen snapshot (burn + service lines).
        viewMonthIdx = (eng2.mom && idx === eng2.mom.length - 1) ? null : idx;
        rerender(); return;
      }

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
