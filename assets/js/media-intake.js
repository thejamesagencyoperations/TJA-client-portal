/* ============================================================
   MEDIA INTAKE — the paid-media creative-submission form (the
   "reverse Present Docs"): clients submit assets to the media team.
   All writes go through the media-intake Edge Function; reads pull
   the 'media_intake' scope directly (RLS: clients see their own,
   staff see all). window.MediaIntake.render()/init().
   ============================================================ */
window.MediaIntake = (function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const sess = () => ((typeof getSession === "function" && getSession()) || {});
  const clientId = () => sess().client;
  const isStaff = () => (typeof window.isStaff === "function") ? window.isStaff() : false;
  let submissions = [];

  const PURPOSES = ["Add to existing campaign", "Replace current creatives", "New campaign", "Test against current creative (A/B)", "Other"];
  const STATUS = { new: "New", "in-progress": "In progress", done: "Done" };
  const STATUS_ORDER = ["new", "in-progress", "done"];

  function fnBase() { const cfg = window.SUPABASE_CONFIG || {}; return cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : ""; }
  async function token() { try { const { data } = await window.SUPA.client.auth.getSession(); return data && data.session ? data.session.access_token : null; } catch (e) { return null; } }

  async function load() {
    submissions = [];
    try {
      if (window.SUPA && window.SUPA.enabled) {
        const d = await window.SUPA.pullScope(clientId(), "media_intake");
        if (d && Array.isArray(d.submissions)) submissions = d.submissions;
      }
    } catch (e) { /* leave empty */ }
  }

  /* ---- the repeatable per-asset field block ---- */
  function assetBlock(n) {
    return `<div class="mi-asset" data-asset>
      <div class="mi-asset-head"><span>Asset ${n}</span><button type="button" class="mi-asset-x" data-assetdel title="Remove this asset">✕</button></div>
      <div class="mi-grid">
        <label class="mi-f mi-wide"><span>Asset name</span><input data-f="name" placeholder="File / asset name"></label>
        <label class="mi-f mi-wide"><span>Attach — Drive link <em>(YouTube link required for a YT asset)</em></span><input data-f="driveLink" placeholder="https://drive.google.com/…"></label>
        <label class="mi-f"><span>Landing page URL <em>blank = media team creates</em></span><input data-f="landingUrl" placeholder="https://…"></label>
        <label class="mi-f"><span>CTA button text <em>blank / N-A ok</em></span><input data-f="cta"></label>
        <label class="mi-f mi-wide"><span>Headline <em>blank = media team creates</em></span><input data-f="headline"></label>
        <label class="mi-f mi-wide"><span>Body copy <em>blank = media team creates</em></span><textarea data-f="body" rows="2"></textarea></label>
        <label class="mi-f"><span>Purpose</span><select data-f="purpose">${PURPOSES.map((p) => `<option>${esc(p)}</option>`).join("")}</select></label>
        <label class="mi-f"><span>Campaign / initiative <em>if applicable</em></span><input data-f="purposeDetail" placeholder="Initiative name"></label>
        <label class="mi-f"><span>Launch date <em>if applicable</em></span><input type="date" data-f="launchDate"></label>
        <label class="mi-f"><span>End date <em>if applicable</em></span><input type="date" data-f="endDate"></label>
        <label class="mi-f mi-wide"><span>Specific audience notes</span><textarea data-f="audience" rows="2"></textarea></label>
        <label class="mi-f mi-wide"><span>Anything else we should know?</span><textarea data-f="notes" rows="2"></textarea></label>
      </div>
    </div>`;
  }

  /* ---- a past submission, shown to client + staff ---- */
  function submissionCard(s) {
    const when = (s.submittedAt || "").slice(0, 16).replace("T", " ");
    const rows = (s.assets || []).map((a, i) => {
      const bits = [];
      if (a.purpose) bits.push(esc(a.purpose) + (a.purposeDetail ? ` — ${esc(a.purposeDetail)}` : ""));
      if (a.launchDate) bits.push("launch " + esc(a.launchDate));
      const link = a.driveLink ? ` · <a href="${esc(a.driveLink)}" target="_blank" rel="noopener">link</a>` : "";
      return `<div class="mi-sub-asset"><span class="mi-sub-aname">${esc(a.name || "Asset " + (i + 1))}</span>${link}${bits.length ? `<span class="mi-sub-meta">${bits.join(" · ")}</span>` : ""}</div>`;
    }).join("");
    const st = STATUS[s.status] || "New";
    const statusCtl = isStaff()
      ? `<select class="mi-status-sel" data-status="${esc(s.id)}">${STATUS_ORDER.map((k) => `<option value="${k}"${s.status === k ? " selected" : ""}>${STATUS[k]}</option>`).join("")}</select>`
      : `<span class="mi-status is-${esc(s.status || "new")}">${esc(st)}</span>`;
    return `<div class="card mi-sub">
      <div class="mi-sub-top">
        <span class="mi-sub-when">${esc(when)} · ${esc((s.assets || []).length)} asset${(s.assets || []).length === 1 ? "" : "s"}${isStaff() && s.submittedBy ? ` · ${esc(s.submittedBy)}` : ""}</span>
        ${statusCtl}
      </div>
      <div class="mi-sub-assets">${rows}</div>
      ${s.note ? `<div class="mi-sub-note">${esc(s.note)}</div>` : ""}
    </div>`;
  }

  function render() {
    const listHtml = submissions.length ? submissions.map(submissionCard).join("") : `<div class="placeholder-note" style="margin-top:10px">No requests submitted yet.</div>`;
    const staff = isStaff();
    return `
    <div class="page-head">
      <div class="page-title">Media Requests</div>
      <div class="page-desc">${staff ? "Creative-asset requests submitted by this client for the paid-media team." : "Submit creative assets to our paid-media team. Add one block per asset."}</div>
    </div>
    <div class="card mi-form-card">
      <div class="mi-form-title">New request</div>
      <div id="miAssets">${assetBlock(1)}</div>
      <button type="button" class="row-add" id="miAddAsset">＋ Add asset</button>
      <div class="mi-err" id="miErr" style="display:none"></div>
      <div class="mi-actions"><button type="button" class="btn btn-primary" id="miSubmit">Submit request</button><span class="mi-saved" id="miSaved"></span></div>
    </div>
    <div class="mi-list-head">${submissions.length ? "Submitted requests" : ""}</div>
    <div id="miList">${listHtml}</div>`;
  }

  function collectAssets(root) {
    return [...root.querySelectorAll("[data-asset]")].map((blk) => {
      const a = {};
      blk.querySelectorAll("[data-f]").forEach((el) => { const v = el.value.trim(); if (v) a[el.dataset.f] = v; });
      return a;
    }).filter((a) => Object.keys(a).length);
  }
  function renumber(root) {
    root.querySelectorAll("[data-asset]").forEach((blk, i) => {
      const h = blk.querySelector(".mi-asset-head > span"); if (h) h.textContent = "Asset " + (i + 1);
    });
  }

  let wired = false;
  function init() {
    const page = document.querySelector('.page[data-page="media"]');
    if (!page) return;
    // refresh the submissions list from the server, then repaint just the list
    load().then(() => { const l = document.getElementById("miList"); if (l) l.innerHTML = submissions.length ? submissions.map(submissionCard).join("") : `<div class="placeholder-note" style="margin-top:10px">No requests submitted yet.</div>`;
      const lh = document.querySelector(".mi-list-head"); if (lh) lh.textContent = submissions.length ? "Submitted requests" : ""; });
    if (wired) return; wired = true;

    page.addEventListener("click", async (e) => {
      const add = e.target.closest("#miAddAsset");
      if (add) { const host = document.getElementById("miAssets"); host.insertAdjacentHTML("beforeend", assetBlock(host.querySelectorAll("[data-asset]").length + 1)); return; }
      const del = e.target.closest("[data-assetdel]");
      if (del) { const host = document.getElementById("miAssets"); if (host.querySelectorAll("[data-asset]").length > 1) { del.closest("[data-asset]").remove(); renumber(host); } return; }
      const sub = e.target.closest("#miSubmit");
      if (sub) { await submit(sub); return; }
    });
    // staff status change
    page.addEventListener("change", async (e) => {
      const sel = e.target.closest("[data-status]");
      if (sel && isStaff()) {
        sel.disabled = true;
        try {
          const t = await token();
          await fetch(fnBase() + "/media-intake", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action: "status", clientId: clientId(), submissionId: sel.dataset.status, status: sel.value }) });
        } catch (err) { /* soft */ }
        sel.disabled = false;
      }
    });
  }

  async function submit(btn) {
    const host = document.getElementById("miAssets");
    const err = document.getElementById("miErr");
    const assets = collectAssets(host);
    if (!assets.length) { err.textContent = "Add at least one asset (an asset name, or any field)."; err.style.display = ""; return; }
    err.style.display = "none";
    const t = await token();
    if (!t) { err.textContent = "You need to be signed in to submit."; err.style.display = ""; return; }
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      const r = await fetch(fnBase() + "/media-intake", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify({ action: "submit", assets }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const saved = document.getElementById("miSaved"); if (saved) { saved.textContent = "✓ Request submitted" + (j.emailed ? " · media team emailed" : ""); setTimeout(() => { saved.textContent = ""; }, 5000); }
        host.innerHTML = assetBlock(1);               // reset the form
        await load();
        const l = document.getElementById("miList"); if (l) l.innerHTML = submissions.map(submissionCard).join("");
        const lh = document.querySelector(".mi-list-head"); if (lh) lh.textContent = "Submitted requests";
      } else {
        err.textContent = j.error || "Couldn't submit — please try again."; err.style.display = "";
      }
    } catch (e) { err.textContent = "Couldn't reach the server — please try again."; err.style.display = ""; }
    btn.disabled = false; btn.textContent = "Submit request";
  }

  return { render, init, load };
})();
