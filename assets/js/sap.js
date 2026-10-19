/* ============================================================
   SERVICE ALLOCATION PLAN (SAP) page (retainer) — v390/v391, Cameron 2026-10-19/20.

   Replaces the retainer "Status" page and is laid out like the team's SAP spreadsheet:
   client + month header, then a Retainer Items | % Planned | Notes table (service headings
   with their line items under them), the terms, and an Authorized Signature | Date row.

   Where a month comes from:
     • a connected Google Sheet (read by the `sap` Edge Function with the service account —
       "REVISED <Month YYYY>" beats "<Month YYYY>", OLD tabs ignored), or
     • built HERE: "+ New month" copies the latest month as a template, and admins edit it in
       place. A month saved in the portal is marked source:"portal" and the sheet stops
       driving it. SAPs are built in the portal from now on; the sheet link is the bridge.
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
  let draft = null;          // { key, sections, terms } while an admin is editing a month
  let busy = false;

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
  // Keep the server's copy in THIS module only (see header).
  function mirror(v) { view = v; loadErr = ""; }
  async function load(force) {
    if (loading) return; loading = true; lastLoad = Date.now();
    const r = await call("fetch", force ? { force: true } : {});
    loading = false;
    if (r.ok && r.view) mirror(r.view); else if (!view) loadErr = r.error || "Couldn't load the plan.";
    if (!draft) repaint("status");
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
    if (forClient !== clientId()) { forClient = clientId(); view = null; viewKey = null; draft = null; loadErr = ""; }
    if (!view && !loading && !loadErr) {
      const eng = getEng();
      if (eng && eng.sap && eng.sap.months) view = { connected: !!eng.sapUrl, sapUrl: eng.sapUrl || "", months: eng.sap.months, fileName: eng.sap.fileName, error: eng.sap.error, current: null, shares: {} };
      setTimeout(() => load(false), 0);
    } else if (view && !loading && !draft && Date.now() - lastLoad > 30000) {
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
    if (draft && draft.key !== viewKey) draft = null;

    // admin toolbar
    const tools = admin ? `<div class="sap-admin">
        <button class="btn btn-ghost" data-sapnewmonth title="Start next month's plan from the latest month">＋ New month</button>
        ${viewKey && view.months[viewKey] && view.months[viewKey].sections && !draft ? `<button class="btn btn-ghost" data-sapedit>✎ Edit this month</button>` : ""}
        <button class="btn btn-ghost" data-sapconnect>${view.connected ? "✎ Change SAP sheet" : "🔗 Connect SAP sheet"}</button>
        ${view.connected ? `<button class="btn btn-ghost" data-saprefresh title="Re-read the sheet now">↻ Refresh</button>` : ""}
      </div>` : "";
    // month-over-month strip — ALWAYS shown, like the burn tile's
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
    if (!draft && (!m || m.missing || !m.sections)) {
      return head + tools + chips + errBanner + `<div class="card sap-empty">${admin
        ? `There's no plan for ${esc(keyLabel(viewKey))} yet — use <b>＋ New month</b>${view.connected ? `, or add a tab named <b>${esc(keyLabel(viewKey))}</b> to the sheet` : ""}.`
        : "This month's plan is being finalized — check back soon."}</div>`;
    }
    return head + tools + chips + errBanner + (draft ? editor(m) : sheet(m, viewKey));
  }

  // the read view — laid out like the SAP spreadsheet
  function sheet(m, key) {
    const admin = ppAdmin();
    const changed = m.signed && m.signed.hash && m.hash && m.signed.hash !== m.hash;
    const rows = m.sections.map((s, si) => {
      const p = pctFor(m, key, s, si);
      return `<tr class="sap-sec-row"><td>${esc(s.name)}</td><td class="sap-pct">${p == null ? "" : p + "%"}</td><td class="sap-note">${s.notes ? multiline(s.notes) : ""}</td></tr>` +
        (s.items || []).map((it) => `<tr class="sap-item-row"><td>${esc(it.name)}</td><td></td><td class="sap-note">${it.notes ? multiline(it.notes) : ""}</td></tr>`).join("");
    }).join("");
    const canSign = !m.signed && key >= curKey();
    let sigCell = "", dateCell = "", below = "";
    if (m.signed) {
      sigCell = `<div class="sap-sig-name">${esc(m.signed.name)}</div>`;
      dateCell = esc(fmtDate(m.signed.at));
      below = `${changed ? `<div class="sap-banner sap-banner--warn">This plan has changed since it was approved. The signed PDF remains the record of what was approved.</div>` : ""}
        ${(isStaffReal() && m.signed.driveUrl) ? `<a class="btn btn-ghost" href="${esc(m.signed.driveUrl)}" target="_blank" rel="noopener">📄 Signed PDF in Drive ↗</a>` : ""}
        ${(isStaffReal() && m.signed.driveError) ? `<div class="sap-banner sap-banner--err">The signed PDF couldn't be saved to Drive.</div>` : ""}`;
    } else if (canSign) {
      const me = (typeof getSession === "function" && getSession() && !isStaffReal() && getSession().name) || "";
      sigCell = `<div class="pd-sign-preview sap-sig-preview${me ? "" : " placeholder"}">${esc(me || "Your signature")}</div>
        <input type="text" class="pd-sign-name sap-name" maxlength="120" autocomplete="name" placeholder="Type your full name" value="${esc(me)}">`;
      dateCell = esc(fmtDate(new Date().toISOString()));
      below = `<div class="sap-err" aria-live="polite"></div>
        <button class="btn btn-primary sap-approve" data-sapsign${previewing() ? ` disabled title="Client View preview — the client approves here"` : ""}>Approve</button>`;
    } else {
      sigCell = `<span class="sap-dim">Not signed</span>`;
    }
    return `<div class="card sap-sheet">
      <div class="sap-sheet-head"><div class="sap-client">${esc(clientName())}</div><div class="sap-month">${esc(m.label || keyLabel(key))}</div>
        ${admin ? `<div class="sap-src">${m.source === "portal" ? "Built in the portal" : m.tab ? "From the sheet · tab “" + esc(m.tab) + "”" : ""}</div>` : ""}</div>
      <div class="sap-table-wrap"><table class="sap-table">
        <thead><tr><th>Retainer Items</th><th class="sap-pct">% Planned</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${m.terms ? `<div class="sap-terms">${multiline(m.terms)}</div>` : ""}
      <table class="sap-table sap-sig-table"><tbody>
        <tr><th>Authorized Signature</th><th>Date</th></tr>
        <tr><td class="sap-sig-cell">${sigCell}</td><td class="sap-date-cell">${dateCell}</td></tr>
      </tbody></table>
      <div class="sap-below">${below}</div>
    </div>`;
  }

  // the admin editor — same table, every cell editable
  function editor(m) {
    const ls = lines();
    const optList = (s) => `<select class="sap-in sap-link" data-sapf="disc" data-si="${s.__i}" title="Which Executive Summary service line drives this heading's %">
        <option value="">Auto (${esc((ls.find((l) => l.key === canon(s.name)) || {}).name || "no match")})</option>
        ${ls.map((l) => `<option value="${esc(l.key)}"${s.discipline === l.key ? " selected" : ""}>${esc(l.name)}</option>`).join("")}
        <option value="none"${s.discipline === "none" ? " selected" : ""}>Not linked — type a %</option>
      </select>`;
    const rows = draft.sections.map((s, si) => {
      s.__i = si;
      const p = pctFor({}, draft.key, s, si);
      const linked = secKey(s) !== "none" && (liveShares()[secKey(s)] != null) && draft.key >= curKey();
      return `<tr class="sap-sec-row">
          <td><input class="sap-in sap-in-sec" data-sapf="name" data-si="${si}" value="${esc(s.name)}" placeholder="Service heading">
            <div class="sap-row-tools">${optList(s)}<button class="row-del" data-sapdelsec="${si}" title="Remove this service">✕</button></div></td>
          <td class="sap-pct">${linked ? `<span title="From the Executive Summary service lines">${p}%</span>` : `<input class="sap-in sap-in-pct" type="number" min="0" max="100" data-sapf="pct" data-si="${si}" value="${p == null ? "" : p}">%`}</td>
          <td><textarea class="sap-in" rows="2" data-sapf="notes" data-si="${si}" placeholder="Notes">${esc(s.notes || "")}</textarea></td>
        </tr>` +
        (s.items || []).map((it, ii) => `<tr class="sap-item-row">
          <td><input class="sap-in" data-sapf="iname" data-si="${si}" data-ii="${ii}" value="${esc(it.name)}" placeholder="Line item"><button class="row-del" data-sapdelitem="${si}.${ii}" title="Remove this line">✕</button></td>
          <td></td>
          <td><textarea class="sap-in" rows="2" data-sapf="inotes" data-si="${si}" data-ii="${ii}" placeholder="Notes">${esc(it.notes || "")}</textarea></td>
        </tr>`).join("") +
        `<tr class="sap-add-row"><td colspan="3"><button class="row-add" data-sapadditem="${si}">＋ Add line item</button></td></tr>`;
    }).join("");
    return `<div class="card sap-sheet sap-editing">
      <div class="sap-sheet-head"><div class="sap-client">${esc(clientName())}</div><div class="sap-month">${esc(keyLabel(draft.key))}</div>
        <div class="sap-src">Editing${m && m.signed ? " — this month is already approved; saving shows it as changed" : ""}${m && m.source !== "portal" && m.tab ? " — once saved here, the sheet stops updating this month" : ""}</div></div>
      <div class="sap-table-wrap"><table class="sap-table">
        <thead><tr><th>Retainer Items</th><th class="sap-pct">% Planned</th><th>Notes</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <button class="row-add" data-sapaddsec>＋ Add service</button>
      <label class="sap-lbl">Terms<textarea class="sap-in" rows="3" data-sapf="terms">${esc(draft.terms || "")}</textarea></label>
      <div class="sap-err" aria-live="polite"></div>
      <div class="sap-edit-actions"><button class="btn btn-ghost" data-sapcancel>Cancel</button><button class="btn btn-primary" data-sapsave>Save month</button></div>
    </div>`;
  }

  async function typedSignature(name) {   // same cursive render as Present Docs
    try { await document.fonts.load("52px 'Great Vibes'"); } catch (e) {}
    const c = document.createElement("canvas"); c.width = 640; c.height = 150; const x = c.getContext("2d");
    x.fillStyle = "#111"; x.textBaseline = "middle"; x.textAlign = "left"; x.font = "52px 'Great Vibes', cursive";
    x.fillText(name, 18, 84); return c.toDataURL("image/png");
  }

  async function saveDraft(page) {
    const err = page.querySelector(".sap-err");
    const sections = draft.sections.map((s) => ({ name: s.name, notes: s.notes, pct: s.pct, discipline: s.discipline || "",
      items: (s.items || []).filter((i) => (i.name || "").trim() || (i.notes || "").trim()) }));
    if (!sections.length) { err.textContent = "Add at least one service."; return false; }
    busy = true;
    const r = await call("save", { month: draft.key, sections, terms: draft.terms || "" });
    busy = false;
    if (!r.ok) { if (err) err.textContent = r.error || "Couldn't save."; return false; }
    mirror(r.view); viewKey = draft.key; draft = null; repaint("status"); return true;
  }

  function init(page) {
    if (wired) return; wired = true;
    // typing updates the draft / the signature preview WITHOUT a repaint (keeps focus)
    page.addEventListener("input", (ev) => {
      const nm = ev.target.closest(".sap-name");
      if (nm) { const pv = page.querySelector(".sap-sig-preview"); if (pv) { pv.textContent = nm.value.trim() || "Your signature"; pv.classList.toggle("placeholder", !nm.value.trim()); } return; }
      const f = ev.target.closest("[data-sapf]"); if (!f || !draft) return;
      const fld = f.dataset.sapf, s = draft.sections[+f.dataset.si];
      if (fld === "terms") draft.terms = f.value;
      else if (fld === "name") s.name = f.value;
      else if (fld === "notes") s.notes = f.value;
      else if (fld === "pct") s.pct = f.value === "" ? null : +f.value;
      else if (fld === "iname") s.items[+f.dataset.ii].name = f.value;
      else if (fld === "inotes") s.items[+f.dataset.ii].notes = f.value;
    });
    page.addEventListener("change", (ev) => {
      const f = ev.target.closest('[data-sapf="disc"]'); if (!f || !draft) return;
      const s = draft.sections[+f.dataset.si]; if (f.value) s.discipline = f.value; else delete s.discipline;
      repaint("status");
    });
    page.addEventListener("click", async (ev) => {
      if (busy) return;
      const mc = ev.target.closest("[data-sapmonth]");
      if (mc) {
        if (draft && !(await window.TJA_UI.confirm("Discard your unsaved changes to this month?", { okText: "Discard" }))) return;
        draft = null; viewKey = mc.dataset.sapmonth; repaint("status"); return;
      }
      if (ev.target.closest("[data-saprefresh]")) { load(true); return; }

      // ---- building / editing (admin) ----
      if (ev.target.closest("[data-sapnewmonth]") && ppAdmin()) {
        const keys = monthKeys(), cur = curKey();
        const latest = keys[keys.length - 1];
        const target = latest && latest >= cur ? nextKey(latest) : cur;   // the month after the latest plan (never a closed one)
        const src = latest && view.months[latest] && view.months[latest].sections ? view.months[latest] : null;
        if (!(await window.TJA_UI.confirm(`Create the ${keyLabel(target)} plan${src ? ` from ${src.label}` : ""}? Line items carry over; notes start blank and the %s follow the Executive Summary.`, { okText: "Create" }))) return;
        draft = { key: target, terms: src ? src.terms || "" : "",
          sections: src ? src.sections.map((s) => ({ name: s.name, notes: "", pct: s.pct ?? null, ...(s.discipline ? { discipline: s.discipline } : {}),
            items: (s.items || []).map((i) => ({ name: i.name, notes: "" })) }))
            : lines().map((l) => ({ name: l.name, notes: "", pct: null, discipline: l.key, items: [{ name: "", notes: "" }] })) };
        viewKey = target;
        view.months[target] = view.months[target] || { key: target, label: keyLabel(target), sections: null };
        repaint("status"); return;
      }
      if (ev.target.closest("[data-sapedit]") && ppAdmin()) {
        const m = view.months[viewKey]; if (!m || !m.sections) return;
        draft = { key: viewKey, terms: m.terms || "", sections: clone(m.sections) };
        repaint("status"); return;
      }
      if (ev.target.closest("[data-sapcancel]")) {
        const m = view.months[viewKey]; if (m && !m.sections) { delete view.months[viewKey]; viewKey = null; }
        draft = null; repaint("status"); return;
      }
      if (ev.target.closest("[data-sapsave]") && draft) { await saveDraft(page); return; }
      const ai = ev.target.closest("[data-sapadditem]");
      if (ai && draft) { draft.sections[+ai.dataset.sapadditem].items.push({ name: "", notes: "" }); repaint("status"); return; }
      if (ev.target.closest("[data-sapaddsec]") && draft) { draft.sections.push({ name: "", notes: "", pct: null, items: [{ name: "", notes: "" }] }); repaint("status"); return; }
      const ds = ev.target.closest("[data-sapdelsec]");
      if (ds && draft) { draft.sections.splice(+ds.dataset.sapdelsec, 1); repaint("status"); return; }
      const di = ev.target.closest("[data-sapdelitem]");
      if (di && draft) { const [a, b] = di.dataset.sapdelitem.split(".").map(Number); draft.sections[a].items.splice(b, 1); repaint("status"); return; }

      const conn = ev.target.closest("[data-sapconnect]");
      if (conn && ppAdmin()) {
        const raw = await window.TJA_UI.prompt(
          "Paste the link to this client's Service Allocation Plan Google Sheet (one tab per month, e.g. “October 2026”; a “REVISED October 2026” tab takes priority).\n\nThe sheet can stay private — share it with the portal's service account (Viewer). Leave blank to disconnect. Months built in the portal are never overwritten by the sheet.",
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
        const err = page.querySelector(".sap-err"), nm = page.querySelector(".sap-name");
        const name = (nm && nm.value || "").trim();
        if (!name) { err.textContent = "Type your full name to sign."; nm && nm.focus(); return; }
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
  }

  return { render, init, reset() { view = null; loadErr = ""; forClient = ""; draft = null; } };
})();
