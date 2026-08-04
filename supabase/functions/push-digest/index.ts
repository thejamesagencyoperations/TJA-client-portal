/* ============================================================
   PUSH-DIGEST — emails what was PUSHED TO MAIN (code, not portal data).

   `main` deploys straight to GitHub Pages with no review gate, so a push IS a
   production release. This is the record of those releases while Cameron is away.
   Portal DATA edits are a different thing entirely and live in audit-digest.

   The workflow does the git work (it has the checkout) and POSTs the commit list
   here; this function only formats and sends. That split keeps the function
   independent of any GitHub API token.

   TEMPORARY BY DESIGN, same as audit-digest: past DIGEST_UNTIL it sends nothing and
   returns {expired:true}, so it switches itself off with nothing to remember. The
   final in-window email says so explicitly.

   Gate: SNAPSHOT_SECRET header. Deploy:
     supabase functions deploy push-digest --use-api --no-verify-jwt
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { portalEmail } from "../_shared/email.ts";

const DIGEST_UNTIL = "2026-08-17";          // inclusive last day (America/Phoenix)
const TO = (Deno.env.get("AUDIT_DIGEST_TO") || "cameron@thejamesagency.com")
  .split(",").map((s) => s.trim()).filter(Boolean);
const REPO_URL = "https://github.com/thejamesagencyoperations/TJA-client-portal";
const MAX_COMMITS = 30;                     // shown before "…and N more"

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const phoenix = (d: Date) => new Date(d.getTime() - 7 * 3600e3);
const ymd = (d: Date) => phoenix(d).toISOString().slice(0, 10);

interface Commit {
  sha?: string; author?: string; email?: string; date?: string;
  subject?: string; files?: number; insertions?: number; deletions?: number;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret)
    return json(req, 401, { error: "bad or missing snapshot secret" });

  const today = ymd(new Date());
  if (today > DIGEST_UNTIL) return json(req, 200, { ok: true, expired: true, until: DIGEST_UNTIL, sent: false });
  if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { error: "email not configured (RESEND_API_KEY)" });

  let body: { commits?: Commit[]; windowHours?: number; branch?: string; deployOk?: boolean | null };
  try { body = await req.json(); } catch { return json(req, 400, { error: "JSON body required" }); }
  const commits = Array.isArray(body.commits) ? body.commits : [];
  const hours = +(body.windowHours || 24);
  const branch = String(body.branch || "main");
  const when = ymd(new Date());
  const isLast = today === DIGEST_UNTIL;

  const tail = isLast
    ? `<p style="margin:18px 0 0;font-size:13px;color:#666"><b>This is the last of these.</b> The
       digest covered 3–17 August and has now switched itself off — no action needed.</p>`
    : `<p style="margin:18px 0 0;font-size:13px;color:#666">Daily until ${esc(DIGEST_UNTIL)}, then it
       stops on its own. <code>${esc(branch)}</code> deploys straight to production, so every commit
       below is live.</p>`;

  /* A QUIET DAY STILL SENDS. "Nothing was pushed" is the answer Cameron actually wants most
     days, and it is only trustworthy if the absence of news is a message rather than silence
     that could equally mean the cron died. */
  if (!commits.length) {
    const html = portalEmail({
      preheader: `Nothing was pushed to ${branch} in the last ${hours} hours.`,
      heading: "No code pushed",
      bodyHtml: `<p style="margin:0">No commits landed on <code>${esc(branch)}</code> in the last
        ${hours} hours — the live portal is unchanged. Sent on quiet days too, so silence never
        has to mean "maybe the watcher broke".</p>${tail}`,
      metaRows: [["Branch", branch], ["Window", `${hours} hours to ${when}`]],
      ctaText: "View commit history", ctaUrl: `${REPO_URL}/commits/${branch}`,
    });
    return json(req, 200, { ok: true, commits: 0, sent: await send(`TJA Portal code — nothing pushed (${when})`, html) });
  }

  // who pushed, and how much — the top-line answer
  const byAuthor = new Map<string, number>();
  for (const c of commits) {
    const a = c.author || c.email || "Unknown";
    byAuthor.set(a, (byAuthor.get(a) || 0) + 1);
  }
  const whoLine = [...byAuthor.entries()].sort((a, b) => b[1] - a[1])
    .map(([w, n]) => `${esc(w)} (${n})`).join(" · ");
  const totalFiles = commits.reduce((s, c) => s + (+(c.files || 0)), 0);
  const churn = commits.reduce((s, c) => s + (+(c.insertions || 0)) + (+(c.deletions || 0)), 0);

  const list = commits.slice(0, MAX_COMMITS).map((c) => {
    const sha = String(c.sha || "").slice(0, 7);
    const t = c.date ? phoenix(new Date(c.date)).toISOString().slice(11, 16) : "";
    const stat = [
      c.files != null ? `${c.files} file${+c.files === 1 ? "" : "s"}` : "",
      c.insertions != null || c.deletions != null ? `+${c.insertions || 0}/-${c.deletions || 0}` : "",
    ].filter(Boolean).join(" · ");
    return `<div style="margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid #f0f0f0">
      <div style="font-size:13px"><b>${esc(c.subject || "(no message)")}</b></div>
      <div style="font-size:12px;color:#666;margin-top:3px">
        ${esc(c.author || "Unknown")}${t ? ` · ${esc(t)}` : ""}
        ${sha ? ` · <a href="${REPO_URL}/commit/${esc(c.sha)}" style="color:#f78f22;text-decoration:none">${esc(sha)}</a>` : ""}
        ${stat ? ` · ${esc(stat)}` : ""}</div>
    </div>`;
  }).join("");
  const overflow = commits.length > MAX_COMMITS
    ? `<div style="font-size:12px;color:#999">…and ${commits.length - MAX_COMMITS} more commit(s)</div>` : "";

  const html = portalEmail({
    preheader: `${commits.length} commit${commits.length === 1 ? "" : "s"} pushed to ${branch}.`,
    heading: commits.length === 1 ? "1 commit pushed to production" : `${commits.length} commits pushed to production`,
    bodyHtml: `<p style="margin:0 0 16px"><b>${commits.length} commit${commits.length === 1 ? "" : "s"}</b>
      landed on <code>${esc(branch)}</code> in the last ${hours} hours, touching ${totalFiles}
      file change${totalFiles === 1 ? "" : "s"}. <code>${esc(branch)}</code> deploys straight to
      the live portal, so this is already in production.</p>${list}${overflow}${tail}`,
    metaRows: [["Branch", branch], ["Pushed by", whoLine || "—"],
      ["Lines changed", String(churn)], ["Window", `${hours} hours to ${when}`]],
    ctaText: "View commit history", ctaUrl: `${REPO_URL}/commits/${branch}`,
  });

  const sent = await send(
    `TJA Portal code — ${commits.length} commit${commits.length === 1 ? "" : "s"} pushed (${when})`, html);
  return json(req, 200, { ok: true, commits: commits.length, authors: byAuthor.size, sent, last: isLast });

  async function send(subject: string, bodyHtml: string): Promise<boolean> {
    try {
      const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: `The James Agency <${from}>`, to: TO, subject, html: bodyHtml }),
      });
      if (!r.ok) { console.error("push-digest resend", r.status, (await r.text()).slice(0, 300)); return false; }
      return true;
    } catch (e) {
      console.error("push-digest send failed", String((e as Error).message || e));
      return false;
    }
  }
});
