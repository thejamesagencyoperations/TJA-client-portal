/* ============================================================
   REQUEST-PASSWORD-RESET — the sign-in page's "Forgot password?"
   flow. PUBLIC + unauthenticated (the user is locked out), so deploy
   with --no-verify-jwt.

   SECURITY: the reset link is ONLY ever emailed to the address that
   owns the account (generateLink derives it from the real user), so
   requesting a reset for someone else's email just mails THEM — never
   the requester. We ALWAYS return ok and never say whether an account
   exists (no account enumeration). This send IGNORES the per-client
   email preference on purpose: locking someone out of recovery because
   "deliverable emails" is off would be a footgun — account recovery is
   not a notification.

   Deploy: supabase functions deploy request-password-reset --use-api --no-verify-jwt
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { portalEmail } from "../_shared/email.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";
const SET_PASSWORD_URL = PORTAL_BASE_URL + "/set-password.html";

async function sendResetEmail(to: string, link: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
  const html = portalEmail({
    preheader: "Reset your The James Agency client portal password.",
    heading: "Reset your password",
    bodyHtml:
      `<p style="margin:0 0 14px">We received a request to reset the password for your client portal account. ` +
      `Choose a new one below — it takes under a minute.</p>` +
      `<p style="margin:0;color:#999;font-size:12px;line-height:1.6">This link expires in <b>1 hour</b>. ` +
      `Didn't request this? You can safely ignore this email — your password won't change.</p>`,
    ctaText: "Reset your password",
    ctaUrl: link,
  });
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `The James Agency <${from}>`,
      to: [to],
      subject: "Reset your client portal password",
      html,
      text: `Reset your client portal password:\n${link}\n\nThis link expires in 1 hour.\nDidn't request it? Ignore this email.\n— The James Agency`,
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 160)}`);
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  let body: { email?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const email = String(body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, 400, { error: "Enter a valid email address." });

  // Best-effort send. Any failure (no such user, mail hiccup) is swallowed so the response
  // is identical whether or not the account exists — nothing to enumerate.
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data, error } = await svc.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo: SET_PASSWORD_URL },
    });
    const hashed = data?.properties?.hashed_token;
    if (!error && hashed) {
      // token_hash form (scanner-proof — same reasoning as the invite); set-password.html
      // redeems ?token_hash&type=recovery via verifyOtp.
      const link = `${SET_PASSWORD_URL}?token_hash=${encodeURIComponent(hashed)}&type=recovery`;
      await sendResetEmail(email, link);
    }
  } catch (_e) { /* swallow — no enumeration, no leak */ }

  return json(req, 200, { ok: true });
});
