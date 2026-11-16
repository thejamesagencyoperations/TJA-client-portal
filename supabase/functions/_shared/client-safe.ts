/* ============================================================
   CLIENT-SAFE DASHBOARD COPY — the one place that decides which parts of a client's
   dashboard row a CLIENT may receive. Used by client-dashboard (the client's dashboard read)
   and ask-tja (the data the assistant may answer from). Moved here from client-dashboard
   2026-11-16 so both share exactly the same stripping.
   ============================================================ */
// KEEP IN SYNC with app.js / exec-summary.js planTaskKey / planGroupKey
// deno-lint-ignore no-explicit-any
const planTaskKey = (t: any) => (t && t.num ? "n:" + t.num : "t:" + (t && t.task));
// deno-lint-ignore no-explicit-any
const planGroupKey = (g: any) => "g:" + ((g && (g.num || g.name)) || "");

// tile key (exec-summary TILE_DEFS) → the engagement fields that hold that tile's content
const TILE_FIELDS: Record<string, string[]> = {
  milestones: ["milestones"],
  todosdep: ["todos", "dependencies"],
  kpis: ["kpis"],
  pr: ["prCoverage"],
};

// deno-lint-ignore no-explicit-any
function scrubEngagement(e: any): void {
  if (!e || typeof e !== "object") return;

  // CRF: hours only (the dollars live in the staff-only _crf_rates row)
  if (e.crf && typeof e.crf === "object") {
    for (const k of ["rate", "monthDollars", "baselineDollars", "month", "tab", "sows"]) delete e.crf[k];
  }

  // internal dependencies, and to-do links that point at them
  if (Array.isArray(e.dependencies)) {
    const hidden = new Set(e.dependencies.filter((d: any) => d && d.internal).map((d: any) => d.id).filter(Boolean));
    e.dependencies = e.dependencies.filter((d: any) => !(d && d.internal));
    if (hidden.size && Array.isArray(e.todos)) {
      for (const t of e.todos) if (t && Array.isArray(t.waitingOn)) t.waitingOn = t.waitingOn.filter((id: string) => !hidden.has(id));
    }
  }

  // internal project-plan phases / tasks
  const internal = e.planInternal || {};
  const p = e.projectPlanSheet;
  if (p && Array.isArray(p.groups) && Object.keys(internal).length) {
    p.groups = p.groups
      .filter((g: any) => !internal[planGroupKey(g)])
      .map((g: any) => ({ ...g, tasks: Array.isArray(g.tasks) ? g.tasks.filter((t: any) => !internal[planTaskKey(t)]) : g.tasks }))
      .filter((g: any) => !Array.isArray(g.tasks) || g.tasks.length);
  }

  // team-only tiles: the client view lays out as if they were off — so ship no content either
  const teamOnly = e.tileTeamOnly || {};
  for (const [tile, fields] of Object.entries(TILE_FIELDS)) {
    if (teamOnly[tile]) for (const f of fields) e[f] = [];
  }
}

// deno-lint-ignore no-explicit-any
export function clientSafe(data: any): any {
  const d = JSON.parse(JSON.stringify(data || {}));
  const eng = d.engagements || {};
  scrubEngagement(eng.retainer);
  if (Array.isArray(eng.projects)) {
    eng.projects = eng.projects.filter((p: any) => !(p && p.archived));   // archived = hidden from the client
    eng.projects.forEach(scrubEngagement);
  }
  return d;
}

