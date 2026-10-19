/* ============================================================
   SERVICE ALLOCATION PLAN page (retainer) — v390, Cameron 2026-10-19.

   Replaces the retainer "Status" page. The plan itself lives in the team's private Google
   Sheet (one tab per month; a "REVISED <Month YYYY>" tab wins over the plain one). The `sap`
   Edge Function reads it with the service account, snapshots every month into the retainer
   record (so past months stay viewable as they ended) and handles the one signature:

     • shows each service heading + every line item under it + Notes — never planned hours/%;
     • ONE signature per month, from anyone on the account (typed name + drawn signature);
     • the server builds the signed PDF, files it in Drive under
       Service Allocation Plans/<YYYY>/<MM-YYYY Month SAP>/ and posts it to the client's
       Slack channel; edits to the sheet after signing show "changed since signed".

   The SAP data is SERVER-OWNED: this page never saves it through the normal dashboard write,
   it only mirrors what the function returns into memory for display.
   ============================================================ */
window.SAP_PAGE = (function () {
  let view = null, loading = false, loadErr = "", viewKey = null, wired = false, forClient = "";

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

  // Keep the server's copy in THIS module only. Writing it onto the dashboard state would make
  // the next ordinary save (a 3-way merge) treat it as an admin edit and could clash with a
  // signature the server just recorded. The real copy reaches the state by the normal sync.
  function mirror(v) { view = v; loadErr = ""; }
  async function load(force) {
    if (loading) return; loading = true;
    const r = await call("fetch", force ? { force: true } : {});
    loading = false;
    if (r.ok && r.view) mirror(r.view); else loadErr = r.error || "Couldn't load the plan.";
    repaint("status");
  }

  const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch (e) { return ""; } };
  const isStaffReal = () => { const s = (typeof getSession === "function") && getSession(); return !!(s && s.role && s.role !== "client"); };
  const previewing = () => (typeof isPreviewing === "function") && isPreviewing();
  const multiline = (t) => esc(t).replace(/\n/g, "<br>");

  function monthKeys() {
    const ms = (view && view.months) || {};
    return Object.keys(ms).filter((k) => k >= "2026-10").sort().reverse();
  }

  function render() {
    const admin = ppAdmin();
    const head = `
    <div class="page-head">
      <div class="page-title">Service Allocation Plan</div>
      <div class="page-desc">What the team is focused on for you this month.</div>
      ${admin ? `<div class="sap-admin">
        <button class="btn btn-ghost" data-sapconnect>${view && view.connected ? "✎ Change SAP sheet" : "🔗 Connect SAP sheet"}</button>
        ${view && view.connected ? `<button class="btn btn-ghost" data-saprefresh title="Re-read the sheet now">↻ Refresh</button>` : ""}
      </div>` : ""}
    </div>`;
    // first paint for this client → fetch (the cached copy shows meanwhile if we have one)
    if (forClient !== clientId()) { forClient = clientId(); view = null; viewKey = null; }
    if (!view && !loading && !loadErr) {
      const eng = getEng();
      if (eng && eng.sap && eng.sap.months) view = { connected: !!eng.sapUrl, sapUrl: eng.sapUrl || "", months: eng.sap.months, fileName: eng.sap.fileName, error: eng.sap.error, current: null };
      setTimeout(() => load(false), 0);
    }
    if (!view) return head + `<div class="card sap-empty">${loadErr ? esc(loadErr) : "Loading the plan…"}</div>`;
    if (!view.connected) return head + `<div class="card sap-empty">${admin
      ? "Connect this client's Service Allocation Plan sheet. It stays private — just share it with the portal's service account (Viewer)."
      : "Your Service Allocation Plan will appear here once it's ready."}</div>`;

    const keys = monthKeys();
    const cur = view.current || keys[0];
    if (!viewKey || !view.months[viewKey]) viewKey = cur && view.months[cur] ? cur : keys[0];
    const m = viewKey ? view.months[viewKey] : null;
    const chips = keys.length > 1 ? `<div class="mom-strip sap-months">${keys.map((k) => `<div class="mom-chip ${k === viewKey ? "active" : ""}" data-sapmonth="${k}"><div class="m">${esc((view.months[k].label || k).replace(/ \d{4}$/, ""))}</div><div class="v">${view.months[k].signed ? "✓ signed" : (k === cur ? "current" : "")}</div></div>`).join("")}</div>` : "";
    const errBanner = (view.error && admin) ? `<div class="sap-banner sap-banner--err">⚠ ${esc(view.error)} — showing the last copy read.</div>` : "";
    if (!m || m.missing || !m.sections) {
      return head + chips + errBanner + `<div class="card sap-empty">${admin
        ? `This month's plan isn't in the sheet yet — add a tab named <b>${esc((m && m.label) || "")}</b> (or <b>REVISED ${esc((m && m.label) || "")}</b>).`
        : "This month's plan is being finalized — check back soon."}</div>`;
    }
    const isCur = viewKey === cur;
    const changed = m.signed && m.signed.hash && m.hash && m.signed.hash !== m.hash;
    const sections = m.sections.map((s) => `
      <div class="card sap-sec">
        <div class="sap-sec-head">${esc(s.name)}</div>
        ${s.notes ? `<div class="sap-notes">${multiline(s.notes)}</div>` : ""}
        ${s.items.length ? `<ul class="sap-items">${s.items.map((it) => `<li><span class="sap-item">${esc(it.name)}</span>${it.notes ? `<div class="sap-notes">${multiline(it.notes)}</div>` : ""}</li>`).join("")}</ul>` : ""}
      </div>`).join("");
    let sign = "";
    if (m.signed) {
      sign = `<div class="card sap-signed">
        <div class="sap-signed-head">✅ Signed by <b>${esc(m.signed.name)}</b> on ${esc(fmtDate(m.signed.at))}</div>
        ${changed ? `<div class="sap-banner sap-banner--warn">This plan has changed since it was signed. The signed PDF remains the record of what was approved.</div>` : ""}
        ${(isStaffReal() && m.signed.driveUrl) ? `<a class="btn btn-ghost" href="${esc(m.signed.driveUrl)}" target="_blank" rel="noopener">📄 Signed PDF in Drive ↗</a>` : ""}
        ${(isStaffReal() && m.signed.driveError) ? `<div class="sap-banner sap-banner--err">The signed PDF couldn't be saved to Drive.</div>` : ""}
      </div>`;
    } else if (isCur) {
      const blocked = previewing();
      sign = `<div class="card sap-sign">
        <div class="sap-sec-head">Approve this plan</div>
        <p class="sap-sub">One signature is needed from anyone on your team.</p>
        <label class="sap-lbl">Full name<input class="sap-name" type="text" maxlength="120" autocomplete="name" placeholder="Your full name"></label>
        <div class="sap-lbl">Signature <button type="button" class="sap-clear" data-sapclear>Clear</button></div>
        <canvas class="sap-pad" width="600" height="160" aria-label="Draw your signature"></canvas>
        <div class="sap-err" aria-live="polite"></div>
        <button class="btn btn-primary" data-sapsign${blocked ? ` disabled title="Client View preview — the client signs here"` : ""}>✍️ Sign plan</button>
      </div>`;
    } else {
      sign = `<div class="card sap-empty">This month's plan wasn't signed.</div>`;
    }
    return head + chips + errBanner +
      `<div class="sap-month-title">${esc(m.label)}${admin && m.tab ? ` <span class="sap-tab">tab: ${esc(m.tab)}</span>` : ""}</div>` +
      sections + (m.terms ? `<div class="sap-terms">${multiline(m.terms)}</div>` : "") + sign;
  }

  /* ---- signature pad ---- */
  let drew = false;
  function wirePad(page) {
    const c = page.querySelector(".sap-pad"); if (!c || c.dataset.wired) return;
    c.dataset.wired = "1"; drew = false;
    const ctx = c.getContext("2d");
    ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#111";
    let down = false, last = null;
    const pt = (ev) => { const r = c.getBoundingClientRect(); return { x: (ev.clientX - r.left) * c.width / r.width, y: (ev.clientY - r.top) * c.height / r.height }; };
    c.addEventListener("pointerdown", (ev) => { ev.preventDefault(); down = true; last = pt(ev); c.setPointerCapture(ev.pointerId); });
    c.addEventListener("pointermove", (ev) => {
      if (!down) return; const p = pt(ev);
      ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; drew = true;
    });
    const up = () => { down = false; };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  }

  function init(page) {
    wirePad(page);
    if (wired) return; wired = true;
    // the page is repainted often; re-wire the pad on every paint
    new MutationObserver(() => wirePad(page)).observe(page, { childList: true });
    page.addEventListener("click", async (ev) => {
      const mc = ev.target.closest("[data-sapmonth]");
      if (mc) { viewKey = mc.dataset.sapmonth; repaint("status"); return; }
      if (ev.target.closest("[data-saprefresh]")) { load(true); return; }
      if (ev.target.closest("[data-sapclear]")) { const c = page.querySelector(".sap-pad"); if (c) { c.getContext("2d").clearRect(0, 0, c.width, c.height); drew = false; } return; }
      const conn = ev.target.closest("[data-sapconnect]");
      if (conn && ppAdmin()) {
        const raw = await window.TJA_UI.prompt(
          "Paste the link to this client's Service Allocation Plan Google Sheet (one tab per month, e.g. “October 2026”; a “REVISED October 2026” tab takes priority).\n\nThe sheet can stay private — share it with the portal's service account (Viewer). Leave blank to disconnect.",
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
      const sb = ev.target.closest("[data-sapsign]");
      if (sb && !sb.disabled) {
        const err = page.querySelector(".sap-err"), nm = page.querySelector(".sap-name"), pad = page.querySelector(".sap-pad");
        const name = (nm && nm.value || "").trim();
        if (!name) { err.textContent = "Type your full name."; return; }
        if (!drew) { err.textContent = "Draw your signature in the box."; return; }
        if (isStaffReal()) {
          const ok = await window.TJA_UI.confirm("You're signing as TJA staff. Normally the client signs their plan — sign anyway?", { okText: "Sign" });
          if (!ok) return;
        }
        sb.disabled = true; sb.textContent = "Signing…"; err.textContent = "";
        const r = await call("sign", { name, signature: pad.toDataURL("image/png") });
        if (!r.ok) { err.textContent = r.error || "Couldn't sign — please try again."; sb.disabled = false; sb.textContent = "✍️ Sign plan"; return; }
        mirror(r.view);
        // hand the signer their own copy
        if (r.pdf) {
          try {
            const bin = atob(r.pdf), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
            const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([u], { type: "application/pdf" }));
            const mm = view.months[view.current] || {}; a.download = `${mm.label || "SAP"} - Signed SAP.pdf`; document.body.appendChild(a); a.click(); a.remove();
          } catch (e) { /* the copy is a convenience — Drive + Slack already have it */ }
        }
        repaint("status");
      }
    });
  }

  return { render, init, reset() { view = null; loadErr = ""; forClient = ""; } };
})();
