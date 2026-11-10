/* ============================================================
   BUDGET CONTROLS page — v407, Cameron 2026-11-04.

   The client's yearly paid-media Budget Control, laid out EXACTLY like the team's sheet:
   BUDGET CONTROL banner · client · year, a quarter row (Q1–Q4) over a MONTH row, then each
   category (SEARCH ADS, PAID SOCIAL …, grey) with its channels under it, a $ per month, the
   ESTIMATED NET TOTAL per channel, Digital Sub-Total (NET), Total Monthly Spend (GROSS =
   NET ÷ (1 − agency %)) and the Client Approval · Print Name · Date of Approval block.

     • ORANGE cell = actualized (spent). Editors flip a cell with the small button in its
       corner (or a whole month from the month header) — one click, saves itself.
     • Built HERE (2027 on): editors type straight into the grid (amounts accept "1500+250"
       like the sheet's formulas), add / remove / reorder categories and channels.
       "＋ New year" starts a year blank or as a DUPLICATE of last year's channels ($ cleared).
     • Or import once from the connected Google Sheet (orange fills → actualized, CHANGE LOG
       tab → the change log). After that the portal copy is the one that counts.
     • Signing: same typed signature as the SAP. If planned $ change after a signature, the year
       reads "Amended — needs re-signing" and can be signed again; each signed version is a PDF
       in Drive (Budget Controls/<YYYY>/) + the client's Slack. Actualizing isn't a change.
     • Change Log under the grid: automatic once a year is signed (every $ edit), plus manual
       Reflight / Rollover entries.

   Editors = admin, the client's AM/PM (canEdit) and the paid-media team. Server-owned data:
   everything goes through the `budget` Edge Function, never the dashboard write.
   ============================================================ */
