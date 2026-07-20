/* ============================================================
   MANAGE-USERS — the backend for the portal's Team page.

   WHY THIS EXISTS AS A FUNCTION and not browser code: creating a
   user, setting a password and writing `profiles` all require the
   SERVICE ROLE key. The portal is public JS on GitHub Pages — that
   key can never go there. So it lives here, in a server-side function
   that only ever acts after verifying the caller is a real admin.
   `profiles` therefore keeps NO write policy at all: the table that
   decides everyone's access is writable only by this function.

   Caller: role='admin' ONLY — the agency account.
   AM/PMs are role='manager' (schema-v7), a genuinely separate tier: RLS refuses
   their DELETEs and they can't touch profiles at all. So `admin` here IS the
   owner tier, and the old PORTAL_OWNER_EMAILS allowlist that faked this
   distinction is gone. Hiding the Admin Center link is cosmetic; this check is
   the boundary — a manager curling the endpoint with a valid JWT is refused here.

   Deploy:
     supabase functions deploy manage-users --use-api
   --use-api is NOT optional here: the default path bundles via Docker and
   fails on this Mac with "failed to open eszip: ENOENT" (the edge-runtime
   image pulls and runs but emits no bundle). --use-api bundles on
   Supabase's servers instead and works.
   Needs no new secrets — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY /
   SUPABASE_ANON_KEY are injected by the platform automatically.

   NOTE role 'creative' only becomes valid once schema-v6.sql has run
   (it widens the profiles role CHECK). Until then, creating/assigning
   a creative returns a database error — which this surfaces verbatim.
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";
import { portalEmail } from "../_shared/email.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const ROLES = ["admin", "manager", "creative", "client"];
const ADMIN_WORKSPACE = "_admin";
const CREATIVE_WORKSPACE = "_creative";
// AM/PMs own no client workspace either — same sentinel idea as admin/creative.
const MANAGER_WORKSPACE = "_manager";

// The only place the portal's own URL exists in this function (mirrors the email fn).
// On a custom domain, change this + the CORS list + Supabase's Site URL.
const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";
const SET_PASSWORD_URL = PORTAL_BASE_URL + "/set-password.html";

function svcClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// GoTrue's admin list ignores filters, so page through and match locally —
// the same bug the provisioning script works around.
async function allAuthUsers(svc: ReturnType<typeof svcClient>) {
  const out: any[] = [];
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    out.push(...data.users);
    if (data.users.length < 200) break;
  }
  return out;
}

// The workspace a role implies. Staff own no client workspace — they get a
// sentinel, which is what routes them to the picker instead of a dashboard.
function workspaceFor(role: string, clientId: string) {
  if (role === "admin") return ADMIN_WORKSPACE;
  if (role === "manager") return MANAGER_WORKSPACE;
  if (role === "creative") return CREATIVE_WORKSPACE;
  return (clientId || "").trim();
}

/* ---------- invites ----------
   We generate the link and send it OURSELVES via Resend, rather than using
   inviteUserByEmail() and letting Supabase mail it. Three reasons:
     1. Supabase's built-in mailer is capped at a few per hour and is explicitly
        not for production. This route doesn't touch it.
     2. We own the template — Supabase's default is an unbranded stub.
     3. One less thing to configure (no Supabase SMTP setup needed at all).
   generateLink creates the auth user as a side effect and returns the link
   without emailing anything. */
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// Shared TJA-branded shell (see _shared/email.ts).
function inviteEmailHtml(clientName: string, link: string, inviterName: string) {
  return portalEmail({
    preheader: `Set your password and step into the ${clientName} portal — progress, creative and feedback in one place.`,
    heading: "Welcome to your client portal",
    bodyHtml:
      `<p style="margin:0 0 14px">${esc(inviterName)} at The James Agency has set up a private portal for ` +
      `<b>${esc(clientName)}</b> — one place to follow progress, review creative work and leave feedback ` +
      `that reaches the team instantly.</p>` +
      `<p style="margin:0 0 14px">Choose your own password to get started — it takes under a minute.</p>` +
      `<p style="margin:0;color:#999;font-size:12px;line-height:1.6">This link expires in <b>24 hours</b> — if it has, ` +
      `ask your account manager to send a fresh one. Weren't expecting this? You can safely ignore this email.</p>`,
    ctaText: "Set your password",
    ctaUrl: link,
  });
}

