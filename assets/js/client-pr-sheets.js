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
    parseRows(text).forEach(r => {
      const date = (r[0] || "").trim(), outlet = (r[1] || "").trim(), link = (r[2] || "").trim(),
        impressions = (r[3] || "").trim(), adValue = (r[4] || "").trim();
      if (!outlet) return;                                  // skip blank / spacer rows
      if (/^outlet$/i.test(outlet)) return;                 // skip the header cell
      hits.push({ date, outlet, link, impressions, adValue, source: "sheet" });
    });
    hits.sort((a, b) => dateKey(b.date) - dateKey(a.date));
    return hits;
  }
  // "… YTD Hits: 24 …" in the title cell, else the parsed count
  function hitCount(text, fallback) { const m = /hits:\s*(\d+)/i.exec(text || ""); return m ? +m[1] : fallback; }

  return { SHEETS, forClient, csvUrl, parseSheetUrl, parseRows, parseHits, hitCount };
})();
