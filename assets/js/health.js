/* ============================================================
   SYSTEM HEALTH — one admin page answering "is anything broken or stale?"

   Two kinds of signal:
     1. AUTOMATION — each scheduled job writes its last-run outcome to
        app_state("_health","clients") via _shared/health.ts. We read that and also
        judge FRESHNESS: a job whose last run is older than its schedule allows is a
        finding in itself (that's how a silently-dead cron shows up here).
     2. DATA — computed live by reading every client's dashboard row. Catches the
        things that look fine on a client's own page but are wrong in aggregate:
        a burn still labelled last month, a connected plan that stopped parsing,
        a retainer with no denominator, a missing Slack/Drive integration.

   Findings are grouped by severity, worst first, and each one names the client so
   it's actionable rather than a count. Read-only: this page diagnoses, it never
   writes — fixing anything happens on the client's own page or in Admin Center.
   ============================================================ */
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const MON_FULL = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  // TJA's business month is America/Phoenix (UTC-7, no DST) — the same basis the
  // scheduled snapshot keys on, so this page and the cron never disagree about "this month".
  function phoenixNow() { return new Date(Date.now() - 7 * 3600e3); }
  function currentMonthLabel() {
    const n = phoenixNow();
    return MON_FULL[n.getUTCMonth()] + " " + n.getUTCFullYear();
  }

  const agoText = (iso) => {
    if (!iso) return "never";
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "unknown";
    const m = Math.round(ms / 60000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    const h = Math.round(m / 60);
    if (h < 48) return h + " hr ago";
    return Math.round(h / 24) + " days ago";
  };
  const hoursSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : Infinity);

  /* Each scheduled job, its cadence, and how stale is too stale. The limits are
     deliberately loose: GitHub defers scheduled workflows by hours under load, so a
     tight limit would cry wolf. See the note in monthly-snapshot.yml. */
  const JOBS = [
    { key: "snapshot-months", label: "Monthly burn snapshot",
      cadence: "twice daily", staleHrs: 30,
      why: "Freezes each client's month-end burn and rolls everyone into the new month." },
    { key: "plan-refresh", label: "Project plan auto-refresh",
      cadence: "every 5 min", staleHrs: 3,
      why: "Re-pulls connected project-plan sheets so edits appear without anyone clicking refresh." },
    { key: "assign-sync", label: "AM/PM assignment sync",
      cadence: "daily", staleHrs: 30,
      why: "Reads the assignment workbook so each AM/PM can edit the clients they own." },
  ];

  const findings = [];
  const add = (sev, area, title, detail, clients) =>
    findings.push({ sev, area, title, detail, clients: clients || [] });

  /* ---------- 1. automation ---------- */
  function checkAutomation(health) {
    JOBS.forEach((j) => {
      const h = health[j.key];
      if (!h) {
        add("warn", "Automation", j.label + " has never reported",
          "No run has recorded its outcome yet. This is expected until the job next runs (" + j.cadence + ").");
        return;
      }
      const hrs = hoursSince(h.at);
      if (h.ok === false) {
        add("error", "Automation", j.label + " failed on its last run",
          (h.error ? esc(h.error) : "The job reported a failure.") + " · last run " + agoText(h.at));
      } else if (hrs > j.staleHrs) {
        add("error", "Automation", j.label + " has not run recently",
          "Last successful run was " + agoText(h.at) + ", but it is scheduled " + j.cadence +
          ". The schedule may be disabled or failing before it reports.");
      }

      // job-specific findings from the recorded payload
      if (j.key === "snapshot-months" && h.ok !== false) {
        if (h.month && h.month !== currentMonthLabel()) {
          add("error", "Automation", "Snapshot is keyed to the wrong month",
            "The last run recorded " + esc(h.month) + " but the current business month is " +
            esc(currentMonthLabel()) + ".");
        }
        if (+h.suspect > 0) {
          add("error", "Data", "Burn snapshot skipped " + h.suspect + " client(s) as suspect",
            "The retainer timesheet came back EMPTY while these clients already had hours recorded " +
            "for this month, so the snapshot left them alone rather than zeroing real data. " +
            "Check that the Workamajig retainer export is still publishing.",
            h.suspectClients || []);
        }
        if (+h.clientsInSheet === 0) {
          add("warn", "Integration", "No clients in the retainer timesheet",
            "The Workamajig export returned no billable rows. Normal on the 1st of a month or a " +
            "weekend; a concern on a working day mid-month.");
        }
        if ((h.noDenominator || []).length) {
          add("warn", "Data", (h.noDenominator || []).length + " retainer client(s) have no contracted hours",
            "Their burn gauge cannot show a percentage (it renders as “—”) until contracted hours " +
            "or a monthly SOW value is set.", h.noDenominator || []);
        }
      }
      if (j.key === "assign-sync" && h.ok !== false) {
        /* THE ONE THAT BITES SILENTLY: no assignment means that client's AM/PM cannot edit
           anything, and the portal gives them no reason why — a field just refuses to take
           focus. Worth the loudest severity even though nothing is technically "broken". */
        if ((h.unassigned || []).length) {
          add("error", "Access", (h.unassigned || []).length + " client(s) have no AM/PM assigned",
            "Nobody can edit these clients except an admin — their AM/PM sees a view-only page. " +
            "Either add the client to the assignment workbook, or assign someone directly in " +
            "Admin Center → ⇄ Assignments (which also pins it against the nightly sync).",
            h.unassigned || []);
        }
        if ((h.blank_rows || []).length) {
          add("warn", "Access", (h.blank_rows || []).length + " workbook row(s) have no AM or PM",
            "These clients are in the assignment workbook but both name cells are empty, so the " +
            "sync skips them.", h.blank_rows || []);
        }
        if ((h.name_issues || []).length) {
          add("warn", "Access", (h.name_issues || []).length + " assignment name(s) could not be matched",
            "A name in the workbook doesn't resolve to exactly one portal login, so that " +
            "assignment was skipped.", h.name_issues || []);
        }
        if ((h.unmatched_clients || []).length) {
          add("warn", "Access", (h.unmatched_clients || []).length + " workbook client(s) aren't in the portal",
            "These rows name a client the portal doesn't have, so their assignment goes nowhere.",
            h.unmatched_clients || []);
        }
        // the workbook is month-tabbed; a tab that has fallen behind means stale ownership
        if (h.tab && h.tab !== currentMonthLabel()) {
          add("warn", "Access", "Assignment workbook has no tab for " + currentMonthLabel(),
            "The sync is reading “" + esc(h.tab) + "”, the most recent tab it can find. " +
            "Assignments will keep following that month until this month's tab exists.");
        }
      }
      if (j.key === "plan-refresh" && +h.failed > 0) {
        add("error", "Data", h.failed + " project plan(s) failed to parse",
          "The sheet was reached but could not be read as a project plan. Usually the tab is " +
          "missing the “# | TASK” header row, or the link points at a workbook that has been moved.",
          (h.failures || []).map((f) => f.client + (f.error ? " — " + f.error : "")));
      }
    });
  }

  /* ---------- 2. live data checks ---------- */
  function checkData(rows, roster) {
    const nameOf = (id) => {
      const c = roster.find((x) => String(x.id) === String(id));
      return (c && c.name) || id;
    };
    const label = currentMonthLabel();
    const staleMonth = [], planBroken = [], planNever = [], noSlack = [], noDrive = [], overrides = [];

    rows.forEach((r) => {
      const id = String(r.client_id || "");
      if (!id || id.charAt(0) === "_") return;             // sentinel rows are not clients
      const d = r.data || {};
      const eng = d.engagements || {};
      const ret = eng.retainer;

      if (ret && ret.burn) {
        // the exact symptom that started this page: the month rolled but a client didn't
        if (ret.burn.periodLabel && ret.burn.periodLabel !== label) staleMonth.push(nameOf(id) + " — shows " + ret.burn.periodLabel);
        // a presentation override left over from an earlier month would make the gauge lie
        const hasOv = !!(ret.svcUtilOverride && Object.keys(ret.svcUtilOverride).length) ||
                      !!(ret.hoursRealloc && Object.keys(ret.hoursRealloc).length);
        if (hasOv && ret.overrideMonth !== label) overrides.push(nameOf(id) + (ret.overrideMonth ? " — set in " + ret.overrideMonth : " — no month recorded"));
      }

      (eng.projects || []).forEach((p) => {
        if (!p || !p.projectPlanSheetUrl) return;
        const plan = p.projectPlanSheet;
        const ok = plan && Array.isArray(plan.groups) && plan.groups.length;
        if (!ok) planBroken.push(nameOf(id) + (p.label ? " · " + p.label : ""));
        else if (!(plan.meta && plan.meta.burn && plan.meta.burn.pct != null)) {
          // the plan parses but carries no stated progress figure — the portal will show 0%
          planNever.push(nameOf(id) + (p.label ? " · " + p.label : "") + " — no “Burn to Date” row in the sheet");
        }
      });
    });

    roster.forEach((c) => {
      if (!c || !c.id || c.archived) return;
      const integ = c.integrations || {};
      if (!integ.slackChannel) noSlack.push(c.name || c.id);
      if (!integ.driveFolderId) noDrive.push(c.name || c.id);
    });

    if (staleMonth.length) add("error", "Data", staleMonth.length + " client(s) still showing a previous month",
      "Their Monthly Services burn is labelled with an earlier month, so the page reads as though " +
      "the month never rolled over. The snapshot should correct this on its next run.", staleMonth);
    if (overrides.length) add("error", "Data", overrides.length + " client(s) carry an expired burn override",
      "An admin previously dragged the burn dial or reallocated hours for a different month. These " +
      "are ignored now that overrides are month-scoped, and the next snapshot clears them — but " +
      "until then an older cached browser tab may still show the overridden figure.", overrides);
    if (planBroken.length) add("error", "Data", planBroken.length + " connected project plan(s) are not parsing",
      "A plan sheet is linked but no tasks could be read from it. Check the tab has the " +
      "“# | TASK | WHO | …” header row and that the link points at the live tab.", planBroken);
    if (planNever.length) add("warn", "Data", planNever.length + " project plan(s) have no stated progress",
      "The plan parses, but the sheet has no “Burn to Date/Projected Burn:” row, so the portal has " +
      "no percentage to show. The figure is taken verbatim from the sheet and never recalculated.", planNever);
    if (noSlack.length) add("warn", "Integration", noSlack.length + " client(s) have no Slack channel",
      "Present Docs approvals and client reviews for these clients post nowhere. Set the channel in " +
      "All Clients → Edit → Integrations.", noSlack);
    if (noDrive.length) add("warn", "Integration", noDrive.length + " client(s) have no Drive folder yet",
      "File uploads provision a folder on first use, so this resolves itself — but a nightly " +
      "provision run should normally have created them already.", noDrive);
  }

  /* ---------- render ---------- */
  const SEV = { error: { label: "Needs attention", cls: "hz-error" }, warn: { label: "Worth a look", cls: "hz-warn" } };

  function render(health) {
    const box = $("hzFindings");
    const order = ["error", "warn"];
    const shown = findings.filter((f) => order.indexOf(f.sev) > -1);

    $("hzSummary").innerHTML = shown.length
      ? order.map((sev) => {
          const n = shown.filter((f) => f.sev === sev).length;
          return n ? `<span class="hz-pill ${SEV[sev].cls}">${n} ${esc(SEV[sev].label.toLowerCase())}</span>` : "";
        }).join("")
      : `<span class="hz-pill hz-ok">Everything checks out</span>`;

    if (!shown.length) {
      box.innerHTML = `<div class="hz-empty">No problems found. Automation is reporting on schedule and no
        client data looks stale.</div>`;
    } else {
      box.innerHTML = order.map((sev) => {
        const group = shown.filter((f) => f.sev === sev);
        if (!group.length) return "";
        return group.map((f) => `
          <div class="hz-card ${SEV[f.sev].cls}">
            <div class="hz-card-head">
              <span class="hz-dot"></span>
              <span class="hz-title">${esc(f.title)}</span>
              <span class="hz-area">${esc(f.area)}</span>
            </div>
            <div class="hz-detail">${f.detail}</div>
            ${f.clients.length ? `<ul class="hz-list">${f.clients.slice(0, 40).map((c) => `<li>${esc(c)}</li>`).join("")}
              ${f.clients.length > 40 ? `<li class="hz-more">…and ${f.clients.length - 40} more</li>` : ""}</ul>` : ""}
          </div>`).join("");
      }).join("");
    }

    // the automation strip — always shown, so "when did this last run" is answerable
    $("hzJobs").innerHTML = JOBS.map((j) => {
      const h = health[j.key] || null;
      const hrs = h ? hoursSince(h.at) : Infinity;
      const bad = !h || h.ok === false || hrs > j.staleHrs;
      const counts = [];
      if (h && j.key === "snapshot-months") {
        if (h.month) counts.push(esc(h.month));
        if (h.snapped != null) counts.push(h.snapped + " with hours");
        if (h.rolled != null) counts.push(h.rolled + " rolled to zero");
        if (+h.expired > 0) counts.push(h.expired + " stale overrides cleared");
      }
      if (h && j.key === "plan-refresh") {
        if (h.unchanged != null) counts.push(h.unchanged + " unchanged");
        if (h.changed != null) counts.push(h.changed + " updated");
        if (+h.failed > 0) counts.push(h.failed + " failed");
        if (+h.deferred > 0) counts.push(h.deferred + " deferred to next run");
      }
      return `<div class="hz-job ${bad ? "hz-job-bad" : ""}">
        <div class="hz-job-top"><span class="hz-job-name">${esc(j.label)}</span>
          <span class="hz-job-when">${esc(agoText(h && h.at))}</span></div>
        <div class="hz-job-sub">${esc(j.why)}</div>
        <div class="hz-job-meta">Runs ${esc(j.cadence)}${counts.length ? " · " + counts.join(" · ") : ""}</div>
      </div>`;
    }).join("");

    $("hzStamp").textContent = "Checked " + new Date().toLocaleString();
  }

  async function run() {
    findings.length = 0;
    $("hzFindings").innerHTML = `<div class="hz-empty">Running checks…</div>`;
    let health = {};
    try {
      const { data } = await window.SUPA.client.from("app_state").select("data")
        .eq("client_id", "_health").eq("scope", "clients").maybeSingle();
      if (data && data.data && typeof data.data === "object") health = data.data;
    } catch (e) { /* no record yet — checkAutomation reports that */ }

    let rows = [], roster = [];
    try {
      const res = await window.SUPA.client.from("app_state").select("client_id,data").eq("scope", "dashboard");
      rows = res.data || [];
      const reg = await window.SUPA.client.from("app_state").select("data")
        .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
      roster = Array.isArray(reg.data && reg.data.data) ? reg.data.data : [];
    } catch (e) {
      add("error", "Portal", "Could not read client data",
        "The health checks below are incomplete: " + esc(String(e && e.message || e)));
    }

    checkAutomation(health);
    if (rows.length) checkData(rows, roster);
    // worst first, then group by area so related findings sit together
    findings.sort((a, b) => (a.sev === b.sev ? a.area.localeCompare(b.area) : (a.sev === "error" ? -1 : 1)));
    render(health);
  }

  window.TJA_HEALTH = { run };
})();
