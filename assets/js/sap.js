/* ============================================================
   SERVICE ALLOCATION PLAN (SAP) page (retainer) — v390/v391, Cameron 2026-10-19/20.

   Replaces the retainer "Status" page and is laid out like the team's SAP spreadsheet:
   client + month header, then a Retainer Items | % Planned | Notes table (service headings
   with their line items under them), the terms, and an Authorized Signature | Date row.

   Where a month comes from:
     • a connected Google Sheet (read by the `sap` Edge Function with the service account —
       "REVISED <Month YYYY>" beats "<Month YYYY>", OLD tabs ignored), or
     • built HERE: admins type straight into the table (no edit mode — saves itself). A month
       saved in the portal is marked source:"portal" and the sheet stops driving it, and every
       NEW month (the 1st-of-month rollover, or "+ New month") is a copy of the latest portal
       month — never the sheet's version. The sheet link is only the bridge.
   % PLANNED is linked to the Executive Summary — the RULING number: a service heading's % is
   its linked service line's share of the retainer (contracted ÷ total), live for this month
   and upcoming ones, frozen at approval. An unlinked heading falls back to its own %.
   Approval = ONE typed signature (same cursive style as Present Docs) from anyone on the
   account; the server builds the signed PDF → Drive + the client's Slack channel.

   The SAP data is SERVER-OWNED: this page never saves it through the normal dashboard
   write (whose 3-way merge could clash with a signature); every change goes through `sap`.
   ============================================================ */
