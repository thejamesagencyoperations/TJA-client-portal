# TJA Client Portal — Sandbox

A front-end-only prototype of The James Agency client portal, built to present
the concept internally. **No backend, no real auth, no data wiring** — every
number is placeholder/sample data for now.

## Run it locally

From this folder:

```bash
python3 -m http.server 8080
```

Then open **http://localhost:8080** in your browser.

## Demo logins (two roles)

| Role            | Email                                | Password         | Can do                                                              |
| --------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------ |
| **Client**      | `celticelevator@thejamesagency.com`  | `celticelevator` | Read-only data tabs; upload Files; comment/draw/approve Present Docs |
| **Admin (TJA)** | `clientservices@thejamesagency.com`  | `admin`          | Everything — upload deliverables/files, manage versions, rename     |

Admin sees a **Mode** switch (Admin / Client view) in the top bar to preview the
client experience without logging out. **Clients never see this switch.**

> ⚠️ The login is a **client-side demo gate only** — it does not secure anything.
> Real authentication comes in a later phase.

## Pages (V1 — per the 06/16 workshop)

| Tab                   | Purpose                                                            |
| --------------------- | ----------------------------------------------------------------- |
| **Executive Summary** | The home page — burn, condition, service lines, milestones, to-dos, dependencies, KPIs, PR coverage. All editable by admin. |
| Project Plan          | Full plan w/ line items (replaces "Key Dates")                    |
| Status                | Service-line detail (target for the SAP + Status merge)          |
| Present Docs          | Creative review — upload, version, draw, pin comments, approve   |
| Files                 | Signed agreements + shared docs (both roles upload)              |
| Backlog               | Retainer-only — SOW conversation starters                        |

