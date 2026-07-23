/* ============================================================
   DRIVE-WATCH-SETUP — registers (and renews) a Google Drive
   files.watch webhook for every connected project-plan file, so an
   edit pushes to drive-webhook within seconds. Idempotent: only
   (re)registers a file whose watch is missing or expiring soon.
   Stores the channel↔file map in app_state (_drive_watch/clients).

   Requires:
     • DRIVE_WEBHOOK_URL — the drive-webhook function's URL on a
       GOOGLE-VERIFIED domain (Supabase custom domain on
       thejamesagency.com). Google refuses *.supabase.co, so until the
       custom domain + domain verification are done this returns 428.
     • GOOGLE_SA_KEY, SNAPSHOT_SECRET (the channel token + the gate).

   Gate: SNAPSHOT_SECRET header. Deploy:
     supabase functions deploy drive-watch-setup --use-api --no-verify-jwt
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { driveAccessToken, parseDriveFileId } from "../_shared/google.ts";

const WATCH_CLIENT = "_drive_watch";
const WATCH_SCOPE = "clients";
const RENEW_WITHIN_MS = 12 * 60 * 60 * 1000;   // renew anything expiring within 12h

async function stopChannel(token: string, channelId: string, resourceId: string) {
  try {
    await fetch("https://www.googleapis.com/drive/v3/channels/stop", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channelId, resourceId }),
    });
  } catch (_e) { /* best-effort — Google auto-expires anyway */ }
}

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "GOOGLE_SA_KEY missing" });
  const webhook = Deno.env.get("DRIVE_WEBHOOK_URL");
  if (!webhook) return json(req, 428, { error: "DRIVE_WEBHOOK_URL not set — finish the custom-domain + Google domain verification first, then set this secret to the drive-webhook URL." });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");

  // every connected plan file → {fileId, clientId} (dedupe by fileId)
  const { data: rows } = await svc.from("app_state").select("client_id,data").eq("scope", "dashboard");
  const files = new Map<string, string>();   // fileId → clientId
  for (const row of (rows || [])) {
    if (String(row.client_id).startsWith("_")) continue;
    const projs = (row.data as any)?.engagements?.projects || [];
    for (const p of projs) {
      const fid = parseDriveFileId(p.projectPlanSheetUrl || "");
      if (fid && !files.has(fid)) files.set(fid, row.client_id);
    }
  }

  const { data: wrow } = await svc.from("app_state").select("data").eq("client_id", WATCH_CLIENT).eq("scope", WATCH_SCOPE).maybeSingle();
  const watches: any[] = Array.isArray(wrow?.data) ? wrow!.data : [];
  const byFile = new Map(watches.map((w) => [w.fileId, w]));
  const now = Date.now();
  let created = 0, renewed = 0, kept = 0, failed = 0;
  const next: any[] = [];

  for (const [fileId, clientId] of files) {
    const cur = byFile.get(fileId);
    if (cur && cur.expiration && (cur.expiration - now) > RENEW_WITHIN_MS) { next.push(cur); kept++; continue; }
    const channelId = crypto.randomUUID();
    try {
      const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/watch?supportsAllDrives=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: channelId, type: "web_hook", address: webhook, token: secret, expiration: now + 7 * 24 * 60 * 60 * 1000 }),
      });
      const j = await r.json();
      if (!r.ok || !j.resourceId) { failed++; if (cur) next.push(cur); continue; }
      if (cur && cur.channelId && cur.resourceId) await stopChannel(token, cur.channelId, cur.resourceId);
      next.push({ fileId, clientId, channelId, resourceId: j.resourceId, expiration: Number(j.expiration) || (now + 24 * 60 * 60 * 1000) });
      if (cur) renewed++; else created++;
    } catch (_e) { failed++; if (cur) next.push(cur); }
  }
  // drop watches for files no longer connected
  await svc.from("app_state").upsert({ client_id: WATCH_CLIENT, scope: WATCH_SCOPE, data: next, updated_at: new Date().toISOString() }, { onConflict: "client_id,scope" });

  return json(req, 200, { ok: true, files: files.size, created, renewed, kept, failed });
});
