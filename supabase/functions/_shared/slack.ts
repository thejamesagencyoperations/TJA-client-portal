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