window.BUDGET_PAGE = (function () {
  const PAGE = "budget";
  let view = null, loading = false, loadErr = "", yearKey = null, wired = false, forClient = "", lastLoad = 0;
  let work = null, dirty = false, saving = false, saveTimer = null, busy = false;

  async function call(action, extra) {
    const cfg = window.SUPABASE_CONFIG || {};
    const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
    if (!base || !(window.SUPA && window.SUPA.enabled && window.SUPA.client)) return { ok: false, error: "The portal backend isn't available." };
    const { data } = await window.SUPA.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) return { ok: false, error: "Please sign in again." };
    try {
      const r = await fetch(base + "/budget", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(Object.assign({ action, clientId: clientId() }, extra || {})),
      });
      const j = await r.json().catch(() => ({}));
      return Object.assign({ ok: r.ok && j.ok !== false }, j, r.ok ? {} : { error: j.error || "Something went wrong (" + r.status + ")." });
    } catch (e) { return { ok: false, error: "Couldn't reach the portal backend." }; }
  }
  const editingNow = () => dirty || saving || !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".bc-sheet, .bc-log"));
  async function load(force) {
    if (loading) return; loading = true; lastLoad = Date.now();
    const r = await call("fetch", force ? { force: true } : {});
    loading = false;
    if (r.ok && r.view) { view = r.view; loadErr = ""; } else if (!view) loadErr = r.error || "Couldn't load the budget control.";
    if (!editingNow()) repaint(PAGE);
  }

  /* ---- helpers ---- */
  const MONTHS = ["JANUARY","FEBRUARY","MARCH","APRIL","MAY","JUNE","JULY","AUGUST","SEPTEMBER","OCTOBER","NOVEMBER","DECEMBER"];
  const MON_S = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const r2 = (n) => Math.round(n * 100) / 100;
  const money = (n) => (n == null || n === "") ? "" : (n < 0 ? "-" : "") + "$" + Math.abs(+n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); } catch (e) { return ""; } };
  const shortDate = (s) => {
    if (!s) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); if (m) return `${+m[2]}/${+m[3]}/${m[1].slice(2)}`;
    return String(s);
  };
  const isStaffReal = () => { const s = (typeof getSession === "function") && getSession(); return !!(s && s.role && s.role !== "client"); };
  const previewing = () => (typeof isPreviewing === "function") && isPreviewing();
  // who may build / actualize: admins, the client's AM/PM, the paid-media team (never in Client View)
  const canBC = () => !previewing() && ((typeof canEdit === "function" && canEdit()) || (typeof isMedia === "function" && isMedia()));
  const isAdminReal = () => !previewing() && typeof isAdmin === "function" && isAdmin();
  const clientName = () => (STATE && STATE.client && STATE.client.name) || "";
  const yearKeys = () => Object.keys((view && view.years) || {}).sort();
  const amended = (y) => !!(y && y.signed && y.hash && y.signed.hash !== y.hash);

  /* amounts accept the sheet's habit of typing a sum: "1500+250+10". A tiny parser —
     numbers, + − × ÷ and brackets only; never eval. → number, or NaN if it can't be read. */
  function evalExpr(src) {
    const s = String(src).replace(/[$,\s]/g, "");
    if (!/^[0-9.+\-*/()]+$/.test(s)) return NaN;
    let i = 0;
    const peek = () => s[i];
    function num() {
      if (peek() === "(") { i++; const v = add(); if (peek() !== ")") throw 0; i++; return v; }
      if (peek() === "-") { i++; return -num(); }
      const m = /^\d*\.?\d+|^\d+\./.exec(s.slice(i)); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]);
    }
    function mul() { let v = num(); while (peek() === "*" || peek() === "/") { const o = s[i++]; const w = num(); v = o === "*" ? v * w : v / w; } return v; }
    function add() { let v = mul(); while (peek() === "+" || peek() === "-") { const o = s[i++]; const w = mul(); v = o === "+" ? v + w : v - w; } return v; }
    try { const v = add(); return i === s.length && isFinite(v) ? r2(v) : NaN; } catch (e) { return NaN; }
  }
  const isExpr = (s) => /[+*/()]/.test(s) || /\d-/.test(s);

  function totalsOf(y) {
    const chans = (y.groups || []).flatMap((g) => g.channels || []);
    const net = MONTHS.map((_, i) => r2(chans.reduce((t, c) => t + (+(c.cells[i] && c.cells[i].v) || 0), 0)));
    const k = (y.grossUp != null && y.grossUp !== "" && +y.grossUp < 100) ? 1 - +y.grossUp / 100 : null;
    const gross = k ? net.map((v) => r2(v / k)) : null;
    return { net, gross, netTotal: r2(net.reduce((a, b) => a + b, 0)), grossTotal: gross ? r2(gross.reduce((a, b) => a + b, 0)) : null };
  }
  const chanTotal = (c) => r2((c.cells || []).reduce((t, x) => t + (+(x && x.v) || 0), 0));

  /* ---- render ---- */
  function render() {
    const ed = canBC();
    if (forClient !== clientId()) { forClient = clientId(); view = null; yearKey = null; work = null; dirty = false; loadErr = ""; }
    if (!view && !loading && !loadErr) setTimeout(() => load(false), 0);
    else if (view && !loading && !editingNow() && Date.now() - lastLoad > 30000) setTimeout(() => load(false), 0);
    const head = `
    <div class="page-head">
      <div class="page-title">Budget Controls</div>
    </div>`;
    if (!view) return head + `<div class="card sap-empty">${loadErr ? esc(loadErr) : "Loading the budget control…"}</div>`;

    const keys = yearKeys(), cur = String(view.currentYear || new Date().getFullYear());
    if (!yearKey || !view.years[yearKey]) yearKey = view.years[cur] ? cur : (keys.filter((k) => k <= cur).pop() || keys[keys.length - 1] || null);

    const tools = ed ? `<div class="sap-admin">
        <button class="btn btn-ghost" data-bcnewyear title="Start a new year — blank, or with last year's channels">＋ New year</button>
        <button class="btn btn-ghost" data-bcconnect>${view.connected ? "✎ Change sheet" : "🔗 Connect sheet"}</button>
        ${view.connected ? `<button class="btn btn-ghost" data-bcimport title="Re-read the connected sheet">↻ Re-import</button>` : ""}
        ${(isAdminReal() && yearKey && view.years[yearKey] && !(view.years[yearKey].signatures || []).length) ? `<button class="btn btn-ghost" data-bcdelyear title="Delete this unsigned year">🗑 Delete ${esc(yearKey)}</button>` : ""}
        <span class="sap-savestate" aria-live="polite">${saving ? "Saving…" : dirty ? "Unsaved changes…" : ""}</span>
      </div>` : "";
    const chips = keys.length ? `<div class="mom-strip sap-months">${keys.map((k) => {
      const y = view.years[k];
      const sub = amended(y) ? "amended" : y.signed ? "✓ signed" : "draft";
      return `<div class="mom-chip ${k === yearKey ? "active" : ""}" data-bcyear="${k}" title="View ${esc(k)}"><div class="m">${esc(k)} Budget</div><div class="v">${sub}</div></div>`;
    }).join("")}</div>` : "";
    const errBanner = (view.error && ed) ? `<div class="sap-banner sap-banner--err">⚠ ${esc(view.error)}</div>` : "";
    if (!yearKey) return head + tools + `<div class="card sap-empty">${ed
      ? "No budget controls yet. Use <b>＋ New year</b> to build one here, or connect the client's Budget Control sheet to bring it in."
      : "Your budget control will appear here once it's ready."}</div>`;
    const y = view.years[yearKey];
    if (ed && (!work || work.year !== yearKey || !dirty)) work = { year: yearKey, groups: clone(y.groups || []), grossUp: y.grossUp };
    return head + tools + chips + errBanner + sheet(y, ed ? work : null) + changeLog(y, ed);
  }

  function sheet(y, w) {
    const ed = !!w, src = w || y;
    const ce = (val, attr, ph) => ed
      ? `<span class="sap-ce bc-name" contenteditable="true" spellcheck="true" ${attr} data-ph="${esc(ph)}">${esc(val || "")}</span>`
      : esc(val || "");
    const tt = totalsOf(src);
    const quarters = [0, 1, 2, 3].map((q) => `<th colspan="3" class="bc-q ${q % 2 ? "bc-q-d" : "bc-q-l"}">Q${q + 1}</th>`).join("");
    const monthHead = MONTHS.map((m, i) => {
      const allOn = ed && src.groups.some((g) => g.channels.length) && src.groups.every((g) => g.channels.every((c) => c.cells[i] && c.cells[i].a));
      return `<th class="bc-m">${m}${ed ? `<button class="bc-mact${allOn ? " on" : ""}" data-bcmonth="${i}" title="${allOn ? "Un-mark" : "Mark"} every ${MON_S[i]} cell actualized">${allOn ? "✓" : "○"}</button>` : ""}</th>`;
    }).join("");
    let body = "";
    src.groups.forEach((g, gi) => {
      if (g.name || ed) body += `<tr class="bc-grp"><td class="bc-lab">${ce(g.name, `data-bcgname="${gi}"`, "CATEGORY")}${ed ? `<span class="bc-tools">
          <button class="bc-x" data-bcmvg="${gi}.-1" title="Move up">↑</button><button class="bc-x" data-bcmvg="${gi}.1" title="Move down">↓</button>
          <button class="bc-x" data-bcdelg="${gi}" title="Remove this category">✕</button></span>` : ""}</td>${"<td></td>".repeat(12)}<td class="bc-tot"></td></tr>`;
      g.channels.forEach((c, ci) => {
        const cells = c.cells.map((x, mi) => {
          const val = x && x.v != null ? money(x.v) : "";
          const amt = ed
            ? `<span class="bc-ce" contenteditable="true" inputmode="decimal" data-bcamt="${gi}.${ci}.${mi}" title="${x && x.x ? esc("= " + x.x) : "Type an amount (sums like 1500+250 work)"}">${val}</span><button class="bc-act" data-bcact="${gi}.${ci}.${mi}" tabindex="-1" title="${x && x.a ? "Actualized — click to mark as planned" : "Mark as actualized (spent)"}" aria-label="Toggle actualized"></button>`
            : val;
          return `<td class="bc-amt${x && x.a ? " is-act" : ""}">${amt}</td>`;
        }).join("");
        body += `<tr class="bc-chan"><td class="bc-lab">${ce(c.name, `data-bccname="${gi}.${ci}"`, "Channel")}${ed ? `<span class="bc-tools">
            <button class="bc-x" data-bcmvc="${gi}.${ci}.-1" title="Move up">↑</button><button class="bc-x" data-bcmvc="${gi}.${ci}.1" title="Move down">↓</button>
            <button class="bc-x" data-bcdelc="${gi}.${ci}" title="Remove this channel">✕</button></span>` : ""}</td>${cells}<td class="bc-tot" data-bctot="c${gi}.${ci}">${money(chanTotal(c))}</td></tr>`;
      });
      if (ed) body += `<tr class="bc-add"><td class="bc-lab" colspan="14"><button class="row-add" data-bcaddc="${gi}">＋ Add channel${g.name ? ` to ${esc(g.name)}` : ""}</button></td></tr>`;
    });
    if (ed) body += `<tr class="bc-add"><td class="bc-lab" colspan="14"><button class="row-add" data-bcaddg>＋ Add category</button></td></tr>`;
    const foot = `
      <tr class="bc-spacer"><td colspan="14"></td></tr>
      <tr class="bc-sum"><td class="bc-lab">Digital Sub-Total (NET)</td>${tt.net.map((v, i) => `<td data-bctot="n${i}">${money(v)}</td>`).join("")}<td class="bc-tot" data-bctot="nt">${money(tt.netTotal)}</td></tr>
      <tr class="bc-sum"><td class="bc-lab">Total Monthly Spend (GROSS)${ed
        ? `<label class="bc-gross" title="Agency % — GROSS = NET ÷ (1 − %)">÷ (1 − <input type="number" min="0" max="90" step="0.5" data-bcgross value="${src.grossUp == null ? "" : esc(src.grossUp)}">%)</label>` : ""}</td>${tt.gross
        ? tt.gross.map((v, i) => `<td data-bctot="g${i}">${money(v)}</td>`).join("") + `<td class="bc-tot bc-tot-grey" data-bctot="gt">${money(tt.grossTotal)}</td>`
        : `<td colspan="12" class="bc-dim">${ed ? "Set the agency % to show gross spend" : ""}</td><td class="bc-tot bc-tot-grey"></td>`}</tr>`;

    // ---- approval block (like the sheet: Client Approval · Print Name · Date of Approval) ----
    const needsSign = !y.signed || amended(y);
    let sigCell, nameCell, dateCell, below = "";
    if (!needsSign) {
      sigCell = `<div class="sap-sig-name">${esc(y.signed.name)}</div>`;
      nameCell = esc(y.signed.name); dateCell = esc(fmtDate(y.signed.at));
    } else {
      sigCell = `<input type="text" class="sap-sign-input" maxlength="120" autocomplete="name" placeholder="Sign here" aria-label="Signature">`;
      nameCell = `<span class="sap-dim bc-printname">Your typed name</span>`; dateCell = esc(fmtDate(new Date().toISOString()));
      below = `${amended(y) ? `<div class="sap-banner sap-banner--warn">Amended — the planned budget has changed since ${esc(y.signed.name)} signed it on ${esc(fmtDate(y.signed.at))}. Please review and sign again.</div>` : ""}
        <div class="sap-err" aria-live="polite"></div>
        <button class="btn btn-primary sap-approve" data-bcsign${previewing() ? ` disabled title="Client View preview — the client signs here"` : ""}>${amended(y) ? "Approve changes" : "Approve"}</button>`;
    }
    const sigs = (y.signatures || []).slice().reverse();
    const history = (isStaffReal() && !previewing() && sigs.length) ? `<div class="bc-sigs">${sigs.map((s) => `<div class="bc-sig-row">
        <b>${s.n > 1 ? `Amendment ${s.n - 1}` : "Original"}</b> · signed by ${esc(s.name)} · ${esc(fmtDate(s.at))}
        ${s.driveUrl ? ` · <a href="${esc(s.driveUrl)}" target="_blank" rel="noopener">📄 Signed PDF ↗</a>` : s.driveError ? ` · <span class="bc-bad">PDF not saved to Drive</span>` : ""}</div>`).join("")}</div>` : "";
    const srcNote = ed ? `<div class="sap-src">${y.source === "sheet" ? `Imported from the sheet${y.tab ? ` (tab “${esc(y.tab)}”)` : ""} — edit anything here; the portal copy is the one that counts` : y.copiedFrom ? `Built in the portal from ${esc(y.copiedFrom)}'s channels` : "Built in the portal"} · click a cell to type, the ○ in its corner marks it actualized</div>` : "";
    return `<div class="card bc-sheet${ed ? " bc-edit" : ""}">
      <div class="bc-banner"><div class="bc-client">${esc(clientName())}</div><div class="bc-year">${esc(y.year)}</div>${srcNote}</div>
      <div class="bc-legend"><span><i class="bc-sw bc-sw-act"></i>Actualized (spent)</span><span><i class="bc-sw"></i>Planned</span></div>
      <div class="bc-wrap"><table class="bc-table">
        <thead>
          <tr class="bc-qrow"><th class="bc-lab bc-blank"></th>${quarters}<th rowspan="2" class="bc-tot-h">ESTIMATED<br>NET TOTAL</th></tr>
          <tr class="bc-mrow"><th class="bc-lab">MONTH</th>${monthHead}</tr>
        </thead>
        <tbody>${body}${foot}</tbody>
      </table></div>
      <table class="bc-approve"><tbody>
        <tr><th>Client Approval:</th><td class="sap-sig-cell">${sigCell}</td></tr>
        <tr><th>Print Name:</th><td>${nameCell}</td></tr>
        <tr><th>Date of Approval:</th><td>${dateCell}</td></tr>
      </tbody></table>
      <div class="sap-below">${below}${history}</div>
      <div class="bc-foot"><span class="bc-logo">tja</span><span>THE JAMES AGENCY</span></div>
    </div>`;
  }

  function changeLog(y, ed) {
    const log = (y.log || []);
    const chans = [...new Set((y.groups || []).flatMap((g) => (g.channels || []).map((c) => c.name)).filter(Boolean))];
    const rows = log.map((e) => {
      const detail = e.type === "Change" && e.month != null ? `${MON_S[e.month]}: ${money(e.from ?? 0)} → ${money(e.to ?? 0)}` : "";
      return `<tr><td>${esc(e.channel)}</td><td>${esc(e.type)}</td><td class="bc-num">${e.amount == null ? "" : money(e.amount)}</td>
        <td>${esc(shortDate(e.date || (e.at || "").slice(0, 10)))}</td><td>${esc(e.initials || "")}</td>
        <td class="bc-note">${esc([detail, e.note].filter(Boolean).join(" — "))}${e.auto ? ` <span class="bc-auto">auto</span>` : ""}</td>
        ${ed ? `<td>${!e.auto ? `<button class="bc-x" data-bclogdel="${esc(e.id)}" title="Remove this entry">✕</button>` : ""}</td>` : ""}</tr>`;
    }).join("");
    if (!log.length && !ed) return "";
    const form = ed ? `<tr class="bc-log-form">
        <td><input list="bcChanList" data-bclf="channel" placeholder="Channel"><datalist id="bcChanList">${chans.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></td>
        <td><select data-bclf="type"><option>Reflight</option><option>Rollover</option><option>Other</option></select></td>
        <td><input data-bclf="amount" inputmode="decimal" placeholder="$0.00"></td>
        <td><input type="date" data-bclf="date" value="${new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" })}"></td>
        <td></td>
        <td><input data-bclf="note" placeholder="Notes"></td>
        <td><button class="btn btn-primary bc-log-add" data-bclogadd>Add</button></td></tr>` : "";
    return `<div class="card bc-log">
      <div class="bc-log-head">CHANGE LOG <span class="bc-log-sub">${ed ? "Reflights and rollovers. Once the year is signed, every $ change is logged automatically." : "Reflights, rollovers and changes since the budget was approved."}</span></div>
      <div class="bc-wrap"><table class="bc-log-table">
        <thead><tr><th>Channel</th><th>Reflight/Rollover</th><th>Amount</th><th>Date</th><th>Initials</th><th>Notes</th>${ed ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows || `<tr><td colspan="${ed ? 7 : 6}" class="bc-dim">No changes logged yet.</td></tr>`}${form}</tbody>
      </table></div>
    </div>`;
  }

  async function typedSignature(name) {   // same cursive render as Present Docs / the SAP
    try { await document.fonts.load("52px 'Great Vibes'"); } catch (e) {}
    const c = document.createElement("canvas"); c.width = 640; c.height = 150; const x = c.getContext("2d");
    x.fillStyle = "#111"; x.textBaseline = "middle"; x.textAlign = "left"; x.font = "52px 'Great Vibes', cursive";
    x.fillText(name, 18, 84); return c.toDataURL("image/png");
  }

  /* ---- saving ---- */
  const setSaveState = () => { const el = document.querySelector(`.page[data-page="${PAGE}"] .sap-savestate`); if (el) el.textContent = saving ? "Saving…" : dirty ? "Unsaved changes…" : "Saved"; };
  function scheduleSave(ms) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, ms == null ? 1200 : ms); setSaveState(); }
  async function flush() {
    clearTimeout(saveTimer);
    if (!work || !dirty) return true;
    if (saving) { scheduleSave(400); return false; }
    const w = work, snap = JSON.stringify(w);
    saving = true; setSaveState();
    const r = await call("save", { year: w.year, groups: w.groups, grossUp: w.grossUp });
    saving = false;
    if (!r.ok) { setSaveState(); window.TJA_UI.alert(r.error || "Couldn't save the budget — your changes are still here; try again."); return false; }
    if (JSON.stringify(work) === snap) dirty = false;
    view = r.view;
    setSaveState();
    if (dirty) scheduleSave(); else if (!editingNow()) repaint(PAGE);
    return true;
  }
  function structural(fn) { if (!work) return; fn(work); dirty = true; repaint(PAGE); scheduleSave(0); }
  // recompute the totals in place (no repaint — the cursor stays put)
  function paintTotals() {
    if (!work) return;
    const pg = document.querySelector(`.page[data-page="${PAGE}"]`); if (!pg) return;
    const set = (k, v) => { const el = pg.querySelector(`[data-bctot="${k}"]`); if (el) el.textContent = money(v); };
    work.groups.forEach((g, gi) => g.channels.forEach((c, ci) => set(`c${gi}.${ci}`, chanTotal(c))));
    const tt = totalsOf(work);
    tt.net.forEach((v, i) => set("n" + i, v)); set("nt", tt.netTotal);
    if (tt.gross) { tt.gross.forEach((v, i) => set("g" + i, v)); set("gt", tt.grossTotal); }
  }
  const cellAt = (path) => { const [g, c, m] = path.split(".").map(Number); return work && work.groups[g] && work.groups[g].channels[c] && work.groups[g].channels[c].cells[m]; };
  const rawOf = (x) => (x && x.x) ? x.x : (x && x.v != null ? String(x.v) : "");
  const blank = () => Array.from({ length: 12 }, () => ({ v: null }));

  function newYearDialog() {
    const keys = yearKeys();
    const latest = keys[keys.length - 1];
    const suggest = latest ? String(+latest + 1) : String(view.currentYear || new Date().getFullYear());
    return new Promise((resolve) => {
      const ov = document.createElement("div"); ov.className = "burn-pop-overlay";
      ov.innerHTML = `<div class="burn-pop" role="dialog" aria-modal="true" aria-label="New budget year">
        <div class="bp-head">New budget control</div>
        <label class="cp-row cp-field"><span class="cp-txt"><b>Year</b></span><input type="number" class="cp-in" data-ny="year" min="2020" max="2100" value="${esc(suggest)}"></label>
        <div class="bc-ny-opts">
          ${latest ? `<label class="bc-ny-opt"><input type="radio" name="bcny" value="${esc(latest)}" checked><span><b>Duplicate ${esc(latest)}'s channels</b><br><span class="bc-dim">Same categories and channels, every $ cleared.</span></span></label>` : ""}
          <label class="bc-ny-opt"><input type="radio" name="bcny" value=""${latest ? "" : " checked"}><span><b>Start from the standard template</b><br><span class="bc-dim">Search Ads, Paid Social, Display, Video, Print.</span></span></label>
        </div>
        <div class="bp-actions"><button type="button" class="btn btn-ghost" data-ny="cancel">Cancel</button><button type="button" class="btn btn-primary" data-ny="ok">Create</button></div>
      </div>`;
      document.body.appendChild(ov);
      const done = (v) => { ov.remove(); resolve(v); };
      ov.addEventListener("click", (e) => {
        if (e.target === ov || e.target.closest('[data-ny="cancel"]')) return done(null);
        if (e.target.closest('[data-ny="ok"]')) {
          const yr = ov.querySelector('[data-ny="year"]').value.trim();
          const from = (ov.querySelector('input[name="bcny"]:checked') || {}).value || "";
          done({ year: yr, copyFrom: from });
        }
      });
    });
  }

  function init(page) {
    if (wired) return; wired = true;
    // ---- amounts: show the raw figure (or the typed sum) while editing, money once you leave ----
    page.addEventListener("focusin", (ev) => {
      const c = ev.target.closest("[data-bcamt]"); if (!c) return;
      c.textContent = rawOf(cellAt(c.dataset.bcamt));
      const r = document.createRange(); r.selectNodeContents(c); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    });
    page.addEventListener("focusout", (ev) => {
      const c = ev.target.closest("[data-bcamt]");
      if (c) {
        const x = cellAt(c.dataset.bcamt); if (!x) return;
        const t = c.textContent.trim();
        if (c.dataset.cancel) { delete c.dataset.cancel; c.textContent = x.v != null ? money(x.v) : ""; return; }
        let v = null, expr = "";
        if (t) {
          v = evalExpr(t);
          if (isNaN(v)) { c.textContent = x.v != null ? money(x.v) : ""; window.TJA_UI.alert(`“${t}” isn't an amount. Type a number like 2900 or a sum like 1500+250.`); return; }
          const plain = t.replace(/[$,\s]/g, "");
          if (isExpr(plain)) expr = plain;
        }
        const changed = (x.v ?? null) !== v || (x.x || "") !== expr;
        x.v = v; if (expr) x.x = expr; else delete x.x;
        c.textContent = v != null ? money(v) : "";
        c.title = expr ? "= " + expr : "Type an amount (sums like 1500+250 work)";
        if (changed) { dirty = true; paintTotals(); scheduleSave(); }
        return;
      }
      if (ev.target.closest("[data-bcgname], [data-bccname]") && dirty) scheduleSave(150);
    });
    page.addEventListener("keydown", (ev) => {
      const c = ev.target.closest("[data-bcamt], [data-bcgname], [data-bccname]"); if (!c) return;
      if (ev.key === "Enter") { ev.preventDefault(); c.blur(); }
      if (ev.key === "Escape" && c.dataset.bcamt) { c.dataset.cancel = "1"; c.blur(); }
      // Tab / arrows move along the row like a sheet (Tab already does; arrows for the amount cells)
      if (c.dataset.bcamt && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
        const all = [...page.querySelectorAll("[data-bcamt]")], [g, ch, m] = c.dataset.bcamt.split(".").map(Number);
        const col = all.filter((e) => +e.dataset.bcamt.split(".")[2] === m);
        const i = col.findIndex((e) => e === c), nx = col[i + (ev.key === "ArrowDown" ? 1 : -1)];
        if (nx) { ev.preventDefault(); nx.focus(); }
        void g; void ch;
      }
    });
    page.addEventListener("input", (ev) => {
      const si = ev.target.closest(".bc-sheet .sap-sign-input");
      if (si) { const pn = page.querySelector(".bc-printname"); if (pn) { pn.textContent = si.value.trim() || "Your typed name"; pn.classList.toggle("sap-dim", !si.value.trim()); } return; }
      const g = ev.target.closest("[data-bcgname]"), c = ev.target.closest("[data-bccname]");
      if (g && work) { work.groups[+g.dataset.bcgname].name = g.innerText.replace(/ /g, " ").trim(); dirty = true; scheduleSave(); }
      if (c && work) { const [a, b] = c.dataset.bccname.split(".").map(Number); work.groups[a].channels[b].name = c.innerText.replace(/ /g, " ").trim(); dirty = true; scheduleSave(); }
    });
    page.addEventListener("paste", (ev) => {
      if (!ev.target.closest("[data-bcamt], [data-bcgname], [data-bccname]")) return;
      ev.preventDefault();
      document.execCommand("insertText", false, (ev.clipboardData || window.clipboardData).getData("text/plain"));
    });
    page.addEventListener("change", (ev) => {
      const gi = ev.target.closest("[data-bcgross]");
      if (gi && work) { const n = parseFloat(gi.value); work.grossUp = isNaN(n) ? null : Math.max(0, Math.min(90, n)); structural(() => {}); }
    });
    // keep the cell's focus when its actualize button is pressed
    page.addEventListener("mousedown", (ev) => { if (ev.target.closest(".bc-act, .bc-mact")) ev.preventDefault(); });

    page.addEventListener("click", async (ev) => {
      if (busy) return;
      const yc = ev.target.closest("[data-bcyear]");
      if (yc) { if (dirty) await flush(); yearKey = yc.dataset.bcyear; work = null; repaint(PAGE); return; }

      // ---- actualize: one cell, or a whole month ----
      const act = ev.target.closest("[data-bcact]");
      if (act && work) {
        const x = cellAt(act.dataset.bcact); if (!x) return;
        if (x.a) delete x.a; else x.a = true;
        const td = act.closest("td"); if (td) td.classList.toggle("is-act", !!x.a);
        act.title = x.a ? "Actualized — click to mark as planned" : "Mark as actualized (spent)";
        dirty = true; scheduleSave(400); return;
      }
      const ma = ev.target.closest("[data-bcmonth]");
      if (ma && work) {
        const m = +ma.dataset.bcmonth;
        const all = work.groups.every((g) => g.channels.every((c) => c.cells[m].a));
        structural((w) => w.groups.forEach((g) => g.channels.forEach((c) => { if (all) delete c.cells[m].a; else c.cells[m].a = true; })));
        return;
      }

      // ---- structure ----
      const ac = ev.target.closest("[data-bcaddc]");
      if (ac) {
        const gi = +ac.dataset.bcaddc;
        structural((w) => w.groups[gi].channels.push({ name: "", cells: blank() }));
        setTimeout(() => { const els = page.querySelectorAll(`[data-bccname^="${gi}."]`); const e = els[els.length - 1]; if (e) e.focus(); }, 30);
        return;
      }
      if (ev.target.closest("[data-bcaddg]")) {
        structural((w) => w.groups.push({ name: "", channels: [{ name: "", cells: blank() }] }));
        setTimeout(() => { const els = page.querySelectorAll("[data-bcgname]"); const e = els[els.length - 1]; if (e) e.focus(); }, 30);
        return;
      }
      const dc = ev.target.closest("[data-bcdelc]");
      if (dc) {
        const [a, b] = dc.dataset.bcdelc.split(".").map(Number), c = work.groups[a].channels[b];
        if (c.cells.some((x) => x.v != null) && !(await window.TJA_UI.confirm(`Remove “${c.name || "this channel"}” and its amounts?`, { okText: "Remove", danger: true }))) return;
        structural((w) => w.groups[a].channels.splice(b, 1)); return;
      }
      const dg = ev.target.closest("[data-bcdelg]");
      if (dg) {
        const g = work.groups[+dg.dataset.bcdelg];
        if (g.channels.length && !(await window.TJA_UI.confirm(`Remove “${g.name || "this category"}” and its ${g.channels.length} channel${g.channels.length === 1 ? "" : "s"}?`, { okText: "Remove", danger: true }))) return;
        structural((w) => w.groups.splice(+dg.dataset.bcdelg, 1)); return;
      }
      const mc = ev.target.closest("[data-bcmvc]");
      if (mc) {
        const [a, b, d] = mc.dataset.bcmvc.split(".").map(Number);
        structural((w) => {
          const list = w.groups[a].channels, j = b + d;
          if (j >= 0 && j < list.length) { [list[b], list[j]] = [list[j], list[b]]; return; }
          // off the end of its category → into the neighbouring one
          const ng = w.groups[a + d]; if (!ng) return;
          const [c] = list.splice(b, 1); if (d < 0) ng.channels.push(c); else ng.channels.unshift(c);
        });
        return;
      }
      const mg = ev.target.closest("[data-bcmvg]");
      if (mg) {
        const [a, d] = mg.dataset.bcmvg.split(".").map(Number);
        structural((w) => { const j = a + d; if (j >= 0 && j < w.groups.length) [w.groups[a], w.groups[j]] = [w.groups[j], w.groups[a]]; });
        return;
      }

      // ---- years ----
      if (ev.target.closest("[data-bcnewyear]") && canBC()) {
        if (dirty) await flush();
        const pick = await newYearDialog(); if (!pick) return;
        busy = true;
        const r = await call("newyear", { year: pick.year, copyFrom: pick.copyFrom || null });
        busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't create that year."); return; }
        view = r.view; yearKey = String(parseInt(pick.year, 10)); work = null; dirty = false; repaint(PAGE); return;
      }
      if (ev.target.closest("[data-bcdelyear]") && isAdminReal()) {
        if (!(await window.TJA_UI.confirm(`Delete the ${yearKey} budget control? This can't be undone.`, { okText: "Delete", danger: true }))) return;
        busy = true; const r = await call("delyear", { year: yearKey }); busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't delete it."); return; }
        view = r.view; yearKey = null; work = null; dirty = false; repaint(PAGE); return;
      }

      // ---- the sheet bridge ----
      const conn = ev.target.closest("[data-bcconnect]");
      if (conn && canBC()) {
        const raw = await window.TJA_UI.prompt(
          "Paste the link to this client's Budget Control Google Sheet. Each tab with a MONTH row (January … December) becomes that year's budget — the year comes from the tab name or the cell above the months. Orange cells come across as actualized; a CHANGE LOG tab becomes the change log.\n\nThe sheet can stay private — share it with the portal's service account (Viewer). It's never written to. Leave blank to disconnect.",
          { title: "Connect Budget Control sheet", value: (view && view.sheetUrl) || "", okText: "Connect" });
        if (raw == null) return;
        busy = true; conn.disabled = true; conn.textContent = "Connecting…";
        const r = await call("connect", { url: raw.trim() });
        busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't connect that sheet."); repaint(PAGE); return; }
        view = r.view; work = null; dirty = false;
        if (r.imported && r.imported.length) yearKey = String(r.imported[r.imported.length - 1]);
        if (r.kept && r.kept.length) window.TJA_UI.alert(`Connected. ${r.kept.join(", ")} already ${r.kept.length === 1 ? "exists" : "exist"} in the portal, so ${r.kept.length === 1 ? "it was" : "they were"} left as ${r.kept.length === 1 ? "is" : "they are"} — use ↻ Re-import to replace from the sheet.`);
        repaint(PAGE); return;
      }
      if (ev.target.closest("[data-bcimport]") && canBC()) {
        if (dirty) await flush();
        const y = view.years[yearKey];
        const edited = y && (y.source === "portal" || (y.signatures || []).length);
        if (edited && !(await window.TJA_UI.confirm(`Replace the portal's ${yearKey} budget with the sheet's version? Edits made in the portal for ${yearKey} will be overwritten${(y.signatures || []).length ? " (signed PDFs are kept; it will show as amended if the $ differ)" : ""}.`, { okText: "Replace from sheet", danger: true }))) return;
        busy = true; const r = await call("import", { force: true }); busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't read the sheet."); return; }
        view = r.view; work = null; dirty = false; repaint(PAGE); return;
      }

      // ---- change log ----
      if (ev.target.closest("[data-bclogadd]")) {
        const f = (k) => page.querySelector(`[data-bclf="${k}"]`);
        const channel = f("channel").value.trim(); if (!channel) { f("channel").focus(); return; }
        const amtRaw = f("amount").value.trim(), amount = amtRaw ? evalExpr(amtRaw) : null;
        if (amtRaw && isNaN(amount)) { window.TJA_UI.alert("That amount isn't a number."); return; }
        if (dirty) await flush();
        busy = true;
        const r = await call("log", { year: yearKey, entry: { channel, type: f("type").value, amount, date: f("date").value, note: f("note").value } });
        busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't add that entry."); return; }
        view = r.view; repaint(PAGE); return;
      }
      const ld = ev.target.closest("[data-bclogdel]");
      if (ld) {
        if (!(await window.TJA_UI.confirm("Remove this change-log entry?", { okText: "Remove", danger: true }))) return;
        busy = true; const r = await call("log", { year: yearKey, removeId: ld.dataset.bclogdel }); busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't remove it."); return; }
        view = r.view; repaint(PAGE); return;
      }

      // ---- approval ----
      const sb = ev.target.closest("[data-bcsign]");
      if (sb && !sb.disabled) {
        if (dirty && !(await flush())) return;
        const err = page.querySelector(".bc-sheet .sap-err"), nm = page.querySelector(".bc-sheet .sap-sign-input");
        const name = (nm && nm.value || "").trim();
        if (!name) { err.textContent = "Sign by typing your name in the Client Approval box."; nm && nm.focus(); return; }
        if (isStaffReal() && !(await window.TJA_UI.confirm("You're approving as TJA staff. Normally the client approves their budget — approve anyway?", { okText: "Approve" }))) return;
        const label = sb.textContent;
        sb.disabled = true; sb.textContent = "Approving…"; err.textContent = ""; busy = true;
        const r = await call("sign", { year: yearKey, name, signature: await typedSignature(name) });
        busy = false;
        if (!r.ok) { err.textContent = r.error || "Couldn't approve — please try again."; sb.disabled = false; sb.textContent = label; return; }
        view = r.view;
        if (r.pdf) {   // the signer's own copy (Drive + Slack already have it)
          try {
            const bin = atob(r.pdf), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([u], { type: "application/pdf" }));
            a.download = r.fileName || `${yearKey} Budget Control - Signed.pdf`; document.body.appendChild(a); a.click(); a.remove();
          } catch (e) { /* convenience only */ }
        }
        repaint(PAGE);
      }
    });
    window.addEventListener("beforeunload", (ev) => { if (dirty) { flush(); ev.preventDefault(); ev.returnValue = ""; } });
  }

  return { render, init, reset() { view = null; loadErr = ""; forClient = ""; work = null; dirty = false; } };
})();
