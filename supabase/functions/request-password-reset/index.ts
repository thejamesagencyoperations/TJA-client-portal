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

// One small staff-invisible row: { e: {hash: [ts…]}, i: {hash: [ts…]}, all: [ts…] }, pruned to the
// last hour on every call. Hashes, not raw emails/IPs, so the row holds nothing personal.
// deno-lint-ignore no-explicit-any
async function allowReset(svc: any, email: string, ip: string): Promise<boolean> {
  const HOUR = 3600_000, now = Date.now();
  const h = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))
    .slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
  const he = await h("e:" + email), hi = await h("i:" + ip);
  try {
    const { data: row } = await svc.from("app_state").select("data").eq("client_id", "_reset_throttle").eq("scope", "clients").maybeSingle();
    // deno-lint-ignore no-explicit-any
    const d: any = row?.data || {};
    const fresh = (a: unknown) => (Array.isArray(a) ? a : []).filter((t) => now - +t < HOUR);
    const e: Record<string, number[]> = {}, i: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(d.e || {})) { const f = fresh(v); if (f.length) e[k] = f; }
    for (const [k, v] of Object.entries(d.i || {})) { const f = fresh(v); if (f.length) i[k] = f; }
    const all = fresh(d.all);
    if ((e[he] || []).length >= 3 || (i[hi] || []).length >= 10 || all.length >= 60) return false;
    e[he] = [...(e[he] || []), now]; i[hi] = [...(i[hi] || []), now]; all.push(now);
    await svc.from("app_state").upsert({ client_id: "_reset_throttle", scope: "clients", data: { e, i, all }, updated_at: new Date().toISOString() },
      { onConflict: "client_id,scope" });
    return true;
  } catch (_) { return true; }   // the throttle must never stop a genuine reset
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
    /* THROTTLE (2026-11-16, launch audit). This endpoint is public, so without a limit anyone
       could flood an inbox with reset emails and burn the daily Resend allowance. Limits:
       3 per email per hour, 10 per IP per hour, 60 overall per hour. Over a limit we still
       answer {ok:true} — same as success — so the response never reveals anything. */
    if (!(await allowReset(svc, email, (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?")))
      return json(req, 200, { ok: true });
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
