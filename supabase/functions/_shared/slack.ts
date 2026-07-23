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
