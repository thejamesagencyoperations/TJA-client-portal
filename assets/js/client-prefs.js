/* ============================================================
   CLIENT PREFERENCES — one panel for how a client is notified (Cameron 2026-10-21).
   Opened from the Executive Summary ("⚙ Client Preferences", next to Customize) by admins
   and the client's own AM/PM. Reads/writes through the `client-prefs` Edge Function, which
   checks who's asking and changes only these preference fields on the registry (the
   registry is admin-write in RLS, so AM/PMs can't save it from the browser directly).
   Every switch saves on the spot. Same fields Admin Center → Preferences and Clients → ✎
   edit, so all three stay in agreement.
   ============================================================ */
window.CLIENT_PREFS = (function () {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  async function call(action, extra) {
    const cfg = window.SUPABASE_CONFIG || {};
    const base = cfg.url ? cfg.url.replace(/\/$/, "") + "/functions/v1" : "";
    if (!base || !(window.SUPA && window.SUPA.enabled && window.SUPA.client)) return { ok: false, error: "The portal backend isn't available." };
    const { data } = await window.SUPA.client.auth.getSession();
    const token = data && data.session ? data.session.access_token : null;
    if (!token) return { ok: false, error: "Please sign in again." };
    try {
      const r = await fetch(base + "/client-prefs", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(Object.assign({ action, clientId: clientId() }, extra || {})),
      });
      const j = await r.json().catch(() => ({}));
      return Object.assign({ ok: r.ok && j.ok !== false }, j);
    } catch (e) { return { ok: false, error: "Couldn't reach the portal backend." }; }
  }

  const sw = (attr, on, label, desc) => `
    <label class="cp-row"><span class="cp-txt"><b>${esc(label)}</b>${desc ? `<span>${esc(desc)}</span>` : ""}</span>
      <span class="tm-switch"><input type="checkbox" ${attr} ${on ? "checked" : ""}><span class="tm-slider-ui"></span></span></label>`;   // the whole row is the <label>

  async function open() {
    const old = document.getElementById("cpPop"); if (old) old.remove();
    const ov = document.createElement("div");
    ov.id = "cpPop"; ov.className = "burn-pop-overlay";
    const name = ((typeof STATE !== "undefined") && STATE.client && STATE.client.name) || (window.CLIENT_DATA && CLIENT_DATA.client && CLIENT_DATA.client.name) || "this client";
    ov.innerHTML = `<div class="burn-pop burn-pop--wide cp-pop" role="dialog" aria-modal="true" aria-label="Client preferences">
      <div class="bp-head">Client Preferences <span class="cp-who">${esc(name)}</span></div>
      <div class="cp-body"><div class="pr-date">Loading…</div></div>
      <div class="bp-actions"><span class="cp-status" aria-live="polite"></span><button type="button" class="btn btn-primary" data-cpdone>Done</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.querySelector("[data-cpdone]").addEventListener("click", close);
    window.TJA_UI.backdropClose(ov, close);
    const status = (t, bad) => { const el = ov.querySelector(".cp-status"); el.textContent = t; el.classList.toggle("bad", !!bad); };

    const r = await call("get");
    if (!r.ok) { ov.querySelector(".cp-body").innerHTML = `<div class="cp-err">${esc(r.error || "Couldn't load preferences.")}</div>`; return; }
    let p = r.prefs; const logins = r.logins || [];
    const has = (list, e) => (p[list] || []).map((x) => String(x).toLowerCase()).includes(String(e).toLowerCase());

    const paint = () => {
      ov.querySelector(".cp-body").innerHTML = `
        <div class="cz-sub">Present Docs</div>
        ${sw('data-cpbool="deliverableEmails"', p.deliverableEmails, "Deliverable emails", "Email the client when a deliverable is sent and when reviews come in.")}
        <label class="cp-row cp-field"><span class="cp-txt"><b>Slack channel</b><span>Where send + review posts go (invite the portal bot to it).</span></span>
          <input type="text" class="cp-in" data-cptext="slackChannel" value="${esc(p.slackChannel)}" placeholder="client-name"></label>
        <label class="cp-row cp-field"><span class="cp-txt"><b>Extra email recipients</b><span>Comma-separated; everyone with a login gets emails already.</span></span>
          <input type="text" class="cp-in" data-cptext="emailRecipients" value="${esc((p.emailRecipients || []).join(", "))}" placeholder="name@client.com"></label>

        <div class="cz-sub">Deadline reminders</div>
        ${sw('data-cpbool="todoReminders"', p.todoReminders, "Day-before reminders", "8am Arizona the day before a CLIENT-owned to-do or project-plan item is due (Friday covers the weekend + Monday). One digest per person; nothing due = no email. Only the people switched on below get it.")}

        <div class="cz-sub">People <span class="cz-sub-note">per client login</span></div>
        ${logins.length ? `<div class="cp-people">
          <div class="cp-ph"><span></span><span>Deliverable emails</span><span>Required approver</span><span>Deadline reminders</span></div>
          ${logins.map((l) => `<div class="cp-person">
            <span class="cp-pname"><b>${esc(l.name || l.email)}</b>${l.name ? `<span>${esc(l.email)}</span>` : ""}</span>
            <span><label class="tm-switch"><input type="checkbox" data-cpperson="notifyOff" data-email="${esc(l.email)}" ${has("notifyOff", l.email) ? "" : "checked"} title="Deliverable emails"><span class="tm-slider-ui"></span></label></span>
            <span><label class="tm-switch"><input type="checkbox" data-cpperson="approvalOff" data-email="${esc(l.email)}" ${has("approvalOff", l.email) ? "" : "checked"} title="Required approver"><span class="tm-slider-ui"></span></label></span>
            <span><label class="tm-switch"><input type="checkbox" data-cpperson="todoRemindOn" data-email="${esc(l.email)}" ${has("todoRemindOn", l.email) ? "checked" : ""} title="Deadline reminders"><span class="tm-slider-ui"></span></label></span>
          </div>`).join("")}</div>` : `<div class="pr-date">No client logins yet — invite one from Admin Center.</div>`}

        <div class="cz-sub">Account</div>
        ${sw('data-cpbool="signupEmails"', p.signupEmails, "Signup / invite emails", "Email new client logins their signup link (off = you get a link to send yourself).")}`;
    };
    paint();

    async function save(patch, revert) {
      status("Saving…");
      const s = await call("set", { patch });
      if (!s.ok) { status(s.error || "Couldn't save.", true); if (revert) revert(); return; }
      p = s.prefs; status(s.roundsUpdated ? `Saved ✓ — also applied to ${s.roundsUpdated} round${s.roundsUpdated === 1 ? "" : "s"} out for review` : "Saved ✓");
    }
    ov.addEventListener("change", (ev) => {
      const b = ev.target.closest("[data-cpbool]");
      if (b) { const k = b.dataset.cpbool, was = !b.checked; save({ [k]: b.checked }, () => { b.checked = was; }); return; }
      const t = ev.target.closest("[data-cptext]");
      if (t) { save({ [t.dataset.cptext]: t.dataset.cptext === "emailRecipients" ? t.value.split(",").map((x) => x.trim()).filter(Boolean) : t.value }); return; }
      const pp = ev.target.closest("[data-cpperson]");
      if (pp) {
        const list = pp.dataset.cpperson, email = pp.dataset.email.toLowerCase();
        const cur = new Set((p[list] || []).map((x) => String(x).toLowerCase()));
        // notifyOff / approvalOff are "off" lists (switch ON = not listed); todoRemindOn is an "on" list
        const listed = list === "todoRemindOn" ? pp.checked : !pp.checked;
        if (listed) cur.add(email); else cur.delete(email);
        const was = !pp.checked;
        save({ [list]: [...cur] }, () => { pp.checked = was; });
      }
    });
  }
  return { open };
})();
