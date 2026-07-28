# HANDOFF — TJA Client Portal

**Purpose:** everything a new maintainer needs to run, fix, and own the TJA
Client Portal without the person who built it. Nothing here is tied to any one
individual's personal account — this doc confirms that and points to the
TJA-controlled logins behind each piece.

> **Security note:** this file names *where* secrets live and *what they're
> called* — it never contains a secret value. Do not paste keys, tokens, or
> passwords into this file. It is in a **public** repo.

Last verified: 2026-07-27 · Code version: see [`version.json`](version.json) (327 at handoff).

---

## 1. What this is

A static HTML/CSS/JS client portal (no build step) served by **GitHub Pages**,
backed by **Supabase** (auth + database + Edge Functions). Clients log in to see
their dashboard, project plans, retainer burn, and Present Docs (deliverable
review/approval). Staff (admin / AM-PM / creative / paid-media) manage all of it.

- **Live URL:** https://thejamesagencyoperations.github.io/TJA-client-portal/
- **Deploy:** push to `main` → GitHub Pages rebuilds in ~30s. No CI build; the
  repo *is* the site. `.nojekyll` is present so Pages serves files as-is.
- **Cache-busting:** page assets are versioned with `?v=NN`; bump on asset
  changes. `version.json` holds the current number.

---

## 2. Ownership map — all TJA-controlled (confirmed 2026-07-27)

| Asset | Where it lives | Owner / access | Status |
|---|---|---|---|
| **Code repo** | GitHub `thejamesagencyoperations/TJA-client-portal` (public) | GitHub account `thejamesagencyoperations` — recovery email + 2FA are TJA-controlled | ✅ |
| **Auth + database + Edge Functions + secrets** | Supabase project `sliutkbdpuimxxmvsbek` | TJA-owned, multiple people have access | ✅ |
| **Outbound email** | Resend | TJA-owned account | ✅ |
| **Google Drive/Sheets** (project plans, assignment workbook, history folder) | Google Shared Drive | Shared drive (not a personal Drive) | ✅ |
| **Drive/Sheets API access** | Google Cloud service account | GCP project under a TJA identity; SA address is `…@<project>.iam.gserviceaccount.com` (never a personal email) | ✅ |
| **Slack notifications** | Slack app `tja_client_dashboard_` in the TJA workspace | App has ≥2 collaborators (not a single-owner app) | ✅ |
| **Sending-domain DNS** | Network Solutions | Held by Veronique (WHOIS registrant) — see [`DNS-SETUP-RESEND.md`](DNS-SETUP-RESEND.md) | ✅ |

**There is no dependency on any individual's personal email anywhere in the
codebase.** The portal admin is a shared role account (see §4), not a person.

---

## 3. Secrets inventory (names only — values live in the dashboards above)

**Supabase → Project Settings → Edge Functions → Secrets:**

| Secret | Used by | What it's for |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | all functions | Supabase API access (service-role = admin writes) |
| `SNAPSHOT_SECRET` | all cron functions | Shared gate — the `x-snapshot-secret` header every scheduled call must present. **Also stored as a GitHub Actions repo secret** (see §5) — the two must match. |
| `GOOGLE_SA_KEY` | `_shared/google.ts`, plan/drive/history functions | base64 of the Google service-account JSON key |
| `RESEND_API_KEY` | all email functions | Resend send key |
| `PORTAL_FROM_EMAIL` | email functions | From address (e.g. `noreply@thejamesagency.com`) |
| `SLACK_BOT_TOKEN` | `_shared/slack.ts` | Bot token for the Slack app |
| `SLACK_DEFAULT_CHANNEL` | `_shared/slack.ts` | Fallback channel when a client has no per-client channel |
| `PAID_MEDIA_EMAIL` | `media-intake` | Where media-request notifications go |
| `DRIVE_HISTORY_FOLDER_ID` | `history-snapshot` | Drive folder for daily snapshots/archive (function returns 428 until set) |
| `DRIVE_WEBHOOK_URL` | `drive-watch-setup` | Instant plan-push receiver — **inert until a custom domain exists** (see §7) |

