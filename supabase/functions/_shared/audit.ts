/* Server-side audit trail helper — see schema-v12-audit.sql.
   Lets Edge Functions put their own actions on the record (plan re-pulls, month freezes,
   assignment syncs, login changes) so the History page shows the machine's work alongside
   human edits. Uses the service role, so it bypasses RLS.

   ALWAYS fire-and-forget: an audit failure must never fail the real work. Every call is
   wrapped, and the caller does not await a result it depends on. */
import { createClient } from "npm:@supabase/supabase-js@2";

export type AuditRow = {
  clientId: string;
  action: string;                 // 'plan.refreshed', 'assignments.synced', 'login.invited', …
  summary: string;                // the human line shown in the History timeline
  scope?: string | null;          // app_state scope this touched, when there is one
  actorEmail?: string;            // the human who triggered it, when there is one
  actorName?: string;
  actorRole?: string;             // defaults to 'system' for unattended crons
  changes?: unknown[];
  n?: number;
};

export async function audit(row: AuditRow): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    const svc = createClient(url, key);
    await svc.from("audit_log").insert({
      client_id: row.clientId,
      scope: row.scope ?? null,
      actor_email: row.actorEmail ?? "",
      actor_name: row.actorName ?? (row.actorRole === "system" || !row.actorRole ? "TJA Portal" : ""),
      actor_role: row.actorRole ?? "system",
      action: row.action,
      summary: row.summary,
      changes: row.changes ?? [],
      n: row.n ?? 0,
    });
  } catch (_e) { /* never surface — the real work already succeeded */ }
}
