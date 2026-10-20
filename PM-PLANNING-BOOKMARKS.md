# Client Portal — PM Planning Session Bookmarks

An ongoing list of decisions to knock out in one comprehensive planning session
with the project-management team. Grouped by theme. (Maintained by Claude as we go.)

---

## 1. Projects: what counts as a "project"? (SOW vs retainer-rolled) ⭐ blocker
**Decision:** Only campaigns with their **own SOW** should become projects. Small
2-hr one-offs that are **rolled into a monthly-services retainer** should NOT be
projects.

**✅ Interim fix shipped (v1.90):** admins can now **archive** any auto-synced project
from the Projects folder (📁, mirrors the Clients page pattern) — it's hidden from the
client but recoverable in an admin-only Archived tab. Lets the team manually prune
small non-SOW campaigns today, without waiting on WMJ. The durable fix (a real WMJ
Project Type field) below is still the long-term answer.

**The problem — the sheet can't tell us this today.** Findings from the WMJ export
(51 billable campaigns):
- There is **no SOW / billing-type flag** in the columns we have.
- The `(123)` budget suffix is **not reliable** — only ~22/51 campaigns have it, and
  several clearly-real SOWs **lack** it (RCS Website Redesign 196h, DNA Stratagem
  435h, DEL Stratagem 669h all have no number). So `(xxx)` ≠ SOW.
- **Size doesn't cleanly separate** either (no-number campaigns range 0.5h → 669h).

**Recommendation (decide here):**
- **Best / reliable:** ask the WMJ admin to add one native field to the export —
  **Project Type** (or **Billing Type / Contract Type**, or a budget/contract #).
  WMJ already distinguishes retainer vs project work; this is a standard field and
  is the single source of truth for "is this a SOW project." (Different from the
  `wmjName` mapping column we declined — this is real source data, high value.)
- **Interim (no WMJ change):** keep project-creation **admin-curated** — auto-pull,
  but let an admin mark/hide which campaigns clients see as projects (we can reuse
  the archive pattern). Avoid auto-hiding by size (would hide real small SOWs).

## 2. Retainer ↔ project overlap (how to navigate)
A lot of small 2-hr tasks are **completed within monthly-services retainers**, not as
standalone projects. Need to decide how the portal represents work that lives in a
retainer vs a project — and how WMJ data for each is surfaced without double-counting
or confusing the client. (Ties into #1.)

## 3. Standardized phase sets per project TYPE ⭐ high-impact
The pizza tracker phases currently = raw WMJ Project_Names. That breaks differently
per type:
- **Stratagem:** many workstreams (good tracker, but some names are internal-ish:
  "Internal & Client Kickoff", "Ongoing Client Services").
- **Website build (e.g. RCS):** ALL work sits under **one** Project_Name → the
  tracker shows a **single useless dot at 0%**, while the real phases live in the
  numbered task names ("1 …", "2 Phase 1 - Homepage Coding").

**Decide:** a standard phase set per project type (Website, Stratagem, Brand,
Creative/Collateral, Video, PR…) e.g. Discovery → Strategy → Design → Build → Launch,
and a rule mapping WMJ rows → those phases.

## 4. Friendly project display names
Raw campaign codes ("DEL Stratagem - One Time Deliverables", "AHS Website Phase 2
(450)") are internal. Decide naming rules / a manual override for client-facing names.

## 5. Empty Milestones / To-Do's / Dependencies on project pages
No WMJ source today. Decision so far: **leave them for manual entry.** Revisit whether
to auto-populate any from WMJ (e.g. To-Do's = client-owed tasks) or hide when empty.

## 6. Multiple projects per client — surfacing
Approved direction: **Major projects as cards**, split **In Progress / Completed**
(building now). Quick-wins rollup intentionally **dropped** (small things shouldn't be
projects at all — see #1). Confirm the picker/landing behavior with the team.

---

## Action item — connect Claude to WMJ (read-only) ⏳ Cameron to set up
Get Claude read access to WMJ to resolve #1 with real data. Steps:
1. WMJ admin: create a **read-only user** (view-only security group — no edit rights).
2. Generate that user's **User Token**.
3. Generate the account **API Access Token**: Menu → Admin/Manager → System Setup →
   Account Information → Connections → API → *Generate New API Access Token*.
4. Note the **WMJ base URL**.
5. Put base URL + both tokens in a local file **outside the repo**: `~/.wmj.env`
   (never paste tokens in chat, never commit them).
6. Tell Claude it's there → Claude writes a read-only Reports-API fetch, tests it,
   and explores the project-type / SOW fields.
Read-only is enforced 3 ways: view-only user → read-only Reports API → Claude's
commitment. Live portal↔WMJ feed is a SEPARATE server-side build (Supabase/Option B)
— secrets can't live in client-side code.

## Present Docs — automated review reminders (later)
Now that we capture upload date+time, review-submitted date+time, and an editable
**Revisions-due** date per version, wire **automated reminders** off those dates
(e.g. nudge the client when a review is overdue, remind TJA when revisions are due).
Needs the backend (Supabase/Option B) + a notification channel (email/Slack) — can't
run from a static client-only site.

## TapClicks dashboards inside the portal (later) 🔖 bookmarked 2026-10-20
Goal: show each client's TapClicks dashboard in the portal (the Reporting page).

**What we found (research, Oct 2026):**
- **Permalink** (announced 2026-09-17): a no-login share link to a live dashboard. The
  creator picks View-Only or Interactive, can lock the date range, limit sections, set an
  expiry, and choose **whether the link may be embedded elsewhere**. Included at no extra
  cost on "eligible packages" (which ones isn't stated).
  → Best route: paste a Permalink into the client's Reporting link. The portal only embeds
  hosts it knows can be framed (`reportingEmbedUrl` in `app.js`), so add the TapClicks
  Permalink host once we have a real link to test.
- **Data Exporter**: scheduled/on-demand export of TapClicks data to PostgreSQL, BigQuery,
  Snowflake, S3, SFTP… Supabase is Postgres, so it could feed portal-native KPI tiles.
  Heavier build; whether it's a paid add-on isn't stated.
- **General API**: no public developer docs found; reviews mention "an API for custom
  integrations". Ask the rep.

**Next steps:**
1. Ask the TapClicks rep: is Permalink on our package (with embedding allowed)? Can a
   Permalink be set not to expire? Is the Data Exporter / a read API included?
2. Send Claude one Permalink → allow-list its host in `reportingEmbedUrl`, test the embed.
3. Later, if wanted: Data Exporter → Supabase → our own KPI tiles.

Sources: tapclicks.com/blog/tapclicks-permalink-share-live-dashboards-without-logins ·
tapclicks.com/tapclicks-data-exporter

## Smaller / later
- ✅ **Done (v1.90):** client-tile footer now shows a live "Monthly Services · N
  projects" count computed from real dashboard state, not the static string stamped
  at creation.
- Confirm `(xxx)` = contracted hours with WMJ (and whether to display it to clients).
- ✅ **Done (v1.90):** engagement-mode default now checks actual data (retainer vs
  projects) instead of always opening Monthly Services — and is scoped per client so
  an admin's last-used mode doesn't leak between clients in the same tab.
- **Actual vs allocated hours:** the sheet only has *allocated*. Ask WMJ to expose
  *actual/logged* hours → enables a true burn instead of "allocated of budget."
- **Production backend (Option B):** move the WMJ sync to a Supabase Edge Function +
  cron so it's always-on (not just when a browser is open) and the data isn't behind
  a public CSV URL. Needed before real client launch.
