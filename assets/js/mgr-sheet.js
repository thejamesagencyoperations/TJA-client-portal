/* ============================================================
   AM/PM ASSIGNMENT SHEET → manager tags
   The team keeps the live list of active AM/PMs and their client
   assignments in one Google Sheet (Cameron, 2026-07-17). Layout:

     row 1:  manager first names, one per COLUMN-PAIR (cols 0,2,4,…)
     row 2:  "Client / Industry" subheaders (ignored)
     rows 3+: client name in the manager's first column, industry in
              the second (industry ignored here)

   This sheet is the SOURCE OF TRUTH for `managers` tags on portal
   clients it names: tags are overwritten on every sync (unlike the
   WMJ-derived accountManager, which only ever seeds once). Portal
   clients the sheet doesn't mention keep their existing tags —
   the sheet not listing a client proves nothing (archived, new,
   or just spelled differently).

   Sheet manager names are FIRST names; portal accounts use full
   names. Each sheet name is resolved to a full account name when
   exactly one roster name starts with it (case-insensitive), so
   the "my clients" default filter (which matches the login's full
   name) still works. Unresolved names are kept as-is.

   Matching sheet clients → portal clients: normalized exact match
   or one-contains-the-other. Unmatched sheet rows are returned in
   the result (surfaced in console) — fix by aligning the name in
   the sheet or the portal, not by loosening the matcher into
   guesswork.
   ============================================================ */
window.MGR_SHEET = (function () {
  "use strict";
  const SHEET_ID = "1_I3UlEU__O4ea9SVV2J4ERKww3XWumc68wGDr0cDrQM";
  const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=0`;

  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  let lastManagers = [];   // resolved manager names from the last successful sync

  function parse(text) {
    const reg = window.CLIENT_PR_SHEETS;               // reuse the quote-aware CSV parser
    if (!reg) return null;
    const rows = reg.parseRows(text);
    if (rows.length < 2) return null;
    // column-pair layout: manager name sits in the first column of its pair
    const managers = [];                               // [{ name, col }]
    rows[0].forEach((cell, col) => { const n = String(cell || "").trim(); if (n) managers.push({ name: n, col }); });
    const byManager = {};                              // manager name -> [client names]
    managers.forEach(m => { byManager[m.name] = []; });
    rows.slice(2).forEach(r => {
      managers.forEach(m => {
        const client = String(r[m.col] || "").trim();
        if (client) byManager[m.name].push(client);
      });
    });
    return { managers: managers.map(m => m.name), byManager };
  }

  // first name → full account name, when exactly one roster name starts with it
  function resolveFull(first, roster) {
    const f = String(first || "").trim().toLowerCase();
    const hits = (roster || []).filter(n => n.toLowerCase().startsWith(f));
    return hits.length === 1 ? hits[0] : String(first || "").trim();
  }

  function matchPortalClient(sheetName, roster) {
    const target = norm(sheetName);
    if (!target) return null;
    return roster.find(c => {
      const a = norm(c.name), b = norm(c.wmjName || "");
      return a === target || b === target
        || (a && (a.indexOf(target) === 0 || target.indexOf(a) === 0))
        || (b && (b.indexOf(target) === 0 || target.indexOf(b) === 0));
    }) || null;
  }

  async function sync() {
    if (!window.TJA_STORE) return { clients: 0 };
    let text;
    try {
      const res = await fetch(CSV_URL, { cache: "no-store" });
      if (!res.ok) throw new Error("mgr sheet fetch " + res.status);
      text = await res.text();
    } catch (e) { console.warn("mgr-sheet sync", e); return { clients: 0, error: String(e) }; }
    const parsed = parse(text);
    if (!parsed || !parsed.managers.length) { console.warn("mgr-sheet: nothing parsed"); return { clients: 0 }; }

    const staffRoster = window.TJA_STAFF_ROSTER || [];   // full account names, set by clients.html
    const fullName = {};                                  // sheet first name -> resolved full name
    parsed.managers.forEach(m => { fullName[m] = resolveFull(m, staffRoster); });
    lastManagers = parsed.managers.map(m => fullName[m]);

    // invert: portal client -> [manager full names]
    const roster = window.TJA_STORE.list() || [];
    const tagsFor = new Map();                            // portal id -> Set of manager names
    const unmatched = [];
    Object.keys(parsed.byManager).forEach(m => {
      parsed.byManager[m].forEach(clientName => {
        if (norm(clientName).indexOf("thejamesagency") === 0) return;   // the agency itself, not a client
        const ent = matchPortalClient(clientName, roster);
        if (!ent) { unmatched.push(clientName + " (" + m + ")"); return; }
        if (!tagsFor.has(ent.id)) tagsFor.set(ent.id, new Set());
        tagsFor.get(ent.id).add(fullName[m]);
      });
    });

    let n = 0;
    tagsFor.forEach((set, id) => {
      const next = [...set].sort();
      const ent = window.TJA_STORE.get(id); if (!ent) return;
      const cur = Array.isArray(ent.managers) ? ent.managers.slice().sort() : [];
      if (JSON.stringify(cur) !== JSON.stringify(next)) { window.TJA_STORE.update(id, { managers: next }); n++; }
    });
    if (unmatched.length) console.log("mgr-sheet: no portal client matched for:", unmatched.join(", "));
    return { clients: n, managers: lastManagers, unmatched };
  }

  return { sync, managers: () => lastManagers.slice(), CSV_URL };
})();
