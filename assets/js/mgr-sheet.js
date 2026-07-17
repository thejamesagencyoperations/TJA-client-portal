/* ============================================================
   AM/PM ASSIGNMENT SHEET → manager tags + client codes
   The team's client-status workbook (Cameron, 2026-07-17) is the
   monthly source of truth for who runs each account. One tab per
   month ("July 2026", "August 2026", …), flat rows:

     A: client code ("245 STB" — WMJ project number + code)
     B: client name
     K: Account Manager (first name)
     L: Project Manager (first name)

   (The workbook also has hidden legacy tabs — "Kristin Doc" /
   "Grid View", a per-manager column-pair grid — which is what the
   bare gid=0 CSV export serves. Do NOT parse that; always request
   a month tab by NAME.)

   Sync behavior:
   • Reads the CURRENT month's tab, falling back up to 3 months
     back until one parses (new month tabs appear when the team
     makes them — the previous month stays truth until then).
   • For each row, matches the portal client by CODE first (the
     "STB" token — survives name drift like "Ray Cammack Shows" vs
     "RCS, Inc."), then by normalized name.
   • Overwrites the client's `managers` tags with [AM, PM] — the
     sheet is truth for assignment; portal clients the sheet
     doesn't list keep their existing tags (absence proves nothing).
   • Backfills a missing portal `code` from column A.
   • First names resolve to full account names via the staff
     roster (window.TJA_STAFF_ROSTER) when exactly one matches, so
     the "my clients" default filter keeps working.
   ============================================================ */
window.MGR_SHEET = (function () {
  "use strict";
  const SHEET_ID = "1_I3UlEU__O4ea9SVV2J4ERKww3XWumc68wGDr0cDrQM";
  const tabUrl = (name) =>
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`;

  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  function monthTabCandidates() {
    const out = [], now = new Date();
    for (let back = 0; back < 4; back++) {
      const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
      out.push(MONTHS[d.getMonth()] + " " + d.getFullYear());
    }
    return out;
  }

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  // "245 STB" → "STB"; tolerate a bare code or extra spaces
  function codeFrom(a) {
    const m = /([A-Za-z]{2,6})\s*$/.exec(String(a || "").trim());
    return m ? m[1].toUpperCase() : "";
  }

  let lastManagers = [];   // resolved manager names from the last successful sync
  let lastTab = "";        // which month tab actually served the data

  // rows → [{code, name, am, pm}]; null if this tab isn't the flat monthly layout
  function parseTab(rows) {
    const headIdx = rows.findIndex(r => String(r[1] || "").trim().toLowerCase() === "client");
    if (headIdx < 0) return null;
    const out = [];
    rows.slice(headIdx + 1).forEach(r => {
      const name = String(r[1] || "").trim();
      if (!name) return;
      out.push({
        code: codeFrom(r[0]),
        name,
        am: String(r[10] || "").trim(),   // K
        pm: String(r[11] || "").trim(),   // L
      });
    });
    return out.length ? out : null;
  }

  // first name → full account name, when exactly one roster name starts with it
  function resolveFull(first, roster) {
    const f = String(first || "").trim().toLowerCase();
    if (!f) return "";
    const hits = (roster || []).filter(n => n.toLowerCase().startsWith(f));
    return hits.length === 1 ? hits[0] : String(first).trim();
  }

  function matchPortalClient(row, roster) {
    if (row.code) {
      const byCode = roster.find(c => String(c.code || "").toUpperCase() === row.code);
      if (byCode) return byCode;
    }
    const target = norm(row.name);
    if (!target) return null;
    return roster.find(c => {
      const a = norm(c.name), b = norm(c.wmjName || "");
      return a === target || b === target
        || (a && (a.indexOf(target) === 0 || target.indexOf(a) === 0))
        || (b && (b.indexOf(target) === 0 || target.indexOf(b) === 0));
    }) || null;
  }

  async function sync() {
    if (!window.TJA_STORE || !window.CLIENT_PR_SHEETS) return { clients: 0 };
    let parsed = null;
    for (const tab of monthTabCandidates()) {
      try {
        const res = await fetch(tabUrl(tab), { cache: "no-store" });
        if (!res.ok) continue;
        parsed = parseTab(window.CLIENT_PR_SHEETS.parseRows(await res.text()));
        if (parsed) { lastTab = tab; break; }
      } catch (e) { /* try the next month back */ }
    }
    if (!parsed) { console.warn("mgr-sheet: no month tab parsed"); return { clients: 0 }; }

    const staffRoster = window.TJA_STAFF_ROSTER || [];
    const portal = window.TJA_STORE.list() || [];
    const managerSet = new Set();
    const unmatched = [];
    let n = 0;

    parsed.forEach(row => {
      const am = resolveFull(row.am, staffRoster), pm = resolveFull(row.pm, staffRoster);
      [am, pm].forEach(m => m && managerSet.add(m));
      const ent = matchPortalClient(row, portal);
      if (!ent) { unmatched.push(row.name + (row.code ? " (" + row.code + ")" : "")); return; }
      const next = [...new Set([am, pm].filter(Boolean))].sort();
      const patch = {};
      const cur = Array.isArray(ent.managers) ? ent.managers.slice().sort() : [];
      if (next.length && JSON.stringify(cur) !== JSON.stringify(next)) patch.managers = next;
      if (!ent.code && row.code) patch.code = row.code;   // backfill only — WMJ's code stays authoritative
      if (Object.keys(patch).length) { window.TJA_STORE.update(ent.id, patch); n++; }
    });

    lastManagers = [...managerSet].sort();
    if (unmatched.length) console.log(`mgr-sheet (${lastTab}): no portal client matched for:`, unmatched.join(", "));
    return { clients: n, tab: lastTab, managers: lastManagers, unmatched };
  }

  return { sync, managers: () => lastManagers.slice(), tab: () => lastTab };
})();
