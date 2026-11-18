/* ============================================================
   ASK TJA — the client chat assistant (front end). Server: supabase/functions/ask-tja.

   • A floating TJA-orange bubble (bottom-right; above the tab bar on phones) opens a chat panel
     that slides in from the right (full-screen on phones).
   • Shown only when the server says so: the Admin Center switch is ON (clients), or the viewer
     is staff ("Staff preview" badge while it's off). Nothing here decides access — the function
     re-checks every call and builds the assistant's data on the server.
   • Quick answers ("What's waiting on me?", "What's next?") come from portal data with no AI.
     "How do I…?" guides are static text in this file. Typed questions follow the server's
     typedMode: "am" (default, until the AI is switched on) sends the message to the client's
     Slack channel for their account manager; "ai" answers with Claude.
   • "Send to my account manager" posts the question to the client's Slack channel.
   ============================================================ */
(function () {
  const sess = (typeof getSession === "function" && getSession()) || null;
  if (!sess || !sess.client || !window.SUPA || !window.SUPA.enabled) return;

  const fnBase = () => { const c = window.SUPABASE_CONFIG || {}; return c.url ? c.url.replace(/\/$/, "") + "/functions/v1" : ""; };
  async function token() { try { const { data } = await window.SUPA.client.auth.getSession(); return data && data.session ? data.session.access_token : null; } catch (e) { return null; } }
  async function call(body, timeoutMs) {
    const t = await token(); if (!t || !fnBase()) return { error: "Not signed in" };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs || 45000);
    try {
      const r = await fetch(fnBase() + "/ask-tja", {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + t },
        body: JSON.stringify({ clientId: sess.client, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || ("Error " + r.status) };
    } catch (e) { return { error: "The connection dropped. Please try again." }; }
    finally { clearTimeout(timer); }
  }

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // tiny, safe formatter: escape first, then **bold**, bullet lines, and plain https links
  function fmt(text) {
    const lines = esc(text).split("\n");
    let html = "", inList = false;
    for (const raw of lines) {
      let l = raw.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/(https:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
      const m = /^\s*[-•*]\s+(.*)$/.exec(l);
      if (m) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + m[1] + "</li>"; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += l.trim() ? "<p>" + l + "</p>" : "";
    }
    return html + (inList ? "</ul>" : "");
  }

  /* ---------- "How do I…?" — static, no AI ---------- */
  const HOWTO = [
    ["Review and approve a deliverable", "Open **Present Docs** and click the deliverable.\n- Use **✎ Draw** to circle or highlight areas, or **💬 Comment** and click on the proof to pin a comment.\n- Choose a status: **Approve**, **Approve with changes** or **Revisions needed**.\n- Add any **Client Notes**, then click **Submit Review**.\nThe TJA team is notified as soon as you submit. Each person on your team reviews separately."],
    ["Leave a comment on a proof", "In **Present Docs**, open the deliverable and pick **💬 Comment**. Click the spot on the proof you want to comment on and type your note. On a video, the comment is pinned to the moment that's playing. Comments are saved with your review when you click **Submit Review**."],
    ["Sign to approve", "Some deliverables ask you to **Sign to approve**. Open it in **Present Docs**, then type your name or switch to **✎ Draw** to draw your signature, and submit your review."],
    ["Approve my SAP", "Open the **SAP** tab under Monthly Services. Review how your monthly hours are allocated, then click **Approve** when TJA has asked for your sign-off."],
    ["Request a creative asset", "Open **Media Creative Asset Request**, fill in the details for each asset (you can attach files), then click **Submit request**. The team is notified straight away."],
    ["Find a file or report", "Shared files and folders are under **Files**. Reports and dashboards are under **Reporting**."],
    ["Switch between Monthly Services and Projects", "Use the **Monthly Services / Projects** switch at the top of the page. If you have several projects, choose one from the Projects view."],
    ["Reset my password", "Sign out, then click **Forgot password** on the sign-in page. You'll get an email with a link to set a new one."],
  ];

  /* ---------- state ---------- */
  const KEY = "tja_asktja_" + sess.client;
  let cfg = null, open = false, busy = false;
  let msgs = [];   // {role:'user'|'assistant', content, handoff?, local?}
  try { msgs = JSON.parse(sessionStorage.getItem(KEY) || "[]") || []; } catch (e) { msgs = []; }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(msgs.slice(-40))); } catch (e) { /* private mode */ } };

  /* ---------- DOM ---------- */
  /* Timmy's face — a little TJA-orange character (inline SVG, no image file). Gradient ids are
     unique per copy so several faces on the page never share one definition. */
  let faceSeq = 0;
  function face(size) {
    const id = "atjg" + (++faceSeq);
    return `<svg class="atj-face" viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
      <defs><radialGradient id="${id}" cx="38%" cy="32%" r="75%"><stop offset="0" stop-color="#FFC266"/><stop offset=".55" stop-color="#F68E21"/><stop offset="1" stop-color="#DA662A"/></radialGradient></defs>
      <path d="M33 9c1-4 4-6 8-6-1 4-4 6-8 6z" fill="#4CAF50"/><path d="M32 12V7" stroke="#7a4a1c" stroke-width="2.4" stroke-linecap="round"/>
      <circle cx="32" cy="36" r="25" fill="url(#${id})"/>
      <ellipse cx="24" cy="25" rx="7" ry="4" fill="#fff" opacity=".28"/>
      <ellipse cx="23.5" cy="35" rx="3.6" ry="4.6" fill="#2b1a0e"/><ellipse cx="40.5" cy="35" rx="3.6" ry="4.6" fill="#2b1a0e"/>
      <circle cx="24.8" cy="33.2" r="1.4" fill="#fff"/><circle cx="41.8" cy="33.2" r="1.4" fill="#fff"/>
      <ellipse cx="16.5" cy="43" rx="4" ry="2.6" fill="#ff5f6d" opacity=".45"/><ellipse cx="47.5" cy="43" rx="4" ry="2.6" fill="#ff5f6d" opacity=".45"/>
      <path d="M26 44.5c3.4 3.6 8.6 3.6 12 0" fill="none" stroke="#2b1a0e" stroke-width="2.6" stroke-linecap="round"/>
    </svg>`;
  }
  const ICON = () => face(30);
  const AVATAR_HTML = () => `<span class="atj-avatar" aria-hidden="true">${face(30)}</span>`;
  let root, panel, list, input, sendBtn;

  function build() {
    root = document.createElement("div");
    root.className = "atj";
    root.innerHTML = `
      <button class="atj-bubble" type="button" aria-label="${esc(label())} (drag to move it up or down)" title="Drag to move up or down" aria-expanded="false">${ICON()}<span class="atj-label">${esc(label())}</span>${cfg.staffPreview ? `<span class="atj-badge">Staff preview</span>` : ""}</button>
      <button class="atj-min" type="button" aria-pressed="false"></button>
      <section class="atj-panel" role="dialog" aria-label="${esc(cfg.name)}" aria-hidden="true">
        <header class="atj-head">
          ${AVATAR_HTML()}
          <div class="atj-title"><b>${esc(cfg.name)}</b><span>${cfg.staffPreview ? "Preview · hidden from clients" : "Answers from your portal"}</span></div>
          <button class="atj-icon" type="button" data-atj="clear" title="Start a new chat" aria-label="Start a new chat">↺</button>
          <button class="atj-icon" type="button" data-atj="close" title="Close" aria-label="Close">✕</button>
        </header>
        <div class="atj-list" aria-live="polite"></div>
        <div class="atj-chips"></div>
        <form class="atj-form">
          <textarea rows="1" maxlength="1500" placeholder="Ask a question…" aria-label="Your question"></textarea>
          <button type="submit" class="atj-send" aria-label="Send">➤</button>
        </form>
        <div class="atj-foot">Chats are saved to help the TJA team improve answers.</div>
      </section>`;
    document.body.appendChild(root);
    panel = root.querySelector(".atj-panel");
    list = root.querySelector(".atj-list");
    input = root.querySelector("textarea");
    sendBtn = root.querySelector(".atj-send");

    bubble = root.querySelector(".atj-bubble");
    bubble.addEventListener("click", () => { if (dragMoved) { dragMoved = false; return; } toggle(!open); });
    initDrag();
    initMin();
    root.addEventListener("click", onClick);
    root.querySelector(".atj-form").addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
    input.addEventListener("input", grow);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) toggle(false); });
    render();
  }
  /* ---------- the button slides up and down the right edge (position remembered per viewer) ---------- */
  const POS_KEY = "tja_asktja_y";
  let bubble, btnY = null, drag = null, dragMoved = false;
  const isPhone = () => window.innerWidth <= 760;
  function yBounds() {
    const h = bubble.offsetHeight || 48;
    const top = 72;                                          // clear of the top bar
    const bottom = window.innerHeight - h - (isPhone() ? 88 : 20);   // phones: clear of the tab bar
    return [top, Math.max(top, bottom)];
  }
  function place(y) {
    const [lo, hi] = yBounds();
    btnY = Math.min(hi, Math.max(lo, y));
    root.style.setProperty("--atj-y", btnY + "px");
    placePanel();
  }
  // desktop: open the panel above the button when there's room, otherwise below it
  function placePanel() {
    if (isPhone() || btnY == null) return;
    const vh = window.innerHeight, gap = 12, margin = 16, want = Math.min(620, vh - 2 * margin);
    const bh = bubble.offsetHeight || 48;
    const above = btnY - gap - margin, below = vh - (btnY + bh) - gap - margin;
    let top, h;
    if (above >= want) { h = want; top = btnY - gap - h; }
    else if (below >= want) { h = want; top = btnY + bh + gap; }
    else if (above >= below) { h = Math.max(320, above); top = Math.max(margin, btnY - gap - h); }
    else { h = Math.max(320, below); top = btnY + bh + gap; }
    if (top + h > vh - margin) h = Math.max(260, vh - margin - top);
    root.style.setProperty("--atj-ptop", Math.round(top) + "px");
    root.style.setProperty("--atj-ph", Math.round(h) + "px");
  }
  function initDrag() {
    let saved = null;
    try { saved = parseFloat(localStorage.getItem(POS_KEY)); } catch (e) { /* storage blocked */ }
    place(Number.isFinite(saved) ? saved * window.innerHeight : Infinity);   // default: bottom-right
    bubble.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { y0: e.clientY, top0: btnY, id: e.pointerId };
      dragMoved = false;
    });
    bubble.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = e.clientY - drag.y0;
      if (!dragMoved && Math.abs(dy) < 5) return;            // a tap, not a drag
      if (!dragMoved) { dragMoved = true; root.classList.add("is-dragging"); try { bubble.setPointerCapture(e.pointerId); } catch (_) {} }
      e.preventDefault();
      place(drag.top0 + dy);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      root.classList.remove("is-dragging");
      if (dragMoved) { try { localStorage.setItem(POS_KEY, String(btnY / window.innerHeight)); } catch (e) { /* fine */ } }
    };
    bubble.addEventListener("pointerup", end);
    bubble.addEventListener("pointercancel", end);
    // keyboard: arrow keys nudge it when focused
    bubble.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      place(btnY + (e.key === "ArrowUp" ? -24 : 24));
      try { localStorage.setItem(POS_KEY, String(btnY / window.innerHeight)); } catch (_) {}
    });
    window.addEventListener("resize", () => place(btnY));
  }
  /* ---------- minimize: shrink Timmy to just his face (remembered per viewer) ---------- */
  const MIN_KEY = "tja_asktja_min";
  function setMin(on) {
    root.classList.toggle("is-min", on);
    const b = root.querySelector(".atj-min");
    b.textContent = on ? "+" : "–";
    b.title = on ? "Show " + label() : "Make " + cfg.name + " smaller";
    b.setAttribute("aria-label", b.title);
    b.setAttribute("aria-pressed", on ? "true" : "false");
    try { localStorage.setItem(MIN_KEY, on ? "1" : "0"); } catch (e) { /* fine */ }
    place(btnY);
  }
  function initMin() {
    let on = false;
    try { on = localStorage.getItem(MIN_KEY) === "1"; } catch (e) { /* storage blocked */ }
    root.querySelector(".atj-min").addEventListener("click", (e) => { e.stopPropagation(); setMin(!root.classList.contains("is-min")); });
    setMin(on);
  }
  const label = () => (/^ask\b/i.test(cfg.name) ? cfg.name : "Ask " + cfg.name);

  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }

  function toggle(on) {
    open = on;
    root.classList.toggle("is-open", on);
    panel.setAttribute("aria-hidden", on ? "false" : "true");
    root.querySelector(".atj-bubble").setAttribute("aria-expanded", on ? "true" : "false");
    document.documentElement.classList.toggle("atj-locked", on);   // phones: stop the page scrolling behind
    if (on) { placePanel(); render(); setTimeout(() => input.focus({ preventScroll: true }), 60); }
  }

  const amMode = () => cfg.typedMode !== "ai";
  function welcome() {
    return `Hi! I'm ${cfg.name}. I can tell you what's waiting on you, what's coming up next, and how to do things in the portal.` +
      (amMode() ? " Or type a message below and I'll send it straight to your account manager." : " Ask me anything about your account.");
  }

  function render() {
    const rows = [{ role: "assistant", content: welcome(), local: true }, ...msgs];
    list.innerHTML = rows.map((m, i) => {
      if (m.role === "user") return `<div class="atj-msg atj-user"><div class="atj-bub">${esc(m.content).replace(/\n/g, "<br>")}</div></div>`;
      const handoff = m.handoff ? `<button class="atj-hand" type="button" data-atj="handoff" data-i="${i - 1}">Send this to my account manager</button>` : "";
      return `<div class="atj-msg atj-bot">${AVATAR_HTML()}<div class="atj-bub">${fmt(m.content)}${handoff}</div></div>`;
    }).join("") + (busy ? `<div class="atj-msg atj-bot">${AVATAR_HTML()}<div class="atj-bub atj-typing"><i></i><i></i><i></i></div></div>` : "");
    chips();
    list.scrollTop = list.scrollHeight;
    input.disabled = busy; sendBtn.disabled = busy;
    input.placeholder = amMode() ? "Message your account manager…" : "Ask a question…";
  }

  let chipMode = "main";
  function chips() {
    const box = root.querySelector(".atj-chips");
    if (chipMode === "howto") {
      box.innerHTML = `<button class="atj-chip atj-chip--back" type="button" data-atj="back">← Back</button>` +
        HOWTO.map((h, i) => `<button class="atj-chip" type="button" data-atj="howto" data-i="${i}">${esc(h[0])}</button>`).join("");
    } else {
      box.innerHTML = `<button class="atj-chip" type="button" data-atj="quick" data-kind="waiting">What's waiting on me?</button>
        <button class="atj-chip" type="button" data-atj="quick" data-kind="next">What's next?</button>
        <button class="atj-chip" type="button" data-atj="howtos">How do I…?</button>`;
    }
    box.querySelectorAll("button").forEach((b) => { b.disabled = busy && b.dataset.atj !== "back"; });
  }

  function push(m) { msgs.push(m); save(); render(); }

  async function onClick(e) {
    const b = e.target.closest("[data-atj]"); if (!b || busy && !["close", "back", "howtos"].includes(b.dataset.atj)) return;
    const a = b.dataset.atj;
    if (a === "close") return toggle(false);
    if (a === "clear") { msgs = []; save(); chipMode = "main"; return render(); }
    if (a === "howtos") { chipMode = "howto"; return chips(); }
    if (a === "back") { chipMode = "main"; return chips(); }
    if (a === "howto") {
      const h = HOWTO[+b.dataset.i]; if (!h) return;
      chipMode = "main";
      push({ role: "user", content: "How do I " + h[0].charAt(0).toLowerCase() + h[0].slice(1) + "?", local: true });
      return push({ role: "assistant", content: h[1], local: true });
    }
    if (a === "quick") {
      const kind = b.dataset.kind;
      push({ role: "user", content: kind === "next" ? "What's next?" : "What's waiting on me?", local: true });
      busy = true; render();
      const r = await call({ action: "quick", kind });
      busy = false;
      return push({ role: "assistant", content: r.answer || ("Sorry, I couldn't load that. " + (r.error || "")), local: true });
    }
    if (a === "handoff") return handoff(+b.dataset.i);
  }

  async function ask(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    input.value = ""; grow();
    const history = msgs.filter((m) => !m.local).slice(-12).map((m) => ({ role: m.role, content: m.content }));
    push({ role: "user", content: text });
    busy = true; render();
    const r = await call({ action: "ask", question: text, history });
    busy = false;
    if (amMode() || r.sent) {
      return push({ role: "assistant", local: true, content: r.sent
        ? "Sent! Your account manager has your message and will get back to you directly."
        : (r.error || "Sorry, I couldn't reach the team. Please email your account manager.") });
    }
    if (r.noKey) { cfg.aiReady = false; return push({ role: "assistant", content: "Typed questions aren't switched on yet. The buttons below work now, or I can pass your question to your account manager.", handoff: true, local: true }); }
    if (r.limited) return push({ role: "assistant", content: `You've reached today's limit of ${r.dailyLimit} typed questions. The buttons below still work, or I can pass this to your account manager.`, handoff: true, local: true });
    if (r.failed || r.error || !r.answer) return push({ role: "assistant", content: "Sorry, something went wrong on my side. Please try again, or I can pass this to your account manager.", handoff: true, local: true });
    push({ role: "assistant", content: r.answer, handoff: !!r.unanswered });
  }

  async function handoff(i) {
    // the question = the user message right before this answer
    let q = "";
    for (let k = Math.min(i, msgs.length - 1); k >= 0; k--) if (msgs[k].role === "user") { q = msgs[k].content; break; }
    if (!q) return;
    if (msgs[i]) msgs[i].handoff = false;
    busy = true; render();
    const transcript = msgs.slice(Math.max(0, i - 5), i + 1).map((m) => ({ role: m.role, content: m.content }));
    const r = await call({ action: "handoff", question: q, transcript });
    busy = false;
    push({ role: "assistant", content: r.ok ? "Done. I've sent your question to the TJA team, and your account manager will follow up with you directly." : (r.error || "Sorry, I couldn't reach the team. Please email your account manager."), local: true });
  }

  /* ---------- boot: ask the server whether to show the bubble ---------- */
  async function boot() {
    const r = await call({ action: "config" }, 10000);
    if (!r || !r.ok || !r.enabled) return;
    cfg = r;
    build();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 800));
  else setTimeout(boot, 800);
})();
