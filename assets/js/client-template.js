/* ============================================================
   CLIENT TEMPLATE FACTORY
   Builds a fresh, blank-but-structured workspace for a brand-new
   client. The shape mirrors the seed data in assets/data/*.js so
   every tab + the Executive Summary render cleanly with nothing in
   them yet — the admin fills it in from the UI.
   Exposed as window.makeClientData(meta) and a few small helpers.
   ============================================================ */
(function () {
  function initialsFrom(name) {
    const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "?";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function slugify(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "client";
  }

  function currentMonthLabel() {
    try {
      const d = new Date();
      return d.toLocaleString("en-US", { month: "long", year: "numeric" });
    } catch { return ""; }
  }

  // The standard monthly-services disciplines. Each carries an admin-set monthly
  // CONTRACTED-hours budget; actual hours worked come from the WMJ timesheet, matched
  // to a discipline via canonDiscipline() below.
  const STANDARD_DISCIPLINES = ["Public Relations", "Strategic Oversight", "Creative", "Paid Media"];
  function defaultDisciplines() { return STANDARD_DISCIPLINES.map(n => ({ name: n, contracted: 0 })); }

  // Per-client seed budgets, applied the first time a retainer is set up (if the admin
  // hasn't entered its own). Keyed by normalized client name. A New Leaf is the template.
  const SEED_DISCIPLINES = {
    anewleaf: [
      { name: "Public Relations", contracted: 30 },
      { name: "Strategic Oversight", contracted: 31 },
      { name: "Creative", contracted: 33 },
      { name: "Paid Media", contracted: 6 },
    ],
  };
  function seedDisciplinesFor(name) {
    const key = String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return (SEED_DISCIPLINES[key] || defaultDisciplines()).map(d => ({ name: d.name, contracted: d.contracted }));
  }

  // Canonical bucket key — maps BOTH an admin discipline name AND a WMJ User_Department to
  // the same slot, so actual billable hours land under the right discipline.
  function canonDiscipline(s) {
    s = String(s || "").toLowerCase();
    if (/public relation|(^|[^a-z])pr([^a-z]|$)/.test(s)) return "pr";
    if (/paid media|(^|[^a-z])media/.test(s)) return "media";
    if (/creativ|design/.test(s)) return "creative";
    if (/web|develop|coding/.test(s)) return "web";
    if (/strateg|oversight|account|client service|management|leadership|project manage/.test(s)) return "oversight";
    return s.replace(/[^a-z0-9]/g, "");
  }

  function blankRetainer(name) {
    return {
      type: "retainer",
      label: "Retainer",
      name: name + " — Retainer",
      northStar: "",
      dueDate: "",
      burn: { usedHours: 0, contractedHours: 0, periodLabel: currentMonthLabel() },
      condition: { level: "green", note: "" },
      serviceDisciplines: seedDisciplinesFor(name),
      serviceLines: [],
      mom: [],
      milestones: [],
      todos: [],
      dependencies: [],
      kpis: [],
      prCoverage: [],
      backlog: [],
      status: { groups: [] },
      projectPlan: {
        outcome: "", startDate: "", endDate: "",
        status: { level: "green", pct: 0, note: "" },
        criticalPath: [], phases: [], risks: [],
      },
    };
  }

  function blankProject(id, name) {
    return {
      id: id, type: "project", label: "New Project", name: name + " — New Project",
      northStar: "", dueDate: "",
      pizza: { phases: [
        { label: "Discovery", done: false }, { label: "Strategy", done: false },
        { label: "Design", done: false }, { label: "Build", done: false }, { label: "Launch", done: false },
      ] },
      condition: { level: "green", note: "" },
      serviceLines: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
      status: { groups: [] },
      projectPlan: {
        outcome: "", startDate: "", endDate: "",
        status: { level: "green", pct: 0, note: "" },
        criticalPath: [],
        phases: [
          { name: "1 Discovery", tasks: [] }, { name: "2 Strategy", tasks: [] },
          { name: "3 Design", tasks: [] }, { name: "4 Build", tasks: [] }, { name: "5 Launch", tasks: [] },
        ],
        risks: [],
      },
    };
  }

  // meta: { name, initials?, logo?, kind? }  kind = "retainer" | "project" | "both"
  function makeClientData(meta) {
    meta = meta || {};
    const name = meta.name || "New Client";
    const initials = meta.initials || initialsFrom(name);
    const logo = meta.logo || "";
    const kind = meta.kind || "retainer";
    const data = {
      client: { name: name, initials: initials, code: (meta.code || "").trim(), logo: logo },
      files: [],
      engagements: { retainer: blankRetainer(name), projects: [] },
    };
    if (kind === "project" || kind === "both") {
      data.engagements.projects.push(blankProject("p_" + Math.floor(Math.random() * 1e6).toString(36), name));
    }
    return data;
  }

  window.makeClientData = makeClientData;
  window.tjaInitialsFrom = initialsFrom;
  window.tjaSlugify = slugify;
  window.tjaStandardDisciplines = STANDARD_DISCIPLINES;
  window.tjaDefaultDisciplines = defaultDisciplines;
  window.tjaSeedDisciplinesFor = seedDisciplinesFor;
  window.tjaCanonDiscipline = canonDiscipline;
})();
