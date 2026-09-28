/* ============================================================
   SEND-REVIEW-NOTIFICATION — tells the TJA team (Slack + email) when a
   Present Docs review round is COMPLETE.

   THE GUARANTEE (rebuilt 2026-09-28): the ping goes out on SUBMISSION, every time,
   independent of anyone's browser staying open.
     • The message is built HERE from the saved deliverable record — never from what a
       browser says — so it always carries every reviewer's verdict and notes.
     • It is IDEMPOTENT: each round (client:doc:version) is claimed once in the
       "_review_notified" tracker row with a compare-and-set, so any number of callers can
       ask and exactly one Slack post + one email goes out.
     • It is RETRIED: a Slack or email failure is recorded and re-attempted by the next call
       (a teammate's or staff member's browser, or the 10-minute sweep cron) until it lands.

   Callers:
     1. the submitting CLIENT's browser, the moment their review is saved (keepalive fetch —
        survives the tab closing);
     2. any portal browser that sees a completed round the tracker hasn't confirmed (safety net);
     3. .github/workflows/review-notify-sweep.yml every 10 min (mode "sweep", SNAPSHOT_SECRET).
   The signed/marked-up proof PDF is built in a browser and follows as a THREAD REPLY under
   the original Slack post (mode "pdf") — it never delays the notification itself.

   Body: { mode?: "notify"|"pdf"|"sweep", clientId? (staff only), docId, vid?,
           pdfBase64?, pdfName?, pdfDriveLink? }
   Deploy: supabase functions deploy send-review-notification --use-api --project-ref sliutkbdpuimxxmvsbek
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";
import { portalEmail } from "../_shared/email.ts";
import { postToSlack, uploadFileToSlack, slackUserIdsByName } from "../_shared/slack.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";
const TRACK_CLIENT = "_review_notified";
const TRACK_SCOPE = "clients";
const MAX_ATTEMPTS = 14;                         // with the backoff below: ~1–2 DAYS of retrying before giving up
const STAFF_ROLES = ["admin", "manager", "creative"];
// exponential backoff between attempts, however many browsers/sweeps are asking: 1,2,4… → max 3h
const backoffMs = (attempts: number) => Math.min(3 * 3600_000, 60_000 * Math.pow(2, Math.max(0, attempts - 1)));
const SENDING_LEASE_MS = 3 * 60_000;             // a crashed sender's claim expires after this
const SWEEP_WINDOW_MS = 3 * 24 * 3600_000;       // the sweep only chases rounds completed recently

const STATUS: Record<string, { label: string; word: string; emoji: string }> = {
  approved:  { label: "Approved as shown",     word: "Approved",            emoji: "✅" },
  changes:   { label: "Approved with changes", word: "Approved w/ changes", emoji: "📝" },
  revisions: { label: "Revisions needed",      word: "Revisions needed",    emoji: "🔄" },
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const svc = () => createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function sendViaResend(to: string[], subject: string, html: string, text: string) {
  const from = Deno.env.get("PORTAL_FROM_EMAIL") || "onboarding@resend.dev";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: `The James Agency <${from}>`, to, subject, html, text }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return await r.json();
}

/* ---------- round state, read from the saved record ---------- */
type Review = { name?: string; email?: string; status?: string; notes?: string; reviewedAt?: string };
const lower = (e: unknown) => String(e || "").trim().toLowerCase();
function expectedOf(v: any): string[] { return Array.isArray(v?.expectedReviewers) ? v.expectedReviewers.map(lower) : []; }
function reviewsOf(v: any): Record<string, Review> { return (v?.reviews && typeof v.reviews === "object" && !Array.isArray(v.reviews)) ? v.reviews : {}; }
function roundComplete(v: any): boolean {
  const exp = expectedOf(v);
  if (exp.length) return exp.every((e) => !!reviewsOf(v)[e]);
  return !!v?.reviewedAt;
}
function aggregate(v: any): string | null {
  const st = Object.values(reviewsOf(v)).map((r) => r.status).filter(Boolean) as string[];
  if (!st.length) return v?.status || null;
  if (st.includes("revisions")) return "revisions";
  if (st.includes("changes")) return "changes";
  return "approved";
}
function surfaces(v: any): any[] { return (Array.isArray(v?.pages) && v.pages.length) ? v.pages : [v]; }
function commentCount(v: any): number { return surfaces(v).reduce((n, s) => n + ((s && Array.isArray(s.pins)) ? s.pins.length : 0), 0); }
const roundKey = (clientId: string, docId: string, v: any) => `${clientId}:${docId}:${v?.vid || v?.label || "v"}`;

