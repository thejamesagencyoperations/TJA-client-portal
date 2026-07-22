/* ============================================================
   MEDIA-INTAKE — clients submit paid-media creative requests from
   the portal (the "reverse Present Docs"). All writes go through
   here (service role) so we never need a client-write RLS policy;
   reads happen directly (staff read all scopes, clients read own).

   Storage: app_state (client_id, scope='media_intake'),
     data = { submissions: [ { id, submittedAt, submittedBy, status,
              note, assets: [ {name,driveLink,landingUrl,headline,
              body,cta,purpose,purposeDetail,audience,launchDate,
              endDate,notes} ] } ] }

   Body (JSON):
     { action: "submit", clientId?, note?, assets: [...] }
       - client caller: clientId is forced to their own (body ignored)
       - staff caller: may pass clientId (submitting on a client's behalf)
     { action: "status", clientId, submissionId, status }   (staff only)

   Notifies the paid-media team on submit: Slack → the client's channel,
   email → PAID_MEDIA_EMAIL (a Supabase secret; skipped if unset).
   Deploy: supabase functions deploy media-intake --use-api
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { registryEntry } from "../_shared/registry.ts";
import { portalEmail } from "../_shared/email.ts";
import { postToSlack } from "../_shared/slack.ts";

const PORTAL_BASE_URL = "https://thejamesagencyoperations.github.io/TJA-client-portal";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

type Asset = Record<string, string>;
type Submission = { id: string; submittedAt: string; submittedBy: string; status: string; note?: string; assets: Asset[] };

function svc() {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
async function readIntake(db: ReturnType<typeof svc>, clientId: string): Promise<{ submissions: Submission[] }> {
  const { data } = await db.from("app_state").select("data").eq("client_id", clientId).eq("scope", "media_intake").maybeSingle();
  const d = data?.data as { submissions?: Submission[] } | undefined;
  return { submissions: Array.isArray(d?.submissions) ? d!.submissions! : [] };
}
async function writeIntake(db: ReturnType<typeof svc>, clientId: string, value: { submissions: Submission[] }) {
  return await db.from("app_state").upsert(
    { client_id: clientId, scope: "media_intake", data: value, updated_at: new Date().toISOString() },
    { onConflict: "client_id,scope" },
  );
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });

  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });

  let body: { action?: string; clientId?: string; note?: string; assets?: Asset[]; submissionId?: string; status?: string };
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const isStaff = ["admin", "manager", "creative"].includes(caller.role);
  const db = svc();

  // ---- submit (client, or staff on a client's behalf) ----
  if (action === "submit") {
    const clientId = caller.role === "client" ? caller.clientId : String(body.clientId ?? "").trim();
    if (!clientId || clientId.startsWith("_")) return json(req, 400, { error: "no target client" });
    const assets = Array.isArray(body.assets) ? body.assets.filter((a) => a && Object.values(a).some((v) => String(v).trim())) : [];
    if (!assets.length) return json(req, 400, { error: "add at least one asset" });

    const cur = await readIntake(db, clientId);
    const sub: Submission = {
      id: "sub_" + crypto.randomUUID().slice(0, 8),
      submittedAt: new Date().toISOString(),
      submittedBy: caller.email || caller.role,
      status: "new",
      note: String(body.note ?? "").trim() || undefined,
      assets,
    };
    cur.submissions.unshift(sub);
    const { error } = await writeIntake(db, clientId, cur);
    if (error) return json(req, 500, { error: error.message });

    // notify the paid-media team (fire-and-forget-ish; never blocks the submit)
    const entry = await registryEntry(clientId);
    const clientName = entry?.name || clientId;
    const REVIEW_URL = `${PORTAL_BASE_URL}/?open=media`;
    postToSlack(entry?.integrations?.slackChannel,
      `📥 New *media request* from *${clientName}* · ${assets.length} asset${assets.length === 1 ? "" : "s"}\n<${REVIEW_URL}|Open in the portal →>`).catch(() => {});
    const to = (Deno.env.get("PAID_MEDIA_EMAIL") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    let emailed = false;
    if (to.length && Deno.env.get("RESEND_API_KEY")) {
      try {
        const listHtml = assets.map((a, i) =>
          `<p style="margin:0 0 8px"><b>Asset ${i + 1}:</b> ${esc(a.name || "(unnamed)")}${a.purpose ? ` — <i>${esc(a.purpose)}</i>` : ""}${a.driveLink ? `<br><a href="${esc(a.driveLink)}">${esc(a.driveLink)}</a>` : ""}</p>`).join("");
        const html = portalEmail({
          preheader: `${clientName} submitted ${assets.length} creative asset request(s).`,
          heading: "New media request",
          bodyHtml: `<p style="margin:0 0 14px"><b>${esc(clientName)}</b> submitted ${assets.length} asset request${assets.length === 1 ? "" : "s"} for the paid-media team.</p>${listHtml}`,
          metaRows: [["Client", clientName], ["Assets", String(assets.length)]],
          ctaText: "Open it in the portal",
          ctaUrl: REVIEW_URL,
        });
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: Deno.env.get("PORTAL_FROM_EMAIL") || "noreply@thejamesagency.com", to, subject: `New media request — ${clientName} (${assets.length} asset${assets.length === 1 ? "" : "s"})`, html }),
        });
        emailed = r.ok;
      } catch (_e) { /* email is best-effort */ }
    }
    return json(req, 200, { ok: true, id: sub.id, emailed });
  }

  // ---- status update (staff only) ----
  if (action === "status") {
    if (!isStaff) return json(req, 403, { error: "staff only" });
    const clientId = String(body.clientId ?? "").trim();
    const submissionId = String(body.submissionId ?? "").trim();
    const status = String(body.status ?? "").trim();
    if (!clientId || !submissionId || !status) return json(req, 400, { error: "clientId, submissionId, status required" });
    const cur = await readIntake(db, clientId);
    const sub = cur.submissions.find((s) => s.id === submissionId);
    if (!sub) return json(req, 404, { error: "submission not found" });
    sub.status = status;
    const { error } = await writeIntake(db, clientId, cur);
    if (error) return json(req, 500, { error: error.message });
    return json(req, 200, { ok: true });
  }

  return json(req, 400, { error: "unknown action" });
});
