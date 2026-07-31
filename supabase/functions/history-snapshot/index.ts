/* ============================================================
   HISTORY-SNAPSHOT — the Drive half of the version/edit history.

   Two jobs, once a day:
     1. SNAPSHOT  — for each client whose data changed since its last snapshot, write ONE
        gzipped JSON of every scope to Drive:
            <history folder>/snapshots/<client-id>/<YYYY-MM-DD>.json.gz
        These are the restore points. Supabase keeps no snapshots at all.
     2. ARCHIVE   — audit_log rows older than 45 days are exported to
            <history folder>/audit-archive/<YYYY-MM>.ndjson.gz
        and only THEN deleted from Supabase. Upload-verify-before-delete: if the upload
        throws, nothing is pruned and the next run retries.

   NOTHING here ever deletes from Drive. Snapshots and archives are kept forever.

   Needs DRIVE_HISTORY_FOLDER_ID (a Drive folder shared with the service account as
   Editor). Without it the function no-ops with 428 so the cron stays harmless.

   Gate: SNAPSHOT_SECRET header. Deploy:
     supabase functions deploy history-snapshot --use-api --no-verify-jwt
   ============================================================ */
import { json } from "../_shared/cors.ts";
import { driveAccessToken, driveUploadBytes, driveEnsureFolder, gzipBytes } from "../_shared/google.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const STATE_CLIENT = "_history";      // where we remember folder ids + last-snapshot stamps
const STATE_SCOPE = "clients";
const RETAIN_DAYS = 45;               // in-portal audit window; older rows live in Drive
const SNAPSHOT_SCOPES = ["dashboard", "deliverables", "deliverables_draft", "files", "notifications", "media_intake"];

