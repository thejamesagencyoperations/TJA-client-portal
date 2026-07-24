/* ============================================================
   SEND-PR-WIN — posts a single PR hit to the #tja-pr_wins Slack
   channel, on demand, from the PR Coverage tile. The channel is fixed
   (Cameron: "always #tja-pr_wins"). Staff-only; the bot posts via
   chat:write.public (no channel invite needed).

   Deploy: supabase functions deploy send-pr-win --use-api
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { postToSlack } from "../_shared/slack.ts";

const CHANNEL = "#tja-pr_wins";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (!["admin", "manager", "creative", "media"].includes(caller.role)) return json(req, 403, { error: "staff only" });

  let body: { text?: string; link?: string; outlet?: string; date?: string; impressions?: string; adValue?: string; client?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }

  const text = String(body.text || "").trim();
  const link = String(body.link || "").trim();
  const outlet = String(body.outlet || "").trim();
  const client = String(body.client || "").trim();
  const date = String(body.date || "").trim();
  const impressions = String(body.impressions || "").trim();
  const adValue = String(body.adValue || "").trim();

  const lines: string[] = [`📣 *PR Win*${client ? ` — *${client}*` : ""}`];
  if (text) lines.push(text);
  const meta = [outlet, date, impressions ? `${impressions} impressions` : "", adValue ? `${adValue} AVE` : ""].filter(Boolean).join(" · ");
  if (meta) lines.push(`_${meta}_`);
  if (link) lines.push(`<${link}|View coverage →>`);

  const r = await postToSlack(CHANNEL, lines.join("\n"));
  if (r.ok) return json(req, 200, { ok: true });
  return json(req, 502, { error: r.error || (r.skipped ? "Slack not configured" : "post failed") });
});
