/* ============================================================
   RETAINER-VALUE — staff-only proxy for the revenue-forecast Apps Script (2026-11-16, launch audit).

   The browser used to call the Apps Script /exec URL directly, so that URL sat in the public
   repo and anyone could pull every client's signed SOW $ and hourly rate. Now:
     • the URL lives in a Supabase secret (RETAINER_VALUE_URL), not the repo;
     • every call carries a shared key (RETAINER_VALUE_KEY) that the Apps Script checks in
       doGet — once the script has the check, the public URL alone returns nothing;
     • only staff logins can call this (clients never needed the feed);
     • one cached copy (15 min) in app_state `_retainer_value_cache`, so 25 staff opening
       dashboards can't trip Apps Script's ~30 concurrent-execution limit.
   READ-ONLY: doGet only — nothing here can write to the workbook.

   POST {}  → the script's JSON ({ clients: [...] })
   Deploy: supabase functions deploy retainer-value --use-api --no-verify-jwt   (does its own auth)
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleOptions, json } from "../_shared/cors.ts";
import { getCaller } from "../_shared/auth.ts";
import { fetchT } from "../_shared/http.ts";

const STAFF = ["admin", "manager", "creative", "media", "team"];
const TTL_MS = 15 * 60_000, STALE_OK_MS = 12 * 3600_000;
const CACHE_ID = "_retainer_value_cache";

Deno.serve(async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== "POST") return json(req, 405, { error: "POST only" });
  const caller = await getCaller(req);
  if (!caller) return json(req, 401, { error: "not signed in" });
  if (!STAFF.includes(caller.role)) return json(req, 403, { error: "staff only" });

  const url = Deno.env.get("RETAINER_VALUE_URL"), key = Deno.env.get("RETAINER_VALUE_KEY");
  if (!url || !key) return json(req, 500, { error: "retainer-value not configured" });

  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await svc.from("app_state").select("data").eq("client_id", CACHE_ID).eq("scope", "clients").maybeSingle();
  // deno-lint-ignore no-explicit-any
  const c: any = row?.data || null;
  const age = c && c.at ? Date.now() - c.at : Infinity;
  if (c && c.feed && age < TTL_MS) return json(req, 200, c.feed);

  let failure = "";
  try {
    const res = await fetchT(url + (url.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(key),
      { headers: { "cache-control": "no-cache" } }, { timeoutMs: 30_000, retries: 1, label: "retainer-value Apps Script" });
    if (res.ok) {
      const feed = await res.json();
      if (feed && Array.isArray(feed.clients)) {
        await svc.from("app_state").upsert({ client_id: CACHE_ID, scope: "clients", data: { at: Date.now(), feed }, updated_at: new Date().toISOString() },
          { onConflict: "client_id,scope" });
        return json(req, 200, feed);
      }
      failure = "unexpected response" + (feed && feed.error ? ": " + feed.error : "");
    } else failure = "HTTP " + res.status;
  } catch (e) { failure = String((e as Error).message || e).slice(0, 200); }
  // the script is slow / down: serve the last good copy rather than blanking every burn
  if (c && c.feed && age < STALE_OK_MS) return json(req, 200, c.feed);
  return json(req, 502, { error: "retainer-value: " + failure });
});
