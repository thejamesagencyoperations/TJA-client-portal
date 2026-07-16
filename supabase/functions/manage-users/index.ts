/* ============================================================
   MANAGE-USERS — the backend for the portal's Team page.

   WHY THIS EXISTS AS A FUNCTION and not browser code: creating a
   user, setting a password and writing `profiles` all require the
   SERVICE ROLE key. The portal is public JS on GitHub Pages — that
   key can never go there. So it lives here, in a server-side function
   that only ever acts after verifying the caller is a real admin.
   `profiles` therefore keeps NO write policy at all: the table that
   decides everyone's access is writable only by this function.

   Caller: THE OWNER ONLY — the agency's own account (PORTAL_OWNER_EMAILS).
   Every account manager is role=admin and runs their clients freely, but minting
   admins / changing roles / deleting people is a separate clearance. role=admin is
   NOT sufficient here. Hiding the Admin Center link in the UI is cosmetic; this
   check is the actual boundary — a manager who found the URL, or curled the
   endpoint with their own perfectly valid admin JWT, is refused right here.

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
import { createClient } from "npm:@supabase/supabase-js@2";

const ROLES = ["admin", "creative", "client"];
const ADMIN_WORKSPACE = "_admin";
const CREATIVE_WORKSPACE = "_creative";

// Who may manage logins. Overridable without a redeploy:
//   supabase secrets set PORTAL_OWNER_EMAILS="a@tja.com,b@tja.com"
// Must mirror OWNER_EMAILS in assets/js/auth.js (that copy only hides the UI).
const OWNERS = (Deno.env.get("PORTAL_OWNER_EMAILS") || "clientservices@thejamesagency.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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
  if (role === "creative") return CREATIVE_WORKSPACE;
  return (clientId || "").trim();
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  // role=admin is necessary but NOT sufficient — see the header.
  if (caller.role !== "admin" || !OWNERS.includes((caller.email || "").toLowerCase()))
    return json(req, 403, { error: "Only the agency's owner account can manage logins." });

  let body: any;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const svc = svcClient();

  try {
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
        })),
      });
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

      // GUARD 1 — don't let an admin demote themselves. They'd lose the Team page
      // in the same click and couldn't undo it.
      if (id === caller.userId && role !== "admin")
        return json(req, 400, { error: "You can't change your own role — you'd lock yourself out of this page. Ask another admin." });

      // GUARD 2 — never let the last admin stop being an admin, or nobody can
      // ever manage users again.
      if (role !== "admin") {
        const { data: admins } = await svc.from("profiles").select("id").eq("role", "admin");
        if ((admins || []).length <= 1 && (admins || []).some((a: any) => a.id === id))
          return json(req, 400, { error: "This is the only admin left — promote someone else first." });
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
