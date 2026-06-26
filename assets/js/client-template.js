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

  function blankRetainer(name) {
    return {
      type: "retainer",
      label: "Retainer",
      name: name + " — Retainer",
      northStar: "",
      dueDate: "",
      burn: { usedHours: 0, contractedHours: 0, periodLabel: currentMonthLabel() },
      condition: { level: "green", note: "" },
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
      client: { name: name, initials: initials, logo: logo },
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
})();