async function loadDeliverables(clientId: string): Promise<any[]> {
  const { data, error } = await svc().from("app_state").select("data").eq("client_id", clientId).eq("scope", "deliverables").maybeSingle();
  if (error) throw new Error("deliverables read failed: " + error.message);
  return Array.isArray(data?.data) ? data!.data : [];
}
function findRound(items: any[], docId: string, vid?: string) {
  const d = items.find((x) => x && x.id === docId);
  if (!d) return null;
  const vs: any[] = Array.isArray(d.versions) ? d.versions : [];
  const v = vid ? vs.find((x) => x && x.vid === vid) : [...vs].reverse().find((x) => x && x.state !== "pending_approval");
  return v ? { d, v } : null;
}

/* ---------- the tracker: a compare-and-set claim per round ---------- */
type Track = { state: "sending" | "sent" | "failed"; at: number; attempts: number;
               slack?: "ok" | "skipped" | "error"; email?: "ok" | "skipped" | "error";
               slackTs?: string; slackChannel?: string; pdf?: boolean; pendingPdfLink?: string;
               nextAt?: number; lastError?: string };
async function trackerTxn<T>(fn: (t: Record<string, Track>) => { result: T; changed: boolean }): Promise<T> {
  const db = svc();
  for (let i = 0; i < 10; i++) {
    const { data: row, error } = await db.from("app_state").select("data,updated_at")
      .eq("client_id", TRACK_CLIENT).eq("scope", TRACK_SCOPE).maybeSingle();
    if (error) throw new Error("tracker read failed: " + error.message);
    const t: Record<string, Track> = (row?.data && typeof row.data === "object" && !Array.isArray(row.data)) ? row.data as any : {};
    const { result, changed } = fn(t);
    if (!changed) return result;
    // prune entries older than 45 days so the row can't grow forever
    const cutoff = Date.now() - 45 * 24 * 3600_000;
    for (const k of Object.keys(t)) if ((t[k]?.at || 0) < cutoff) delete t[k];
    const stamp = new Date().toISOString();
    if (!row) {
      const ins = await db.from("app_state").insert({ client_id: TRACK_CLIENT, scope: TRACK_SCOPE, data: t, updated_at: stamp });
      if (!ins.error) return result;
    } else {
      const up = await db.from("app_state").update({ data: t, updated_at: stamp })
        .eq("client_id", TRACK_CLIENT).eq("scope", TRACK_SCOPE).eq("updated_at", row.updated_at).select("updated_at");
      if (!up.error && up.data && up.data.length) return result;
    }
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  }
  throw new Error("tracker busy");
}
const needs = (x?: string) => x !== "ok" && x !== "skipped";

