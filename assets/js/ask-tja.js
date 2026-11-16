/* ============================================================
   ASK TJA — the client chat assistant (front end). Server: supabase/functions/ask-tja.

   • A floating TJA-orange bubble (bottom-right; above the tab bar on phones) opens a chat panel
     that slides in from the right (full-screen on phones).
   • Shown only when the server says so: the Admin Center switch is ON (clients), or the viewer
     is staff ("Staff preview" badge while it's off). Nothing here decides access — the function
     re-checks every call and builds the assistant's data on the server.
   • Quick answers ("What's waiting on me?", "What's next?") come from portal data with no AI.
     "How do I…?" guides are static text in this file. Typed questions go to Claude once the
     ANTHROPIC_API_KEY secret exists; until then the panel says so and offers the quick answers.
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
  const ICON = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M12 3C6.9 3 3 6.5 3 10.8c0 2.4 1.2 4.5 3.2 5.9L5.6 20.4c-.1.5.4.9.9.6l4-2.3c.5.1 1 .1 1.5.1 5.1 0 9-3.5 9-7.9S17.1 3 12 3Z"/></svg>`;
  const AVATAR = `<span class="atj-avatar" aria-hidden="true">tja</span>`;
  let root, panel, list, input, sendBtn;

  function build() {
    root = document.createElement("div");
    root.className = "atj";
    root.innerHTML = `
      <button class="atj-bubble" type="button" aria-label="Open ${esc(cfg.name)}" aria-expanded="false">${ICON}${cfg.staffPreview ? `<span class="atj-badge">Staff preview</span>` : ""}</button>
      <section class="atj-panel" role="dialog" aria-label="${esc(cfg.name)}" aria-hidden="true">
        <header class="atj-head">
          ${AVATAR}
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

    root.querySelector(".atj-bubble").addEventListener("click", () => toggle(!open));
    root.addEventListener("click", onClick);
    root.querySelector(".atj-form").addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(input.value); } });
    input.addEventListener("input", grow);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) toggle(false); });
    render();
  }
  function grow() { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; }

  function toggle(on) {
    open = on;
    root.classList.toggle("is-open", on);
    panel.setAttribute("aria-hidden", on ? "false" : "true");
    root.querySelector(".atj-bubble").setAttribute("aria-expanded", on ? "true" : "false");
    document.documentElement.classList.toggle("atj-locked", on);   // phones: stop the page scrolling behind
    if (on) { render(); setTimeout(() => input.focus({ preventScroll: true }), 60); }
  }

  function welcome() {
    return `Hi! I'm ${cfg.name}. I can tell you what's waiting on you, what's coming up next, and how to do things in the portal.` +
      (cfg.aiReady ? " Ask me anything about your account." : "");
  }

  function render() {
    const rows = [{ role: "assistant", content: welcome(), local: true }, ...msgs];
    list.innerHTML = rows.map((m, i) => {
      if (m.role === "user") return `<div class="atj-msg atj-user"><div class="atj-bub">${esc(m.content).replace(/\n/g, "<br>")}</div></div>`;
      const handoff = m.handoff ? `<button class="atj-hand" type="button" data-atj="handoff" data-i="${i - 1}">Send this to my account manager</button>` : "";
      return `<div class="atj-msg atj-bot">${AVATAR}<div class="atj-bub">${fmt(m.content)}${handoff}</div></div>`;
    }).join("") + (busy ? `<div class="atj-msg atj-bot">${AVATAR}<div class="atj-bub atj-typing"><i></i><i></i><i></i></div></div>` : "");
    chips();
    list.scrollTop = list.scrollHeight;
    input.disabled = busy || !cfg.aiReady; sendBtn.disabled = busy || !cfg.aiReady;
    input.placeholder = cfg.aiReady ? "Ask a question…" : "Typed questions are coming soon. Try the buttons above.";
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
    if (!text || busy || !cfg.aiReady) return;
    input.value = ""; grow();
    const history = msgs.filter((m) => !m.local).slice(-12).map((m) => ({ role: m.role, content: m.content }));
    push({ role: "user", content: text });
    busy = true; render();
    const r = await call({ action: "ask", question: text, history });
    busy = false;
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