window.SAP_PAGE = (function () {
  let view = null, loading = false, loadErr = "", viewKey = null, wired = false, forClient = "", lastLoad = 0;
  // INLINE EDITING (Cameron 2026-10-20 — no "Edit" mode): admins type straight into the table.
  // `work` is the editable copy of the viewed month; changes save themselves (debounced).
  let work = null, dirty = false, saving = false, saveTimer = null, busy = false;

  async function call(action, extra) {
    const cfg = window.SUPABASE_CONFIG || {};
    const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
    if (!base || !(window.SUPA && window.SUPA.enabled && window.SUPA.client)) return { ok: false, error: "The portal backend isn't available." };
    const { data } = await window.SUPA.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) return { ok: false, error: "Please sign in again." };
    try {
      const r = await fetch(base + "/sap", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(Object.assign({ action, clientId: clientId() }, extra || {})),
      });
      const j = await r.json().catch(() => ({}));
      return Object.assign({ ok: r.ok && j.ok !== false }, j, r.ok ? {} : { error: j.error || "Something went wrong (" + r.status + ")." });
    } catch (e) { return { ok: false, error: "Couldn't reach the portal backend." }; }
  }
  // is someone typing in the plan right now? (never repaint under their cursor)
  const editingNow = () => dirty || saving || !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".sap-sheet"));
  // Keep the server's copy in THIS module only (see header).
  function mirror(v) { view = v; loadErr = ""; }
  async function load(force) {
    if (loading) return; loading = true; lastLoad = Date.now();
    const r = await call("fetch", force ? { force: true } : {});
    loading = false;
    if (r.ok && r.view) mirror(r.view); else if (!view) loadErr = r.error || "Couldn't load the plan.";
    if (!editingNow()) repaint("status");
  }

  /* ---- helpers ---- */
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const keyLabel = (k) => { const [y, m] = k.split("-"); return `${MONTHS[+m - 1]} ${y}`; };
  const nextKey = (k) => { let [y, m] = k.split("-").map(Number); m += 1; if (m > 12) { m = 1; y += 1; } return `${y}-${String(m).padStart(2, "0")}`; };
  const nowKey = () => {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "numeric" }).formatToParts(new Date());
    return `${p.find((x) => x.type === "year").value}-${String(p.find((x) => x.type === "month").value).padStart(2, "0")}`;
  };
  const curKey = () => (view && view.current) || nowKey();
  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }); } catch (e) { return ""; } };
  const isStaffReal = () => { const s = (typeof getSession === "function") && getSession(); return !!(s && s.role && s.role !== "client"); };
  const previewing = () => (typeof isPreviewing === "function") && isPreviewing();
  const multiline = (t) => esc(t).replace(/\n/g, "<br>");
  const clientName = () => (STATE && STATE.client && STATE.client.name) || "";
  const clone = (x) => JSON.parse(JSON.stringify(x));
  // KEEP IN SYNC with supabase/functions/sap canonDiscipline
  function canon(s) {
    s = String(s || "").toLowerCase();
    if (/social/.test(s)) return "social";
    if (/public relation|(^|[^a-z])pr([^a-z]|$)/.test(s)) return "pr";
    if (/paid media|(^|[^a-z])media/.test(s)) return "media";
    if (/creativ|design/.test(s)) return "creative";
    if (/web|seo|develop|coding/.test(s)) return "web";
    if (/client experience|strateg|oversight|account|client service|management|leadership|project manage/.test(s)) return "oversight";
    return s.replace(/[^a-z0-9]/g, "");
  }
  const secKey = (s) => s.discipline || canon(s.name);
  // the service lines a heading can link to (from the Executive Summary)
  function lines() {
    const eng = STATE && STATE.engagements && STATE.engagements.retainer;
    const seen = new Set(), out = [];
    ((eng && eng.serviceDisciplines) || []).forEach((d) => { const k = canon(d.name); if (!seen.has(k)) { seen.add(k); out.push({ key: k, name: d.name }); } });
    return out;
  }
  // Executive Summary shares (browser, always current) → the server's copy as a fallback
  function liveShares() {
    const eng = STATE && STATE.engagements && STATE.engagements.retainer;
    const loc = (window.ExecSummary && window.ExecSummary.serviceShares && eng) ? window.ExecSummary.serviceShares(eng) : {};
    return Object.keys(loc).length ? loc : ((view && view.shares) || {});
  }
  // the % shown for section si of month m (see header)
  function pctFor(m, key, s, si) {
    if (m.signed && Array.isArray(m.signed.pcts) && m.signed.pcts[si] != null) return m.signed.pcts[si];
    const shares = liveShares();
    if (key >= curKey() && secKey(s) !== "none" && shares[secKey(s)] != null) return shares[secKey(s)];
    return (s.pct == null || s.pct === "") ? null : s.pct;
  }
  function monthKeys() {
    const ms = (view && view.months) || {};
    return Object.keys(ms).filter((k) => k >= "2026-10").sort();
  }

  /* ---- render ---- */
  function render() {
    const admin = ppAdmin();
    if (forClient !== clientId()) { forClient = clientId(); view = null; viewKey = null; work = null; dirty = false; loadErr = ""; }
    if (!view && !loading && !loadErr) {
      const eng = getEng();
      if (eng && eng.sap && eng.sap.months) view = { connected: !!eng.sapUrl, sapUrl: eng.sapUrl || "", months: eng.sap.months, fileName: eng.sap.fileName, error: eng.sap.error, current: null, shares: {} };
      setTimeout(() => load(false), 0);
    } else if (view && !loading && !editingNow() && Date.now() - lastLoad > 30000) {
      setTimeout(() => load(false), 0);   // pick up new Executive Summary %s / sheet edits
    }
    const head = `
    <div class="page-head">
      <div class="page-title">Service Allocation Plan</div>
      <div class="page-desc">What the team is focused on for you each month.</div>
    </div>`;
    if (!view) return head + `<div class="card sap-empty">${loadErr ? esc(loadErr) : "Loading the plan…"}</div>`;

    const keys = monthKeys(), cur = curKey();
    if (!viewKey || !view.months[viewKey]) viewKey = view.months[cur] ? cur : (keys.filter((k) => k <= cur).pop() || keys[0] || null);

    const tools = admin ? `<div class="sap-admin">
        <button class="btn btn-ghost" data-sapnewmonth title="Start next month's plan from the latest month">＋ New month</button>
        <button class="btn btn-ghost" data-sapconnect>${view.connected ? "✎ Change SAP sheet" : "🔗 Connect SAP sheet"}</button>
        ${view.connected ? `<button class="btn btn-ghost" data-saprefresh title="Re-read the sheet now">↻ Refresh</button>` : ""}
        <span class="sap-savestate" aria-live="polite">${saving ? "Saving…" : dirty ? "Unsaved changes…" : ""}</span>
      </div>` : "";
    const chips = keys.length ? `<div class="mom-strip sap-months">${keys.map((k) => {
      const mm = view.months[k];
      const sub = mm.signed ? "✓ approved" : k === cur ? "current" : k > cur ? "upcoming" : "";
      return `<div class="mom-chip ${k === viewKey ? "active" : ""}" data-sapmonth="${k}" title="View ${esc(keyLabel(k))}"><div class="m">${esc(MONTHS[+k.slice(5) - 1].slice(0, 3) + " " + k.slice(0, 4))}</div><div class="v">${sub || "&nbsp;"}</div></div>`;
    }).join("")}</div>` : "";
    const errBanner = (view.error && admin) ? `<div class="sap-banner sap-banner--err">⚠ ${esc(view.error)} — showing the last copy read.</div>` : "";

    if (!viewKey) return head + tools + `<div class="card sap-empty">${admin
      ? "No plans yet. Use <b>＋ New month</b> to build this month's plan here, or connect the client's SAP sheet."
      : "Your Service Allocation Plan will appear here once it's ready."}</div>`;
    const m = view.months[viewKey];
    if (!m || m.missing || !m.sections) {
      return head + tools + chips + errBanner + `<div class="card sap-empty">${admin
        ? `There's no plan for ${esc(keyLabel(viewKey))} yet — use <b>＋ New month</b>${view.connected ? `, or add a tab named <b>${esc(keyLabel(viewKey))}</b> to the sheet` : ""}.`
        : "This month's plan is being finalized — check back soon."}</div>`;
    }
    // the editable copy follows the server's unless the admin has unsaved typing in it
    if (admin && (!work || work.key !== viewKey || !dirty)) work = { key: viewKey, sections: clone(m.sections), terms: m.terms || "" };
    return head + tools + chips + errBanner + sheet(m, viewKey, admin ? work : null);
  }

  // laid out like the SAP spreadsheet; with `w` (admin) every cell is typed into directly
  function sheet(m, key, w) {
    const admin = !!w;
    const src = w || m;
    const changed = m.signed && m.signed.hash && m.hash && m.signed.hash !== m.hash;
    // an editable cell: contenteditable, no visible "edit mode"
    const ce = (val, f, si, ii, ph, multi) => admin
      ? `<span class="sap-ce${multi ? " sap-ce-multi" : ""}" contenteditable="true" spellcheck="true" data-sapce="${f}" data-si="${si}"${ii != null ? ` data-ii="${ii}"` : ""} data-ph="${esc(ph)}">${esc(val || "")}</span>`
      : (multi ? multiline(val || "") : esc(val || ""));
    const ls = admin ? lines() : [];
    const linkPick = (s, si) => `<select class="sap-link" data-saplink="${si}" title="Which Executive Summary service line drives this heading's %">
        <option value="">${esc((ls.find((l) => l.key === canon(s.name)) || {}).name ? "Linked: " + ls.find((l) => l.key === canon(s.name)).name : "Not linked")}</option>
        ${ls.map((l) => `<option value="${esc(l.key)}"${s.discipline === l.key ? " selected" : ""}>Link to ${esc(l.name)}</option>`).join("")}
        <option value="none"${s.discipline === "none" ? " selected" : ""}>Don't link — type a %</option>
      </select>`;
    const rows = src.sections.map((s, si) => {
      const p = pctFor(m, key, s, si);
      const linked = key >= curKey() && !(m.signed && m.signed.pcts) && secKey(s) !== "none" && liveShares()[secKey(s)] != null;
      const pctCell = (admin && !linked)
        ? `<span class="sap-ce sap-ce-pct" contenteditable="true" data-sapce="pct" data-si="${si}" data-ph="—">${p == null ? "" : p}</span>%`
        : (p == null ? "" : `<span${admin ? ` title="From the Executive Summary service lines"` : ""}>${p}%</span>`);
      return `<tr class="sap-sec-row"><td>${ce(s.name, "name", si, null, "Service heading")}
            ${admin ? `<div class="sap-row-tools">${linkPick(s, si)}<button class="sap-x" data-sapdelsec="${si}" title="Remove this service">✕</button></div>` : ""}</td>
          <td class="sap-note">${ce(s.notes, "notes", si, null, admin ? "Notes" : "", true)}</td>
          <td class="sap-pct">${pctCell}</td></tr>` +
        (s.items || []).map((it, ii) => `<tr class="sap-item-row"><td>${ce(it.name, "iname", si, ii, "Line item")}${admin ? `<button class="sap-x" data-sapdelitem="${si}.${ii}" title="Remove this line">✕</button>` : ""}</td>
          <td class="sap-note">${ce(it.notes, "inotes", si, ii, admin ? "Notes" : "", true)}</td><td></td></tr>`).join("") +
        (admin ? `<tr class="sap-add-row"><td colspan="3"><button class="row-add" data-sapadditem="${si}">＋ Add line item</button></td></tr>` : "");
    }).join("");
    /* % MUST TOTAL 100 (Cameron 2026-10-20). A total row under % Planned; when the %s don't
       add up — or the Executive Summary's service-line hours don't add up to the contracted
       total that drives them — the plan is outlined in red with the gap spelled out (staff only). */
    const shown = src.sections.map((s2, i2) => pctFor(m, key, s2, i2));
    const pctSum = shown.reduce((t, v) => t + (+v || 0), 0);
    const anyLinked = src.sections.some((s2) => secKey(s2) !== "none" && liveShares()[secKey(s2)] != null);
    const eng = STATE && STATE.engagements && STATE.engagements.retainer;
    const split = (key >= curKey() && !m.signed && anyLinked && window.ExecSummary && window.ExecSummary.splitStatus) ? window.ExecSummary.splitStatus(eng) : { off: false };
    // exact: linked shares are rounded so they add up (ExecSummary sharesOf) — anything but 100 is real
    const pctOff = shown.some((v) => v != null) && pctSum !== 100;
    const totalOff = admin && (pctOff || split.off);
    const totalRow = shown.some((v) => v != null)
      ? `<tr class="sap-total-row${totalOff ? " is-off" : ""}"><td>Total</td><td></td><td class="sap-pct">${pctSum}%</td></tr>` : "";
    const offNote = totalOff ? `<div class="sap-split-warn" role="alert">⚠ ${split.off
        ? `The Executive Summary service lines add up to <b>${Math.round(split.sum * 10) / 10}</b> of <b>${Math.round(split.total * 10) / 10}</b> contracted hours (${split.pct}%), so this plan's % Planned doesn't total 100%. Adjust the service-line hours on the Executive Summary.`
        : `% Planned adds up to <b>${pctSum}%</b>, not 100% — adjust the %s${anyLinked ? " (or the Executive Summary service-line hours they come from)" : ""}.`}</div>` : "";
    const canSign = !m.signed && key >= curKey();
    let sigCell = "", dateCell = "", below = "";
    if (m.signed) {
      sigCell = `<div class="sap-sig-name">${esc(m.signed.name)}</div>`;
      dateCell = esc(fmtDate(m.signed.at));
      below = `${changed ? `<div class="sap-banner sap-banner--warn">This plan has changed since it was approved. The signed PDF remains the record of what was approved.</div>` : ""}
        ${(isStaffReal() && m.signed.driveUrl) ? `<a class="btn btn-ghost" href="${esc(m.signed.driveUrl)}" target="_blank" rel="noopener">📄 Signed PDF in Drive ↗</a>` : ""}
        ${(isStaffReal() && m.signed.driveError) ? `<div class="sap-banner sap-banner--err">The signed PDF couldn't be saved to Drive.</div>` : ""}`;
    } else if (canSign) {
      // ONE box: you type your name straight into it and it reads as your signature
      sigCell = `<input type="text" class="sap-sign-input" maxlength="120" autocomplete="name" placeholder="Sign here" aria-label="Signature">`;
      dateCell = esc(fmtDate(new Date().toISOString()));
      below = `<div class="sap-err" aria-live="polite"></div>
        <button class="btn btn-primary sap-approve" data-sapsign${previewing() ? ` disabled title="Client View preview — the client approves here"` : ""}>Approve</button>`;
    } else {
      sigCell = `<span class="sap-dim">Not signed</span>`;
    }
    return `<div class="card sap-sheet${admin ? " sap-admin-edit" : ""}${totalOff ? " sap-off" : ""}">
      <div class="sap-sheet-head"><div class="sap-client">${esc(clientName())}</div><div class="sap-month">${esc(m.label || keyLabel(key))}</div>
        ${admin ? `<div class="sap-src">${m.source === "portal" ? "Built in the portal — click any text to edit" : m.tab ? `From the sheet (tab “${esc(m.tab)}”) — click any text to edit; once edited, the portal version is kept` : ""}</div>` : ""}</div>
      <div class="sap-table-wrap"><table class="sap-table">
        <thead><tr><th>Retainer Items</th><th>Notes</th><th class="sap-pct">% Planned</th></tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table></div>
      ${offNote}
      ${admin ? `<div class="sap-add-sec"><button class="row-add" data-sapaddsec>＋ Add service</button></div>` : ""}
      ${(admin || src.terms) ? `<div class="sap-terms">${ce(src.terms, "terms", null, null, "Terms (optional)", true)}</div>` : ""}
      <table class="sap-table sap-sig-table"><tbody>
        <tr><th>Authorized Signature</th><th>Date</th></tr>
        <tr><td class="sap-sig-cell">${sigCell}</td><td class="sap-date-cell">${dateCell}</td></tr>
      </tbody></table>
      <div class="sap-below">${below}</div>
    </div>`;
  }

  async function typedSignature(name) {   // same cursive render as Present Docs
    try { await document.fonts.load("52px 'Great Vibes'"); } catch (e) {}
    const c = document.createElement("canvas"); c.width = 640; c.height = 150; const x = c.getContext("2d");
    x.fillStyle = "#111"; x.textBaseline = "middle"; x.textAlign = "left"; x.font = "52px 'Great Vibes', cursive";
    x.fillText(name, 18, 84); return c.toDataURL("image/png");
  }

  /* ---- saving the inline edits ---- */
  const setSaveState = () => { const el = document.querySelector('.page[data-page="status"] .sap-savestate'); if (el) el.textContent = saving ? "Saving…" : dirty ? "Unsaved changes…" : "Saved"; };
  function scheduleSave(ms) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, ms == null ? 1200 : ms); setSaveState(); }
  async function flush() {
    clearTimeout(saveTimer);
    if (!work || !dirty) return true;
    if (saving) { scheduleSave(400); return false; }
    const w = work, snap = JSON.stringify(w);
    saving = true; setSaveState();
    const sections = w.sections.map((x) => ({ name: x.name, notes: x.notes || "", pct: x.pct, discipline: x.discipline || "",
      items: (x.items || []).map((i) => ({ name: i.name || "", notes: i.notes || "" })) }));
    const r = await call("save", { month: w.key, sections, terms: w.terms || "" });
    saving = false;
    if (!r.ok) { setSaveState(); window.TJA_UI.alert(r.error || "Couldn't save the plan — your changes are still here; try again."); return false; }
    if (JSON.stringify(work) === snap) dirty = false;    // more typing landed meanwhile → stays dirty, saves next
    view = r.view;
    setSaveState();
    if (dirty) scheduleSave(); else if (!editingNow()) repaint("status");
    return true;
  }
  // structural change (add/remove/link) → save now and redraw
  function structural(fn) { if (!work) return; fn(work); dirty = true; repaint("status"); scheduleSave(0); }

  function init(page) {
    if (wired) return; wired = true;
    // typing in a cell updates the working copy — no repaint, so the cursor never jumps
    page.addEventListener("input", (ev) => {
      const c = ev.target.closest("[data-sapce]"); if (!c || !work) return;
      const f = c.dataset.sapce, s = work.sections[+c.dataset.si], v = c.innerText.replace(/ /g, " ");
      if (f === "terms") work.terms = v.trim();
      else if (f === "name") s.name = v.trim();
      else if (f === "notes") s.notes = v.trim();
      else if (f === "pct") { const n = parseFloat(v.replace(/[^0-9.]/g, "")); s.pct = isNaN(n) ? null : Math.max(0, Math.min(100, Math.round(n))); }
      else if (f === "iname") s.items[+c.dataset.ii].name = v.trim();
      else if (f === "inotes") s.items[+c.dataset.ii].notes = v.trim();
      dirty = true; scheduleSave();
    });
    page.addEventListener("focusout", (ev) => { if (ev.target.closest("[data-sapce]") && dirty) scheduleSave(150); });
    page.addEventListener("keydown", (ev) => {
      const c = ev.target.closest("[data-sapce]");
      if (c && ev.key === "Enter" && !c.classList.contains("sap-ce-multi")) { ev.preventDefault(); c.blur(); }
    });
    page.addEventListener("paste", (ev) => {   // paste as plain text (no fonts/colours from Docs or the sheet)
      if (!ev.target.closest("[data-sapce]")) return;
      ev.preventDefault();
      const t = (ev.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, t);
    });
    page.addEventListener("change", (ev) => {
      const sel = ev.target.closest("[data-saplink]"); if (!sel) return;
      structural((w) => { const s = w.sections[+sel.dataset.saplink]; if (sel.value) s.discipline = sel.value; else delete s.discipline; });
    });
    page.addEventListener("click", async (ev) => {
      if (busy) return;
      const mc = ev.target.closest("[data-sapmonth]");
      if (mc) { if (dirty) await flush(); viewKey = mc.dataset.sapmonth; work = null; repaint("status"); return; }
      if (ev.target.closest("[data-saprefresh]")) { if (dirty) await flush(); load(true); return; }

      if (ev.target.closest("[data-sapnewmonth]") && ppAdmin()) {
        if (dirty) await flush();
        const keys = monthKeys(), cur = curKey();
        const latest = keys[keys.length - 1];
        const target = latest && latest >= cur ? nextKey(latest) : cur;   // the month after the latest plan (never a closed one)
        const srcM = latest && view.months[latest] && view.months[latest].sections ? view.months[latest] : null;
        if (!(await window.TJA_UI.confirm(`Create the ${keyLabel(target)} plan${srcM ? ` as a copy of ${srcM.label}` : ""}? You can edit it straight away; the %s follow the Executive Summary.`, { okText: "Create" }))) return;
        const sections = srcM ? clone(srcM.sections).map((x) => ({ name: x.name, notes: x.notes || "", pct: x.pct ?? null, discipline: x.discipline || "", items: x.items || [] }))
          : lines().map((l) => ({ name: l.name, notes: "", pct: null, discipline: l.key, items: [{ name: "", notes: "" }] }));
        busy = true;
        const r = await call("save", { month: target, sections, terms: srcM ? srcM.terms || "" : "" });
        busy = false;
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't create the month."); return; }
        view = r.view; viewKey = target; work = null; dirty = false; repaint("status"); return;
      }
      const ai = ev.target.closest("[data-sapadditem]");
      if (ai) { structural((w) => w.sections[+ai.dataset.sapadditem].items.push({ name: "", notes: "" }));
        setTimeout(() => { const cells = page.querySelectorAll(`[data-sapce="iname"][data-si="${ai.dataset.sapadditem}"]`); const c = cells[cells.length - 1]; if (c) c.focus(); }, 30); return; }
      if (ev.target.closest("[data-sapaddsec]")) { structural((w) => w.sections.push({ name: "", notes: "", pct: null, items: [{ name: "", notes: "" }] })); return; }
      const ds = ev.target.closest("[data-sapdelsec]");
      if (ds) {
        const s = work && work.sections[+ds.dataset.sapdelsec];
        if (s && (s.name || (s.items || []).length) && !(await window.TJA_UI.confirm(`Remove “${s.name || "this service"}” and its line items?`, { okText: "Remove", danger: true }))) return;
        structural((w) => w.sections.splice(+ds.dataset.sapdelsec, 1)); return;
      }
      const di = ev.target.closest("[data-sapdelitem]");
      if (di) { const [a, b] = di.dataset.sapdelitem.split(".").map(Number); structural((w) => w.sections[a].items.splice(b, 1)); return; }

      const conn = ev.target.closest("[data-sapconnect]");
      if (conn && ppAdmin()) {
        const raw = await window.TJA_UI.prompt(
          "Paste the link to this client's Service Allocation Plan Google Sheet (one tab per month, e.g. “October 2026”; a “REVISED October 2026” tab takes priority).\n\nThe sheet can stay private — share it with the portal's service account (Viewer). Leave blank to disconnect. Months built or edited in the portal are never overwritten by the sheet, and new months copy the latest portal month.",
          { title: "Connect SAP sheet", value: (view && view.sapUrl) || "", okText: "Connect" });
        if (raw == null) return;
        conn.disabled = true; conn.textContent = "Connecting…";
        const r = await call("connect", { url: raw.trim() });
        if (!r.ok) { window.TJA_UI.alert(r.error || "Couldn't connect that sheet."); repaint("status"); return; }
        mirror(r.view);
        if (raw.trim() && !r.tabFound) window.TJA_UI.alert("Connected — but there's no tab for this month yet. Name it like “October 2026” (or “REVISED October 2026”).");
        else if (raw.trim() && !r.parsed) window.TJA_UI.alert("Connected, but this month's tab didn't have the expected “Retainer Items … % Planned … Notes” header row.");
        repaint("status"); return;
      }

      // ---- approval (typed signature, like Present Docs) ----
      const sb = ev.target.closest("[data-sapsign]");
      if (sb && !sb.disabled) {
        if (dirty && !(await flush())) return;
        const err = page.querySelector(".sap-err"), nm = page.querySelector(".sap-sign-input");
        const name = (nm && nm.value || "").trim();
        if (!name) { err.textContent = "Sign by typing your name in the signature box."; nm && nm.focus(); return; }
        if (isStaffReal() && !(await window.TJA_UI.confirm("You're approving as TJA staff. Normally the client approves their plan — approve anyway?", { okText: "Approve" }))) return;
        sb.disabled = true; sb.textContent = "Approving…"; err.textContent = ""; busy = true;
        const r = await call("sign", { month: viewKey, name, signature: await typedSignature(name) });
        busy = false;
        if (!r.ok) { err.textContent = r.error || "Couldn't approve — please try again."; sb.disabled = false; sb.textContent = "Approve"; return; }
        mirror(r.view);
        if (r.pdf) {   // hand the signer their own copy (Drive + Slack already have it)
          try {
            const bin = atob(r.pdf), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([u], { type: "application/pdf" }));
            a.download = `${keyLabel(viewKey)} - Signed SAP.pdf`; document.body.appendChild(a); a.click(); a.remove();
          } catch (e) { /* convenience only */ }
        }
        repaint("status");
      }
    });
    // don't lose typing when the admin leaves the page / closes the tab
    window.addEventListener("beforeunload", (ev) => { if (dirty) { flush(); ev.preventDefault(); ev.returnValue = ""; } });
  }

  return { render, init, reset() { view = null; loadErr = ""; forClient = ""; work = null; dirty = false; } };
})();
