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
  function parseHits(text) {
    const hits = [];
    const rows = parseRows(text);
    for (const r of rows) {
      // A "Pending Media Coverage" (or any "Pending …") DIVIDER row marks the start of
      // anticipated / not-yet-launched coverage. Everything below it is NOT a real hit and
      // must never show as secured PR (esp. client-facing). We detect the divider as a row
      // that says "pending" but carries NO link (a section label, not an article), then stop.
      // No manual management: keep the pending rows under that divider and they're auto-hidden.
      const rowText = r.join(" ");
      if (/\bpending\b/i.test(rowText) && !/https?:\/\//i.test(rowText)) break;
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
  function parseProjectPlan(text) {
    const rows = parseRows(text);
    const meta = { title: "", outcome: "", deliverables: "", weeks: "", startDate: "", endDate: "", condition: { level: "green", pct: null } };
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
    }
    if (headerIdx < 0) return null;
    const groups = []; let cur = null;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      const num = (r[0] || "").trim(), task = (r[1] || "").trim(), who = (r[2] || "").trim(),
        dep = (r[3] || "").trim(), start = (r[4] || "").trim(), end = (r[5] || "").trim(),
        pctRaw = (r[6] || "").trim(), notes = (r[7] || "").trim();
      if (!num && !task) continue;                       // blank / spacer
      // A PHASE header is an integer-numbered row (1, 2, "4.0") with no owner/dates/%.
      // The numbering check matters: an early-project task like "3.2 | Draft copy" with
      // WHO/dates still TBD must stay a TASK, not fragment the plan into bogus sections.
      const emptyMeta = !who && !start && !end && !pctRaw;
      const numVal = parseFloat(num);
      const isGroup = emptyMeta && (!num || isNaN(numVal) || Number.isInteger(numVal));
      if (isGroup) { cur = { num, name: task, tasks: [] }; groups.push(cur); continue; }
      if (!cur) { cur = { num: "", name: "Tasks", tasks: [] }; groups.push(cur); }
      const pct = planPct(pctRaw);
      cur.tasks.push({ num, task, who, dep, start: planFmtDate(start), end: planFmtDate(end), pct, notes, status: planStatus(notes, pct) });
    }
    if (!groups.length) return null;
    return { meta, groups };
  }

  return { SHEETS, forClient, csvUrl, parseSheetUrl, parseRows, parseHits, hitCount, parseProjectPlan };
})();
