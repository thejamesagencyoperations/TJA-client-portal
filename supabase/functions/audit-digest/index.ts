/* ============================================================
   AUDIT-DIGEST — a once-a-day email of everything that changed in the portal.

   TEMPORARY BY DESIGN. Cameron asked for this to cover a two-week absence
   (2026-08-03 → 2026-08-17) and explicitly does NOT want it ongoing, so it
   EXPIRES ON ITS OWN: past DIGEST_UNTIL this function sends nothing and returns
   {expired:true}. The last in-window digest says so in the email, so the run of
   emails ending is a deliberate signal rather than something you wonder about.
   Nothing to remember to switch off — but the workflow can be deleted after, and
   the final email says as much.

   Reads audit_log directly with the service role (bypasses RLS), covering the
   WINDOW_HOURS before the run. Groups by client, then by person, so the mail
   answers "who touched what" without scrolling a raw feed.

   Gate: SNAPSHOT_SECRET header, same as the other machine endpoints. Deploy:
     supabase functions deploy audit-digest --use-api --no-verify-jwt
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { portalEmail } from "../_shared/email.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

// Inclusive last day this digest runs (America/Phoenix dates). After this it self-disables.
const DIGEST_UNTIL = "2026-08-17";
const WINDOW_HOURS = 24;
const TO = (Deno.env.get("AUDIT_DIGEST_TO") || "cameron@thejamesagency.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PORTAL_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal/history.html";
const MAX_PER_GROUP = 12;          // rows shown per client before "…and N more"
const MAX_CHANGE_LINES = 4;        // field-level lines shown per row

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// TJA's day is America/Phoenix (UTC-7, no DST) — same basis as every other scheduled job here.
const phoenix = (d: Date) => new Date(d.getTime() - 7 * 3600e3);
const ymd = (d: Date) => phoenix(d).toISOString().slice(0, 10);

interface Row {
  ts: string; client_id: string; scope: string | null;
  actor_email: string | null; actor_name: string | null; actor_role: string | null;
  action: string; summary: string | null;
  changes: Array<{ p?: string; f?: string; t?: string }> | null; n: number | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST" && req.method !== "GET") return json(req, 405, { error: "POST/GET only" });
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret)
    return json(req, 401, { error: "bad or missing snapshot secret" });

  const today = ymd(new Date());
  // SELF-EXPIRY, checked before any work: this was commissioned for one specific fortnight.
  if (today > DIGEST_UNTIL) return json(req, 200, { ok: true, expired: true, until: DIGEST_UNTIL, sent: false });
  if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { error: "email not configured (RESEND_API_KEY)" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const since = new Date(Date.now() - WINDOW_HOURS * 3600e3).toISOString();

  const { data, error } = await svc.from("audit_log")
    .select("ts,client_id,scope,actor_email,actor_name,actor_role,action,summary,changes,n")
    .gte("ts", since).order("ts", { ascending: false }).limit(2000);
  if (error) return json(req, 500, { error: error.message });
  const all = (data || []) as Row[];
  /* PEOPLE vs AUTOMATION. The point of this digest is "what did my team change", and the
     unattended crons (plan re-pulls, WMJ syncs, snapshots) out-write humans by orders of
     magnitude — the first live send was 229 automated plan re-pulls against 7 real edits.
     Left mixed, the thing you actually want is buried and the email stops being read.
     People lead; automation collapses to a per-action count at the bottom. */
  const isBot = (r: Row) => r.actor_role === "system" || !r.actor_email;
  // actor breakdown on the response — makes "why is this row counted as a person?" answerable
  // without shell access to the table.
  const byRole: Record<string, number> = {};
  for (const r of all) {
    const k = `${r.actor_role || "(null)"}|${r.actor_email ? "email" : "no-email"}|${r.action}`;
    byRole[k] = (byRole[k] || 0) + 1;
  }
  const rows = all.filter((r) => !isBot(r));
  const botRows = all.filter(isBot);

  // client_id → display name, so the email reads "Circle the City", not "circle-the-city"
  const { data: reg } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: Array<{ id?: string; name?: string }> = Array.isArray(reg?.data) ? reg!.data : [];
  const nameOf = (id: string) => {
    if (id === "_registry") return "Client registry (assignments / integrations)";
    if (id === "_settings") return "Workspace settings";
    const c = roster.find((x) => String(x.id) === id);
    return (c && c.name) || id;
  };

  // one line per automated action, e.g. "plan.refreshed — 229"
  const botCounts = new Map<string, number>();
  for (const r of botRows) botCounts.set(r.action, (botCounts.get(r.action) || 0) + 1);
  const botBlock = botRows.length
    ? `<div style="margin:22px 0 0;padding-top:14px;border-top:1px solid #e6e6e6">
         <div style="font-size:13px;font-weight:bold;color:#666;margin-bottom:6px">Automation
           <span style="font-weight:normal;color:#999">· ${botRows.length} event${botRows.length === 1 ? "" : "s"}, no human involved</span></div>
         ${[...botCounts.entries()].sort((a, b) => b[1] - a[1])
             .map(([a, n]) => `<div style="font-size:12px;color:#666">${esc(a)} — ${n}</div>`).join("")}
       </div>`
    : "";

  const isLast = today === DIGEST_UNTIL;
  const when = phoenix(new Date()).toISOString().slice(0, 10);
  const tail = isLast
    ? `<p style="margin:18px 0 0;font-size:13px;color:#666"><b>This is the last of these.</b> The
       digest was set up to cover 3–17 August and has now switched itself off — no action needed.
       The full history stays in the portal (45 days live, older months archived to Drive
       indefinitely).</p>`
    : `<p style="margin:18px 0 0;font-size:13px;color:#666">Daily until ${esc(DIGEST_UNTIL)}, then
       it stops on its own. The full searchable history lives in the portal.</p>`;

  /* NOTHING CHANGED is worth sending too: a silent day is indistinguishable from a broken
     cron, and the entire point of this fortnight is knowing the record is intact. */
  if (new URL(req.url).searchParams.get("inspect") === "1") {
    return json(req, 200, { ok: true, inspect: true, total: all.length,
      people: rows.length, automation: botRows.length, byRole });
  }
  if (!rows.length) {
    const html = portalEmail({
      preheader: `Nobody changed anything in the portal in the last ${WINDOW_HOURS} hours.`,
      heading: "No changes yesterday",
      bodyHtml: `<p style="margin:0">No one on the team edited anything in the portal in the last
        ${WINDOW_HOURS} hours. This email is sent on quiet days too — a silent day and a broken
        digest would otherwise look identical.</p>${botBlock}${tail}`,
      metaRows: [["Window", `${WINDOW_HOURS} hours to ${when}`]],
      ctaText: "Open edit history", ctaUrl: PORTAL_URL,
    });
    const sent = await send(`TJA Portal — no team changes (${when})`, html);
    return json(req, 200, { ok: true, people: 0, automation: botRows.length, sent, last: isLast });
  }

  // ---- group by client, then summarise per person ----
  const byClient = new Map<string, Row[]>();
  for (const r of rows) {
    const k = r.client_id || "(unknown)";
    (byClient.get(k) || byClient.set(k, []).get(k)!).push(r);
  }
  const people = new Map<string, number>();
  for (const r of rows) {
    const who = r.actor_name || r.actor_email || (r.actor_role === "system" ? "Automation" : "Unknown");
    people.set(who, (people.get(who) || 0) + 1);
  }
  const whoLine = [...people.entries()].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${esc(w)} (${n})`).join(" · ");

  // Clients with the most activity first — that's what you want to read at the top.
  const sections = [...byClient.entries()].sort((a, b) => b[1].length - a[1].length).map(([cid, list]) => {
    const shown = list.slice(0, MAX_PER_GROUP);
    const items = shown.map((r) => {
      const who = esc(r.actor_name || r.actor_email || (r.actor_role === "system" ? "Automation" : "Unknown"));
      const t = new Date(r.ts); const hhmm = phoenix(t).toISOString().slice(11, 16);
      const changes = (r.changes || []).slice(0, MAX_CHANGE_LINES).map((c) => {
        const f = String(c.f ?? ""), to = String(c.t ?? "");
        const shorten = (v: string) => (v.length > 60 ? v.slice(0, 60) + "…" : v);
        return `<div style="font-size:12px;color:#666;padding-left:10px">${esc(c.p || "")}: ` +
               `<span style="text-decoration:line-through">${esc(shorten(f)) || "—"}</span> → ` +
               `<b>${esc(shorten(to)) || "—"}</b></div>`;
      }).join("");
      const more = (r.n || 0) > MAX_CHANGE_LINES
        ? `<div style="font-size:12px;color:#999;padding-left:10px">…and ${(r.n || 0) - MAX_CHANGE_LINES} more field(s)</div>`
        : "";
      return `<div style="margin:0 0 10px">
        <div style="font-size:13px"><b>${who}</b> — ${esc(r.summary || r.action)}
          <span style="color:#999">· ${esc(hhmm)}</span></div>${changes}${more}</div>`;
    }).join("");
    const overflow = list.length > MAX_PER_GROUP
      ? `<div style="font-size:12px;color:#999">…and ${list.length - MAX_PER_GROUP} more change(s) on this client</div>`
      : "";
    return `<div style="margin:0 0 22px">
      <div style="font-size:14px;font-weight:bold;border-bottom:1px solid #e6e6e6;padding-bottom:5px;margin-bottom:9px">
        ${esc(nameOf(cid))} <span style="color:#999;font-weight:normal">· ${list.length} change${list.length === 1 ? "" : "s"}</span>
      </div>${items}${overflow}</div>`;
  }).join("");

  const html = portalEmail({
    preheader: `${rows.length} change${rows.length === 1 ? "" : "s"} by the team across ${byClient.size} client${byClient.size === 1 ? "" : "s"}.`,
    heading: "Portal changes yesterday",
    bodyHtml: `<p style="margin:0 0 16px"><b>${rows.length} change${rows.length === 1 ? "" : "s"}</b> by
      the team across ${byClient.size} client${byClient.size === 1 ? "" : "s"} in the last
      ${WINDOW_HOURS} hours${botRows.length ? `, plus ${botRows.length} automated event${botRows.length === 1 ? "" : "s"} (listed at the bottom)` : ""}.</p>
      ${sections}${botBlock}${tail}`,
    metaRows: [["Window", `${WINDOW_HOURS} hours to ${when}`], ["Who", whoLine || "—"]],
    ctaText: "Open edit history", ctaUrl: PORTAL_URL,
  });

  const sent = await send(
    `TJA Portal — ${rows.length} team change${rows.length === 1 ? "" : "s"} (${when})`, html);
  return json(req, 200, { ok: true, people: rows.length, automation: botRows.length,
    clients: byClient.size, sent, last: isLast });

  async function send(subject: string, body: string): Promise<boolean> {
    try {
      const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `The James Agency <${from}>`, to: TO, subject, html: body }),
      });
      if (!r.ok) { console.error("audit-digest resend", r.status, (await r.text()).slice(0, 300)); return false; }
      return true;
    } catch (e) {
      console.error("audit-digest send failed", String((e as Error).message || e));
      return false;
    }
  }
});
