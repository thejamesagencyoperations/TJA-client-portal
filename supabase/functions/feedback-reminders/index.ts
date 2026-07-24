/* ============================================================
   FEEDBACK-REMINDERS — a daily nudge to clients who haven't reviewed a
   Present Docs deliverable yet. Fires TWO reminders per deliverable:
   3 days before its feedback-due date, and on the due date itself.

   Runs once a day at 10:00 America/Phoenix (= 17:00 UTC year-round, no
   DST) via .github/workflows/feedback-reminders.yml. Scans every
   client's deliverables, finds the LATEST version that is sent + still
   unreviewed + has a due date landing on today or today+3, and emails
   the client's recipients — respecting the per-client deliverable-email
   toggle + notifyOff, exactly like send-deliverable-email. Sends each
   milestone ONCE (tracked in app_state _reminders).

   Gate: SNAPSHOT_SECRET header. Deploy:
     supabase functions deploy feedback-reminders --use-api --no-verify-jwt
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { portalEmail } from "../_shared/email.ts";
import { registryEntry } from "../_shared/registry.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";
const TRACK_CLIENT = "_reminders";
const TRACK_SCOPE = "clients";

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Today's date in America/Phoenix (UTC-7, no DST) as YYYY-MM-DD.
function azToday(): string {
  const az = new Date(Date.now() - 7 * 3600 * 1000);
  return az.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// "2026-07-25" → "July 25, 2026"
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return iso;
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function sendViaResend(to: string[], subject: string, html: string, text: string) {
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `The James Agency <${from}>`, to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });
  if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { error: "email not configured" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const today = azToday();
  const in3 = addDays(today, 3);   // a deliverable due on `in3` earns the "3 days out" nudge today

  const { data: rows } = await svc.from("app_state").select("client_id,data").eq("scope", "deliverables");
  const { data: trow } = await svc.from("app_state").select("data").eq("client_id", TRACK_CLIENT).eq("scope", TRACK_SCOPE).maybeSingle();
  const sent: Record<string, number> = (trow?.data && typeof trow.data === "object" && !Array.isArray(trow.data)) ? trow.data as any : {};

  let candidates = 0, remindersSent = 0, skippedAlready = 0, noEmail = 0;

  for (const row of (rows || [])) {
    const clientId = String(row.client_id);
    if (clientId.startsWith("_")) continue;
    const items = Array.isArray(row.data) ? row.data : [];

    // which of this client's deliverables need a nudge today (latest version only)
    const due: Array<{ docId: string; docName: string; label: string; dueDate: string; milestone: string; key: string }> = [];
    for (const d of items) {
      const versions = Array.isArray(d.versions) ? d.versions : [];
      const v = versions[versions.length - 1];
      if (!v || v.state === "pending_approval") continue;   // not yet sent to the client
      if (v.reviewedAt || v.status) continue;               // already reviewed / has a verdict
      const dueDate = String(v.revisionsDue || "");
      const milestone = dueDate === today ? "due" : dueDate === in3 ? "due3" : "";
      if (!milestone) continue;
      const key = `${clientId}:${d.id}:${v.vid || v.label}:${milestone}`;
      if (sent[key]) { skippedAlready++; continue; }
      due.push({ docId: d.id, docName: String(d.name || "your deliverable"), label: String(v.label || ""), dueDate, milestone, key });
    }
    if (!due.length) continue;
    candidates += due.length;

    const entry = await registryEntry(clientId);
    if (!entry) continue;
    if (entry.integrations?.deliverableEmails === false) { noEmail += due.length; continue; }   // opted out of emails

    const { data: profs } = await svc.from("profiles").select("email").eq("client_id", clientId).eq("role", "client");
    const fromLogins = (profs ?? []).map((p: any) => p.email).filter(Boolean);
    const extra = entry.integrations?.emailRecipients ?? [];
    const notifyOff = new Set((entry.integrations?.notifyOff ?? []).map((e: string) => String(e).trim().toLowerCase()));
    const recipients = [...new Set([...fromLogins, ...extra].map((e) => String(e).trim().toLowerCase()))].filter((e) => !notifyOff.has(e));
    if (!recipients.length) { noEmail += due.length; continue; }

    for (const item of due) {
      const nameLine = `${item.docName}${item.label ? " " + item.label : ""}`;
      const url = `${PORTAL_BASE_URL}/?open=docs&doc=${encodeURIComponent(item.docId)}`;
      const whenShort = item.milestone === "due" ? "is due today" : "is due in 3 days";
      const dueLong = longDate(item.dueDate);
      const subject = `Reminder: your feedback on ${nameLine} ${whenShort}`;
      const html = portalEmail({
        preheader: `A quick reminder — your feedback on ${nameLine} ${whenShort}.`,
        heading: item.milestone === "due" ? "Your feedback is due today" : "Your feedback is due soon",
        bodyHtml:
          `<p style="margin:0 0 14px">Just a friendly reminder that <b>${esc(nameLine)}</b> is waiting for your review in your client portal, ` +
          `and feedback ${whenShort}.</p>` +
          `<p style="margin:0">It only takes a minute — open it, leave your notes, and submit. Your feedback goes straight to the team.</p>`,
        metaRows: [["Feedback due", dueLong]],
        ctaText: "Review it now",
        ctaUrl: url,
      });
      const text = [
        `Reminder: your feedback on "${nameLine}" ${whenShort}.`,
        `\nFeedback due: ${dueLong}`,
        `\nReview it in your portal: ${url}`,
        `\n— The James Agency`,
      ].join("\n");
      try {
        await sendViaResend(recipients, subject, html, text);
        sent[item.key] = Date.now();
        remindersSent++;
      } catch (_e) { /* leave unmarked; next daily run retries (the milestone day may pass) */ }
    }
  }

  // prune tracker entries older than 30 days so it can't grow forever
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const k of Object.keys(sent)) if (sent[k] < cutoff) delete sent[k];
  await svc.from("app_state").upsert({ client_id: TRACK_CLIENT, scope: TRACK_SCOPE, data: sent, updated_at: new Date().toISOString() }, { onConflict: "client_id,scope" });

  return json(req, 200, { ok: true, today, in3, candidates, remindersSent, skippedAlready, noEmail });
});
