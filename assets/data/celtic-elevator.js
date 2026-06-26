/* ============================================================
   SEED DATA — Celtic Elevator (V1)
   ⚠️  Placeholder content for the sandbox. This is the DEFAULT;
   once an admin edits a field it is saved to localStorage and
   that overrides the seed (see app.js loadState/saveState).

   Model: a client has one or more ENGAGEMENTS, each either a
   "retainer" or a "project". The Executive Summary + supporting
   tabs render the currently-selected engagement.
   ============================================================ */

window.CLIENT_SEEDS = window.CLIENT_SEEDS || {};
window.CLIENT_SEEDS["celtic-elevator"] = {
  client: { name: "Celtic Elevator", initials: "CE", logo: "assets/img/celtic-elevator-logo.png" },

  // Shared across engagements (working/final files)
  files: [
    { name: "Master Service Agreement (MSA)", type: "Agreement", status: "Signed", date: "Jan 9, 2026", size: "1.2 MB" },
    { name: "Statement of Work – Brand + Marketing", type: "SOW", status: "Signed", date: "Jan 9, 2026", size: "840 KB" },
    { name: "Celtic Elevator Proposal", type: "Proposal", status: "Signed", date: "Dec 18, 2025", size: "3.4 MB" },
  ],

  engagements: {
    /* ===================== RETAINER ===================== */
    retainer: {
      type: "retainer",
      label: "Retainer",
      name: "Celtic Elevator — Retainer",
      northStar: "Grow qualified inbound leads 25% and own the commercial-elevator conversation across Arizona.",
      dueDate: "",

      burn: { usedHours: 72, contractedHours: 113, periodLabel: "June 2026" },

      condition: { level: "green", note: "On track — June deliverables on schedule." },

      serviceLines: [
        { name: "Strategy & Brand",  allocationPct: 22, status: "in-progress" },
        { name: "Organic Social",    allocationPct: 30, status: "in-progress" },
        { name: "Public Relations",  allocationPct: 18, status: "in-progress" },
        { name: "Web & Dev",         allocationPct: 18, status: "complete" },
        { name: "Reporting",         allocationPct: 12, status: "in-progress" },
      ],

      // Month-over-month burn history (retainer only)
      mom: [
        { month: "Apr", usedHours: 108, contractedHours: 113 },
        { month: "May", usedHours: 113, contractedHours: 113 },
        { month: "Jun", usedHours: 72,  contractedHours: 113 },
      ],

      milestones: [
        { label: "Brand refresh delivered",   date: "Jun 13", done: true },
        { label: "Q3 content calendar live",  date: "Jun 20", done: false },
        { label: "Trade-show collateral",     date: "Jun 27", done: false },
      ],

      todos: [
        { text: "Provide June product photography", owner: "Client" },
        { text: "Approve Q3 content calendar",      owner: "Client" },
        { text: "Schedule July strategy call",      owner: "TJA" },
      ],

      dependencies: [
        { text: "Waiting on booth dimensions to finalize trade-show collateral." },
        { text: "Need updated brand-asset library access." },
      ],

      kpis: [
        { label: "Qualified leads / mo", target: "40",   current: "31" },
        { label: "Organic reach",        target: "+25%", current: "+18%" },
      ],

      // PR Coverage — mirrors the real tracker: Date · Outlet · Headline · Impressions · Ad Value
      prCoverage: [
        { date: "Jun 3",  outlet: "Elevator World",          headline: "Celtic Elevator named regional innovator of the year", impressions: "46,433",  adValue: "$1,110" },
        { date: "May 28", outlet: "AZ Big Media",            headline: "Commercial construction feature spotlights Celtic",    impressions: "196,053", adValue: "$1,110" },
        { date: "May 14", outlet: "Phoenix Business Journal", headline: "Local manufacturer expands AZ footprint",             impressions: "24,200",  adValue: "$470" },
        { date: "Apr 30", outlet: "Trade & Industry",        headline: "Modernization trends Q&A with leadership",             impressions: "12,100",  adValue: "$330" },
        { date: "Apr 18", outlet: "AZ Big Media",            headline: "Byline: the future of vertical transportation",        impressions: "176,315", adValue: "$220" },
      ],

      backlog: [
        { title: "Website SEO overhaul",     note: "3+ months of retainer size — candidate for a separate SOW.", estHours: 60 },
        { title: "Video case-study series",  note: "Strong brand builder; needs added budget to fit.",            estHours: 45 },
        { title: "Email automation rebuild", note: "Nice efficiency win when bandwidth allows.",                  estHours: 24 },
      ],

      // Service-line status detail (where homepage service-line clicks land)
      status: {
        groups: [
          { line: "Strategy & Brand", rows: [
            { effort: "Brand positioning refresh", update: "Approved; rolling into templates.", status: "complete", deadline: "Jun 11" },
            { effort: "Messaging matrix",          update: "In final review.",                   status: "in-progress", deadline: "Jun 18" },
          ]},
          { line: "Organic Social", rows: [
            { effort: "June content calendar", update: "Delivered & scheduled.",       status: "complete", deadline: "May 30" },
            { effort: "July content calendar", update: "Drafting; review by 6/20.",     status: "in-progress", deadline: "Jun 20" },
          ]},
          { line: "Web & Dev", rows: [
            { effort: "Landing page updates", update: "Shipped for the month.", status: "complete", deadline: "Jun 6" },
          ]},
        ],
      },

      // Project Plan — retainer is a lighter monthly cadence (real format: critical path + phased tasks + risks)
      projectPlan: {
        outcome: "Sustain category leadership and a steady qualified-lead pipeline month over month.",
        startDate: "Jan 2026", endDate: "Ongoing",
        status: { level: "green", pct: 64, note: "On pace for June deliverables." },
        criticalPath: [
          { ryg: "green",  item: "Brand standards rollout",       owner: "TJA",        window: "Jun 18", why: "Unlocks consistent templated production.", action: "Templates in final review." },
          { ryg: "yellow", item: "Q3 campaign concepts approval", owner: "TJA / Client", window: "Jun 20", why: "Drives Q3 content + paid.",                action: "Two routes in development." },
          { ryg: "red",    item: "Trade-show collateral",         owner: "Client",     window: "Jun 27", why: "Booth assets needed for July show.",        action: "Awaiting booth dimensions." },
        ],
        phases: [
          { name: "Strategy & Brand", tasks: [
            { id: "1.1", task: "Brand positioning refresh", who: "TJA", dependency: "",    start: "6/01", end: "6/11", pct: 100, status: "complete",    notes: "" },
            { id: "1.2", task: "Messaging matrix",          who: "TJA", dependency: "1.1", start: "6/09", end: "6/18", pct: 60,  status: "in-progress", notes: "" },
          ]},
          { name: "Organic Social", tasks: [
            { id: "2.1", task: "June content calendar", who: "TJA", dependency: "", start: "5/20", end: "5/30", pct: 100, status: "complete",    notes: "Delivered" },
            { id: "2.2", task: "July content calendar", who: "TJA", dependency: "", start: "6/10", end: "6/20", pct: 30,  status: "in-progress", notes: "" },
          ]},
          { name: "Creative", tasks: [
            { id: "3.1", task: "Trade-show collateral", who: "Client", dependency: "", start: "6/15", end: "6/27", pct: 0, status: "blocked", notes: "Awaiting booth specs" },
          ]},
        ],
        risks: [
          { id: "R1", risk: "Booth dimensions delay trade-show collateral", ryg: "red",    impact: "High",   owner: "Client",     mitigation: "Confirm specs by 6/18; hold print slot." },
          { id: "R2", risk: "Summer PTO slows approvals",                   ryg: "yellow", impact: "Medium", owner: "TJA / Client", mitigation: "Confirm backup approver + blackout dates." },
        ],
      },
    },

    /* ===================== PROJECTS (a client can have many) ===================== */
    projects: [{
      id: "p_web",
      type: "project",
      label: "Website Redesign",
      name: "Celtic Elevator — Website Redesign",
      northStar: "Launch a high-converting website that positions Celtic as the premium commercial choice.",
      dueDate: "Aug 15, 2026",

      // Project burn = pizza tracker (phase progress), not a speedometer
      pizza: {
        phases: [
          { label: "Discovery", done: true },
          { label: "Strategy",  done: true },
          { label: "Design",    done: false },
          { label: "Build",     done: false },
          { label: "Launch",    done: false },
        ],
      },

      condition: { level: "yellow", note: "Awaiting product photography — may shift design by ~1 week." },

      serviceLines: [
        { name: "UX & Content",   allocationPct: 30, status: "in-progress" },
        { name: "Visual Design",  allocationPct: 35, status: "in-progress" },
        { name: "Development",    allocationPct: 25, status: "in-progress" },
        { name: "QA & Launch",    allocationPct: 10, status: "in-progress" },
      ],

      milestones: [
        { label: "Discovery complete", date: "May 2",  done: true },
        { label: "Strategy approved",  date: "May 30", done: true },
        { label: "Design concepts",    date: "Jun 27", done: false },
        { label: "Site build",         date: "Jul 25", done: false },
        { label: "Launch",             date: "Aug 15", done: false },
      ],

      todos: [
        { text: "Deliver product photography", owner: "Client" },
        { text: "Approve homepage direction",  owner: "Client" },
        { text: "Confirm domain / hosting access", owner: "Client" },
      ],

      dependencies: [
        { text: "Product photography required before design can finalize." },
        { text: "CMS admin credentials needed for build phase." },
      ],

      kpis: [
        { label: "Launch readiness", target: "100%", current: "55%" },
      ],

      prCoverage: [],

      backlog: [],

      status: {
        groups: [
          { line: "Visual Design", rows: [
            { effort: "Homepage concepts", update: "Two routes in design.", status: "in-progress", deadline: "Jun 27" },
          ]},
          { line: "Development", rows: [
            { effort: "Component library", update: "Scaffolding started.", status: "in-progress", deadline: "Jul 10" },
          ]},
        ],
      },

      // Project Plan — full format mirroring the real TJA project-plan sheet
      projectPlan: {
        outcome: "Launch a high-converting website that positions Celtic as the premium commercial choice.",
        startDate: "Jun 1, 2026", endDate: "Aug 15, 2026",
        status: { level: "yellow", pct: 40, note: "Awaiting product photography — may shift design by ~1 week." },
        criticalPath: [
          { ryg: "green",  item: "Project kickoff complete",    owner: "TJA / Client", window: "6/09", why: "Establishes start, stakeholders and cadence.", action: "Maintain weekly status." },
          { ryg: "green",  item: "Strategy approved",           owner: "Client",       window: "5/30", why: "Locks direction before design scales.",        action: "Approved." },
          { ryg: "yellow", item: "Design concepts review",      owner: "TJA / Client", window: "6/27", why: "First major design checkpoint.",               action: "Awaiting product photography." },
          { ryg: "yellow", item: "Final design approval",       owner: "Client",       window: "7/18", why: "Gate for full-site build.",                    action: "Protect 7/18 to keep build on track." },
          { ryg: "red",    item: "Final coded site approval",   owner: "Client",       window: "8/01", why: "Primary gate before launch prep.",             action: "Tight window — watch closely." },
          { ryg: "green",  item: "Launch",                      owner: "TJA",          window: "8/15", why: "Deployment after final approval + QA.",         action: "Target 8/15." },
        ],
        phases: [
          { name: "1 Discovery", tasks: [
            { id: "1.1", task: "Kickoff + alignment",      who: "TJA, Client", dependency: "",    start: "6/01", end: "6/09", pct: 100, status: "complete", notes: "" },
            { id: "1.2", task: "Stakeholder interviews",   who: "TJA",         dependency: "1.1", start: "6/09", end: "6/20", pct: 100, status: "complete", notes: "" },
          ]},
          { name: "2 Strategy", tasks: [
            { id: "2.1", task: "Brand + content strategy", who: "TJA", dependency: "1.2", start: "6/20", end: "7/05", pct: 100, status: "complete", notes: "Approved 5/30" },
          ]},
          { name: "3 Design", tasks: [
            { id: "3.1", task: "Homepage concepts",                  who: "TJA",    dependency: "2.1", start: "6/10", end: "6/27", pct: 60, status: "in-progress", notes: "" },
            { id: "3.2", task: "Key page designs",                  who: "TJA",    dependency: "3.1", start: "6/27", end: "7/18", pct: 0,  status: "pending",     notes: "" },
            { id: "3.3", task: "Client provides product photography", who: "Client", dependency: "",  start: "6/15", end: "6/27", pct: 0,  status: "blocked",     notes: "Dependency" },
          ]},
          { name: "4 Build", tasks: [
            { id: "4.1", task: "Component library + coding", who: "TJA", dependency: "3.2", start: "7/10", end: "8/01", pct: 0, status: "pending", notes: "" },
          ]},
          { name: "5 Launch", tasks: [
            { id: "5.1", task: "QA + launch prep", who: "TJA", dependency: "4.1", start: "8/01", end: "8/14", pct: 0, status: "pending", notes: "" },
            { id: "5.2", task: "Push live",        who: "TJA", dependency: "5.1", start: "8/15", end: "8/15", pct: 0, status: "pending", notes: "" },
          ]},
        ],
        risks: [
          { id: "R1", risk: "Product photography delay compresses design", ryg: "red",    impact: "High",   owner: "Client",       mitigation: "Confirm asset delivery date; use placeholders for layout." },
          { id: "R2", risk: "Approval delays push launch",                 ryg: "yellow", impact: "High",   owner: "Client",       mitigation: "Rolling reviews; escalate missed gates weekly." },
          { id: "R3", risk: "Scope creep during design reviews",           ryg: "yellow", impact: "Medium", owner: "TJA / Client", mitigation: "Change control; estimate net-new separately." },
        ],
      },
    }, {
      id: "p_brand",
      type: "project",
      label: "Brand Refresh",
      name: "Celtic Elevator — Brand Refresh Campaign",
      northStar: "Modernize the Celtic brand system and roll it out across every touchpoint.",
      dueDate: "Sep 30, 2026",
      pizza: { phases: [
        { label: "Audit",    done: true },
        { label: "Concepts", done: false },
        { label: "System",   done: false },
        { label: "Rollout",  done: false },
      ]},
      condition: { level: "green", note: "Kicked off; concepts in development." },
      serviceLines: [
        { name: "Brand Strategy",  allocationPct: 40, status: "in-progress" },
        { name: "Visual Identity", allocationPct: 45, status: "in-progress" },
        { name: "Guidelines",      allocationPct: 15, status: "pending" },
      ],
      milestones: [
        { label: "Brand audit complete", date: "Jul 10", done: true },
        { label: "Concept directions",   date: "Aug 1",  done: false },
        { label: "Final system",         date: "Sep 15", done: false },
      ],
      todos: [
        { text: "Share competitor set for the audit", owner: "Client" },
        { text: "Approve concept directions",         owner: "Client" },
      ],
      dependencies: [
        { text: "Stakeholder availability for the brand workshop." },
      ],
      kpis: [
        { label: "Brand consistency score", target: "90%", current: "—" },
      ],
      prCoverage: [],
      backlog: [],
      status: { groups: [
        { line: "Visual Identity", rows: [
          { effort: "Logo + mark exploration", update: "In design.", status: "in-progress", deadline: "Aug 1" },
        ]},
      ]},
      projectPlan: {
        outcome: "A refreshed, cohesive brand system rolled out across all touchpoints by end of Q3.",
        startDate: "Jul 1, 2026", endDate: "Sep 30, 2026",
        status: { level: "green", pct: 25, note: "On track; concepts in development." },
        criticalPath: [
          { ryg: "green",  item: "Brand audit complete",   owner: "TJA",          window: "7/10", why: "Baseline for concept direction.", action: "Complete." },
          { ryg: "yellow", item: "Concept directions",     owner: "TJA / Client", window: "8/01", why: "Locks creative direction.",      action: "In development." },
          { ryg: "green",  item: "Final system delivery",  owner: "TJA",          window: "9/15", why: "Enables rollout.",               action: "On track." },
        ],
        phases: [
          { name: "1 Audit",    tasks: [ { id: "1.1", task: "Brand + competitor audit", who: "TJA", dependency: "",    start: "7/01", end: "7/10", pct: 100, status: "complete",    notes: "" } ]},
          { name: "2 Concepts", tasks: [ { id: "2.1", task: "Concept directions",       who: "TJA", dependency: "1.1", start: "7/11", end: "8/01", pct: 40,  status: "in-progress", notes: "" } ]},
          { name: "3 System",   tasks: [ { id: "3.1", task: "Build brand system",       who: "TJA", dependency: "2.1", start: "8/04", end: "9/15", pct: 0,   status: "pending",     notes: "" } ]},
          { name: "4 Rollout",  tasks: [ { id: "4.1", task: "Apply across touchpoints", who: "TJA", dependency: "3.1", start: "9/16", end: "9/30", pct: 0,   status: "pending",     notes: "" } ]},
        ],
        risks: [
          { id: "R1", risk: "Stakeholder alignment on direction", ryg: "yellow", impact: "Medium", owner: "Client", mitigation: "Run a directional workshop early." },
        ],
      },
    }],
  },
};
