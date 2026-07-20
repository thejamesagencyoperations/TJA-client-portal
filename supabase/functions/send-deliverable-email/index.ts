/* ============================================================
   SEND-DELIVERABLE-EMAIL — emails the client when an admin
   releases a Present Docs deliverable (the Send button).

   Caller: ADMIN ONLY (creative + client JWTs get 403). The upload
   brief (subject + message + feedback-due) written in the portal IS
   the email body; recipients come from the client's integrations map
   (fallback: their portal login email). No image attachment — the
   email links to the portal.

   Deploy:
     supabase functions deploy send-deliverable-email --use-api
   --use-api is NOT optional: the default path bundles via Docker and fails
   on this Mac with "failed to open eszip: ENOENT" (the edge-runtime image
   pulls and runs but emits no bundle). --use-api bundles server-side.
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
import { createClient } from "npm:@supabase/supabase-js@2";

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

  /* ---------- who gets it ----------
     EVERYONE WITH A LOGIN to this workspace, plus any extra addresses in the
     integrations map. Union, de-duped.

     The logins are the point: inviting rdorner@celticelevator.com already says "this
     person should hear about Celtic's work", so making someone re-type him into a
     second list is duplicate bookkeeping that silently rots — the day someone's
     removed from one and not the other, you're either emailing an ex-employee or
     missing the person who matters. The integrations list now only exists for the
     exception: a CMO who wants the FYI but will never log in.

     NOTE there is deliberately NO fallback to entry.login.email. For 48 of 49 clients
     that's a TJA DISTRIBUTION address (anewleaf@thejamesagency.com), not the client —
     the mail would have gone to TJA's own inbox while the UI said "Emailed the client ✓". */
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data: profs } = await svc.from("profiles")
    .select("email").eq("client_id", clientId).eq("role", "client");
  const fromLogins = (profs ?? []).map((p: any) => p.email).filter(Boolean);
  const extra = (entry.integrations?.emailRecipients ?? []).filter(Boolean);
  const recipients = [...new Set([...fromLogins, ...extra].map((e) => String(e).trim().toLowerCase()))];

  if (!recipients.length) {
    return json(req, 409, {
      error: "Nobody to email for this client. Invite them in the Admin Center, or add an address under Clients → Edit → Integrations.",
    });
  }

  const docName = String(body.docName ?? "deliverable");
  const version = String(body.versionLabel ?? "");
  const subject = String(body.subject ?? "").trim() || `You have a deliverable to proof: ${docName} ${version}`.trim();
  const message = String(body.message ?? "").trim();
  const due = fmtDue(String(body.dueDate ?? ""));
  // Deep-link straight to Present Docs. index.html reads ?open=docs, stashes it, and app.js
  // opens that page after login — no PDF is emailed; the client proofs it in the portal.
  const REVIEW_URL = `${PORTAL_BASE_URL}/?open=docs`;

  const text = [
    `You have a deliverable to proof: ${docName} ${version}.`,
    message ? `\n${message}` : "",
    due ? `\nFeedback due: ${due}` : "",
    `\nProof it in your portal: ${REVIEW_URL}`,
    `\n— The James Agency`,
  ].join("\n");
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;color:#222">
      <div style="background:#F68E21;border-radius:8px 8px 0 0;padding:14px 20px;color:#fff;font-weight:800;font-size:18px">The James Agency</div>
      <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:20px">
        <p style="margin:0 0 6px;font-size:16px"><b>You have a deliverable to proof.</b></p>
        <p style="margin:0 0 12px;color:#555"><b>${esc(docName)} ${esc(version)}</b> is ready for your review in the TJA client portal.</p>
        ${message ? `<p style="margin:0 0 12px;white-space:pre-wrap">${esc(message)}</p>` : ""}
        ${due ? `<p style="margin:0 0 12px"><b>Feedback due:</b> ${esc(due)}</p>` : ""}
        <p style="margin:18px 0 6px"><a href="${REVIEW_URL}" style="background:#F68E21;color:#fff;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:8px;display:inline-block">Proof it in your portal →</a></p>
        <p style="margin:14px 0 0;color:#999;font-size:12px">Review, comment on and approve the work right in the portal — no downloads needed.</p>
      </div>
    </div>`;

  try {
    const out = await sendViaResend(recipients, subject, html, text);
    return json(req, 200, { ok: true, id: out.id, recipients: recipients.length });
  } catch (e) {
    // Surface WHY. This used to return a bare "email send failed", which told the
    // admin nothing and made the thing undiagnosable from the UI — Resend's own
    // messages are actually clear ("domain not verified", "you can only send to…"),
    // so passing them through turns a mystery into an instruction.
    console.error("send failed", e);
    return json(req, 502, { error: String((e as Error).message || e).slice(0, 220) });
  }
});
