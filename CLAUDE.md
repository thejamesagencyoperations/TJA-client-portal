# CLAUDE.md — TJA Client Portal

Briefs future Claude sessions on this repo's conventions. Dev/build details
only — the strategy, PM decisions, and project history live in the private
`TJA-claude-memory` repo (auto-loaded as Claude memory), plus `README.md` (full
changelog), `CLIENT-DASHBOARD-V1-PLAN.md`, and `PM-PLANNING-BOOKMARKS.md`.

## Repo at a glance

Front-end-only prototype of The James Agency client portal. **No backend, no
real auth** — a static HTML/CSS/JS sandbox deployed via GitHub Pages at
`https://thejamesagencyoperations.github.io/TJA-client-portal/`. No build step.
Push to `main` → deploy in ~35s (GitHub Pages has occasionally run 5–10 min).

### Pages
- `index.html` — mock login / landing.
- `clients.html` — multi-client picker (admin), live per-client engagement counts.
- `dashboard.html` — the app. Left-nav tabs: Executive Summary, Status, Present
  Docs, Reporting, Files, Backlog. Retainer ⟷ Projects engagement toggle up top.

### Structure
- `assets/js/` — self-contained modules. Key ones:
  - `app.js` — routing, page renderers (Status, Backlog, Files, Project Plan),
    shared `window.DASH` state + admin-edit helpers.
  - `exec-summary.js` — the whole Executive Summary (burn/pizza, service lines,
    milestones, to-dos, dependencies, KPIs, PR coverage) + the **hard-locked
    free-canvas layout** (`DEFAULT_RETAINER_FREE` / `DEFAULT_PROJECT_FREE`).
  - `present-docs.js` — Present Docs (versions, draw markup, pinned comments,
    approve/sign-off, PDF export).
  - `wmj-transform.js` / `wmj-sync.js` — Workamajig project/task import + rules.
  - `retainer-transform.js` / `retainer-value.js` — retainer hours + the
    active-month value feed.
  - `client-store.js` / `clients.js` / `client-template.js` — client CRUD/seed.
  - `slack-wins.js` — curated PR-wins → Slack (dormant until `PROXY_URL` is set).
  - `supabase-*.js` — wired but `app_state` is empty; all state currently lives
    in each browser's **localStorage** (backend is a later phase).
- `assets/css/styles.css` — all styles + theme tokens (TJA orange `#FF7800`, Inter).
- `assets/data/` — seed client data.

## Versioning (do this on EVERY change to a local asset)
- Every local `<script>`/`<link>` carries a cache-buster `?v=NN`.
- The sidebar shows a version pill `Sandbox · vX.Y`.
- **Currently `?v=200`, pill `v2.0`.** Bump BOTH across `index.html`,
  `clients.html`, `dashboard.html` on any asset edit, and add a `README.md`
  changelog row. (Historic bumps were integer `?v=NN`; the pill tracks alongside.)

## Auth / roles
- Mock login: `clientservices@thejamesagency.com` / `admin` = **admin** (full
  edit). Client logins (e.g. `celticelevator@…`) = **read-only**.
- Admins have a **Client View** preview toggle to see exactly what a client sees.
- `isAdmin()` / `canAdmin()` / `canEdit()` gate every editable control.

## Live data — READ ONLY, never mutate
- **Workamajig**: two Google Sheets read via gviz CSV — projects sheet
  `1UpX-3ddqVsKpRXYENCARUXBTgU4QexZviO2XM2RyFio`, retainers sheet
  `1d-iwYnkA_rmdZyysRPz_b1X7zSucBBviIBwhzdlrj00`. **Never write to these — it
  would break agency operations. Hard stop.**
- **Retainer-value feed**: a read-only Apps Script (`doGet` only) off the
  revenue-forecasting workbook; `/exec` URL in `retainer-value.js`. Burn total =
  this month's billing ÷ rate — **never ÷12** (retainers are flighted).
- New clients that appear in the WMJ sheets **auto-import** (all data). The only
  manual per-client step is the per-discipline retainer hours split.

## Local dev / verify
- Preview server config `portal` in `.claude/launch.json` (`python3 -m
  http.server 8080`). Use the preview tools to verify UI changes headlessly.

## Deploy
- `gh auth switch --user thejamesagencyoperations` **before** pushing, then push
  to `main`. Poll the live version pill to confirm the deploy landed.

## Commit style
`Area: short subject (vX.Y)` + a bullet-list body. Always end with:
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Never
- Don't edit the Workamajig / revenue Google Sheets (read-only, above).
- Don't commit secrets (service-account keys, OAuth tokens, proxy URLs with keys).
- Don't add internal strategy/PM notes here — those belong in the private
  `TJA-claude-memory` repo, not the client-facing codebase.
