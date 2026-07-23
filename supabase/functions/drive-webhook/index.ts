/* ============================================================
   DRIVE-WEBHOOK — receives Google Drive push notifications for the
   connected project-plan files and re-pulls the changed one within
   seconds (vs. the 5-min poll). PUBLIC endpoint (Drive sends no JWT),
   so deploy with --no-verify-jwt; the security is the per-channel
   token we set at watch registration (X-Goog-Channel-Token).

   ACTIVATION: this only fires once drive-watch-setup has registered
   watches, which itself needs the webhook reachable on a Google-
   VERIFIED domain (Supabase custom domain on thejamesagency.com) —
   Google refuses to push to *.supabase.co. Until then it's inert.

   Deploy: supabase functions deploy drive-webhook --use-api --no-verify-jwt
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { driveAccessToken } from "../_shared/google.ts";
import { fetchPlanFromDrive, stable } from "../_shared/planfetch.ts";

const WATCH_CLIENT = "_drive_watch";
const WATCH_SCOPE = "clients";

Deno.serve(async (req) => {
  // Drive sends POST with X-Goog-* headers. Always 200 fast — a non-2xx makes Drive retry/back off.
  const token = req.headers.get("x-goog-channel-token") || "";
  const state = req.headers.get("x-goog-resource-state") || "";
  const resourceId = req.headers.get("x-goog-resource-id") || "";
  const secret = Deno.env.get("SNAPSHOT_SECRET") || "";

  // Verify the channel token — a spoofed POST without it does nothing.
  if (!secret || token !== secret) return new Response("no", { status: 200 });
  // "sync" is the initial handshake Drive sends when a watch is created — ack it, nothing to do.
  if (state === "sync" || !resourceId) return new Response("ok", { status: 200 });

  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // map the notification's resourceId → which plan file / client it belongs to
    const { data: wrow } = await svc.from("app_state").select("data").eq("client_id", WATCH_CLIENT).eq("scope", WATCH_SCOPE).maybeSingle();
    const watches: any[] = Array.isArray(wrow?.data) ? wrow!.data : [];
    const hit = watches.find((w) => w.resourceId === resourceId);
    if (!hit) return new Response("ok", { status: 200 });   // unknown channel — ignore

    const saToken = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");
    const plan = await fetchPlanFromDrive(saToken, hit.fileId);
    if (!plan || !Array.isArray((plan as any).groups) || !(plan as any).groups.length) return new Response("ok", { status: 200 });

    // write it onto every project on this client that uses this file (guarded on updated_at so a
    // concurrent human edit isn't clobbered — same discipline as plan-refresh).
    const { data: drow } = await svc.from("app_state").select("data,updated_at").eq("client_id", hit.clientId).eq("scope", "dashboard").maybeSingle();
    if (!drow) return new Response("ok", { status: 200 });
    const data = drow.data as { engagements?: { projects?: Array<{ projectPlanSheetUrl?: string; projectPlanSheet?: unknown }> } };
    const projs = data?.engagements?.projects || [];
    let dirty = false;
    for (const p of projs) {
      if (p.projectPlanSheetUrl && p.projectPlanSheetUrl.includes(hit.fileId) && stable(plan) !== stable(p.projectPlanSheet)) {
        p.projectPlanSheet = plan; dirty = true;
      }
    }
    if (dirty) {
      await svc.from("app_state").update({ data, updated_at: new Date().toISOString() })
        .eq("client_id", hit.clientId).eq("scope", "dashboard").eq("updated_at", drow.updated_at);
      // (lost the CAS race → a human just edited; the 5-min poll re-pulls, so no work is lost.)
    }
  } catch (_e) { /* never surface — Drive would just retry */ }
  return new Response("ok", { status: 200 });
});
