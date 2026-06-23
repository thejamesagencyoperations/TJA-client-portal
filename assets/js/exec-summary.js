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
    return `<svg viewBox="0 25 260 180" width="100%" style="max-width:240px${interactive ? ";cursor:grab;touch-action:none" : ""}" class="gauge-svg${interactive ? " gauge-drag" : ""}">
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
  function conditionInline(e) {
    const c = e.condition || { level: "green", note: "" }, lvl = c.level;
    const labels = { green: "On Track", yellow: "Needs Attention", red: "Off Track" };
    const dot = (col) => `<span class="cond-dot ${col} ${lvl === col ? "on" : ""} ${canAdmin() ? "admin-edit" : ""}" data-cond="${col}" ${canAdmin() ? `title="Set to ${col}"` : ""}></span>`;
    return `<div class="burn-cond">
      <div class="burn-cond-row"><span class="bc-label">${IC.cond}Condition</span><span class="cond-label ${lvl}">${labels[lvl] || "—"}</span><span class="cond-dots">${dot("green")}${dot("yellow")}${dot("red")}</span></div>
      <div class="cond-note">${ed(c.note, "condition.note")}</div>
    </div>`;
  }

  /* ---- monthly history (retainer) — keep every past month so nothing is lost ---- */
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function syncCurrentMonth(eng) {           // mirror the live burn into the persisted month-history array
    if (!eng || !eng.burn) return;
    eng.mom = eng.mom || [];
    const cur = (eng.burn.periodLabel || "").trim().slice(0, 3);
    const last = eng.mom[eng.mom.length - 1];
    if (last && last.month === cur) { last.usedHours = eng.burn.usedHours; last.contractedHours = eng.burn.contractedHours; }
    else eng.mom.push({ month: cur, usedHours: eng.burn.usedHours, contractedHours: eng.burn.contractedHours });
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
      const ph = e.pizza.phases, cur = ph.findIndex(p => !p.done);
      const steps = ph.map((p, i) => {
        const state = p.done ? "done" : (i === cur ? "current" : "");
        return `<div class="pizza-step ${state}"><div class="pizza-dot ${canAdmin() ? "admin-edit" : ""}" data-phase="${i}" ${canAdmin() ? `title="Toggle ${esc(p.label)} complete"` : ""}>${p.done ? "✓" : i + 1}</div><div class="pizza-label">${esc(p.label)}</div></div>`;
      }).join("");
      const pct = Math.round(ph.filter(p => p.done).length / ph.length * 100);
      return `<div class="module">
        <div class="module-head"><span class="module-title">${IC.burn}Project Progress · ${pct}%</span></div>
        <div class="pizza">${steps}</div>
        ${canAdmin() ? `<div class="burn-edit">Click a phase to mark it complete.</div>` : ""}
        ${conditionInline(e)}
      </div>`;
    }
    // retainer speedometer
    const b = (viewMonthIdx == null) ? e.burn : e.mom[viewMonthIdx];
    const used = b.usedHours, total = b.contractedHours, pct = Math.round(used / total * 100);
    const mom = (e.mom || []).map((m, i) => {
      const active = (viewMonthIdx == null) ? (i === e.mom.length - 1) : (i === viewMonthIdx);
      return `<div class="mom-chip ${active ? "active" : ""}" data-mom="${i}" title="View ${esc(m.month)}"><div class="m">${esc(m.month)}</div><div class="v">${Math.round(m.usedHours / m.contractedHours * 100)}%</div></div>`;
    }).join("");
    const interactive = canAdmin() && viewMonthIdx == null;
    const bigPct = canAdmin()
      ? `<span class="ed burn-pct" contenteditable="true" data-burnpct="1">${pct}</span>%`
      : `${pct}%`;
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.burn}Retainer Burn · ${esc(e.burn.periodLabel)}</span></div>
      <div class="burn-wrap">
        ${gauge(pct, interactive)}
        <div class="burn-readout">
          <div class="big">${bigPct}</div>
          ${canAdmin()
            ? `<div class="sub">${used} of ${ed(total, "burn.contractedHours", { num: true, rerender: true })} hrs used</div>
               <div class="burn-hint">drag the dial or edit the % to set burn</div>`
            : `<div class="sub">${used} of ${total} hrs used</div>`}
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

  function serviceModule(e) {
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
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.flag}Milestones</span></div>
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
  function todosModule(e) {
    const cc = e.todoClientColor || "#6aa6ff";   // TJA tasks are always orange; Client task colour is configurable
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
    if (!list.length && !canAdmin()) return "";
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
  function defaultLayout(e) {
    return { v: LAYOUT_V, free: {}, hidden: e.type === "project" ? ["pr"] : [] };
  }
  function getLayout(e) {
    if (!e.layout || e.layout.v !== LAYOUT_V) {
      const prevHidden = (e.layout && Array.isArray(e.layout.hidden)) ? e.layout.hidden.slice() : null;
      e.layout = defaultLayout(e);
      if (prevHidden) e.layout.hidden = prevHidden;
    }
    const L = e.layout;
    if (!L.free || typeof L.free !== "object") L.free = {};
    if (!Array.isArray(L.hidden)) L.hidden = [];
    const valid = Object.keys(MODULES);
    L.hidden = [...new Set(L.hidden.filter(k => valid.includes(k)))];
    Object.keys(L.free).forEach(k => { if (!valid.includes(k) || L.hidden.includes(k)) delete L.free[k]; });
    return L;
  }
  const TILEBAR = (key) => !canAdmin() ? "" : `<button class="tile-remove" data-tileremove="${key}" title="Remove tile">✕</button>`;

  /* ---- North Star banner (full-width strip across all 3 columns) ---- */
  function northStarBanner(e) {
    const due = e.type === "project" ? `<span class="ns-banner-due">Due ${ed(e.dueDate, "dueDate")}</span>` : "";
    return `<div class="ns-banner">
      <span class="ns-banner-bolt">${IC.bolt}</span>
      <span class="ns-banner-label">North Star</span>
      <span class="ns-banner-text">${ed(e.northStar, "northStar")}</span>
      ${due}
    </div>`;
  }

  /* ---- assemble (free canvas: tiles absolutely positioned, drag anywhere) ---- */
  function render(e) {
    const lay = getLayout(e);
    const visible = Object.keys(MODULES).filter(k => !lay.hidden.includes(k));
    const tiles = visible.map(k => {
      const p = lay.free[k];
      const style = p
        ? `left:${p.x}px;top:${p.y}px;width:${p.w}px;${p.h ? `height:${p.h}px;` : ""}`
        : `width:${DEF_W}px;`;   // unplaced → positioned by ensurePositions after first layout
      return `<div class="exec-tile${p ? "" : " unplaced"}" data-key="${k}" style="${style}">${TILEBAR(k)}${MODULES[k].fn(e)}</div>`;
    }).join("");
    const hiddenRow = (canAdmin() && lay.hidden.length)
      ? `<div class="exec-add"><span class="exec-add-label">Hidden tiles:</span>${lay.hidden.map(k => `<button class="exec-add-btn" data-tilerestore="${k}">＋ ${esc(MODULES[k].label)}</button>`).join("")}</div>`
      : "";
    return `
    ${window.DASH.projectBack ? window.DASH.projectBack() : ""}
    ${northStarBanner(e)}
    <div class="exec-canvas">${tiles}</div>
    ${hiddenRow}`;
  }
  function rerender() {
    const s = section(); if (!s) return;
    s.innerHTML = render(window.DASH.getEng());
    ensurePositions(); setupFreeDrag(); updateCanvasHeight();
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

  /* ---- default placement: pack any unplaced tile into the shortest column ---- */
  function nearestCol(x, colX) { let b = 0, bd = Infinity; colX.forEach((cx, i) => { const d = Math.abs(x - cx); if (d < bd) { bd = d; b = i; } }); return b; }
  function applyPos(t, p) { t.style.left = p.x + "px"; t.style.top = p.y + "px"; t.style.width = p.w + "px"; if (p.h) t.style.height = p.h + "px"; }
  function ensurePositions() {
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    const lay = getLayout(window.DASH.getEng());
    const cw = canvas.clientWidth || 1100;
    const ncols = Math.max(1, Math.min(3, Math.floor((cw + GRID_GAP) / (DEF_W + GRID_GAP))));
    const colW = ncols === 1 ? cw : DEF_W;
    const colX = []; for (let i = 0; i < ncols; i++) colX.push(Math.round(i * (colW + GRID_GAP)));
    const colH = new Array(ncols).fill(0);
    canvas.querySelectorAll(".exec-tile:not(.unplaced)").forEach(t => {
      const ci = nearestCol(t.offsetLeft, colX);
      colH[ci] = Math.max(colH[ci], t.offsetTop + t.offsetHeight + GRID_GAP);
    });
    let changed = false;
    canvas.querySelectorAll(".exec-tile.unplaced").forEach(t => {
      t.style.width = colW + "px";
      const h = t.offsetHeight;
      const ci = colH.indexOf(Math.min(...colH));
      const pos = { x: colX[ci], y: Math.round(colH[ci]), w: colW };
      colH[ci] += h + GRID_GAP;
      applyPos(t, pos); t.classList.remove("unplaced");
      lay.free[t.dataset.key] = pos; changed = true;
    });
    if (changed && canAdmin()) window.DASH.saveState();
  }
  function updateCanvasHeight() {
    const s = section(); const canvas = s && s.querySelector(".exec-canvas"); if (!canvas) return;
    let maxB = 120;
    canvas.querySelectorAll(".exec-tile").forEach(t => { maxB = Math.max(maxB, t.offsetTop + t.offsetHeight); });
    canvas.style.height = (maxB + 8) + "px";
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
          const nx = Math.max(0, ox + (mv.clientX - sx)), ny = Math.max(0, oy + (mv.clientY - sy));
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
          updateCanvasHeight();
        };
        head.addEventListener("pointermove", move);
        head.addEventListener("pointerup", up);
        head.addEventListener("pointercancel", up);
      });
    });
  }

  /* ---- wiring (delegated, attached once) ---- */
  const defaults = {
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

    // per-tile resize (CSS resize: both) — persist each tile's width/height on release
    document.addEventListener("mouseup", () => {
      if (!canAdmin()) return;
      const sec = section(); if (!sec) return;
      const lay = getLayout(window.DASH.getEng()); if (!lay.free) return;
      let changed = false;
      sec.querySelectorAll(".exec-tile[data-key]").forEach(t => {
        const pos = lay.free[t.dataset.key]; if (!pos) return;
        const w = Math.round(t.offsetWidth), h = Math.round(t.offsetHeight);
        if (pos.w !== w || (t.style.height && pos.h !== h)) { pos.w = w; if (t.style.height) pos.h = h; changed = true; }
      });
      if (changed) { window.DASH.saveState(); updateCanvasHeight(); }
    });

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
        eng.burn.usedHours = Math.round(pct / 100 * eng.burn.contractedHours);
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
      const eng = window.DASH.getEng();
      eng.burn.usedHours = Math.round(pct / 100 * eng.burn.contractedHours);
      viewMonthIdx = null; rerender();
    }
    function gaugeMove(ev) { ev.preventDefault(); pendingEv = ev; if (!raf) raf = requestAnimationFrame(gaugeApply); }
    function gaugeUp() {
      if (!gaugeDragging) return; gaugeDragging = false;
      document.removeEventListener("pointermove", gaugeMove);
      document.removeEventListener("pointerup", gaugeUp);
      syncCurrentMonth(window.DASH.getEng()); window.DASH.saveState();
    }
    s.addEventListener("pointerdown", ev => {
      if (!canAdmin() || !ev.target.closest(".gauge-drag")) return;
      ev.preventDefault(); gaugeDragging = true; pendingEv = ev; gaugeApply();
      document.addEventListener("pointermove", gaugeMove);
      document.addEventListener("pointerup", gaugeUp);
    });

    // structural / toggle actions
    s.addEventListener("click", e => {
      const eng = window.DASH.getEng();

      // kanban tile controls
      const tm = e.target.closest("[data-tilemove]"); if (tm) { tileAction(tm.dataset.tilemove, tm.dataset.key); return; }
      const tr = e.target.closest("[data-tileremove]"); if (tr) { tileAction("remove", tr.dataset.tileremove); return; }
      const ts = e.target.closest("[data-tilerestore]"); if (ts) { tileAction("restore", ts.dataset.tilerestore); return; }

      const go = e.target.closest("[data-go]"); if (go) { window.DASH.activate(go.dataset.go); return; }

      const add = e.target.closest("[data-listadd]");
      if (add) { eng[add.dataset.listadd].push(defaults[add.dataset.listadd]()); window.DASH.saveState(); rerender(); return; }

      const del = e.target.closest("[data-listdel]");
      if (del) { eng[del.dataset.listdel].splice(+del.dataset.idx, 1); window.DASH.saveState(); rerender(); return; }

      const cond = e.target.closest("[data-cond]");
      if (cond && canAdmin()) { eng.condition.level = cond.dataset.cond; window.DASH.saveState(); rerender(); return; }

      const phase = e.target.closest("[data-phase]");
      if (phase && canAdmin()) {
        const i = +phase.dataset.phase, ph = eng.pizza.phases;
        // sequential: clicking a done phase clears it onward; clicking an undone phase fills up to it
        if (ph[i].done) { for (let j = i; j < ph.length; j++) ph[j].done = false; }
        else { for (let j = 0; j <= i; j++) ph[j].done = true; }
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
