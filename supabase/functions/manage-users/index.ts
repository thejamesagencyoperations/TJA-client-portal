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
import { createClient } from "npm:@supabase/supabase-js@2";

const ROLES = ["admin", "manager", "creative", "client"];
const ADMIN_WORKSPACE = "_admin";
const CREATIVE_WORKSPACE = "_creative";
// AM/PMs own no client workspace either — same sentinel idea as admin/creative.
const MANAGER_WORKSPACE = "_manager";

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

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  // The agency account only. An AM/PM is role='manager' and lands here.
  if (caller.role !== "admin")
    return json(req, 403, { error: "Only the agency's admin account can manage logins." });

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
