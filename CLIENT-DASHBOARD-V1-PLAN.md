# TJA Client Dashboard — V1 Project Plan

**Status:** Draft for review
**Source:** Client Dashboard Workshop, 06/16/26 (+ whiteboard)
**Prepared for:** Project Manager review / team sign-off

> **Note for reviewers:** A working first-cut prototype of Phases 1–2 (below)
> already exists in the `TJA-client-portal` sandbox at v1.7 — so this document is
> both the plan *and* a description of what the early build already does. It is a
> front-end-only sandbox (mock login, no backend yet) meant for internal review.

---

## Context

The workshop defined the real V1 of the client dashboard. The earlier sandbox was
a throwaway visual to get us talking. The workshop replaced that structure with a
clear idea:

**The homepage is an Executive Summary** — the one screen a CEO/CMO opens and
understands their engagement without clicking anything. The hard rule from the
room: *keep it simple, don't bog it down, don't make it feel "damning."* Burn is
no longer its own tab — it becomes a module on this homepage. Everything else is
either a module on the homepage or part of a minimal set of supporting tabs.

---

## 1. Information Architecture

**Engagement-type toggle at the very top (Retainer ⟷ Project).** A client can have
both (e.g. "Celtic Elevator — Stratagem + Website"), so these are two separate
"homepages" you flip between, not one merged view.

**Left-nav tabs (kept deliberately minimal):**

| Tab | Origin | Notes |
|---|---|---|
| **Executive Summary** | NEW (home/landing page) | The focus of V1 |
| **Project Plan** | renamed from "Key Dates" | Full plan with line items |
| **Status** | from "Status Report" + "SAP" | Service-line detail (SAP + Status merge lands here) |
| **Present Docs** | exists | Creative review (comment / draw / approve) — keep |
| **Files** | exists | Working / final files — keep, **not** merged with Present Docs |
| **Backlog** | NEW | Retainer engagements only |

> **"Key Dates" is retired.** Clients found having both "key dates" and a "project
> plan" confusing. It becomes **Project Plan** (one source), with the high-level
> milestones surfaced as a *module* on the Executive Summary.

---

## 2. Executive Summary Homepage — Module Inventory (heart of V1)

Every field is **admin-editable (manual entry)** and read-only in client view.

**A. Header bar** — Client / engagement name · **North Star** (one editable
sentence: the goal/KPI we're driving to) · **Due / completion date** (projects
only) · **Client logo** top-right.

**B. Burn module** — Retainer: a **speedometer** (% of monthly retainer hours).
Project: a **Domino's-style "pizza tracker"** of phase/milestone progress.
**Manual / fudgeable** — it does not auto-pull (there's a real difference between
"hours burned" and actual progress). **Projected depletion is removed from the
client view.**

**C. Project Condition ("temperature")** — a red / yellow / green indicator
("on track" / "delayed"), client-facing, admin-set, with an optional one-line
explanation ("moved to yellow — waiting on 2 interviews").

**D. Service Lines module** — disciplines (PR, Organic Social, Web …) each with a
**status** (In Progress / Complete) and **% hours allocation**. Discipline-level
only — not task counts. Click a service line → the **Status** tab for that line.
Retainers add **month-over-month history**.

**E. Milestones module** — ~4 high-level call-outs pulled from the Project Plan
("first 30 / 45 days," phase entries) — the "CEO-fied" view, not line-by-line.
Click the header → the full **Project Plan** tab.

**F. Three bottom tiles** — the room locked on **three**:
- **To-Do's** — action items for either side ("schedule site visit," "client to
  send metrics").
- **Dependencies** — what we're waiting on from the client (softened language,
  **not** "blockers"; **risks are folded in**, not a separate negative box).
- **Third tile — OPEN (see §6).**

**G. PR Coverage module** — a **scrolling** feed of PR hits (~5 visible) for
clients with PR — "client wins." Lives at the bottom of the Executive Summary.

---

## 3. Retainer vs Project — What Differs

