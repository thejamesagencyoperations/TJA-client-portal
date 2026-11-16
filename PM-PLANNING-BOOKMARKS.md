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

## Weekly status report email per client (to do) 🔖 added 2026-10-21
A weekly email per client that's a snapshot of the Executive Summary: burn, service
lines, sprint goals, to-dos (+ dependencies), KPIs, PR hits. Sent FROM the client's
account manager.
- **Sender:** the portal sends through Resend, and the whole `thejamesagency.com` domain
  is verified there, so any `@thejamesagency.com` address can be the From with no
  per-person setup — e.g. `Alex Duggan <alex@thejamesagency.com>`, Reply-To the same, so
  client replies land in the AM's real inbox. Caveat: it won't appear in the AM's Sent
  folder (could BCC them). AM = the client's registry `am` / manager tags.
- **Build sketch:** a scheduled edge function (pg_cron, e.g. Mon 8am Phoenix) renders the
  summary as an HTML email (same data the page uses, client-visible items only — internal
  dependencies / team-only tiles excluded), to the client's notification recipients.
  Decide: who receives it and the per-client on/off (Admin Center prefs).
- **AM review before it sends (required — Cameron 2026-10-21):** the AM gets a draft of
  each client's report ahead of the send time, can edit or correct it, then approves.
  Nothing goes to the client without that approval. (Open: if the AM hasn't approved by the
  send time, does it wait, or remind them and hold?)
- **Schedule set per client at account setup:** each client's send day + time is agreed at
  the start of the engagement, so it's a field in client setup (Clients → ✎ / Admin
  Center), editable at any time. The scheduler reads each client's own day/time — no single
  global send slot.
- **Customisable content, like Customize on the Exec Summary:** per-client tick boxes for
  what the report includes — e.g. burn numbers, service lines, sprint goals, to-dos,
  dependencies, KPIs, PR summary, SAP status. Stored per client and reused every week; the
  AM can still adjust a single week's draft during review.

## Book a meeting with the team, from the dashboard (to do) 🔖 added 2026-10-22
A dashboard feature that shows the account team's open meeting slots (from their real
calendars) so a client can pick a time for upcoming meetings themselves.
- **Quickest route:** Google Calendar *appointment schedules* — TJA is on Google Workspace,
  so each AM/PM can publish a booking page from their own calendar (free/busy respected,
  confirmations + invites handled by Google). The portal embeds it (booking pages can be
  framed) or links to it: a "Book a meeting" button/tile per client, pointing at that
  client's AM/PM booking page(s), set in Client Preferences.
- **Bigger build (only if we outgrow that):** read team free/busy via the Google Calendar
  API and book natively in the portal (needs Workspace admin to grant calendar access to
  the portal's service account; we'd own invites, reschedules, time zones).
- **Decide:** whose calendars (AM only, AM + PM, the whole account team?), meeting types +
  lengths, how far ahead / minimum notice, and whether clients see one combined
  availability or pick a person.

## Push-button client emails from the portal (to do) 🔖 added 2026-10-23
From the CTC email analysis (Aug–Oct 2026): sign-off requests and meeting reminders are
the most repeated hand-written emails. Turn them into buttons the team presses in the portal.
- **Bundled sign-off email:** one button that sends a single email with EVERYTHING
  currently awaiting the client's approval — e.g. this month's HeyOrca social calendar,
  Figma design links, Present Docs deliverables — each with its link, what to decide, the
  due date and who approves. Replaces separate "FOR REVIEW" emails + re-sent links per tool.
  - Pull the items from the portal (Present Docs rounds out for review, plus links added
    per item for HeyOrca / Figma / PandaDoc), so nothing has to be typed.
  - AM previews before it sends (same review step as the weekly status report).
  - Name the approver on each item; leadership sign-offs called out separately.
- **Day-before meeting reminder button** (once calendars are synced into the portal —
  see "Book a meeting with the team" below):
  - Pings the client the day before a meeting, sent FROM the AM's email address (not the
    portal noreply) so it reads like the AM's own reminder.
  - Built from the meeting (date/time, Zoom link or address), the agenda, and the
    client's open to-dos due soon ("what we need from you").
  - Same push-to-send + preview pattern as the bundled sign-off email; could later run
    automatically once the team trusts it.

## "Ask TJA" AI chat assistant 🛠 built v4.21 (2026-11-16), hidden until switched on 🔖 added 2026-11-13
**Left before launch:** (1) add the `ANTHROPIC_API_KEY` Supabase secret; (2) ✅ named **Timmy** for now (change any time in Admin Center → Ask TJA); (3) ✅ tone set from the Digital Brand Standards' tone of voice (magnetic, sophisticated, genuine, capable, constructive; 30% witty / 30% expert / 20% humble / 20% ego), kept clean for clients; (4) live test of typed questions with the QA login, including trying to get hours or other clients' data out of it; (5) set the daily limit to 25; (6) flip the switch on.
An **Ask TJA** button on every dashboard page that opens a chat panel. The client (or staff)
asks plain questions about their account and gets an instant answer from the portal's own data,
e.g. "What's waiting on me?", "When is the website launch?", "How many hours have we used this month?",
"How do I approve a deliverable?"
- **How it works:**
  - The button opens a chat panel that slides out on the right.
  - The question goes to a new Supabase Edge Function, `ask-tja`.
  - The function checks the signed-in user and works out which client they belong to.
  - It loads **only that client's** portal data on the server and strips out staff-only fields.
  - It sends the question, that data and the client guide to Claude (Anthropic API) and streams the answer back.
