/* ============================================================
   ADMIN CENTER → ASK TJA tab (v4.21)
   • Switch (admin only): on = every client sees the chat bubble; off = staff preview only.
   • Daily AI-question limit per client login (0 = unlimited) and the assistant's display name.
   • Whether the AI key is connected yet.
   • Chat log: every client question + answer (AI, quick answers, handoffs), filter by client or
     "couldn't answer". Rows come from the ask-tja function, which checks the caller is staff.
   • "What it can see": the exact data the assistant is given for one client.
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const admin = () => typeof isAdmin === "function" && isAdmin();

  async function call(body) {
    const cfg = window.SUPABASE_CONFIG || {};
    const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
    try {
      const { data } = await window.SUPA.client.auth.getSession();
      const t = data && data.session ? data.session.access_token : null;
      if (!base || !t) return { error: "Not signed in to the backend" };
      const r = await fetch(base + "/ask-tja", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + t }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || "Error " + r.status };
    } catch (e) { return { error: "Network error" }; }
  }

  const clientName = (id) => { const c = window.TJA_STORE && window.TJA_STORE.get(id); return (c && c.name) || id; };
  const clientIds = () => {
    const all = (window.TJA_STORE && window.TJA_STORE.list && window.TJA_STORE.list()) || [];
    return all.filter((c) => c && c.id && !String(c.id).startsWith("_")).map((c) => c.id)
      .sort((a, b) => clientName(a).localeCompare(clientName(b)));
  };
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch (e) { return iso; } };
  const KIND = { ai: "AI answer", quick: "Quick answer", handoff: "Sent to AM", limited: "Hit daily limit", error: "Error" };

  let state = { rows: [], cfg: null, client: "", unanswered: false, loaded: false };

  function shell() {
    const host = $("acAsk");
    host.innerHTML = `
      <div class="tm-settings" style="margin:0 0 18px">
        <div class="tm-set-row" style="border-top:none">
          <div class="tm-set-txt"><b>Show Ask TJA to clients</b><span>Off = only staff see the chat bubble, marked "Staff preview", so you can test it. On = every client sees it on their dashboard. ${admin() ? "" : "<em>Only admins can change this.</em>"}</span></div>
          <label class="tm-switch"><input type="checkbox" id="atjEnabled" ${admin() ? "" : "disabled"}><span class="tm-slider-ui"></span></label>
        </div>
        <div class="tm-set-row">
          <div class="tm-set-txt"><b>Typed questions per client login, per day</b><span>Counts only questions answered by the AI (each costs a few cents). Quick-answer buttons are free and unlimited. 0 = unlimited.</span></div>
          <input type="number" min="0" max="500" step="1" id="atjLimit" class="tm-search atj-ctl" style="width:90px" ${admin() ? "" : "disabled"}>
        </div>
        <div class="tm-set-row">
          <div class="tm-set-txt"><b>Assistant name</b><span>What clients see in the chat header.</span></div>
          <input type="text" maxlength="40" id="atjName" class="tm-search atj-ctl" style="width:200px" ${admin() ? "" : "disabled"}>
        </div>
        <div class="tm-set-row">
          <div class="tm-set-txt"><b>AI connection</b><span id="atjKey">Checking…</span></div>
          ${admin() ? `<button class="btn btn-primary btn-sm atj-ctl" type="button" id="atjSave">Save</button>` : ""}
        </div>
        <div class="cl-err" id="atjErr" style="min-height:0;padding:0 16px 10px"></div>
      </div>
      <div class="tm-filter-row">
        <div class="tm-chips">
          <button class="tm-chip active" type="button" data-atjf="all">All chats</button>
          <button class="tm-chip" type="button" data-atjf="unanswered">Couldn't answer</button>
        </div>
        <div class="tm-filter-right">
          <select class="tm-client-filter" id="atjClient"><option value="">All clients</option>${clientIds().map((id) => `<option value="${esc(id)}">${esc(clientName(id))}</option>`).join("")}</select>
          <button class="btn btn-ghost btn-sm" type="button" id="atjFacts" title="Show exactly what the assistant is given for the selected client">What it can see</button>
          <button class="btn btn-ghost btn-sm" type="button" id="atjRefresh">↻ Refresh</button>
        </div>
      </div>
      <div class="card"><table class="table atj-log">
        <thead><tr><th>When</th><th>Client</th><th>Who</th><th>Type</th><th>Question</th><th>Answer</th></tr></thead>
        <tbody id="atjBody"><tr><td colspan="6" style="padding:18px 16px;color:var(--text-faint)">Loading chats…</td></tr></tbody>
      </table></div>
      <div class="cl-overlay" id="atjFactsOverlay" style="display:none">
        <div class="cl-card" role="dialog" aria-modal="true" style="max-width:760px">
          <div class="cl-card-head"><div class="cl-title">What Ask TJA can see · <span id="atjFactsWho"></span></div>
            <button class="cl-x" type="button" id="atjFactsX" title="Close">✕</button></div>
          <p class="cl-done-lead">This is everything the assistant is given for this client: only what they can already see in the portal. It never receives hours, rates, budgets, dollar figures, CRF data, internal items or other clients' data.</p>
          <pre id="atjFactsPre" class="atj-facts"></pre>
        </div>
      </div>`;

    host.addEventListener("click", async (e) => {
      const f = e.target.closest("[data-atjf]");
      if (f) {
        state.unanswered = f.dataset.atjf === "unanswered";
        host.querySelectorAll("[data-atjf]").forEach((c) => c.classList.toggle("active", c === f));
        return load();
      }
      if (e.target.closest("#atjRefresh")) return load();
      if (e.target.closest("#atjSave")) return saveCfg();
      if (e.target.closest("#atjFacts")) return showFacts();
      if (e.target.closest("#atjFactsX") || e.target.id === "atjFactsOverlay") { $("atjFactsOverlay").style.display = "none"; return; }
      const row = e.target.closest("tr[data-i]");
      if (row) row.classList.toggle("is-open");
    });
    $("atjClient").addEventListener("change", (e) => { state.client = e.target.value; load(); });
  }

  function paintCfg(c) {
    if (!c) return;
    state.cfg = c;
    $("atjEnabled").checked = !!c.enabled;
    $("atjLimit").value = c.dailyLimit || 0;
    $("atjName").value = c.name || "Ask TJA";
    $("atjKey").innerHTML = c.aiReady
      ? `<strong style="color:var(--good)">Connected.</strong> Typed questions are answered by Claude.`
      : `<strong style="color:var(--warn)">Not connected yet.</strong> Quick answers and how-to guides work now. Typed questions switch on once the Anthropic API key is added as the Supabase secret <code>ANTHROPIC_API_KEY</code>.`;
  }

  async function saveCfg() {
    $("atjErr").textContent = "";
    const r = await call({ action: "setConfig", enabled: $("atjEnabled").checked, dailyLimit: +$("atjLimit").value || 0, name: $("atjName").value });
    if (r.error) { $("atjErr").textContent = r.error; return; }
    paintCfg(r);
    $("atjErr").innerHTML = `<span style="color:var(--good)">Saved.</span>`;
  }

  async function load() {
    const body = $("atjBody");
    body.innerHTML = `<tr><td colspan="6" style="padding:18px 16px;color:var(--text-faint)">Loading chats…</td></tr>`;
    const r = await call({ action: "logs", clientId: state.client || undefined, unansweredOnly: state.unanswered });
    if (r.error) { body.innerHTML = `<tr><td colspan="6" style="padding:18px 16px;color:var(--bad)">${esc(r.error)}</td></tr>`; return; }
    paintCfg(r);
    state.rows = r.rows || [];
    if (!state.rows.length) { body.innerHTML = `<tr><td colspan="6" style="padding:18px 16px;color:var(--text-faint)">No chats yet.</td></tr>`; return; }
    body.innerHTML = state.rows.map((x, i) => `
      <tr data-i="${i}" class="${x.unanswered ? "atj-flag" : ""}" title="Click to expand">
        <td class="atj-nowrap">${esc(when(x.created_at))}</td>
        <td>${esc(clientName(x.client_id))}</td>
        <td>${esc(x.email)}${x.preview ? ` <span class="plan-int-tag">Staff test</span>` : ""}</td>
        <td class="atj-nowrap">${esc(KIND[x.kind] || x.kind)}${x.unanswered ? ` <span class="atj-flag-tag">Couldn't answer</span>` : ""}</td>
        <td><div class="atj-cell">${esc(x.question)}</div></td>
        <td><div class="atj-cell">${esc(x.answer)}</div></td>
      </tr>`).join("");
  }

  async function showFacts() {
    const id = state.client;
    if (!id) { $("atjErr").textContent = "Pick a client in the filter first, then click What it can see."; return; }
    $("atjFactsWho").textContent = clientName(id);
    $("atjFactsPre").textContent = "Loading…";
    $("atjFactsOverlay").style.display = "";
    const r = await call({ action: "facts", clientId: id });
    $("atjFactsPre").textContent = r.error ? r.error : JSON.stringify(r.facts, null, 2);
  }

  function tabs() {
    document.querySelectorAll("[data-actab]").forEach((b) => b.addEventListener("click", () => {
      const ask = b.dataset.actab === "ask";
      document.querySelectorAll("[data-actab]").forEach((x) => x.classList.toggle("active", x === b));
      $("acLogins").style.display = ask ? "none" : "";
      $("acAsk").style.display = ask ? "" : "none";
      const add = $("tmAdd"); if (add) add.style.visibility = ask ? "hidden" : "";
      if (ask && !state.loaded) { state.loaded = true; shell(); load(); }
    }));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tabs); else tabs();
})();
