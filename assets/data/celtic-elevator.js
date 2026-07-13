/* ============================================================
   SEED DATA — Celtic Elevator
   Celtic is a PROJECT client: its only real engagement is the
   "CEL Stratagem" project, which populates live from the Workamajig
   projects sheet. Its retainer-sheet rows are non-billable internal
   time only, so there is NO monthly-services retainer — the retainer
   below stays blank and `projectOnly` suppresses the placeholder
   disciplines the self-heal would otherwise seed.
   Registers into window.CLIENT_SEEDS (resolved by the bootstrap in
   dashboard.html).
   ============================================================ */
window.CLIENT_SEEDS = window.CLIENT_SEEDS || {};
window.CLIENT_SEEDS["celtic-elevator"] = {
  client: { name: "Celtic Elevator", initials: "CE", logo: "assets/img/celtic-elevator-logo.png" },
  files: [],
  engagements: {
    retainer: {
      type: "retainer", label: "Retainer", name: "Celtic Elevator — Retainer",
      projectOnly: true,
      northStar: "", dueDate: "",
      burn: { usedHours: 0, contractedHours: 0, periodLabel: "" },
      condition: { level: "green", note: "" },
      serviceLines: [], serviceDisciplines: [], mom: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
      status: { groups: [] },
      projectPlan: { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] },
    },
    projects: [],
  },
};