/* ---------- send the notification for one COMPLETE round (idempotent) ---------- */
async function notifyRound(clientId: string, d: any, v: any): Promise<Record<string, unknown>> {
  if (!roundComplete(v)) return { ok: false, reason: "round not complete" };
  const key = roundKey(clientId, d.id, v);
  const now = Date.now();
  // CLAIM: exactly one caller proceeds; everyone else is told it's handled.
  const claim = await trackerTxn((t) => {
    const cur = t[key];
    if (cur) {
      const done = !needs(cur.slack) && !needs(cur.email);
      if (done) return { result: { go: false, why: "already sent", cur }, changed: false };
      if (cur.state === "sending" && now - cur.at < SENDING_LEASE_MS) return { result: { go: false, why: "in progress", cur }, changed: false };
      if ((cur.attempts || 0) >= MAX_ATTEMPTS) return { result: { go: false, why: "gave up", cur }, changed: false };
      if (cur.state === "failed" && cur.nextAt && now < cur.nextAt) return { result: { go: false, why: "backing off", cur }, changed: false };
    }
    t[key] = Object.assign({}, cur || { attempts: 0 }, { state: "sending", at: now, attempts: ((cur && cur.attempts) || 0) + 1 }) as Track;
    return { result: { go: true, cur: cur || null }, changed: true };
  });
  if (!claim.go) return { ok: true, already: true, why: claim.why };
  const prev: Track | null = claim.cur as Track | null;
  const record = (patch: Partial<Track>, finalize: boolean) => trackerTxn((t) => {
    const cur = Object.assign({}, t[key] || {}, patch) as Track;
    if (finalize) {
      cur.state = (needs(cur.slack) || needs(cur.email)) ? "failed" : "sent";
      cur.at = Date.now();
      if (cur.state === "failed") cur.nextAt = Date.now() + backoffMs(cur.attempts || 1); else delete cur.nextAt;
    }
    t[key] = cur;
    return { result: cur, changed: true };
  });

  const entry = await registryEntry(clientId).catch(() => null);
  if (!entry) { await record({ lastError: "registry entry not found" }, true).catch(() => {}); return { ok: false, reason: "unknown client" }; }
  const clientName = entry.name || clientId;
  const status = aggregate(v) || "";
  const st = STATUS[status];
  const statusLabel = st ? st.label : "Responded";
  const nameLine = `${d.name || "a deliverable"}${v.label ? " " + v.label : ""}`;
  const nComments = commentCount(v);
  const REVIEW_URL = `${PORTAL_BASE_URL}/?open=docs&doc=${encodeURIComponent(d.id)}&client=${encodeURIComponent(clientId)}`;
  const folderUrl = /^[\w-]{10,}$/.test(String(d.driveFolderId || "")) ? `https://drive.google.com/drive/folders/${d.driveFolderId}` : "";

  // Every reviewer's verdict + notes, straight from the record. Required first, then optional.
  const exp = expectedOf(v), revs = reviewsOf(v);
  const people = [...exp, ...Object.keys(revs).filter((e) => !exp.includes(e))]
    .filter((e) => revs[e]).map((e) => ({ ...revs[e], optional: exp.length > 0 && !exp.includes(e) }));
  if (!people.length && (v.reviewedAt || v.status)) {
    // legacy single-reviewer round: the shared fields ARE the review
    people.push({ name: v.signedBy || "Client", status: v.status, notes: v.clientNotes || "", optional: false } as any);
  }
  const clip = (s: unknown, n: number) => { const t = String(s || "").trim().replace(/\s+/g, " "); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  const slackPeople = people.map((p) =>
    `• *${p.name || p.email || "Reviewer"}*${p.optional ? " (optional)" : ""} — ${STATUS[p.status || ""]?.word || "Responded"}` +
    (p.notes ? `\n    “${clip(p.notes, 500)}”` : "")).join("\n");

  let ccLine = "";
  if (status === "approved" || status === "changes") {
    const names = [...new Set([entry.am, entry.pm].filter(Boolean).map((n) => String(n)))];
    if (names.length) {
      const ids = await slackUserIdsByName(names).catch(() => ({} as Record<string, string>));
      ccLine = `\n${names.map((n) => ids[n.toLowerCase()] ? `<@${ids[n.toLowerCase()]}>` : `*${n}*`).join(" ")} — approved, over to you`;
    }
  }
  const emoji = st ? st.emoji : "💬";
  const slackText = `${emoji} *${clientName}* responded to *${nameLine}*: *${statusLabel}*` +
    `${nComments > 0 ? ` · ${nComments} comment${nComments === 1 ? "" : "s"}` : ""}` +
    `${slackPeople ? `\n${slackPeople}` : ""}${ccLine}` +
    `\n<${REVIEW_URL}|Open the deliverable →>${folderUrl ? `  ·  <${folderUrl}|Drive folder →>` : ""}` +
    `\n_The signed proof PDF follows in this thread._`;

  const result: Partial<Track> = {};
  // ---- Slack (skip if it already landed on a previous attempt) ----
  if (needs(prev?.slack)) {
    const ch = entry.integrations?.slackChannel;
    const r = await postToSlack(ch, slackText).catch((e) => ({ ok: false, error: String((e as Error).message || e) } as any));
    if (r.ok) {
      result.slack = "ok"; result.slackTs = r.ts; result.slackChannel = r.channel || ch;
      // record the post IMMEDIATELY — a later failure must never cause a second Slack post
      await record({ slack: "ok", slackTs: r.ts, slackChannel: result.slackChannel }, false).catch(() => {});
      // a PDF link that arrived while this post was pending/failing goes under it now
      const pend = (await trackerTxn((t) => ({ result: t[key] || null, changed: false })).catch(() => null)) as Track | null;
      if (pend && pend.pendingPdfLink && !pend.pdf && r.ts) {
        const pr = await postToSlack(r.channel || ch, `📎 Signed / marked-up proof — <${pend.pendingPdfLink}|Open the PDF in Drive →>`, { threadTs: r.ts }).catch(() => ({ ok: false } as any));
        if (pr.ok) await record({ pdf: true }, false).catch(() => {});
      }
    }
    else if (r.skipped) result.slack = "skipped";
    else { result.slack = "error"; result.lastError = "slack: " + (r.error || "unknown"); console.error("review-notification slack", r.error, ch); }
  }
  // ---- Email ----
  if (needs(prev?.email)) {
    const notifyOff = new Set((entry.integrations?.notifyOff ?? []).map(lower));
    const to = [...new Set([...(entry.login?.email ? [entry.login.email] : []), ...(entry.integrations?.emailRecipients ?? [])]
      .filter(Boolean).map(lower))].filter((e) => !notifyOff.has(e));
    if (!Deno.env.get("RESEND_API_KEY") || entry.integrations?.deliverableEmails === false || !to.length) {
      result.email = "skipped";
    } else {
      const peopleHtml = people.map((p) =>
        `<p style="margin:0 0 10px"><b>${esc(p.name || p.email || "Reviewer")}</b>${p.optional ? " <span style=\"color:#888\">(optional)</span>" : ""} — ${esc(STATUS[p.status || ""]?.word || "Responded")}` +
        (p.notes ? `<br><span style="white-space:pre-wrap;color:#444">${esc(p.notes)}</span>` : "") + `</p>`).join("");
      const html = portalEmail({
        preheader: `${clientName} responded to ${nameLine}: ${statusLabel}.`,
        heading: `${clientName} responded to their proof`,
        bodyHtml:
          `<p style="margin:0 0 14px">They&rsquo;ve reviewed &ldquo;<b>${esc(nameLine)}</b>&rdquo; in the portal.</p>` +
          peopleHtml +
          `<p style="margin:14px 0">${nComments > 0 ? `${nComments} comment${nComments === 1 ? " was" : "s were"} left on the proof.` : "No comments were left on the proof."}</p>` +
          (folderUrl ? `<p style="margin:0 0 14px;font-size:13px"><a href="${folderUrl}" style="color:#F68E21">Open the deliverable's Drive folder →</a> (the signed proof PDF is saved there)</p>` : ""),
        metaRows: [["Client", clientName], ["Response", statusLabel]],
        ctaText: "Open it in the portal",
        ctaUrl: REVIEW_URL,
      });
      const text = [
        `${clientName} has reviewed "${nameLine}".`, `\nResponse: ${statusLabel}.`,
        ...people.map((p) => `\n${p.name || p.email}${p.optional ? " (optional)" : ""}: ${STATUS[p.status || ""]?.word || "Responded"}${p.notes ? `\n  ${p.notes}` : ""}`),
        `\nOpen it in the portal: ${REVIEW_URL}`, folderUrl ? `Drive folder: ${folderUrl}` : "", `\n— The James Agency portal`,
      ].join("\n");
      try { await sendViaResend(to, `${clientName} responded: ${statusLabel} — ${nameLine}`, html, text); result.email = "ok"; }
      catch (e) { result.email = "error"; result.lastError = "email: " + String((e as Error).message || e).slice(0, 200); console.error("review-notification email", e); }
    }
  }
  // record the outcome — a failed channel stays "error" and a later caller retries just that one
  let final: Track;
  try { final = await record(result, true); }
  catch (_e) { final = await record(result, true); }       // one more go; trackerTxn already retries 10×
  return { ok: final.state === "sent", state: final.state, slack: final.slack, email: final.email, error: final.lastError || undefined };
}

/* ---------- the proof PDF, threaded under the notification ---------- */
async function postPdf(clientId: string, d: any, v: any, body: any): Promise<Record<string, unknown>> {
  if (!roundComplete(v)) return { ok: false, reason: "round not complete" };
  const key = roundKey(clientId, d.id, v);
  // make sure the notification itself went (or is going) first
  let t = await trackerTxn((tt) => ({ result: tt[key] || null, changed: false }));
  if (!t) { await notifyRound(clientId, d, v); t = await trackerTxn((tt) => ({ result: tt[key] || null, changed: false })); }
  if (t && t.pdf) return { ok: true, already: true };
  const entry = await registryEntry(clientId);
  if (!entry) return { ok: false, reason: "unknown client" };
  const link = /^https:\/\/(drive|docs)\.google\.com\//.test(String(body.pdfDriveLink || "")) ? String(body.pdfDriveLink) : "";
  // Only ever THREAD the PDF under the notification. If that post hasn't landed yet (failed, or
  // still sending), park the Drive link — notifyRound attaches it the moment the post succeeds —
  // rather than posting a lone PDF that the real notification then lands without.
  if (!(t && t.slack === "ok" && t.slackTs)) {
    if (t && t.slack === "skipped") return { ok: true, skipped: true };
    if (link) await trackerTxn((tt) => { tt[key] = Object.assign({}, tt[key] || { state: "failed", at: Date.now(), attempts: 0 }, { pendingPdfLink: link }); return { result: null, changed: true }; });
    return { ok: true, deferred: true };
  }
  const comment = `📎 Signed / marked-up proof — *${d.name || "deliverable"}${v.label ? " " + v.label : ""}*${link ? `\n<${link}|Open the PDF in Drive →>` : ""}`;
  const ch = t.slackChannel || entry.integrations?.slackChannel;
  const threadTs = t.slackTs;
  const b64 = String(body.pdfBase64 || "");
  const name = String(body.pdfName || `${d.name || "deliverable"}.pdf`).replace(/[^\w.\-]+/g, "_");
  let r: any = { ok: false, skipped: true };
  if (b64) r = await uploadFileToSlack(ch, comment, b64, name, { threadTs }).catch((e) => ({ ok: false, error: String(e) }));
  if (!r.ok) r = await postToSlack(ch, comment, { threadTs }).catch((e) => ({ ok: false, error: String(e) }));
  if (r.ok || r.skipped) {
    await trackerTxn((tt) => { tt[key] = Object.assign({}, tt[key] || { state: "sent", at: Date.now(), attempts: 0 }, { pdf: true }); return { result: null, changed: true }; });
  }
  return { ok: !!r.ok, skipped: !!r.skipped, error: r.error };
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  let body: any = {};
  try { body = await req.json(); } catch { body = {}; }
  const mode = String(body.mode || "notify");

  try {
    /* ---- SWEEP (cron): every recently completed round the tracker hasn't confirmed ---- */
    if (mode === "sweep") {
      const secret = Deno.env.get("SNAPSHOT_SECRET");
      if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });
      // only workspaces whose deliverables changed inside the window (a completion is a write),
      // so the sweep never drags every client's multi-MB row through the function
      const since = new Date(Date.now() - SWEEP_WINDOW_MS).toISOString();
      const { data: rows, error } = await svc().from("app_state").select("client_id,data")
        .eq("scope", "deliverables").gte("updated_at", since);
      if (error) throw new Error(error.message);
      const tracker = await trackerTxn((t) => ({ result: t, changed: false }));
      const out: unknown[] = [];
      for (const row of rows || []) {
        const clientId = String(row.client_id);
        if (clientId.startsWith("_")) continue;
        for (const d of (Array.isArray(row.data) ? row.data : [])) {
          for (const v of (Array.isArray(d?.versions) ? d.versions : [])) {
            const done = Number(v?.completedAtMs || 0);
            if (!done || Date.now() - done > SWEEP_WINDOW_MS || !roundComplete(v)) continue;
            const tr = tracker[roundKey(clientId, d.id, v)];
            if (tr && !needs(tr.slack) && !needs(tr.email)) continue;
            out.push({ clientId, doc: d.name, label: v.label, ...(await notifyRound(clientId, d, v)) });
          }
        }
      }
      return json(req, 200, { ok: true, handled: out });
    }

    /* ---- a signed-in caller ---- */
    const caller = await getCaller(req);
    if (!caller) return json(req, 401, { error: "not signed in" });
    // A client can only ever notify about its OWN workspace (profile, never the body). Staff
    // browsers act as the safety net and name the client; the server still verifies the round
    // really is complete from the saved record, so nobody can fabricate a notification.
    if (caller.role !== "client" && !STAFF_ROLES.includes(caller.role)) return json(req, 403, { error: "not allowed" });
    const clientId = caller.role === "client" ? caller.clientId : String(body.clientId || "").trim();
    if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "no client" });
    const docId = String(body.docId || "").trim();
    if (!docId) return json(req, 400, { error: "docId required" });
    const hit = findRound(await loadDeliverables(clientId), docId, body.vid ? String(body.vid) : undefined);
    if (!hit) return json(req, 404, { error: "deliverable/version not found" });
    const res = mode === "pdf" ? await postPdf(clientId, hit.d, hit.v, body) : await notifyRound(clientId, hit.d, hit.v);
    return json(req, 200, res);
  } catch (e) {
    console.error("send-review-notification", e);
    return json(req, 503, { error: String((e as Error).message || e).slice(0, 220) });
  }
});