**Public (safe, committed) config:** [`assets/js/supabase-config.js`](assets/js/supabase-config.js)
holds only the Supabase URL + **anon** key — both are designed to be public.

**Never committed:** no service-account key, `.env`, or token is in the repo.
`.gitignore` excludes `scripts/users.json*` (the provisioning password list) and
`supabase/.temp/`.

---

## 4. The admin account + password recovery

- The portal's built-in admin is the shared account **`clientservices@thejamesagency.com`**
  (role `admin`), defined in [`assets/js/auth.js`](assets/js/auth.js). It is a
  role account, not a person.
- The **real password is stored hashed in Supabase Auth** — it is not in the
  repo and cannot be read by anyone (the `"admin"` string in `auth.js` is a
  disabled offline-demo mock; production uses `ALLOW_MOCK_FALLBACK = false`).
- **To recover / reset it, two TJA-controlled paths (either works):**
  1. **Supabase** → Authentication → Users → `clientservices@thejamesagency.com`
     → set a new password (or "Send recovery").
  2. The portal's **"Forgot password?"** link on the sign-in page — the reset
     email is sent to `clientservices@thejamesagency.com`, so anyone who can read
     that mailbox can reset it.
- **Recommendation:** keep the current password in TJA's shared password manager
  so day-to-day login doesn't require a reset.

### Roles (defined in `auth.js`)
- **admin** — the agency account. Everything, plus logins (Admin Center), Backup
  & Sync, and deleting. Enforced in Supabase RLS, not just the UI.
- **manager** (AM/PM) — full edit on their tagged clients, reads all; no deletes.
- **creative** — read-any, uploads Present Docs into the waiting room only.
- **media** (paid media) — reads all, triages media requests; no edits/uploads.
- **client** — read-only on their own data; uploads Files + reviews Present Docs.

Real staff/client accounts are provisioned in Supabase Auth (see §8), not
hardcoded.

---

## 5. Scheduled jobs (GitHub Actions → Supabase Edge Functions)

All live in [`.github/workflows/`](.github/workflows). Each is a cron that POSTs
to a Supabase function with the `SNAPSHOT_SECRET` header (stored as the GitHub
Actions repo secret **`SNAPSHOT_SECRET`** — must equal the Supabase one). The
anon key in these YAMLs is the public key; it's fine that it's visible.

| Workflow | Schedule (UTC) | Triggers function | Does |
|---|---|---|---|
| `plan-refresh.yml` | every 5 min | `plan-refresh` | re-pull project plans from Drive |
| `monthly-snapshot.yml` | daily 06:00 | `snapshot-months` | freeze each retainer client's month-end burn |
| `history-snapshot.yml` | daily 09:00 | `history-snapshot` | daily Drive snapshot + archive audit rows >45d |
| `feedback-reminders.yml` | daily 17:00 | `feedback-reminders` | nudge clients who haven't reviewed a deliverable |
| `assign-sync.yml` | daily 16:30 | `assign-sync` | sync AM/PM assignments from the assignment workbook |
| `drive-watch-renew.yml` | every 6h | `drive-watch-setup` | renew Drive push webhooks (inert until `DRIVE_WEBHOOK_URL` set) |

You can run any of them by hand: **GitHub → Actions → pick the workflow → Run
workflow.**

---

## 6. Edge Functions (`supabase/functions/`)

Deployed to Supabase, not GitHub Pages. Shared helpers live in `_shared/`
(`google.ts`, `slack.ts`, `email.ts`, `cors.ts`, `plan.ts`).

