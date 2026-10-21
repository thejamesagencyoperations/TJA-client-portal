/* ============================================================
   TODO-REMINDERS — the day-before deadline digest (Cameron 2026-10-21).

   Once a day at 8am Arizona (pg_cron), for every client with reminders ON
   (registry integrations.todoReminders), email each opted-in client login
   (integrations.todoRemindOn = [emails]) ONE digest of the client-owned to-dos and
   project-plan items due tomorrow (Friday → Sat–Mon; nothing on weekends). Nothing
   due → no email. TJA-owned items never send. See _shared/todo-reminders.ts for the rules.

   Both switches default OFF — a client and a person are only reminded once someone turns
   them on (Exec Summary → Client Preferences).

   Idempotent: what's been sent is recorded per day in the "_todo_reminders"/"clients"
   sentinel row, so a re-run (manual, retry, GitHub backup) never double-sends.

   Body: { dry?: true, client?: "<id>", date?: "YYYY-MM-DD" (pretend today, dry only) }
   Auth: the scheduler secret (x-snapshot-secret: SNAPSHOT_SECRET or CRON_SECRET).
   Output: counts only.

   Deploy: supabase functions deploy todo-reminders --use-api --no-verify-jwt
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { cronAuthorized } from "../_shared/cron-auth.ts";
import { phoenixToday, dueDatesFor, collectDue, reminderEmail } from "../_shared/todo-reminders.ts";

const PORTAL_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal/";
const SENT_ID = "_todo_reminders", SENT_SCOPE = "clients";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  if (!cronAuthorized(req)) return json(req, 401, { error: "bad or missing secret" });
  // deno-lint-ignore no-explicit-any
  let body: any = {}; try { body = await req.json(); } catch { /* empty body = live run */ }
  const dry = !!body.dry;
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let today = phoenixToday();
  if (dry && /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) {
    const [y, m, d] = String(body.date).split("-").map(Number);
    today = { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
  }
  const todayKey = `${today.y}-${String(today.m).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
  const dueDates = dueDatesFor(today);
  if (!dueDates.length) return json(req, 200, { ok: true, today: todayKey, skipped: "weekend" });

  const { data: regRow } = await svc.from("app_state").select("data").eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const roster: any[] = Array.isArray(regRow?.data) ? regRow!.data : [];
  // deno-lint-ignore no-explicit-any
  const on = roster.filter((c: any) => c && c.id && !c.mergedInto && !c.archived && c.integrations && c.integrations.todoReminders === true
    && (!body.client || c.id === body.client));

  // people: names for the greeting, staff emails for the AM reply-to
  const names: Record<string, string> = {}, staffByName: Record<string, string> = {};
  for (let page = 1; page < 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data || !data.users.length) break;
    data.users.forEach((u) => {
      const nm = String(u.user_metadata?.name || "").trim(), em = String(u.email || "").toLowerCase();
      if (em) names[em] = nm;
      if (nm && em.endsWith("@thejamesagency.com")) staffByName[nm.toLowerCase()] = em;
    });
    if (data.users.length < 1000) break;
  }

  const { data: sentRow } = await svc.from("app_state").select("data,updated_at").eq("client_id", SENT_ID).eq("scope", SENT_SCOPE).maybeSingle();
  const sentLog: Record<string, Record<string, string[]>> = (sentRow?.data && typeof sentRow.data === "object") ? sentRow.data : {};
  const sentToday = sentLog[todayKey] || {};

  let clients = 0, withItems = 0, emailed = 0, alreadySent = 0, failed = 0;
  const preview: Array<{ client: string; to: number; items: number; subject: string }> = [];
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "noreply@thejamesagency.com";

  for (const c of on) {
    clients++;
    const { data: dash } = await svc.from("app_state").select("eng:data->engagements").eq("client_id", c.id).eq("scope", "dashboard").maybeSingle();
    const items = collectDue(dash?.eng || {}, { name: c.name, code: c.code, wmjCode: c.wmjCode }, dueDates);
    if (!items.length) continue;
    withItems++;
    const optIn = new Set(((c.integrations.todoRemindOn || []) as string[]).map((e) => String(e).trim().toLowerCase()));
    const { data: profs } = await svc.from("profiles").select("email").eq("client_id", c.id).eq("role", "client");
    // deno-lint-ignore no-explicit-any
    const to = (profs || []).map((p: any) => String(p.email || "").trim().toLowerCase()).filter((e: string) => e && optIn.has(e));
    const amEmail = c.am ? staffByName[String(c.am).trim().toLowerCase()] : "";
    for (const email of to) {
      if ((sentToday[c.id] || []).includes(email)) { alreadySent++; continue; }
      const first = (names[email] || "").split(/\s+/)[0] || "";
      const msg = reminderEmail({ firstName: first, clientName: c.name || c.id, items, dueDates, portalUrl: PORTAL_URL, amName: c.am || "" });
      if (dry) { preview.push({ client: c.id, to: 1, items: items.length, subject: msg.subject }); continue; }
      try {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ from: `The James Agency <${from}>`, to: [email], subject: msg.subject, html: msg.html },
            amEmail ? { reply_to: amEmail } : {})),
        });
        if (!r.ok) throw new Error(`resend ${r.status}`);
        emailed++;
        (sentToday[c.id] = sentToday[c.id] || []).push(email);
      } catch (e) { failed++; console.error("todo-reminders send", c.id, String((e as Error).message || e)); }
    }
  }

  if (!dry && emailed) {
    // keep two weeks of the send log; upsert (this job is the only writer of the row)
    sentLog[todayKey] = sentToday;
    Object.keys(sentLog).sort().slice(0, -14).forEach((k) => delete sentLog[k]);
    await svc.from("app_state").upsert({ client_id: SENT_ID, scope: SENT_SCOPE, data: sentLog, updated_at: new Date().toISOString() }, { onConflict: "client_id,scope" });
  }
  return json(req, 200, { ok: true, today: todayKey, dueDates, dry, clientsOn: clients, clientsWithItems: withItems, emailed, alreadySent, failed,
    ...(dry ? { preview } : {}) });
});
