/* ============================================================
   PR-SHEET — returns a client's PR-coverage Google Sheet as RAW CSV.

   Why this exists (2026-10-14): the browser reads sheets through Google's gviz endpoint, which
   GUESSES each column's type and blanks every cell that doesn't fit. PR sheets keep their
   section labels ("PENDING COVERAGE", "Fall", "SECURED COVERAGE") in the Date column, so gviz
   silently deleted them — and without them the portal can't tell pending coverage from secured
   (M Culinary's 95 hits never showed). The export endpoint returns the cells exactly as typed,
   but browsers can't call it (no CORS) — so the portal asks this function instead.

   Access: any signed-in staff role may read any PR sheet; a CLIENT may read only the PR sheet
   connected to their OWN workspace (checked against their saved dashboard). Public sheets are
   read anonymously; a sheet shared only with the portal's service account is read with it.

   Body: { url } (the sheet link as pasted on the PR tile) [+ clientId for staff]
   Returns: { ok:true, csv } | { ok:false, error }
   Deploy: supabase functions deploy pr-sheet --no-verify-jwt --use-api --project-ref sliutkbdpuimxxmvsbek
   ============================================================ */
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { driveAccessToken } from "../_shared/google.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const STAFF = ["admin", "manager", "creative", "media", "team"];
function parse(raw: string): { id: string; gid: string } | null {
  const s = String(raw || "").trim();
  const id = (/\/d\/([a-zA-Z0-9-_]{20,})/.exec(s) || /^([a-zA-Z0-9-_]{20,})$/.exec(s) || [])[1];
  if (!id) return null;
  return { id, gid: (/[#?&]gid=(\d+)/.exec(s) || [])[1] || "0" };
}
const looksHtml = (t: string) => /^\s*<(!doctype|html)/i.test(t);

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  let body: any = {};
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid JSON" }); }
  const want = parse(body.url);
  if (!want) return json(req, 400, { error: "that doesn't look like a Google Sheets link" });

  if (caller.role === "client") {
    // a client may only read the PR sheet(s) connected to THEIR workspace
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await svc.from("app_state")
      .select("r:data->engagements->retainer->>prSheetUrl, p:data->engagements->projects")
      .eq("client_id", caller.clientId).eq("scope", "dashboard").maybeSingle();
    const urls = [String((data as any)?.r || "")];
    for (const p of (Array.isArray((data as any)?.p) ? (data as any).p : [])) if (p && p.prSheetUrl) urls.push(String(p.prSheetUrl));
    if (!urls.some((u) => { const x = parse(u); return x && x.id === want.id; })) return json(req, 403, { error: "not this workspace's PR sheet" });
  } else if (!STAFF.includes(caller.role)) {
    return json(req, 403, { error: "not allowed" });
  }

  const url = `https://docs.google.com/spreadsheets/d/${want.id}/export?format=csv&gid=${want.gid}`;
  try {
    // 1) public ("Anyone with the link") — no credentials needed
    let r = await fetch(url, { redirect: "follow" });
    let text = r.ok ? await r.text() : "";
    // 2) private but shared with the portal's service account
    if (!r.ok || looksHtml(text)) {
      if (Deno.env.get("GOOGLE_SA_KEY")) {
        const token = await driveAccessToken("https://www.googleapis.com/auth/drive.readonly");
        r = await fetch(url, { redirect: "follow", headers: { Authorization: `Bearer ${token}` } });
        text = r.ok ? await r.text() : "";
      }
    }
    if (!r.ok || looksHtml(text)) {
      return json(req, 200, { ok: false, error: r.status === 404
        ? "that sheet or tab doesn't exist (check the link / gid)"
        : "the sheet isn't shared — set it to \"Anyone with the link → Viewer\" (or share it with the portal's service account)" });
    }
    return json(req, 200, { ok: true, csv: text.slice(0, 2_000_000) });
  } catch (e) {
    return json(req, 200, { ok: false, error: "couldn't read the sheet: " + String((e as Error).message || e).slice(0, 140) });
  }
});