- **Rules:**
  - Read-only: it can't change anything in the portal.
  - It answers only from portal data. If it doesn't know, it says so and offers "Send this to my AM".
  - It never sees another client's data. Isolation is enforced on the server and never trusted from the browser.
  - Staff-only fields are never sent: CRF, internal notes, team-only items, NET vs GROSS.
- **Needed to build:**
  - An Anthropic API account and key, created by an Admin.
  - The key stored as a Supabase secret. **Never in this public repo.**
  - A daily question limit per user, and logging to the audit trail.
- **Cost:** about a few cents per question, less with prompt caching.
- **Phases:**
  1. Client Q&A on their own account.
  2. "Send to my AM" handoff by email or Slack.
  3. Staff mode with cross-client questions, e.g. "What's overdue across my clients?" or "Draft the sign-off email".
- **Decide:**
  - Clients, staff, or both first?
  - Which data it can see. Should Budget Controls be included?
  - Its tone.
  - Where the handoff goes.
  - Whether clients need a short "AI assistant" disclaimer.
  - Check client contracts and confidentiality terms before account data is sent to an AI provider. The API doesn't train on our data.

- **Decided 2026-11-16 (build now; live once the key is added):**
  - **Clients only** at launch. Staff mode comes later.
  - **Hidden until ready:** an Admin Center on/off switch, off by default. While it's off, only staff see the bubble, badged "Staff preview".
  - **Placement:** a floating TJA-orange bubble at the bottom right. The panel slides in from the right; on phones it sits above the tab bar and opens full-screen.
  - **Branding:** TJA-branded, with a persona name (name TBD by Cameron).
  - **What it can answer from:**
    - status, milestones and to-dos;
    - Present Docs (what needs review or sign-off);
    - KPIs, PR wins, reports and files;
    - "how do I…" portal help.
  - **Budget data:** it may say only what Client View shows. Never raw hours, rates or dollars, and these are stripped on the server.
  - **Quick-answer buttons, with no AI and no key:**
    - What's waiting on me?
    - What's next?
    - How do I…?
    - No hours button.
  - **Daily limit:** unlimited for now, capping at **25 AI questions per user per day** at launch. Quick answers don't count.
  - **Handoff:** "Send to my AM" goes to Slack (dormant until the Slack proxy is live).
  - **Logs:** every chat is logged, and staff read them in an Admin Center "Ask TJA" tab. Unanswered questions are flagged.
  - **Before launch:** browser-test that it can't leak data it shouldn't (hours, CRF, other clients, internal items).
- **To do: Cameron to send TJA's brand-voice .md files.** Ask TJA's tone will be built from them.

## Read the CRF through the portal's own Google account (to do: later) 🔖 added 2026-11-16
Today the hourly `snapshot-months` job reads the Client Revenue Forecast sheet through its public
link. Switch it to the portal's service account (Sheets API), keeping the public read as a fallback.
Then the CRF's link sharing can be locked down any time without breaking the burn.
- One-time: share the CRF sheet with the portal's service account as Viewer. No ongoing upkeep.
- Not now: decided 2026-11-16 to keep it on the list and do it after launch.

## Mobile-friendly version ✅ done (v4.20, 2026-11-16) 🔖 added 2026-11-16
Queued to start straight after the launch-audit fixes (blockers, then high-priority security items).
Today the portal *works* on a phone (no sideways scroll), but it's a squeezed desktop layout.
- **What it needs:**
  - a real phone nav (bottom tab bar or hamburger), so the version label no longer collides with the page menu;
  - Executive Summary tiles stacked one per screen width, with readable text (the free-canvas layout shrinks text on narrow screens);
  - Present Docs review on touch: pinch-zoom proofs, tap to pin, a full-screen signature pad;
  - forms (Media request, SAP and Budget signing) with large tap targets.
- **Check on:** iPhone Safari + Android Chrome, client view first (clients are the mobile users), then staff.

## Rename: "TJA Integration Hub"? (to do) 🔖 added 2026-11-16
We might rename the client portal to **TJA Integration Hub**.
- **Where the name appears:**
  - the page `<title>`s;
  - the sidebar / login branding;
  - email templates (invite, review, reminders) in `supabase/functions/_shared/email.ts` and its senders;
  - Slack posts;
  - the Staff SOP and Client Guide (Claude Design docs);
  - the README / CLAUDE.md.
- **Decide:**
  - Keep the GitHub Pages URL (`TJA-client-portal`) as is, or move to a custom domain (e.g. `hub.thejamesagency.com`)? A custom domain avoids the repo name showing in the link.
  - Rename before launch or after? Before is cleaner, so clients never learn two names.

## Gradient page titles everywhere ✅ done (v4.09, 2026-11-04)
Every page title now uses the Budget Control sheet's gold→orange gradient bar
(`.page-title` in styles.css), stretched to at least 640px so the fade runs further across
the page.

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
