# Workamajig → Client Portal — Proposed Integration Approach

**Purpose:** Share how we're proposing to feed Workamajig (WMJ) data into the new TJA
Client Portal so we can compare it against how you have WMJ set up and make sure the two
line up before we build anything.

**TL;DR:** Rather than wiring the portal straight into WMJ's API, we'd put a **Google
Sheet in the middle** as a staging layer: **WMJ → Google Sheet → Portal.** We'd start with
**monthly retainer burn** (the speedometer) to prove the pipeline, then expand.

---

## The goal

Each client's dashboard (burn speedometer, service lines, project status, etc.) should
reflect what's actually in Workamajig — **without anyone re-keying numbers by hand.**

## Why a Google Sheet in the middle (instead of portal ↔ WMJ directly)

1. **De-risks WMJ.** WMJ's API is token-protected and a bit fiddly; a Sheet is a stable,
   predictable "contract" we fully control.
2. **Transparent & editable.** You and the team can *see* the numbers, sanity-check them,
   or hand-override a value before it shows to a client — all in a familiar tool.
3. **No WMJ passwords/keys live in the portal.** The portal only ever reads the Sheet.
4. **We can build the whole portal side now** — even with a Sheet you fill in manually —
   and automate the WMJ → Sheet feed afterward. Nothing is blocked waiting on the API.
5. **Future-proof.** If we later want it fully live, we swap the "read the Sheet" step for
   "read WMJ directly" and *nothing downstream changes.*

## How it flows (plain English)

```
  Workamajig  ──(export / Zapier / manual)──▶  Google Sheet  (tidy tabs & columns)
                                                     │
                                                     ▼
                                      small scheduled job reads the Sheet,
                                      maps it to the portal's data shape
                                                     │
                                                     ▼
                                        Client Portal dashboard updates
```

- The portal **never talks to WMJ directly** — it reads a cleaned, cached copy.
- Refresh can be on a schedule (e.g. nightly / hourly) or on demand.

---

## Proposed Google Sheet structure

One **tab per dataset**, tidy columns, one row per record. Starting set:

### Tab 1 — `Monthly Burn` (drives the burn speedometer + month-over-month)

| Client          | Month   | Contracted Hrs | Used Hrs |
| --------------- | ------- | -------------- | -------- |
| Celtic Elevator | 2026-06 | 113            | 72       |
| Celtic Elevator | 2026-05 | 113            | 113      |
| Celtic Elevator | 2026-04 | 113            | 108      |

*(The portal calculates the % automatically — we only need contracted vs used.)*

### Tab 2 — `Service Lines` (drives the Service Lines module)

| Client          | Service Line     | Allocation % | Status      |
| --------------- | ---------------- | ------------ | ----------- |
| Celtic Elevator | Strategy & Brand | 22           | In Progress |
| Celtic Elevator | Organic Social   | 30           | In Progress |
| Celtic Elevator | Public Relations | 18           | Not Started |

### (Later) Tab 3 — `Projects`, Tab 4 — `Status`, etc.

Same idea — we'll design these once Burn is proven. The portal already has the project
plan, status, milestones, and pizza-tracker views ready to receive data.

> **Key principle:** the **column headers stay fixed.** As long as the headers don't
> change, we can keep pulling automatically. Add rows freely; don't rename columns.

---

## How WMJ data gets *into* the Sheet (your call — this is the part we need your input on)

Any of these work; we can mix-and-match per dataset:

| Option | What it is | Best for |
| --- | --- | --- |
| **WMJ scheduled report export** | A saved WMJ report that exports to a Sheet/CSV on a schedule | If WMJ already produces the report you need |
| **Zapier / Make automation** | "When X in WMJ → add/update a row in the Sheet" | Hands-off, no code, near-real-time |
| **Manual (to start)** | Paste/maintain the Sheet by hand | Proving the pipeline today; low volume |

We can start **manual** to get the portal working end-to-end this week, then automate.

---

## Proposed rollout

- **Phase 1 — Prove it (Burn):** finalize the `Monthly Burn` tab → populate a few rows →
  portal reads it → speedometer reflects the Sheet. *(Manual data is fine here.)*
- **Phase 2 — Automate the feed:** set up WMJ → Sheet (export or Zapier) so it stays
  current on its own.
- **Phase 3 — Expand:** add Service Lines, then Projects/Status, same pattern.
- **Phase 4 — (Optional) Go fully live:** replace the Sheet with a direct WMJ API call if
  we want real-time and decide the token-handling is worth it.

## One note on sensitive data

If a dataset includes **financials ($ budgets, invoicing)**, we'll read the Sheet
*privately* (via Google's API with a service account) rather than a public link. For
hours/status, a simpler public read is fine. We'll choose per dataset.

---

## What we need from you (so we can confirm we're aligned)

1. **How do you currently have WMJ set up?** Which reports/exports do you already run, and
   where does the data live today?
2. **Field mapping:** in WMJ, where do these come from —
   - monthly **contracted** hours vs **used** hours (per client)?
   - hours/allocation **by service line**?
3. **Refresh cadence:** how fresh does this need to be — daily, hourly, real-time?
4. **Sensitivity:** are we including any financials, or just hours/status to start?
5. **Ownership:** are you happy to own/maintain the Sheet (at least for Phase 1), or do
   you want it automated from day one?

If the structure above matches how you're already pulling things, great — we'll build to
it. If you do it differently, tell us how and we'll adapt the tabs to match.

---

*Prepared by the portal build (Cameron) — TJA Client Portal · Workamajig integration, Phase 1 proposal.*