async function sendInviteEmail(to: string, clientName: string, link: string, inviterName: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY not set — can't send the invite.");
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `The James Agency <${from}>`,
      to: [to],
      subject: `Your ${clientName} client portal — set your password`,
      html: inviteEmailHtml(clientName, link, inviterName),
      text: `You've been given access to the ${clientName} client portal.\n\n`
        + `Set your password and sign in:\n${link}\n\n`
        + `This link expires in 24 hours.\n— The James Agency`,
    }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });

  let body: any;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const svc = svcClient();

  try {
    /* ---------- roster ----------
       The one action open to any signed-in staff member (not just admin) — it feeds
       the manager-tag picker on clients.html, which admin AND managers both use.
       WMJ auto-creates a free-text "managers" tag per client from the sheet, so that
       tag list drifts to include people who left or never had a dashboard login.
       This returns just names for real admin/manager accounts — nothing sensitive
       (no email, no invite state — that stays admin-only via "list"). */
    if (action === "roster") {
      if (!["admin", "manager", "creative"].includes(caller.role))
        return json(req, 403, { error: "staff only" });
      const users = await allAuthUsers(svc);
      const { data: profs } = await svc.from("profiles").select("id,role").in("role", ["admin", "manager"]);
      const roleById: Record<string, string> = {};
      (profs || []).forEach((p: any) => roleById[p.id] = p.role);
      const names = users
        .filter((u) => roleById[u.id])
        .map((u) => String(u.user_metadata?.name || "").trim())
        .filter(Boolean);
      return json(req, 200, { names: [...new Set(names)].sort() });
    }

    // Everything below manages real accounts — the agency admin only. An AM/PM is
    // role='manager' and stops here.
    if (caller.role !== "admin")
      return json(req, 403, { error: "Only the agency's admin account can manage logins." });

    /* ---------- list ---------- */
    if (action === "list") {
      const users = await allAuthUsers(svc);
      const { data: profs } = await svc.from("profiles").select("id,email,role,client_id");
      const byId: Record<string, any> = {};
      (profs || []).forEach((p: any) => byId[p.id] = p);
      return json(req, 200, {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          name: u.user_metadata?.name || "",
          // the profiles row is the authority; metadata is only a fallback for
          // users created before the row existed
          role: byId[u.id]?.role || u.user_metadata?.role || "client",
          clientId: byId[u.id]?.client_id || u.user_metadata?.client_id || "",
          lastSignIn: u.last_sign_in_at || null,
          createdAt: u.created_at,
          isYou: u.id === caller.userId,
          // "invited but hasn't accepted": GoTrue stamps invited_at, and
          // last_sign_in_at stays null until they actually set a password and land.
          // Without this the Admin Center can't tell "waiting on them" from "active".
          invitedPending: !!u.invited_at && !u.last_sign_in_at,
        })),
      });
    }

    /* ---------- invite (clients) ----------
       The client never gets a password from us — they set their own. Creates the
       auth user via generateLink (which does NOT send anything), writes the profile,
       then emails our own branded link through Resend. */
    if (action === "invite" || action === "reinvite") {
      const email = String(body.email || "").trim().toLowerCase();
      const role = String(body.role || "client");
      const name = String(body.name || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, 400, { error: "Enter a valid email address." });
      if (!ROLES.includes(role)) return json(req, 400, { error: "Unknown role." });
      const clientId = workspaceFor(role, body.clientId);
      if (!clientId) return json(req, 400, { error: "Pick which client workspace this login belongs to." });

      const existing = (await allAuthUsers(svc)).find((u) => (u.email || "").toLowerCase() === email);
      if (action === "invite" && existing)
        return json(req, 409, { error: "Someone already has that email address." });
      if (action === "reinvite" && !existing)
        return json(req, 404, { error: "That login no longer exists." });

      const entry = await registryEntry(clientId);
      const clientName = entry?.name || clientId;
      const meta: any = { role, client_id: clientId };
      if (name) meta.name = name;

      // 'invite' mints the user; 'recovery' re-links someone who already exists
      // (generateLink type:'invite' rejects an existing user). Both land on the
      // same set-password page, so the client experience is identical.
      const linkType = existing ? "recovery" : "invite";
      const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
        type: linkType,
        email,
        options: { data: meta, redirectTo: SET_PASSWORD_URL },
      });
      if (linkErr) return json(req, 400, { error: linkErr.message });
      const userId = linkData?.user?.id;
      // SCANNER-PROOF LINK: email a DIRECT link to set-password.html carrying the hashed
      // token, NOT Supabase's action_link. The action_link redeems the single-use token
      // server-side on first GET — and corporate mail scanners pre-fetch every link, so
      // the real click lands on "invalid or expired" (burned a live password reset on
      // 2026-07-17). The token_hash form is only redeemed when the page's JS calls
      // verifyOtp, which a scanner's bare GET never does. set-password.html already
      // handles ?token_hash&type=.
      const hashed = linkData?.properties?.hashed_token;
      if (!hashed || !userId) return json(req, 500, { error: "Supabase returned no invite link." });
      const link = `${SET_PASSWORD_URL}?token_hash=${encodeURIComponent(hashed)}&type=${linkType}`;

      // profile written BEFORE the email goes out: if this failed afterwards they'd
      // hold a working link into a workspace the database never granted them.
      const { error: pe } = await svc.from("profiles")
        .upsert({ id: userId, email, role, client_id: clientId }, { onConflict: "id" });
      if (pe) return json(req, 400, { error: pe.message });

      try {
        await sendInviteEmail(email, clientName, link, caller.email || "The James Agency");
      } catch (e) {
        // The account exists and is correctly wired — only the email failed. Say so
        // precisely, so nobody deletes and recreates a perfectly good login.
        return json(req, 502, {
          error: "The login was created, but the invite email didn't send: "
            + String((e as Error).message || e).slice(0, 140)
            + ' — use "Resend invite" once that\'s sorted.',
          id: userId, created: true,
        });
      }
      return json(req, 200, { ok: true, id: userId, invited: email });
    }

    /* ---------- create ---------- */
    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const password = String(body.password || "");
      const role = String(body.role || "client");
      const name = String(body.name || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(req, 400, { error: "Enter a valid email address." });
      if (password.length < 8) return json(req, 400, { error: "Password must be at least 8 characters." });
      if (!ROLES.includes(role)) return json(req, 400, { error: "Unknown role." });
      const clientId = workspaceFor(role, body.clientId);
      if (!clientId) return json(req, 400, { error: "Pick which client workspace this login belongs to." });

      const existing = (await allAuthUsers(svc)).find((u) => (u.email || "").toLowerCase() === email);
      if (existing) return json(req, 409, { error: "Someone already has that email address." });

      const meta: any = { role, client_id: clientId };
      if (name) meta.name = name;
      const { data, error } = await svc.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: meta,
      });
      if (error) return json(req, 400, { error: error.message });

      // The signup trigger writes the profile, but upsert anyway so the row is
      // right even if the trigger is ever changed or missing.
      const { error: pe } = await svc.from("profiles")
        .upsert({ id: data.user.id, email, role, client_id: clientId }, { onConflict: "id" });
      if (pe) return json(req, 400, { error: pe.message });
      return json(req, 200, { ok: true, id: data.user.id });
    }

    /* ---------- update (role / workspace / name) ---------- */
    if (action === "update") {
      const id = String(body.id || "");
      if (!id) return json(req, 400, { error: "missing user id" });
      const role = String(body.role || "");
      if (!ROLES.includes(role)) return json(req, 400, { error: "Unknown role." });
      const clientId = workspaceFor(role, body.clientId);
      if (!clientId) return json(req, 400, { error: "Pick which client workspace this login belongs to." });

      // GUARD 1 — don't let the agency account demote itself (e.g. to manager). It
      // would lose the Admin Center in the same click and couldn't undo it.
      if (id === caller.userId && role !== "admin")
        return json(req, 400, { error: "You can't change your own role — you'd lock yourself out of the Admin Center. Ask another admin." });

      // GUARD 2 — never let the last admin stop being an admin, or nobody can ever
      // manage logins again. Counts role='admin' only: a room full of AM/PMs is NOT
      // a fallback, since managers can't reach this function at all.
      if (role !== "admin") {
        const { data: admins } = await svc.from("profiles").select("id").eq("role", "admin");
        if ((admins || []).length <= 1 && (admins || []).some((a: any) => a.id === id))
          return json(req, 400, { error: "This is the only admin left — promote someone else to Admin first." });
      }

      const name = String(body.name || "").trim();
      const meta: any = { role, client_id: clientId };
      if (name) meta.name = name;
      const { error: ue } = await svc.auth.admin.updateUserById(id, { user_metadata: meta });
      if (ue) return json(req, 400, { error: ue.message });
      const { error: pe } = await svc.from("profiles").update({ role, client_id: clientId }).eq("id", id);
      if (pe) return json(req, 400, { error: pe.message });
      return json(req, 200, { ok: true });
    }

    /* ---------- password ---------- */
    if (action === "password") {
      const id = String(body.id || "");
      const password = String(body.password || "");
      if (!id) return json(req, 400, { error: "missing user id" });
      if (password.length < 8) return json(req, 400, { error: "Password must be at least 8 characters." });
      const { error } = await svc.auth.admin.updateUserById(id, { password });
      if (error) return json(req, 400, { error: error.message });
      return json(req, 200, { ok: true });
    }

    /* ---------- remove ---------- */
    if (action === "remove") {
      const id = String(body.id || "");
      if (!id) return json(req, 400, { error: "missing user id" });
      if (id === caller.userId) return json(req, 400, { error: "You can't delete your own login." });
      const { data: prof } = await svc.from("profiles").select("role").eq("id", id).maybeSingle();
      if (prof?.role === "admin") {
        const { data: admins } = await svc.from("profiles").select("id").eq("role", "admin");
        if ((admins || []).length <= 1)
          return json(req, 400, { error: "This is the only admin left — promote someone else first." });
      }
      // profiles row goes with it (FK is ON DELETE CASCADE). Client WORKSPACE data
      // is untouched — deleting a login never deletes their dashboard.
      const { error } = await svc.auth.admin.deleteUser(id);
      if (error) return json(req, 400, { error: error.message });
      return json(req, 200, { ok: true });
    }

    return json(req, 400, { error: "unknown action" });
  } catch (e) {
    console.error("manage-users", action, e);
    return json(req, 500, { error: String((e as Error).message || e) });
  }
});
