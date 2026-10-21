/* ============================================================
   TO-DO / DEADLINE REMINDERS — what's due, and the email (Cameron 2026-10-21).

   A client asked for a heads-up the day before THEIR items are due. Rules:
     • only CLIENT-owned items — anything TJA owns sends nothing;
     • to-dos (Monthly Services + every project) with a due date, not done, on a visible
       To-Do's tile; project-plan tasks whose "Who" is the client (CTC / BOTH / "Client" /
       the client's code or name), not complete, not in an internal phase;
     • ONE digest per person per day listing everything due; nothing due → no email;
     • sent 8am Arizona the day before; Friday's covers Saturday–Monday, none on weekends.
   Pure functions (no I/O) so the same code renders the preview locally and runs live.
   ============================================================ */
import { portalEmail } from "./email.ts";

export type DueItem = { where: string; kind: "To-do" | "Project plan"; text: string; due: string };

const FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// today in Arizona as {y,m,d,dow}
export function phoenixToday(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", year: "numeric", month: "numeric", day: "numeric", weekday: "short" }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(g("weekday"));
  return { y: +g("year"), m: +g("month"), d: +g("day"), dow };
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
// the due dates today's digest covers: tomorrow; Friday → Sat, Sun, Mon; weekend → none
export function dueDatesFor(t: { y: number; m: number; d: number; dow: number }): string[] {
  if (t.dow === 0 || t.dow === 6) return [];
  const n = t.dow === 5 ? 3 : 1, out: string[] = [];
  for (let i = 1; i <= n; i++) { const x = new Date(Date.UTC(t.y, t.m - 1, t.d + i)); out.push(iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate())); }
  return out;
}
// "2026-10-22" | "10/22/2026" | "Oct 22, 2026" → ISO, else ""
export function toIso(v: unknown): string {
  const s = String(v ?? "").trim(); if (!s) return "";
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) { const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return iso(y, +m[1], +m[2]); }
  const t = Date.parse(s); if (isNaN(t)) return "";
  const x = new Date(t); return iso(x.getFullYear(), x.getMonth() + 1, x.getDate());
}
export function prettyDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${DAYS[dow]}, ${FULL[m - 1]} ${d}`;
}

/* Is a project-plan "Who" the client's? Plan sheets name the owner as the client's code (CTC),
   "Client", "BOTH", or the client's name; "TJA" (alone) is ours. */
export function whoIsClient(who: string, client: { name?: string; code?: string; wmjCode?: string }): boolean {
  const w = String(who || "").trim().toLowerCase(); if (!w) return false;
  const tokens = w.split(/[\s,/&+]+/).filter(Boolean);
  if (tokens.includes("both") || tokens.includes("client")) return true;
  const codes = [client.code, client.wmjCode].filter(Boolean).map((c) => String(c).toLowerCase());
  if (tokens.some((t) => codes.includes(t))) return true;
  const nm = String(client.name || "").toLowerCase();
  return !!nm && w.includes(nm);
}

// deno-lint-ignore no-explicit-any
export function collectDue(engagements: any, client: { name?: string; code?: string; wmjCode?: string }, dueDates: string[]): DueItem[] {
  const want = new Set(dueDates), out: DueItem[] = [];
  // deno-lint-ignore no-explicit-any
  const todosOf = (e: any, where: string) => {
    if (!e || (e.tileVis && e.tileVis.todosdep === false)) return;          // tile switched off → client can't see it
    // deno-lint-ignore no-explicit-any
    (Array.isArray(e.todos) ? e.todos : []).forEach((t: any) => {
      const due = toIso(t && t.date);
      if (!t || t.done || (t.owner || "TJA") === "TJA" || !want.has(due)) return;
      out.push({ where, kind: "To-do", text: String(t.text || "To-do").trim(), due });
    });
  };
  const ret = engagements && engagements.retainer;
  if (ret) todosOf(ret, "Monthly Services");
  // deno-lint-ignore no-explicit-any
  (Array.isArray(engagements && engagements.projects) ? engagements.projects : []).forEach((p: any) => {
    if (!p || p.archived) return;
    const where = String(p.label || p.name || "Project");
    todosOf(p, where);
    const internal = p.planInternal || {};
    const groups = (p.projectPlanSheet && Array.isArray(p.projectPlanSheet.groups)) ? p.projectPlanSheet.groups : [];
    // deno-lint-ignore no-explicit-any
    groups.forEach((g: any) => {
      // internal (team-only) phase or task — hidden from the client. KEEP IN SYNC with app.js
      // planGroupKey ("g:"+num|name) / planTaskKey ("n:"+num, else "t:"+task)
      if (internal["g:" + (g.num || g.name || "")]) return;
      // deno-lint-ignore no-explicit-any
      (Array.isArray(g.tasks) ? g.tasks : []).forEach((tk: any) => {
        if (internal[tk.num ? "n:" + tk.num : "t:" + tk.task]) return;
        const due = toIso(tk.end);
        const done = (tk.pct != null && +tk.pct >= 100) || /complete|done/i.test(String(tk.status || ""));
        if (done || !want.has(due) || !whoIsClient(tk.who, client)) return;
        out.push({ where, kind: "Project plan", text: String(tk.task || "Task").trim(), due });
      });
    });
  });
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.where.localeCompare(b.where));
}

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function reminderEmail(o: { firstName?: string; clientName: string; items: DueItem[]; dueDates: string[]; portalUrl: string; amName?: string }) {
  const single = o.dueDates.length === 1;
  const when = single ? `tomorrow, ${prettyDate(o.dueDates[0])}` : `between ${prettyDate(o.dueDates[0])} and ${prettyDate(o.dueDates[o.dueDates.length - 1])}`;
  // group by date (when the digest spans a weekend), then by project
  const byDate = new Map<string, DueItem[]>();
  o.items.forEach((it) => { const a = byDate.get(it.due) || []; a.push(it); byDate.set(it.due, a); });
  const lists = [...byDate.entries()].map(([d, items]) => {
    const byWhere = new Map<string, DueItem[]>();
    items.forEach((it) => { const a = byWhere.get(it.where) || []; a.push(it); byWhere.set(it.where, a); });
    return `${single ? "" : `<p style="margin:18px 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#000">${esc(prettyDate(d))}</p>`}` +
      [...byWhere.entries()].map(([where, xs]) => `
        <p style="margin:12px 0 4px;font-family:Arial,Helvetica,sans-serif;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#f78f22;font-weight:bold">${esc(where)}</p>
        <ul style="margin:0 0 4px;padding-left:20px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5em;color:#000">
          ${xs.map((x) => `<li style="margin:0 0 4px">${esc(x.text)}${x.kind === "Project plan" ? ` <span style="color:#777;font-size:13px">(project plan)</span>` : ""}</li>`).join("")}
        </ul>`).join("");
  }).join("");
  const n = o.items.length;
  const html = portalEmail({
    preheader: `${n} item${n === 1 ? "" : "s"} due ${single ? "tomorrow" : "soon"} for ${o.clientName}`,
    heading: single ? "Due tomorrow" : "Coming up",
    bodyHtml: `
      <p style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5em;color:#000">Hi ${esc(o.firstName || "there")},</p>
      <p style="margin:0 0 6px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5em;color:#000">A quick reminder of what's due from your team ${esc(when)}:</p>
      ${lists}
      <p style="margin:18px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5em;color:#555">Already taken care of? Great — just let ${o.amName ? esc(o.amName) : "your account team"} know.</p>
      <p style="margin:14px 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5em;color:#999">You're getting this because deadline reminders are on for your login. Ask your account team any time to turn them off.</p>`,
    ctaText: "Open your portal",
    ctaUrl: o.portalUrl,
  });
  const subject = single ? `Reminder: ${n} item${n === 1 ? "" : "s"} due tomorrow — ${o.clientName}` : `Reminder: ${n} item${n === 1 ? "" : "s"} due ${prettyDate(o.dueDates[0]).split(",")[0]}–${prettyDate(o.dueDates[o.dueDates.length - 1]).split(",")[0]} — ${o.clientName}`;
  return { subject, html };
}
