/* ============================================================
   CLIENT PR-COVERAGE SHEETS
   PR hits are maintained by the TJA team in Google Sheets — ONE
   WORKBOOK PER CLIENT (not Workamajig). This registry maps a client
   (by workspace id) to their PR workbook + tab, and parses the hits.

   Sheet layout (per the A New Leaf template):
     A = Date Secured   B = Outlet   C = Link
     D = Impressions    E = Ad Value Equivalent
   Row 1 is a title/header ("… YTD Hits: N …"); data starts below.

   To add a client: publish their PR workbook ("Anyone with the link –
   Viewer"), then add an entry below with its spreadsheet id + gid.
   ============================================================ */
window.CLIENT_PR_SHEETS = (function () {
  // keyed by workspace id (the client slug, e.g. "a-new-leaf")
  const SHEETS = {
    "a-new-leaf": { sheetId: "1EiSZUCRVuMvQcg1ybXVXFENoWcvHX7OuEQs_Qi5HEWo", gid: "1702690732" },
  };
  function forClient(id) { return SHEETS[id] || null; }
  function csvUrl(cfg) { return "https://docs.google.com/spreadsheets/d/" + cfg.sheetId + "/gviz/tq?tqx=out:csv&gid=" + cfg.gid; }

  /* PR sheets are read through the pr-sheet Edge Function, which returns the cells EXACTLY as
     typed. The browser's gviz endpoint (csvUrl) guesses column types and blanks anything that
     doesn't fit — and PR sheets keep their "PENDING COVERAGE" / "SECURED COVERAGE" labels in the
     Date column, so gviz deleted them and pending vs secured couldn't be told apart (M Culinary,
     2026-10-14). gviz stays as the fallback when the function can't be reached.
     → { text } on success, { error } when the sheet can't be read (shown to admins on the tile). */
  async function fetchPRText(cfg) {
    let serverErr = "";
    try {
      const base = window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url;
      const sess = window.SUPA && window.SUPA.client && (await window.SUPA.client.auth.getSession()).data.session;
      if (base && sess) {
        const r = await fetch(base.replace(/\/$/, "") + "/functions/v1/pr-sheet", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + sess.access_token },
          body: JSON.stringify({ url: "https://docs.google.com/spreadsheets/d/" + cfg.sheetId + "/edit#gid=" + cfg.gid }),
        });
        const j = await r.json().catch(() => ({}));
        if (j && j.ok && typeof j.csv === "string") return { text: j.csv };
        serverErr = (j && j.error) || ("HTTP " + r.status);
      }
    } catch (e) { serverErr = String(e && e.message || e); }
    // fallback: the browser's gviz read (works for public sheets; may miss section labels)
    try {
      const r = await fetch(csvUrl(cfg), { cache: "no-store" });
      const t = r.ok ? await r.text() : "";
      if (t && !/^\s*<(!doctype|html)/i.test(t)) return { text: t, degraded: !!serverErr };
    } catch (e) {}
    return { error: serverErr || "couldn't read the PR sheet — check it's shared \"Anyone with the link → Viewer\"" };
  }

  // Admin/AM-PM paste a normal "Share" URL (…/d/<id>/edit#gid=123, or with ?gid=123,
  // or just the bare id) — pull {sheetId, gid} out of whatever they pasted.
  function parseSheetUrl(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    const idMatch = /\/d\/([a-zA-Z0-9-_]{20,})/.exec(s) || /^([a-zA-Z0-9-_]{20,})$/.exec(s);
    if (!idMatch) return null;
    const gidMatch = /[#?&]gid=(\d+)/.exec(s);
    return { sheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : "0" };
  }

  // raw quote-aware CSV → array of row-arrays (no header coercion; we use fixed columns)
  function parseRows(text) {
    const rows = []; let row = [], field = "", i = 0, q = false; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (c === "\r") {} else field += c; }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const dateKey = (d) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(d || ""); if (!m) return 0; const y = m[3].length === 2 ? +("20" + m[3]) : +m[3]; return y * 10000 + (+m[1]) * 100 + (+m[2]); };

  // → [{date, outlet, link, impressions, adValue, source:"sheet"}], newest first
  /* SECTION-AWARE: a row that says "pending" (and carries no link) STARTS a pending section; a
     row that says "secured" (no link) starts a secured one. Pending rows are anticipated /
     not-yet-launched coverage and must never show as PR (esp. client-facing) — but the sections
     can come in EITHER order. This used to `break` at the first "pending" label, which suited
     A New Leaf (secured first, pending at the bottom) and silently hid ALL of M Culinary's hits
     (pending at the top, secured below — 2026-10-14). */
  function sectionOf(rowText) {
    if (/https?:\/\//i.test(rowText)) return null;              // a real hit, not a label
    const t = rowText.toLowerCase();
    const p = t.search(/\bpending\b/), sc = t.search(/\bsecured\b/);
    if (p < 0 && sc < 0) return null;
    if (p > -1 && sc > -1) return p > sc ? "pending" : "secured";  // merged labels: the LAST one is in force
    return p > -1 ? "pending" : "secured";
  }
  function parseHits(text) {
    const hits = [];
    const rows = parseRows(text);
    let pending = false;
    for (const r of rows) {
      const rowText = r.join(" ");
      const sec = sectionOf(rowText);
      if (sec) { pending = sec === "pending"; continue; }
      if (pending) continue;                                      // anticipated coverage — never shown
      const date = (r[0] || "").trim(), outlet = (r[1] || "").trim(), link = (r[2] || "").trim(),
        impressions = (r[3] || "").trim(), adValue = (r[4] || "").trim();
      if (!outlet) continue;                                // skip blank / spacer rows
      if (/^outlet$/i.test(outlet)) continue;               // skip the header cell
      hits.push({ date, outlet, link, impressions, adValue, source: "sheet" });
    }
    hits.sort((a, b) => dateKey(b.date) - dateKey(a.date));
    return hits;
  }
  // "… YTD Hits: 24 …" in the title cell, else the parsed count
  function hitCount(text, fallback) { const m = /hits:\s*(\d+)/i.exec(text || ""); return m ? +m[1] : fallback; }

  /* ---- PROJECT PLAN (Gantt-style sheet) ----
     TJA's project plans are wide Gantt workbooks. We read only the LEFT block —
     columns A-H: # | TASK | WHO | DEPENDENCY | START | END | % DONE | NOTES —
     and ignore the timeline grid (columns I onward). Integer-numbered rows
     (1, 2, 4.0) with no WHO/dates are PHASE headers; decimal rows are tasks.
     A small header block above the table carries Outcome/Deliverables/Weeks/
     Start/End/Condition. Verified against the real "CEL Project Plan 2026". */
  const PLAN_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function planFmtDate(raw) {
    const s = String(raw || "").trim(); if (!s) return "";
    // Some sheets format date cells with a leading day-of-week ("Wed 6/03/26"). Strip it —
    // but ONLY when what's left is an M/D/Y date, so we never eat the month of an already-
    // formatted "Jun 3, 2026". This keeps every parse path (gviz CSV, SheetJS) canonical,
    // so the plan-refresh change-detector doesn't see phantom diffs. Idempotent.
    const stripped = s.replace(/^[A-Za-z]{3,9}\.?,?\s+/, "");
    const src = /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(stripped) ? stripped : s;
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(src);
    if (!m) return s;                                   // leave ISO / already-formatted / text as-is
    const y = m[3].length === 2 ? +("20" + m[3]) : +m[3];
    const mo = +m[1]; if (mo < 1 || mo > 12) return s;
    return PLAN_MONTHS[mo - 1] + " " + (+m[2]) + ", " + y;
  }
  function planPct(raw) {
    const s = String(raw || "").trim(); if (!s) return null;
    let v = parseFloat(s.replace("%", "")); if (isNaN(v)) return null;
    if (s.indexOf("%") >= 0) return Math.round(v);      // "75%"
    if (v <= 1) return Math.round(v * 100);             // 0.75 -> 75
    return Math.round(v);
  }
  function planStatus(notes, pct) {
    const n = String(notes || "").toLowerCase();
    if (/complet|done/.test(n)) return "complete";
    if (/progress/.test(n)) return "in-progress";
    if (/hold/.test(n)) return "on-hold";
    if (/block/.test(n)) return "blocked";
    if (pct != null) { if (pct >= 100) return "complete"; if (pct > 0) return "in-progress"; }
    return "pending";
  }
  function planAfterColon(s) { const i = String(s).indexOf(":"); return i < 0 ? "" : s.slice(i + 1).trim(); }

  // → { meta:{title,outcome,deliverables,weeks,startDate,endDate,condition:{level,pct}},
  //     groups:[{num,name,tasks:[{num,task,who,dep,start,end,pct,notes,status}]}] } | null
  /* The percentage the SHEET ITSELF states, taken verbatim — never recomputed (Cameron
     2026-07-29: "just port in the number the google sheet project plan has in it").
     Order: an explicit % on the "Project condition:" row wins (a PM setting it deliberately),
     else the "Burn to Date/Projected Burn:" figure (e.g. "30/100%" → 30). Returns null when
     the sheet states neither, and only then does the caller fall back to counting tasks. */
  function planStatedPct(plan) {
    const m = (plan && plan.meta) || {};
    if (m.condition && m.condition.pct != null) return m.condition.pct;
    if (m.burn && m.burn.pct != null) return m.burn.pct;
    return null;
  }
  /* Header labels → column indexes; -1 = column absent (reads ""). Only trusted when
     TASK/START/END are all labeled; otherwise the classic fixed positions stand.
     KEEP IN SYNC with plan.ts (planColMap) — Circle the City's sheet dropped the
     DEPENDENCY column and position-based reads shifted everything after WHO. */
  function planColMap(headerRow) {
    const seen = {};
    (headerRow || []).forEach((c, i) => {
      if (i === 0) return;
      const h = String(c == null ? "" : c).trim().toLowerCase();
      if (!h) return;
      const put = (k) => { if (seen[k] == null) seen[k] = i; };
      if (/^task/.test(h)) put("task");
      else if (/^(who|owner)/.test(h)) put("who");
      else if (/^dep/.test(h)) put("dep");
      else if (/^start/.test(h)) put("start");
      else if (/^end/.test(h)) put("end");
      else if (/%|percent|\bdone\b/.test(h)) put("pct");
      else if (/^status/.test(h)) put("status");
      else if (/^note/.test(h)) put("notes");
    });
    if (seen.task != null && seen.start != null && seen.end != null) {
      return { task: seen.task, who: seen.who != null ? seen.who : -1, dep: seen.dep != null ? seen.dep : -1,
        start: seen.start, end: seen.end, pct: seen.pct != null ? seen.pct : -1,
        status: seen.status != null ? seen.status : -1, notes: seen.notes != null ? seen.notes : -1 };
    }
    return { task: 1, who: 2, dep: 3, start: 4, end: 5, pct: 6, status: -1, notes: 7 };
  }

  function parseProjectPlan(text) {
    const rows = parseRows(text);
    const meta = { title: "", outcome: "", deliverables: "", weeks: "", startDate: "", endDate: "",
      condition: { level: "green", pct: null }, burn: { raw: "", pct: null } };
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const a = (rows[i][0] || "").trim(), c = (rows[i][2] || "").trim();
      if (a === "#" && /^task$/i.test((rows[i][1] || "").trim())) { headerIdx = i; break; }
      if (i === 0 && a && !/^(outcome|deliverables|weeks):/i.test(a)) meta.title = a;
      if (/^outcome:/i.test(a)) meta.outcome = planAfterColon(a) || c;
      else if (/^deliverables:/i.test(a)) meta.deliverables = planAfterColon(a) || c;
      else if (/^weeks:/i.test(a)) meta.weeks = c || planAfterColon(a);
      else if (/^project start date:/i.test(a)) meta.startDate = planFmtDate(c || planAfterColon(a));
      else if (/^project end date:/i.test(a)) meta.endDate = planFmtDate(c || planAfterColon(a));
      else if (/^project condition:/i.test(a)) {
        const lvl = planAfterColon(a).toLowerCase();
        meta.condition.level = /red/.test(lvl) ? "red" : (/(amber|yellow)/.test(lvl) ? "amber" : "green");
        meta.condition.pct = planPct(c);
      }
      // "Burn to Date/Projected Burn:  30/100%" — the plan's own headline number. Take the
      // figure before the slash, as written. KEEP IN SYNC with plan.ts.
      else if (/^burn to date/i.test(a)) {
        const raw = c || planAfterColon(a);
        meta.burn.raw = raw;
        meta.burn.pct = planPct(String(raw).split("/")[0]);
      }
    }
    if (headerIdx < 0) return null;
    const col = planColMap(rows[headerIdx]);
    const at = (r, i) => (i < 0 ? "" : String(r[i] == null ? "" : r[i]).trim());
    const groups = []; let cur = null;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const num = (r[0] || "").trim(), task = at(r, col.task), who = at(r, col.who),
        dep = at(r, col.dep), start = at(r, col.start), end = at(r, col.end),
        pctRaw = at(r, col.pct), statusRaw = at(r, col.status), notes = at(r, col.notes);
      if (!num && !task) continue;                       // blank / spacer
      if (/^\s*call name\b/i.test(task) || /\(link to .+ when complete\)/i.test(task)) continue;   // template placeholder stub — never shown (KEEP IN SYNC with plan.ts)
      // A PHASE header is an integer-numbered row (1, 2, "4.0") with no owner/dates/%.
      // The numbering check matters: an early-project task like "3.2 | Draft copy" with
      // WHO/dates still TBD must stay a TASK, not fragment the plan into bogus sections.
      const emptyMeta = !who && !start && !end && !pctRaw;
      const numVal = parseFloat(num);
      const isGroup = emptyMeta && (!num || isNaN(numVal) || Number.isInteger(numVal));
      if (isGroup) { cur = { num, name: task, tasks: [] }; groups.push(cur); continue; }
      if (!cur) { cur = { num: "", name: "Tasks", tasks: [] }; groups.push(cur); }
      const pct = planPct(pctRaw);
      cur.tasks.push({ num, task, who, dep, start: planFmtDate(start), end: planFmtDate(end), pct, notes, status: planStatus(statusRaw || notes, pct) });
    }
    if (!groups.length) return null;
    return { meta, groups };
  }

  return { SHEETS, forClient, csvUrl, fetchPRText, parseSheetUrl, parseRows, parseHits, hitCount, parseProjectPlan, planStatedPct };
})();