A **Retainer / Project** toggle at the top switches between engagement homepages
(burn speedometer for retainers, Domino's-style pizza tracker for projects).

## Swapping in real data

All content lives in **`assets/data/celtic-elevator.js`**. Edit that one file —
nothing else needs to change.

## Brand

Colors/fonts in `assets/css/styles.css` are **placeholders** (inferred orange
`#FF7800` + Inter). Drop in the official TJA brand guide and we re-skin via the
CSS tokens at the top of that file.

## Version log

| Version | Notes                                                                    |
| ------- | ------------------------------------------------------------------------ |
| v1.0    | Initial sandbox: login + 6 pages (Burn, SAP, Status, Key Dates, Docs, Files) with Celtic Elevator placeholder data and the burn dial gauge. |
| v1.1    | Present Docs rebuilt as an interactive creative-review tool: upload image creatives, click to enlarge, draw markup on the image (color pen, undo, clear), pick a status (Approve / Approve w/ changes / Revisions needed), and leave comments. Images downscaled + stored in localStorage. Removed placeholder doc cards. |
| v1.2    | Present Docs deliverables + versions: each tile is a deliverable holding V1/V2/V3… (resubmit adds a version; memory-log chips switch between them). Added a tool switch (Draw / Comment), true stroke-by-stroke Undo, pinned comments (click image to drop a numbered note), fit-to-screen image (no scrolling), and inline tile rename. Migrates v1.1 uploads automatically. |
| v1.3    | Fixed image fit (now `object-fit: contain` against a proper height cascade — the whole image always shows, overlay sized to the displayed picture rect, not natural pixels). Unified Undo now reverts pen strokes, Clear, AND comment-pin add/delete (button always visible + ⌘/Ctrl+Z). |
| v1.4    | Redesigned the comments side panel into proper comment cards: header with live count + **Clear all** (undoable), per-comment **resolve** (✓ dims the card + turns the pin green) and **delete**, and two-way highlight — click a comment to pulse its pin on the image and vice-versa. |
| v1.5    | **Admin vs Client modes.** Role tied to login (admin = full edit, `celticelevator@` = read-only data + can upload Files & review Present Docs). Admin-only **Mode switch** previews the client view without logging out (hidden from clients). Files tab now has a working **Upload File** (both roles, attributed by source; admin can remove uploads). Present Docs upload/new-version/rename/delete are admin-only. |
| v1.6    | Renamed the admin account to `clientservices@thejamesagency.com` (password `admin`). |
| v1.22   | **Supabase integration (gated).** Wired the portal to Supabase for a live, shared, multi-user product: real **Auth**, and the three data scopes (dashboard / files / deliverables) read/written to an `app_state` JSONB table with **Row-Level Security**. New files: `supabase/schema.sql`, `assets/js/supabase-config.js`, `assets/js/supabase-sync.js`, `SUPABASE_SETUP.md`. **Fully backward-compatible:** with blank config the app runs on localStorage exactly as before; pasting your project URL + anon key flips it to Supabase automatically (auth + shared data, localStorage as cache). See `SUPABASE_SETUP.md` for the 5-step go-live. |
| v1.21   | **Bug fixes: kanban drag + empty client view.** Tile drag was firing twice (tile + its column both handled the drop), sending tiles to the column end instead of the drop position — fixed with `stopPropagation`; drop-on-self is now a no-op and placement is precise. Added a **layout safety net**: de-dupes/validates module keys and, if both columns ever end up empty, restores the default — which fixes the **"client view empty"** regression (caused by a corrupted layout saved by the old drag bug). |
| v1.20   | **Project Plan + Status polish.** The **Status** tab is now editable like the rest (inline fields, click-to-cycle status, add/remove efforts & service-line groups) and shows a **completion count per service line** ("1/2 complete") — it fills the page instead of sitting as a bare read-only table. Added matching **section icons** (flag / list / risk) to the Project Plan headings for visual consistency. Both tabs use the full width. |
| v1.19   | Three fixes: (1) removed the 1180px content cap so the dashboard **uses the full width** — the right-side space is no longer locked off; (2) **milestones** redesigned — the tiny ✓/✕ replaced with a large **clickable check-circle** (fills green + strikethrough when done) and a hover-reveal delete; (3) the project **pizza tracker is now sequential** — clicking an undone phase fills up to it, clicking a done phase clears it *and everything after* (un-selecting phase 3 also un-ticks 4+). |
| v1.18   | **Drag tiles + draggable speedometer.** Replaced the kanban arrow buttons with **drag-and-drop** — grab a tile by its **header** to rearrange it within or across columns (subtle ✕ on hover removes a tile). The retainer **speedometer is now interactive**: drag the needle to set burn, or edit the **% directly** (used hours are derived from % of the contract total — no more typing raw burn hours). Verified live: header-drag reorder + cross-column move + persistence, and gauge drag/%-edit. |
| v1.17   | **Deep visual review + layout.** Fixed visual bugs found on review: the always-on orange **edit boxes** were noisy (every field boxed) → now subtle, revealing on hover / clear on focus, and empty fields show a faint dash instead of an orange pill; **orange text was low-contrast on white** → added a darker `--accent-text` for text-on-light (links, owner tags, PR outlets, KPI values). Restructured the Executive Summary into a **2-column kanban**: **PR Coverage now lives in the right column** (compact: outlet/date · headline · impressions/ad-value) instead of a full-width scroll-down, and admins can **move (↑↓), send across columns (←→), and remove/restore tiles** — layout persists per engagement. |
| v1.16   | **QA sweep + bug fix.** Exercised every control across all tabs, both themes, and both roles (nav, engagement toggle, theme, role/preview, undo, all Exec Summary edits + cross-links, Project Plan folders/New+Delete/cycling/add-remove/edits, Present Docs, Files, Backlog, login gate, sign-out, auth guard). **Fixed a real bug:** the Present Docs markup overlay sized to 0×0 on modal open (single `requestAnimationFrame` fired before layout), so drawing + comment pins silently failed — now retries until the image is decoded & laid out, and handles cached images. Everything else passed. |
| v1.15   | **Brand standards (brand-standards-V2).** Adopted the official palette — TJA Orange `#F68E21` (subtle accent), TJA Gray `#5F6165`, data-viz teal/blue/cool-gray tokens — over a black/white base. Typography now follows the guide: **headlines in Inter Black, ALL CAPS, 0 tracking**; body in **Inter Light** with light tracking (loaded weights 300/900). Added **custom line icons** to every Executive Summary module header and swapped the North Star ★ for the brand **bolt** motif. |
| v1.14   | **Editorial polish pass.** Light mode is now the **default** (matches thejamesagency.com first impression; still toggleable + persisted). Added subtle **card depth** (shadows) in light mode, more **whitespace** (roomier padding/gaps), and refined **typography** (larger, tighter headings; softer eyebrow labels). The Present Docs review modal now stays **dark in both themes** (ideal for reviewing imagery) via scoped token overrides. |
| v1.13   | **Visual system + light/dark mode.** Refactored colors into themeable tokens; added a **light mode** (editorial/airy, inspired by thejamesagency.com) alongside the refined dark mode, toggled by a topbar sun/moon button (persisted, flash-free on load). Introduced a brand **gradient** (orange→teal) on primary CTAs "where it makes sense," kept orange as the primary accent. Gauge + surfaces made theme-neutral for readability in both modes. |
| v1.12   | **Undo (admin)** — every dashboard-data edit funnels through one undo stack; an **↶ Undo** button in the topbar (with a count) plus **⌘Z / Ctrl+Z** revert the last action (admin only; native text-undo still works inside a field). Retainer **burn is now clearly editable** (the "X of Y hrs used" numbers are inline-editable and update the gauge live). Added a **migration** so older saved data (pre-`projects[]`) upgrades automatically — fixes the "Project disappeared" issue caused by stale localStorage. |
| v1.11   | **Multiple projects per client** + **editable Project Plan.** Each client now holds an array of projects (Website Redesign, Brand Refresh…); the top toggle lists Retainer + one chip per project, and the Project Plan tab has a **project folder bar** to switch between them. Admins can edit the whole plan inline — click R/Y/G dots and status badges to cycle, edit any field, ＋ add milestones/phases/tasks/risks, rename/delete a project. **＋ New Project** spins up a plan pre-seeded with a Discovery→Launch phase skeleton, and Status shows a live "tasks avg %" roll-up hint. All admin-only; client view stays read-only. |
| v1.10   | Ingested the two reference Google Sheets and built **Step 4** to the real formats. **Project Plan** tab rebuilt: Outcome + R/Y/G status header, a **Key Milestones / critical-path** table (R/Y/G · item · owner · target · why · action), a phased **Detailed Plan** task list (# · task · who · window · % progress · status · notes), and a **Risks & Watch Items** table. **PR Coverage** module now matches the real tracker columns — Date · Outlet · Headline · Impressions · Ad Value. (The two Sheets turned out to be a Project Plan and a PR Coverage report, not Status/SAP — the SAP+Status merge is still being defined by the team.) |
| v1.9    | Real **Celtic Elevator logo** (white background removed via corner flood-fill → transparent PNG at `assets/img/celtic-elevator-logo.png`) now replaces the "CE" orange box in the topbar avatar and the Executive Summary header. Driven by `client.logo` in the data (falls back to initials for clients without a logo). |
| v1.8    | Executive Summary hardening pass: fixed the scroll/layout (sidebar + topbar now pin cleanly while `.main` scrolls — no more black gap), balanced the two-column rows (`align-items: start`, condition card no longer half-empty), and added admin edit affordances — hover states + tooltips on the condition dots, pizza phases, service-line status, owner tags, and MoM chips so it's obvious what's clickable. |
| v1.7    | **V1 restructure (06/16 workshop).** New **Executive Summary** homepage with modules: burn (speedometer for retainers / pizza tracker for projects, manual — projected depletion removed), R/Y/G condition, service lines + month-over-month, milestones timeline, To-Do's, Dependencies, KPIs, scrolling PR coverage. **Retainer/Project engagement toggle.** Every homepage field is admin-editable inline (persisted to localStorage) and read-only in client view. Tabs reorganized to Executive Summary · Project Plan · Status · Present Docs · Files · Backlog (retainer-only). |
