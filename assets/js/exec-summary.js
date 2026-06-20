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
    return `<svg viewBox="0 0 260 175" width="100%" style="max-width:240px${interactive ? ";cursor:grab;touch-action:none" : ""}" class="gauge-svg${interactive ? " gauge-drag" : ""}">
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
      <div class="burn-cond-row"><span class="bc-label">${IC.cond}Condition</span><span class="cond-dots">${dot("green")}${dot("yellow")}${dot("red")}</span><span class="cond-label ${lvl}">${labels[lvl] || "—"}</span></div>
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
    const rows = (e.serviceLines || []).map((s, i) => `
      <div class="svc-row" data-svcrow="${i}">
        <div class="svc-name ed-host">${ed(s.name, "serviceLines." + i + ".name")}</div>
        <div class="svc-alloc"><div class="bar" style="flex:1"><span style="width:${s.allocationPct}%"></span></div><span class="pct">${s.allocationPct}%</span></div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="svc-status ${canAdmin() ? "admin-edit" : ""}" data-svc="${i}" ${canAdmin() ? `title="Toggle status"` : ""}>${window.DASH.badge(s.status)}</span>
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

  function todosModule(e) {
    const rows = (e.todos || []).map((t, i) => `
      <div class="tile-item">
        <span class="owner-tag ${owners(t.owner)} ${canAdmin() ? "admin-edit" : ""}" data-owner="${i}" ${canAdmin() ? `title="Toggle owner (Client / TJA)"` : ""}>${esc(t.owner)}</span>
        <span class="ed-host" style="flex:1">${ed(t.text, "todos." + i + ".text")}</span>
        ${listDel("todos", i)}
      </div>`).join("");
    return `<div class="module">
      <div class="module-head"><span class="module-title">${IC.todo}To-Do's</span></div>
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
          <span class="pr-metric" title="Impressions">${ed(p.impressions, "prCoverage." + i + ".impressions")} impr.</span>
          <span class="pr-metric pr-val" title="Ad value equivalent">${ed(p.adValue, "prCoverage." + i + ".adValue")}</span>
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
  const LAYOUT_V = 3;   // bump to force every saved layout onto the 3-column default once
  const COLS = ["c1", "c2", "c3"];
  function defaultLayout(e) {
    const c3 = ["dependencies", "kpis"];
    if (e.type !== "project") c3.push("pr");
    return { v: LAYOUT_V, c1: ["burn", "service"], c2: ["milestones", "todos"], c3, hidden: e.type === "project" ? ["pr"] : [], widths: [1.2, 1, 1] };
  }
  function getLayout(e) {
    if (!e.layout || e.layout.v !== LAYOUT_V) e.layout = defaultLayout(e);
    const L = e.layout;
    if (!Array.isArray(L.hidden)) L.hidden = [];
    if (!Array.isArray(L.widths) || L.widths.length !== 3) L.widths = [1.2, 1, 1];
    // drop unknown/duplicate keys; keep only real modules, de-duped (e.g. legacy "condition" is now folded into burn)
    const valid = Object.keys(MODULES); const used = new Set();
    [...COLS, "hidden"].forEach(c => { if (!Array.isArray(L[c])) L[c] = []; L[c] = L[c].filter(k => valid.includes(k) && !used.has(k) && used.add(k)); });
    valid.forEach(k => { if (!used.has(k)) L.hidden.push(k); });
    if (L.c1.length + L.c2.length + L.c3.length === 0) { const d = defaultLayout(e); L.c1 = d.c1; L.c2 = d.c2; L.c3 = d.c3; }
    return L;
  }
  function colTemplate(e) {
    const w = getLayout(e).widths;
    return `minmax(0,${w[0]}fr) 16px minmax(0,${w[1]}fr) 16px minmax(0,${w[2]}fr)`;
  }
  const TILEBAR = (key) => !canAdmin() ? "" : `<button class="tile-remove" data-tileremove="${key}" title="Remove tile">✕</button>`;
  function colHtml(e, col) {
    const keys = getLayout(e)[col];
    return keys.map((k) => `<div class="exec-tile" data-key="${k}">${TILEBAR(k)}${MODULES[k].fn(e)}</div>`).join("");
  }

  /* ---- assemble ---- */
  function render(e) {
    const lay = getLayout(e);
    const hiddenRow = (canAdmin() && lay.hidden.length)
      ? `<div class="exec-add"><span class="exec-add-label">Hidden tiles:</span>${lay.hidden.map(k => `<button class="exec-add-btn" data-tilerestore="${k}">＋ ${esc(MODULES[k].label)}</button>`).join("")}</div>`
      : "";
    return `
    ${window.DASH.projectBack ? window.DASH.projectBack() : ""}
    <div class="exec-cols" style="grid-template-columns:${colTemplate(e)}">
      <div class="exec-col" data-col="c1">${colHtml(e, "c1")}</div>
      <div class="exec-gutter" data-gutter="0" title="Drag to resize columns"></div>
      <div class="exec-col" data-col="c2">${colHtml(e, "c2")}</div>
      <div class="exec-gutter" data-gutter="1" title="Drag to resize columns"></div>
      <div class="exec-col" data-col="c3">${colHtml(e, "c3")}</div>
    </div>
    ${hiddenRow}`;
  }
  function rerender() { const s = section(); if (s) { s.innerHTML = render(window.DASH.getEng()); setupDrag(); setupResize(); } }

  /* ---- tile remove / restore ---- */
  function tileAction(action, key) {
    const e = window.DASH.getEng(); const lay = getLayout(e);
    if (action === "remove") {
      COLS.forEach(c => { const i = lay[c].indexOf(key); if (i > -1) lay[c].splice(i, 1); });
      if (!lay.hidden.includes(key)) lay.hidden.push(key);
    } else if (action === "restore") {
      lay.hidden = lay.hidden.filter(k => k !== key); lay.c3.push(key);
    }
    window.DASH.saveState(); rerender();
  }

  /* ---- drag a column gutter to resize the three columns ---- */
  function setupResize() {
    if (!canAdmin()) return;
    const s = section(); if (!s) return;
    const cols = s.querySelector(".exec-cols"); if (!cols) return;
    s.querySelectorAll(".exec-gutter").forEach(g => {
      g.addEventListener("pointerdown", ev => {
        ev.preventDefault();
        const gi = +g.dataset.gutter;
        const e = window.DASH.getEng(), lay = getLayout(e);
        const rect = cols.getBoundingClientRect();
        const pxPerFr = rect.width / lay.widths.reduce((a, b) => a + b, 0);
        const startX = ev.clientX, w0 = lay.widths[gi], w1 = lay.widths[gi + 1];
        g.classList.add("resizing");
        const move = (mv) => {
          const dFr = (mv.clientX - startX) / pxPerFr; const min = 0.45;
          let a = w0 + dFr, b = w1 - dFr;
          if (a < min) { b -= (min - a); a = min; }
          if (b < min) { a -= (min - b); b = min; }
          lay.widths[gi] = a; lay.widths[gi + 1] = b;
          cols.style.gridTemplateColumns = colTemplate(e);
        };
        const up = () => {
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          g.classList.remove("resizing");
          window.DASH.saveState();
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
      });
    });
  }

  /* ---- drag-and-drop: grab a tile by its header to move it ---- */
  let dragKey = null;
  function setupDrag() {
    if (!canAdmin()) return;
    const s = section(); if (!s) return;
    s.querySelectorAll(".exec-tile").forEach(tile => {
      const head = tile.querySelector(".module-head");
      if (head) {
        head.setAttribute("draggable", "true");
        head.classList.add("tile-drag-handle");
        head.addEventListener("dragstart", ev => {
          dragKey = tile.dataset.key;
          ev.dataTransfer.effectAllowed = "move";
          ev.dataTransfer.setData("text/plain", dragKey);
          try { ev.dataTransfer.setDragImage(tile, 24, 18); } catch {}
          requestAnimationFrame(() => tile.classList.add("dragging"));
        });
        head.addEventListener("dragend", () => {
          tile.classList.remove("dragging");
          s.querySelectorAll(".drag-over").forEach(z => z.classList.remove("drag-over"));
        });
      }
    });
    s.querySelectorAll(".exec-tile, .exec-col").forEach(zone => {
      zone.addEventListener("dragover", ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = "move"; zone.classList.add("drag-over"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
      zone.addEventListener("drop", ev => {
        ev.preventDefault();
        ev.stopPropagation();                 // prevent the tile + its column both handling the same drop
        s.querySelectorAll(".drag-over").forEach(z => z.classList.remove("drag-over"));
        const key = ev.dataTransfer.getData("text/plain") || dragKey;
        if (key) dropTile(key, zone, ev);
        dragKey = null;
      });
    });
  }
  function dropTile(key, zone, ev) {
    const e = window.DASH.getEng(); const lay = getLayout(e);
    const tileZone = zone.classList.contains("exec-tile") ? zone : null;
    if (tileZone && tileZone.dataset.key === key) return;          // dropped on itself → no-op
    // remove from wherever it currently lives
    COLS.forEach(c => { const i = lay[c].indexOf(key); if (i > -1) lay[c].splice(i, 1); });
    let col, idx;
    if (tileZone) {
      const tkey = tileZone.dataset.key;
      col = COLS.find(c => lay[c].includes(tkey)) || "c1";
      const r = tileZone.getBoundingClientRect();
      idx = lay[col].indexOf(tkey) + (ev.clientY > r.top + r.height / 2 ? 1 : 0);
    } else {
      col = (zone.dataset && zone.dataset.col) || ((zone.closest(".exec-col") || {}).dataset || {}).col || "c1";
      idx = lay[col].length;
    }
    if (!Array.isArray(lay[col])) col = "c1";                      // safety
    lay[col].splice(idx, 0, key);
    window.DASH.saveState(); rerender();
  }

  /* ---- wiring (delegated, attached once) ---- */
  const defaults = {
    serviceLines: () => ({ name: "New service line", allocationPct: 0, status: "in-progress" }),
    milestones: () => ({ label: "New milestone", date: "", done: false }),
    todos: () => ({ text: "New to-do", owner: "Client" }),
    dependencies: () => ({ text: "New dependency" }),
    kpis: () => ({ label: "New KPI", target: "", current: "" }),
    prCoverage: () => ({ outlet: "Outlet", headline: "Headline", date: "" }),
  };
  let wired = false;
  function init() {
    rerender();
    if (wired) return; wired = true;
    const s = section();

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
      const cx = r.left + (130 / 260) * r.width, cy = r.top + (140 / 175) * r.height;
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

      const svc = e.target.closest("[data-svc]");
      if (svc && canAdmin()) { const sl = eng.serviceLines[+svc.dataset.svc]; sl.status = sl.status === "complete" ? "in-progress" : "complete"; window.DASH.saveState(); rerender(); return; }

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
      if (row && !e.target.closest(".ed,[data-svc],[data-listdel]")) window.DASH.activate("status");
    });
  }

  return { render, init };
})();
