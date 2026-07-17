/* ============================================================
   RETAINER TRANSFORM  (pure, Node-testable)
   Turns the Workamajig RETAINER timesheet export into per-client
   monthly-services data: service lines by User_Department, with an
   allocation share (% of the retainer) and a utilization bar
   (actual billable ÷ allocated).

   Retainer sheet columns:
     Client_Name, Campaign_Name, Project_Name, Project_Number,
     Service_Description, Task_Name, Comments, Actual_Hours_Worked,
     Actual_Non_Billable_Hours, Actual_Billable_Hours, Date_Worked,
     Project_Billing_Method, Allocated_Hours, User_Department, User_Name

   IMPORTANT grain rule: the sheet is timesheet-granular (one row per
   time entry). Allocated_Hours is per-TASK and REPEATS on every entry
   for that task → it must be DEDUPED (counted once per task). Actual
   billable hours are per-entry → SUMMED. Getting this wrong doubles
   the allocation and skews the % spread.

   Exposed as window.WMJ_RETAINER_TRANSFORM + module.exports.
   ============================================================ */
(function (root) {
  "use strict";

  function parseCSV(text) {
    const rows = []; let row = [], field = "", i = 0, q = false; const n = text.length;
    while (i < n) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
      else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (c === "\r") {} else field += c; }
      i++;
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    // Normalize headers to underscore form: the WMJ export's header row has flipped
    // between "Client_Name" and "Client Name" (it changed live on 2026-07-17 and every
    // row silently parsed as undefined → the sync wrote empty actuals over 24 clients).
    // Accept both forever.
    const head = rows[0].map(h => h.trim().replace(/\s+/g, "_"));
    return rows.slice(1).filter(r => r.some(c => c.trim() !== "")).map(r => { const o = {}; head.forEach((h, j) => o[h] = (r[j] || "").trim()); return o; });
  }

  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
  // WMJ client code = the leading token of Campaign_Name (e.g. "ANL 2026 Retainer" → "ANL")
  function leadCode(campaign) { return String(campaign || "").trim().split(/\s+/)[0] || ""; }
  function num(s) { const v = parseFloat(s); return isFinite(v) ? v : 0; }
  function isNonBillable(r) {
    const cm = (r.Campaign_Name || "").toLowerCase(), cl = (r.Client_Name || "").toLowerCase();
    // junk guard (mirrors wmj-transform's DROP_ROW): malformed sheet rows leak note text
    // into Client_Name (e.g. "10am-3:45pm (removed an hour…)") and would auto-create a
    // garbage client. No real client name contains a clock time.
    if (/\b\d{1,2}(:\d{2})?\s*(a|p)m\b/i.test(r.Client_Name || "")) return true;
    return !cl || cm.indexOf("non-billable") > -1 || cl.indexOf("the james agency") > -1;
  }

  function transform(rows) {
    const bill = rows.filter(r => !isNonBillable(r));
    // client -> department -> task-key -> { allocated (max, deduped), billable (summed) }
    const clients = new Map();
    bill.forEach(r => {
      const key = normName(r.Client_Name);
      if (!clients.has(key)) clients.set(key, { wmjName: r.Client_Name.trim(), normName: key, code: leadCode(r.Campaign_Name), depts: new Map() });
      const C = clients.get(key);
      if (!C.code) C.code = leadCode(r.Campaign_Name);
      // SERVICE SPLIT: Organic Social lives inside the Creative DEPARTMENT in WMJ (it's a
      // Service_Description, never a department), but the dashboard treats it as its own
      // service line — as if it were a separate dept (Cameron, 2026-07-17). Routing the
      // split HERE means everything downstream (service lines, discipline auto-add, burn,
      // unallocated drill-down) just sees another department, no special cases.
      const dept = /organic\s*social/i.test(r.Service_Description || "")
        ? "Organic Social"
        : (r.User_Department || "Other").trim() || "Other";
      if (!C.depts.has(dept)) C.depts.set(dept, new Map());
      const T = C.depts.get(dept);
      const tk = (r.Campaign_Name || "") + "|" + (r.Project_Name || "") + "|" + (r.Task_Name || "");
      if (!T.has(tk)) T.set(tk, { allocated: 0, billable: 0 });
      const t = T.get(tk);
      t.allocated = Math.max(t.allocated, num(r.Allocated_Hours));   // per-task → dedupe (max)
      t.billable += num(r.Actual_Billable_Hours);                    // per-entry → sum
    });

    const out = [];
    clients.forEach(C => {
      const lines = [];
      C.depts.forEach((T, dept) => {
        let alloc = 0, bill = 0;
        const projMap = {};   // billable hours by Project_Name within this dept (for the Unallocated drill-down)
        T.forEach((t, tk) => {
          alloc += t.allocated; bill += t.billable;
          const proj = (tk.split("|")[1] || "General").trim() || "General";
          projMap[proj] = (projMap[proj] || 0) + t.billable;
        });
        if (alloc <= 0 && bill <= 0) return;
        const projects = Object.keys(projMap).filter(n => projMap[n] > 0)
          .map(name => ({ name, billable: Math.round(projMap[name] * 100) / 100 }))
          .sort((a, b) => b.billable - a.billable);
        lines.push({ name: dept, allocated: Math.round(alloc * 100) / 100, billable: Math.round(bill * 100) / 100, projects });
      });
      const totalAllocated = Math.round(lines.reduce((s, l) => s + l.allocated, 0) * 100) / 100;
      const totalBillable = Math.round(lines.reduce((s, l) => s + l.billable, 0) * 100) / 100;
      // sharePct = this line's allocated ÷ total allocated (sums to ~100)
      // utilPct  = billable ÷ allocated (how much of the line's hours are used)
      lines.forEach(l => {
        l.sharePct = totalAllocated > 0 ? Math.round(l.allocated / totalAllocated * 100) : 0;
        l.utilPct = l.allocated > 0 ? Math.round(l.billable / l.allocated * 100) : 0;
      });
      lines.sort((a, b) => b.allocated - a.allocated);
      // A "client" with zero real lines is a malformed sheet row that slipped the junk
      // guard (e.g. a comment leaking into Client_Name) — emitting it would auto-create
      // a garbage client workspace on sync.
      if (!lines.length) return;
      out.push({ wmjName: C.wmjName, normName: C.normName, code: C.code || "", serviceLines: lines, totalAllocated, totalBillable });
    });
    out.sort((a, b) => a.wmjName.localeCompare(b.wmjName));
    return out;
  }

  const api = { parseCSV, transform, normName };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.WMJ_RETAINER_TRANSFORM = api;
})(typeof window !== "undefined" ? window : globalThis);
