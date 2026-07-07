/* ============================================================
   SEED DATA — Celtic Elevator
   Cleared to a BLANK workspace (2026-07 reset). All prior test /
   placeholder content removed — real data will be populated from the
   Workamajig retainer + project sheets under the new implementation.
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
      northStar: "", dueDate: "",
      burn: { usedHours: 0, contractedHours: 0, periodLabel: "" },
      condition: { level: "green", note: "" },
      serviceLines: [], mom: [], milestones: [], todos: [], dependencies: [], kpis: [], prCoverage: [], backlog: [],
      status: { groups: [] },
      projectPlan: { outcome: "", startDate: "", endDate: "", status: { level: "green", pct: 0, note: "" }, criticalPath: [], phases: [], risks: [] },
    },
    projects: [],
  },
};
