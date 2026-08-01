/* ============================================================
   SHARED SLACK POST
   Fires alongside the portal's transactional emails (deliverable
   sent, client responded). Reuses the per-client integrations map:
   integrations.slackChannel decides WHERE a client's activity goes.

   Credential — set ONE as a Supabase secret; until then this NO-OPS
   (so wiring it in changes nothing until Slack is actually connected):
     • SLACK_BOT_TOKEN  (xoxb-…) — posts via chat.postMessage to the
       per-client channel in integrations.slackChannel (name or id).
       The bot must be invited to each channel. This is the full
       per-client routing the integrations map was built for.
     • SLACK_WEBHOOK_URL — an Incoming Webhook. Simplest to stand up,
       but every message lands in that webhook's ONE channel
       (integrations.slackChannel is ignored). Good for a single
       central #client-activity channel.
   Bot token wins if both are set. Always fails soft — a Slack problem
   never affects the email that already went out.
   ============================================================ */

// Resolve a channel NAME (#client-x) to its Slack ID (Cxxx) — files.completeUploadExternal
// needs the id, not the name. Uses conversations.list (needs channels:read/groups:read).
async function resolveChannelId(botToken: string, name: string): Promise<string | null> {
  const target = name.replace(/^#/, "").toLowerCase();
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const u = new URL("https://slack.com/api/conversations.list");
    u.searchParams.set("types", "public_channel,private_channel");
    u.searchParams.set("limit", "1000");
    u.searchParams.set("exclude_archived", "true");
    if (cursor) u.searchParams.set("cursor", cursor);
    const r = await fetch(u, { headers: { Authorization: `Bearer ${botToken}` } });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) return null;
    const hit = (j.channels || []).find((c: any) => String(c.name).toLowerCase() === target);
    if (hit) return hit.id;
    cursor = j.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }
  return null;
}

// Upload a file (base64) to a client's Slack channel WITH a message (initial_comment). Used to
// push the deliverable's PDF proof alongside the client's review. Needs the bot scope
// files:write (+ channels:read to resolve the channel). Falls back soft (caller then posts
// text-only). Same central SLACK_DEFAULT_CHANNEL fallback as postToSlack.
export async function uploadFileToSlack(
  channel: string | undefined, comment: string, base64: string, filename: string,
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const botToken = Deno.env.get("SLACK_BOT_TOKEN");
  const fallback = (Deno.env.get("SLACK_DEFAULT_CHANNEL") || "").trim();
  const ch = ((channel || "").trim()) || fallback;
  if (!botToken || !ch || !base64) return { ok: false, skipped: true };
  try {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // 1) reserve an upload URL
    const g = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ filename, length: String(bytes.length) }),
    });
    const gj = await g.json().catch(() => ({}));
    if (!gj.ok || !gj.upload_url || !gj.file_id) return { ok: false, error: gj.error || "getUploadURL failed" };
    // 2) upload the bytes
    const up = await fetch(gj.upload_url, { method: "POST", body: bytes });
    if (!up.ok) return { ok: false, error: `upload ${up.status}` };
    // 3) attach to the channel with the review message as the comment
    const chanId = await resolveChannelId(botToken, ch);
    if (!chanId) return { ok: false, error: "channel_not_found" };
    const c = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ files: [{ id: gj.file_id, title: filename }], channel_id: chanId, initial_comment: comment }),
    });
    const cj = await c.json().catch(() => ({}));
    return cj?.ok ? { ok: true } : { ok: false, error: cj?.error || "complete failed" };
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}

/* Resolve full names ("Frankie Bautista") to Slack user IDs so posts can @-mention people
   for real (<@U…> pings; plain "@Name" text notifies nobody). Matches real_name /
   display_name / handle case-insensitively via users.list.
   Needs the bot scope `users:read` — on missing_scope (or any failure) this returns what it
   has and the caller falls back to bold plain-text names, so tagging can never break a post. */
/* Resolve display names → Slack member ids so the AM/PM can be @-mentioned rather than merely
   named in bold. Matching is deliberately forgiving: the portal's names come from the assignment
   workbook, and a person's Slack profile rarely matches it character-for-character — an exact
   compare tagged one AM and left the other as plain bold text (Cameron 2026-07-31). Tiers, most
   confident first; a tier only runs for names still unresolved:
     1. exact, after normalising case/punctuation/emoji
     2. first + last token (survives a middle name, a suffix, or "Lastname, Firstname")
     3. first name alone — ONLY when exactly one person in the workspace has it, so we can
        never tag the wrong human just to avoid a bold name. */