| Function | Role |
|---|---|
| `manage-users` | create/update auth users (Admin Center backend) |
| `request-password-reset` | public "forgot password" → emails a reset link |
| `plan-fetch` / `plan-refresh` | read/parse project plans from Drive |
| `drive-upload` / `drive-watch-setup` / `drive-webhook` | Drive file writes + instant-push plumbing |
| `history-snapshot` / `snapshot-months` | history + monthly burn snapshots |
| `send-deliverable-email` / `send-review-notification` / `feedback-reminders` | Present Docs emails |
| `send-pr-win` | posts PR wins to `#tja-pr_wins` in Slack |
| `media-intake` | paid-media asset-request intake + notify |
| `assign-sync` | AM/PM assignment sync |

**Deploy a function** (needs the Supabase CLI, logged into the TJA project):
```bash
supabase functions deploy <name> --use-api
```
Public/unauthenticated ones (like `request-password-reset`) additionally use
`--no-verify-jwt` — the header comment in each function's `index.ts` states its
exact deploy command.

---

## 7. Known "built but inert" features (no action needed unless pursuing them)

- **Instant project-plan push (Drive webhook):** fully built + deployed but
  dormant. It needs a Supabase **custom domain** (Google refuses to push to
  `*.supabase.co`) + Google domain verification. Until then `drive-watch-setup`
  returns HTTP 428 (harmless) and the 5-min `plan-refresh` poll covers it.
- **File storage:** `assets/js/file-store.js` has `STORAGE_ENABLED = false` — a
  deliberate kill switch until a final Drive destination for uploaded files is
  chosen. Uploads don't persist anywhere while it's off.
- **`DRIVE_HISTORY_FOLDER_ID`** — set this Supabase secret to a shared-Drive
  folder to turn on daily history snapshots (function returns 428 until set).

---

## 8. Common maintenance tasks

- **Add / edit a login (staff or client):** sign in as admin → **Admin Center**.
  Bulk/scripted provisioning: [`scripts/provision-supabase-users.mjs`](scripts/provision-supabase-users.mjs)
  (reads a gitignored `scripts/users.json`; never commit that file).
- **Back up all data:** admin → **`backup.html`** (export/restore/push-to-cloud),
  or [`scripts/backup-supabase.mjs`](scripts/backup-supabase.mjs) → dumps to
  `~/TJA-portal-backups/<timestamp>/`.
- **Database schema:** `supabase/schema-*.sql` files, applied in the Supabase SQL
  editor in order. The newest is the current shape; each is additive.
- **Change something on the site:** edit the HTML/JS, bump the `?v=NN` on changed
  assets + `version.json`, commit, push → live in ~30s.
- **Local preview:** `node server.js` serves the folder on `:8082` (the hardcoded
  path in `server.js` is local-dev only — irrelevant to production).

---

## 9. Day-1 checklist for a new maintainer

1. Get added to: the **`thejamesagencyoperations`** GitHub account/collaborators,
   the **Supabase** project, the **Google Cloud** project + **Shared Drive**, the
   **Resend** account, and the **Slack** app collaborators.
2. Get the **`clientservices@thejamesagency.com`** portal password from the shared
   password manager (or reset it via Supabase — §4).
3. Read [`CLAUDE.md`](CLAUDE.md) (conventions) and [`README.md`](README.md)
   (full version-by-version history of what shipped and why).
4. Confirm the crons are green: **GitHub → Actions**.
5. Confirm functions are healthy: **Supabase → Edge Functions → logs**.
6. Make a trivial edit + push to confirm the Pages deploy pipeline works for you.

---

## 10. Where to read more

- [`CLAUDE.md`](CLAUDE.md) — repo conventions for future work.
- [`README.md`](README.md) — detailed changelog / rationale per version.
- [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md) — Supabase project setup.
- [`DNS-SETUP-RESEND.md`](DNS-SETUP-RESEND.md) — email domain/DNS (Resend).
- Each Edge Function's `index.ts` header comment — its own setup + deploy notes.
