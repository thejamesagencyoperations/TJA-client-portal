/* ============================================================
   SEND-DELIVERABLE-EMAIL — emails the client when an admin
   releases a Present Docs deliverable (the Send button).

   Caller: ADMIN ONLY (creative + client JWTs get 403). The upload
   brief (subject + message + feedback-due) written in the portal IS
   the email body; recipients come from the client's integrations map
   (fallback: their portal login email). No image attachment — the
   email links to the portal.

   Deploy:
     supabase functions deploy send-deliverable-email
   Secrets (supabase secrets set KEY=value):
     RESEND_API_KEY     — from resend.com (free tier: 3k emails/mo)
     PORTAL_FROM_EMAIL  — PLACEHOLDER until Cameron confirms the
                          address (noreply@thejamesagency.com is the
                          candidate; needs one-time Resend domain
                          verification with SPF/DKIM added ALONGSIDE
                          whatever already sends from that domain).
                          Until then leave unset → Resend's sandbox
                          sender "onboarding@resend.dev" (test only).

   ALTERNATIVE TRANSPORT (documented, not built): Gmail API send-as
   via a domain-wide-delegation service account impersonating
   crm@thejamesagency.com — the exact pattern already proven in
   TJA-new-biz-dashboard/functions/index.js. Swap sendViaResend()
   for a Gmail users.messages.send call if TJA prefers all-Google.
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";

// The only place the portal's own URL exists in the backend. On a future custom
// domain, update this + the CORS list + the Supabase Auth site URL — that's the
// entire hosting migration.
const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";

const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function fmtDue(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return "";
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

async function sendViaResend(to: string[], subject: string, html: string, text: string) {
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";   // sandbox until the real address is confirmed
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `The James Agency <${from}>`, to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { error: "email not configured (RESEND_API_KEY missing)" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (caller.role !== "admin") return json(req, 403, { error: "admins only" });   // creatives release nothing

  let body: { clientId?: string; docName?: string; versionLabel?: string; subject?: string; message?: string; dueDate?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const clientId = String(body.clientId ?? "").trim();
  if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "clientId required" });

  const entry = await registryEntry(clientId);
  if (!entry) return json(req, 404, { error: "unknown client" });
  const recipients = (entry.integrations?.emailRecipients ?? []).filter(Boolean);
  if (!recipients.length && entry.login?.email) recipients.push(entry.login.email);
  if (!recipients.length) return json(req, 409, { error: "no recipients configured for this client" });

  const docName = String(body.docName ?? "deliverable");
  const version = String(body.versionLabel ?? "");
  const subject = String(body.subject ?? "").trim() || `New deliverable for review: ${docName} ${version}`.trim();
  const message = String(body.message ?? "").trim();
  const due = fmtDue(String(body.dueDate ?? ""));

  const text = [
    `${docName} ${version} is ready for your review in the TJA client portal.`,
    message ? `\n${message}` : "",
    due ? `\nFeedback due: ${due}` : "",
    `\nReview it here: ${PORTAL_BASE_URL}`,
    `\n— The James Agency`,
  ].join("\n");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#F68E21;border-radius:8px 8px 0 0;padding:14px 20px;color:#fff;font-weight:800;font-size:18px">The James Agency</div>
      <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0 0 12px"><b>${esc(docName)} ${esc(version)}</b> is ready for your review.</p>
        ${message ? `<p style="margin:0 0 12px;white-space:pre-wrap">${esc(message)}</p>` : ""}
        ${due ? `<p style="margin:0 0 12px"><b>Feedback due:</b> ${esc(due)}</p>` : ""}
        <p style="margin:18px 0 0"><a href="${PORTAL_BASE_URL}" style="background:#F68E21;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px;display:inline-block">Review in the portal →</a></p>
      </div>
    </div>`;

  try {
    const out = await sendViaResend(recipients, subject, html, text);
    return json(req, 200, { ok: true, id: out.id, recipients: recipients.length });
  } catch (e) {
    console.error("send failed", e);
    return json(req, 502, { error: "email send failed" });
  }
});
