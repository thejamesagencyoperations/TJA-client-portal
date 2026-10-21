/* ============================================================
   CLIENT-PREFS — one client's notification preferences, for the Executive
   Summary's "Client Preferences" panel (Cameron 2026-10-21).

   WHO: admins on any client; an AM/PM (role "manager") only on clients they manage
   (their login name is in the client's registry `managers`). The registry is admin-write
   in RLS, so AM/PMs couldn't save these from the browser — this function does it for
   them, after checking, and touches ONLY the preference fields below.

   Fields (all on registry integrations):
     deliverableEmails  bool   Present Docs send/review emails to the client (default on)
     signupEmails       bool   signup / invite emails (default on)
     todoReminders      bool   day-before deadline digest for this client (default OFF)
     notifyOff          [email] client logins who don't get deliverable notifications
     approvalOff        [email] client logins who aren't required Present Docs approvers
     todoRemindOn       [email] client logins who get the deadline digest (default none)
     slackChannel       string  the client's Slack channel (send / review posts)
     emailRecipients    [email] extra addresses for deliverable emails

   Actions: { action:"get", clientId } → { prefs, logins:[{email,name}] }
            { action:"set", clientId, patch:{…subset…} } → { prefs, roundsUpdated }
   Turning a reviewer OFF also takes them off rounds already out for review (same rule as
   Admin Center), and at least one required approver must remain.

   Deploy: supabase functions deploy client-prefs --use-api --no-verify-jwt   (own auth)
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { updateRegistry } from "../_shared/registry.ts";

const BOOL = ["deliverableEmails", "signupEmails", "todoReminders"];
const LISTS = ["notifyOff", "approvalOff", "todoRemindOn", "emailRecipients"];
const DEFAULTS: Record<string, unknown> = { deliverableEmails: true, signupEmails: true, todoReminders: false };
const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

// deno-lint-ignore no-explicit-any
function prefsOf(c: any) {
  const ig = (c && c.integrations) || {};
  // deno-lint-ignore no-explicit-any
  const out: Record<string, any> = {};
  BOOL.forEach((k) => { out[k] = typeof ig[k] === "boolean" ? ig[k] : DEFAULTS[k]; });
  LISTS.forEach((k) => { out[k] = Array.isArray(ig[k]) ? ig[k] : []; });
  out.slackChannel = String(ig.slackChannel || "");
  return out;
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (!["admin", "manager"].includes(caller.role)) return json(req, 403, { error: "staff only" });
  // deno-lint-ignore no-explicit-any
  let body: any; try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const clientId = String(body.clientId || "").trim();
  if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "clientId required" });
  const db = svc();

  const { data: regRow } = await db.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const c = (Array.isArray(regRow?.data) ? regRow!.data : []).find((x: any) => x && x.id === clientId);
  if (!c) return json(req, 404, { error: "client not found" });

  // an AM/PM may only change THEIR clients
  if (caller.role === "manager") {
    const { data: u } = await db.auth.admin.getUserById(caller.userId);
    const me = lc(u?.user?.user_metadata?.name);
    const mgrs = (Array.isArray(c.managers) && c.managers.length ? c.managers : [c.am, c.pm]).filter(Boolean).map(lc);
    if (!me || !mgrs.includes(me)) return json(req, 403, { error: "You can only change preferences for clients you manage." });
  }

  // the client's logins (email + name) — what the per-person switches are about
  const { data: profs } = await db.from("profiles").select("id,email").eq("client_id", clientId).eq("role", "client");
  const logins: Array<{ email: string; name: string }> = [];
  for (const p of profs || []) {
    const email = lc(p.email); if (!email) continue;
    let name = "";
    try { const { data: u } = await db.auth.admin.getUserById(p.id); name = String(u?.user?.user_metadata?.name || "").trim(); } catch { /* name optional */ }
    logins.push({ email, name });
  }

  if (body.action === "get") return json(req, 200, { ok: true, prefs: prefsOf(c), logins });
  if (body.action !== "set") return json(req, 400, { error: "unknown action" });

  // ---- validate the patch: known fields only, right types, emails of this client's logins
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = {}, inPatch = body.patch || {};
  const known = new Set(logins.map((l) => l.email));
  for (const k of BOOL) if (k in inPatch) patch[k] = !!inPatch[k];
  for (const k of ["notifyOff", "approvalOff", "todoRemindOn"]) if (k in inPatch) {
    if (!Array.isArray(inPatch[k])) return json(req, 400, { error: `${k} must be a list` });
    patch[k] = [...new Set(inPatch[k].map(lc).filter((e: string) => known.has(e)))];
  }
  if ("emailRecipients" in inPatch) {
    const list = Array.isArray(inPatch.emailRecipients) ? inPatch.emailRecipients : String(inPatch.emailRecipients || "").split(",");
    const bad = list.map(lc).filter((e: string) => e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    if (bad.length) return json(req, 400, { error: `Not an email address: ${bad.join(", ")}` });
    patch.emailRecipients = [...new Set(list.map(lc).filter(Boolean))];
  }
  if ("slackChannel" in inPatch) patch.slackChannel = String(inPatch.slackChannel || "").trim().replace(/\s+/g, "-").slice(0, 80);
  if (patch.approvalOff && logins.length && logins.every((l) => patch.approvalOff.includes(l.email)))
    return json(req, 400, { error: "At least one person must be a required approver." });
  if (!Object.keys(patch).length) return json(req, 400, { error: "nothing to change" });

  // ---- compare-and-set: change only this client's named fields on a fresh registry copy
  // deno-lint-ignore no-explicit-any
  const w = await updateRegistry((roster: any[]) => {
    const fc = roster.find((x) => x && x.id === clientId); if (!fc) return null;
    fc.integrations = Object.assign({}, fc.integrations, patch);
    return prefsOf(fc);
  });
  if (!w.ok || !w.result) return json(req, 409, { error: "Couldn't save — please try again." });

  // ---- a reviewer turned OFF comes off rounds already out for review (never leaves a round requiring nobody)
  let roundsUpdated = 0;
  if (patch.approvalOff && patch.approvalOff.length) {
    const off = new Set(patch.approvalOff as string[]);
    for (let i = 0; i < 5; i++) {
      const { data: row } = await db.from("app_state").select("data,updated_at").eq("client_id", clientId).eq("scope", "deliverables").maybeSingle();
      if (!row || !Array.isArray(row.data)) break;
      let changed = 0;
      // deno-lint-ignore no-explicit-any
      row.data.forEach((d: any) => (d.versions || []).forEach((v: any) => {
        if (!v || v.state === "pending_approval" || v.reviewedAt || !Array.isArray(v.expectedReviewers)) return;
        const revs = v.reviews || {};
        const exp = v.expectedReviewers.map(lc);
        const keep = exp.filter((e: string) => !off.has(e) || revs[e]);
        if (!keep.length || keep.length === exp.length) return;
        v.expectedReviewers = keep; changed++;
        if (keep.every((e: string) => revs[e])) {
          const st = Object.values(revs).map((x: any) => x && x.status).filter(Boolean);
          v.status = st.includes("revisions") ? "revisions" : st.includes("changes") ? "changes" : (st.length ? "approved" : v.status);
          v.reviewedAt = new Date().toLocaleDateString("en-US", { timeZone: "America/Phoenix", month: "short", day: "numeric", year: "numeric" });
          v.reviewedStatus = v.status || null; v.completedAtMs = Date.now();
        }
      }));
      if (!changed) break;
      const { data: ok } = await db.from("app_state").update({ data: row.data, updated_at: new Date().toISOString() })
        .eq("client_id", clientId).eq("scope", "deliverables").eq("updated_at", row.updated_at).select("updated_at");
      if (ok && ok.length) { roundsUpdated = changed; break; }
    }
  }
  return json(req, 200, { ok: true, prefs: w.result, logins, roundsUpdated });
});