const normName = (s: string) =>
  String(s || "").toLowerCase()
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")   // emoji in display names
    .replace(/\([^)]*\)/g, " ")                                   // "(she/her)", "(PTO)"
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ").trim();
const tokens = (s: string) => normName(s).split(" ").filter(Boolean);
const firstLast = (s: string) => { const t = tokens(s); return t.length > 1 ? `${t[0]} ${t[t.length - 1]}` : (t[0] || ""); };

export async function slackUserIdsByName(names: string[]): Promise<Record<string, string>> {
  const botToken = Deno.env.get("SLACK_BOT_TOKEN");
  const want = [...new Set(names.map((n) => String(n || "").trim().toLowerCase()).filter(Boolean))];
  const out: Record<string, string> = {};
  if (!botToken || !want.length) return out;

  type M = { id: string; forms: Set<string>; fl: Set<string>; first: string };
  const members: M[] = [];
  let cursor = "";
  try {
    for (let page = 0; page < 6; page++) {           // 6×200 covers a workspace far larger than TJA
      const u = new URL("https://slack.com/api/users.list");
      u.searchParams.set("limit", "200");
      if (cursor) u.searchParams.set("cursor", cursor);
      const r = await fetch(u, { headers: { Authorization: `Bearer ${botToken}` } });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) { console.error("slackUserIdsByName", j.error || "users.list failed"); return out; }
      for (const m of (j.members || [])) {
        if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
        const raw = [m.real_name, m.profile?.real_name, m.profile?.real_name_normalized,
                     m.profile?.display_name, m.profile?.display_name_normalized, m.name]
          .map((x: string) => String(x || "")).filter(Boolean);
        // a handle is usually first.last or first_last — treat the separators as spaces
        const forms = new Set(raw.map((x) => normName(x.replace(/[._-]+/g, " "))).filter(Boolean));
        const fl = new Set([...forms].map(firstLast).filter(Boolean));
        const firsts = [...forms].map((f) => f.split(" ")[0]).filter(Boolean);
        members.push({ id: m.id, forms, fl, first: firsts[0] || "" });
      }
      cursor = j.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
  } catch (e) { console.error("slackUserIdsByName", e); return out; }

  const unresolved = () => want.filter((w) => !out[w]);
  for (const w of unresolved()) {                          // tier 1 — exact (normalised)
    const n = normName(w);
    const hits = members.filter((m) => m.forms.has(n));
    if (hits.length !== 1) continue;
    /* A one-word target is a bare first name. Someone whose Slack HANDLE happens to equal it is
       not proof of identity while a second person shares that first name — two Jordans, one with
       the handle "jordan", would tag the wrong human. Defer those to the tier-3 uniqueness test,
       which declines rather than guesses. */
    if (tokens(w).length < 2 && members.filter((m) => m.first === n).length > 1) continue;
    out[w] = hits[0].id;
  }
  for (const w of unresolved()) {                          // tier 2 — first + last
    const n = firstLast(w); if (!n || n.indexOf(" ") < 0) continue;
    const hits = members.filter((m) => m.fl.has(n));
    if (hits.length === 1) out[w] = hits[0].id;
  }
  for (const w of unresolved()) {                          // tier 3 — unique first name only
    const f = tokens(w)[0]; if (!f) continue;
    const hits = members.filter((m) => m.first === f);
    if (hits.length === 1) out[w] = hits[0].id;
    else console.warn("slackUserIdsByName: no confident match for", w, `(${hits.length} share that first name)`);
  }
  return out;
}

export async function postToSlack(channel: string | undefined, text: string): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const botToken = Deno.env.get("SLACK_BOT_TOKEN");
  const webhook = Deno.env.get("SLACK_WEBHOOK_URL");
  // Central fallback: when a client has no per-client channel in the integrations map,
  // route to SLACK_DEFAULT_CHANNEL so notifications still land in one team channel. This
  // is what makes Slack work with ZERO per-client setup; per-client channels override it.
  const fallback = (Deno.env.get("SLACK_DEFAULT_CHANNEL") || "").trim();
  try {
    if (botToken) {
      const ch = ((channel || "").trim()) || fallback;
      if (!ch) return { ok: false, skipped: true };          // no per-client channel AND no default configured
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: ch.replace(/^#/, ""), text, unfurl_links: false }),
      });
      const j = await r.json().catch(() => ({}));
      return j?.ok ? { ok: true } : { ok: false, error: j?.error || `http ${r.status}` };
    }
    if (webhook) {
      const r = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return r.ok ? { ok: true } : { ok: false, error: `http ${r.status}` };
    }
    return { ok: false, skipped: true };                      // Slack not configured yet
  } catch (e) {
    return { ok: false, error: String((e as Error).message || e) };
  }
}
