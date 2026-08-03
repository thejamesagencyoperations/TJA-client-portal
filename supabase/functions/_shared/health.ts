/* ============================================================
   HEALTH REPORTING — every scheduled job records its own last-run outcome so the
   portal can show whether the automation is actually working, instead of that only
   being visible in GitHub Actions logs / function logs that nobody watches.

   One row: app_state (client_id = "_health", scope = "clients"), data keyed by job
   name. Scope "clients" (not a new one) because app_state has a CHECK constraint on
   allowed scopes — same sentinel-row precedent as "_drive_watch" and "_plan_refresh".
   Every reader targets an exact client_id and the client loops skip "_"-prefixed ids,
   so this row is invisible everywhere else.

   Read by health.html (admin only). Never throws: a health write failing must never
   take down the job it is reporting on.
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";

const HEALTH_ID = "_health";
const HEALTH_SCOPE = "clients";

export async function reportHealth(job: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: row } = await svc.from("app_state").select("data")
      .eq("client_id", HEALTH_ID).eq("scope", HEALTH_SCOPE).maybeSingle();
    const all: Record<string, unknown> = (row?.data && typeof row.data === "object" && !Array.isArray(row.data))
      ? { ...(row.data as Record<string, unknown>) } : {};
    all[job] = { ...payload, at: new Date().toISOString() };
    await svc.from("app_state").upsert(
      { client_id: HEALTH_ID, scope: HEALTH_SCOPE, data: all, updated_at: new Date().toISOString() },
      { onConflict: "client_id,scope" },
    );
  } catch (e) {
    console.error("reportHealth(" + job + ") failed:", String((e as Error).message || e));
  }
}
