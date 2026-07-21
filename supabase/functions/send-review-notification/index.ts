/* ============================================================
   SEND-REVIEW-NOTIFICATION — emails the TJA team when a CLIENT
   submits their review of a Present Docs deliverable (approve /
   approve-with-changes / revisions).

   Caller: the CLIENT (role='client'). We derive the client from
   the caller's PROFILE, never the body — a client can only ever
   trigger a notification about their own workspace.

   Recipient: the client's TJA distribution address — entry.login.email
   — which WMJ auto-creates for every client (<name>@thejamesagency.com),
   so this needs ZERO per-client setup, now or for future clients. Any
   extra addresses in integrations.emailRecipients are added too. This is
   the mirror image of send-deliverable-email: that one goes OUT to the
   client, this one comes BACK to the team.

   Deploy: supabase functions deploy send-review-notification --use-api
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";
import { portalEmail } from "../_shared/email.ts";
import { postToSlack } from "../_shared/slack.ts";

const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";

const STATUS = {
  approved:  { label: "Approved as shown",   tone: "great news" },
  changes:   { label: "Approved with changes", tone: "" },
  revisions: { label: "Revisions needed",    tone: "" },
} as const;

async function sendViaResend(to: string[], subject: string, html: string, text: string) {
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `The James Agency <${from}>`, to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { error: "email not configured" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  // Only a client's own review triggers this. Staff edits don't notify the team.
  if (caller.role !== "client" || !caller.clientId || caller.clientId.startsWith("_"))
    return json(req, 403, { error: "clients only" });

  let body: { docName?: string; versionLabel?: string; status?: string; comments?: number };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }

  const clientId = caller.clientId;                       // from the profile, never the body
  const entry = await registryEntry(clientId);
  if (!entry) return json(req, 404, { error: "unknown client" });

  const clientName = entry.name || clientId;
  const docName = String(body.docName ?? "a deliverable");
  const version = String(body.versionLabel ?? "");
  const st = STATUS[(body.status ?? "") as keyof typeof STATUS];
  const statusLabel = st ? st.label : "Responded";
  const nComments = Number(body.comments ?? 0);
  const nameLine = `${docName}${version ? " " + version : ""}`;

  // Slack fires INDEPENDENTLY of email — a client with no distribution address must not
  // suppress the team's Slack ping. Await it so the 409 below can report it landed.
  const emoji = body.status === "approved" ? "✅" : body.status === "changes" ? "📝" : "🔄";
  const slackRes = await postToSlack(entry.integrations?.slackChannel,
    `${emoji} *${clientName}* responded to *${nameLine}*: *${statusLabel}*${nComments > 0 ? ` · ${nComments} comment${nComments === 1 ? "" : "s"}` : ""}`)
    .catch(() => ({ ok: false }));
  const slacked = !!(slackRes && slackRes.ok);

  // distribution address (auto-created per client) + any extra integrations recipients
  const recipients = [
    ...(entry.login?.email ? [entry.login.email] : []),
    ...(entry.integrations?.emailRecipients ?? []),
  ].filter(Boolean).map((e) => String(e).trim().toLowerCase());
  const uniq = [...new Set(recipients)];
  if (!uniq.length) return json(req, 409, { slacked, error: "no distribution address for this client" });

  const commentLine = nComments > 0
    ? `They left ${nComments} comment${nComments === 1 ? "" : "s"} on the proof.`
    : `No comments were left on the proof.`;
  const subject = `${clientName} responded: ${statusLabel} — ${nameLine}`;
  const text = [
    `${clientName} has reviewed "${nameLine}".`,
    `\nTheir response: ${statusLabel}.`,
    `\n${commentLine}`,
    `\nOpen it in the portal: ${PORTAL_BASE_URL}`,
    `\n— The James Agency portal`,
  ].join("\n");
  const html = portalEmail({
    preheader: `${clientName} responded to ${nameLine}: ${statusLabel}.`,
    heading: `${clientName} responded to their proof`,
    bodyHtml:
      `<p style="margin:0 0 14px">They&rsquo;ve reviewed &ldquo;<b>${nameLine}</b>&rdquo; in the portal.</p>` +
      `<p style="margin:0 0 14px">${commentLine}</p>`,
    metaRows: [["Client", clientName], ["Response", statusLabel]],
    ctaText: "Open it in the portal",
    ctaUrl: PORTAL_BASE_URL,
  });

  try {
    const out = await sendViaResend(uniq, subject, html, text);
    return json(req, 200, { ok: true, id: out.id, recipients: uniq.length, slacked });
  } catch (e) {
    console.error("review-notification send failed", e);
    return json(req, 502, { error: String((e as Error).message || e).slice(0, 220) });
  }
});