const enc = new TextEncoder();
const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const secret = Deno.env.get("SNAPSHOT_SECRET");
  if (!secret || req.headers.get("x-snapshot-secret") !== secret) return json(req, 401, { error: "bad or missing secret" });
  if (!Deno.env.get("GOOGLE_SA_KEY")) return json(req, 503, { error: "GOOGLE_SA_KEY missing" });
  const rootId = Deno.env.get("DRIVE_HISTORY_FOLDER_ID");
  if (!rootId) return json(req, 428, { error: "DRIVE_HISTORY_FOLDER_ID not set — designate the Drive history folder (shared with the service account) and set this secret." });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = await driveAccessToken("https://www.googleapis.com/auth/drive");
  const today = ymd(new Date());

  // remembered state: { folders: {path: id}, lastSnapshot: {clientId: {date, stamp}} }
  const { data: stRow } = await svc.from("app_state").select("data").eq("client_id", STATE_CLIENT).eq("scope", STATE_SCOPE).maybeSingle();
  const st: any = (stRow?.data && typeof stRow.data === "object" && !Array.isArray(stRow.data)) ? stRow.data : {};
  st.folders = st.folders || {}; st.lastSnapshot = st.lastSnapshot || {};

  // Per-client History folder ids, so a snapshot lands in that client's own folder inside the
  // main storage tree rather than a separate parallel hierarchy. Read once per run.
  const reg = new Map<string, { integrations?: { driveFolders?: Record<string, string> } }>();
  try {
    const { data: regRow } = await svc.from("app_state").select("data")
      .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
    for (const c of (Array.isArray(regRow?.data) ? regRow!.data : [])) {
      if (c && c.id) reg.set(String(c.id), c);
    }
  } catch (e) { /* fall back to the legacy layout below */ }

  // folder ids are cached so we don't re-query Drive for every client every day
  async function folder(path: string): Promise<string> {
    if (st.folders[path]) return st.folders[path];
    let id = rootId!;
    for (const part of path.split("/")) id = await driveEnsureFolder(token, id, part);
    st.folders[path] = id;
    return id;
  }

  let snapshotted = 0, skipped = 0, failed = 0, remaining = 0;
  const errors: string[] = [];
  // Deliverable proofs are stored INLINE as base64 while Drive storage is off, so a single
  // client's rows can be tens of MB. Loading every client at once blew the worker's memory
  // (WORKER_RESOURCE_LIMIT on the first live run) — so we stream ONE CLIENT AT A TIME and
  // stop before the wall-clock limit, recording progress. The run is resumable: clients
  // already snapshotted today are skipped, so repeated runs finish the set.
  const DEADLINE_MS = 100_000;
  const startedAt = Date.now();

  try {
    /* ---------- 1. per-client snapshots (streamed) ---------- */
    // just the ids + stamps first — small enough to hold, unlike the data
    const { data: idRows } = await svc.from("app_state").select("client_id,scope,updated_at");
    const meta: Record<string, { newest: string; scopes: string[] }> = {};
    for (const r of (idRows || [])) {
      const cid = String(r.client_id), sc = String(r.scope);
      // '_registry' IS snapshotted (the roster is real data); other '_' workspaces are bookkeeping
      if (cid.startsWith("_") && cid !== "_registry") continue;
      if (cid !== "_registry" && !SNAPSHOT_SCOPES.includes(sc)) continue;
      const m = meta[cid] || (meta[cid] = { newest: "", scopes: [] });
      m.scopes.push(sc);
      const u = String(r.updated_at || "");
      if (u > m.newest) m.newest = u;
    }

    for (const [cid, m] of Object.entries(meta)) {
      const last = st.lastSnapshot[cid] || {};
      // nothing changed since the last snapshot, or we already wrote one today → skip
      if (last.date === today || (last.stamp && m.newest && last.stamp >= m.newest)) { skipped++; continue; }
      if (Date.now() - startedAt > DEADLINE_MS) { remaining++; continue; }   // next run picks it up
      try {
        // fetch THIS client's data only, build the file, then let it go out of scope
        const { data: mine } = await svc.from("app_state").select("scope,data")
          .eq("client_id", cid).in("scope", cid === "_registry" ? ["clients"] : SNAPSHOT_SCOPES);
        const scopes: Record<string, unknown> = {};
        for (const r of (mine || [])) scopes[String(r.scope)] = r.data;
        const payload = enc.encode(JSON.stringify({ client: cid, takenAt: new Date().toISOString(), newestChange: m.newest, scopes }));
        const gz = await gzipBytes(payload);
        // Per-client snapshots now live in that client's OWN History folder inside
        // "TJA Client Portal Storage" (integrations.driveFolders.History), so the whole tree is
        // one place — Cameron 2026-07-31. Falls back to the legacy snapshots/<client> path under
        // DRIVE_HISTORY_FOLDER_ID when a client hasn't been provisioned yet.
        const histId = reg.get(cid)?.integrations?.driveFolders?.History;
        const fid = histId || await folder(`snapshots/${cid}`);
        await driveUploadBytes(token, fid, `${today}.json.gz`, gz, "application/gzip");
        st.lastSnapshot[cid] = { date: today, stamp: m.newest, bytes: gz.length };
        snapshotted++;
      } catch (e) { failed++; errors.push(`${cid}: ${String((e as Error).message || e).slice(0, 120)}`); }
    }

    /* ---------- 2. archive audit rows older than RETAIN_DAYS ---------- */
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 3600 * 1000).toISOString();
    let archived = 0;
    // bounded like the snapshot loop — a huge backlog is drained over successive runs
    const { data: old } = (Date.now() - startedAt > DEADLINE_MS)
      ? { data: [] as any[] }
      : await svc.from("audit_log").select("*").lt("ts", cutoff).order("ts", { ascending: true }).limit(2000);
    if (old && old.length) {
      // group by calendar month so each archive file is <YYYY-MM>.ndjson.gz
      const byMonth: Record<string, any[]> = {};
      for (const r of old) (byMonth[String(r.ts).slice(0, 7)] ||= []).push(r);
      const archiveFolder = await folder("audit-archive");
      for (const [month, list] of Object.entries(byMonth)) {
        try {
          const nd = list.map((r) => JSON.stringify(r)).join("\n");
          const gz = await gzipBytes(enc.encode(nd));
          // one file per run (timestamped) — append-only by convention; we never rewrite history
          await driveUploadBytes(token, archiveFolder, `${month}--${Date.now()}.ndjson.gz`, gz, "application/gzip");
          // ONLY delete after the upload came back clean
          const ids = list.map((r) => r.id);
          const { error: delErr } = await svc.from("audit_log").delete().in("id", ids);
          if (delErr) errors.push(`archive delete ${month}: ${delErr.message}`);
          else archived += list.length;
        } catch (e) { errors.push(`archive ${month}: ${String((e as Error).message || e).slice(0, 120)}`); }
      }
    }

    // remember folder ids + snapshot stamps for next run
    await svc.from("app_state").upsert(
      { client_id: STATE_CLIENT, scope: STATE_SCOPE, data: st, updated_at: new Date().toISOString() },
      { onConflict: "client_id,scope" },
    );

    // `remaining` > 0 means the deadline stopped us — run again to finish (the cron will).
    return json(req, 200, { ok: true, date: today, snapshotted, skipped, failed, remaining, archived, errors: errors.slice(0, 10) });
  } catch (e) {
    return json(req, 500, { error: String((e as Error).message || e).slice(0, 300), snapshotted, failed });
  }
});