| Element | Retainer | Project |
|---|---|---|
| Burn module | Speedometer (monthly hours) | Pizza tracker (phase progress) |
| Due date in header | Hidden | Shown (completion date) |
| Service lines | Disciplines + % + **MoM history** | Allocation call-outs / spread |
| North Star | Monthly goal / Stratagem pillars | Project KPI |
| Backlog tab | Shown | Hidden |
| Milestones | Lighter / monthly | Full phase timeline |

---

## 4. Admin vs Client Behavior

Two builds, one project: **admin** = internal TJA team (full edit), **client** =
read-only on data tabs. Admins also have a **"Client view" preview toggle** to see
exactly what the client sees, without logging out — **hidden from clients**.

Every field on the Executive Summary is an editable admin control that renders
read-only in client view. **Manual-first: nothing auto-pulls in V1.**

---

## 5. Supporting Tabs (V1 scope)

- **Project Plan** — full plan: project name, outcome, optional deliverables,
  start / end dates, **condition (R/Y/G)**, and a status-report-style grid
  (item · update / next steps · status · owner · deadline · notes). The homepage
  milestones are the high-level extract of this.
- **Status** — service-line detail (where homepage service-line clicks land).
  This is the **target for the SAP + Status merge** the team is still defining;
  we build the container now and drop in the final format when ready.
- **Present Docs** — upload, versions, draw markup, pinned comments, resolve,
  approve / changes / revisions. Add **notification on comment / revision** later.
- **Files** — upload working / final files (both roles).
- **Backlog** — retainer-only list of ideas / efforts that don't fit the retainer
  (3+ months of retainer size → separate SOW). Brain-dump + upsell starter.

---

## 6. Open Decisions (need team input)

1. **Third bottom tile** — what goes in box 3 alongside To-Do's and Dependencies?
   (KPI tracker, service-line snapshot, or something else.)
2. **PR Coverage** — module on the Exec Summary (recommended) or its own tab?
3. **Notifications** — when a client comments / requests a revision on a Present
   Doc, do we want a Slack message (most feasible), email, or an in-portal flag?
   (WorkMagic routing is a separate question, likely later.)
4. **Monthly sign-off** — build approve / reject monthly sign-off here to replace
   the PandaDocs formality?
5. **Engagement naming** — confirm the convention ("Client — Engagement Type") so
   the Retainer / Project toggle labels read cleanly.

---

## 7. Notifications & Integrations (later phase, flagged now)

Present Docs comment / revision → push notification ("revision submitted"). Slack
is the confident path for V1; email / WorkMagic routing is TBD. Not a homepage
blocker.

---

## 8. Build Sequence

| Phase | Scope | Status |
|---|---|---|
| **1 — Foundation** | IA to the 6 tabs, Retainer/Project toggle, per-engagement data model, admin "edit every field" framework | Prototyped (v1.7) |
| **2 — Executive Summary** | Modules A–G for both variants, fully editable + client preview — **can go live first** | Prototyped (v1.7) |
| **3 — Supporting tabs** | Project Plan, Status, Backlog | Partially prototyped |
| **4 — Present Docs notifications + Files polish** | Notifications, refinements | Not started |
| **5 — Brand + real data + go-live** | Brand pass, real Celtic data, embed on thejamesagency.com | Not started |

---

## 9. Explicitly OUT of Scope for V1 (to keep it simple)

- Final SAP + Status **merged-document design** (defined separately; we build the
  container).
- Live **auto-pull** from Excel / WorkMagic / analytics — everything is manual.
- Moving **full reporting / decks** into the portal — stays in PowerPoint; at most
  a high-level "at a glance" + uploaded decks in Files.
- Real **backend / production auth / hosting** — still a local sandbox; the role
  model maps cleanly onto a real backend later.

---

## Reference: pages still to be designed into the build

- **Status page** (Google Sheet) — provided for reference; format to be ingested
  when we build the Status tab.
- **SAP page** (Google Sheet) — provided for reference; merges into Status.

*(Links held with the team; not yet ingested into the build.)*
