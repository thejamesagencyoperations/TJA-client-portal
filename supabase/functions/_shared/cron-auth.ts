/* Who may trigger a scheduled job: the GitHub workflows (SNAPSHOT_SECRET) or the database's own
   scheduler (pg_cron + pg_net → CRON_SECRET, held in Supabase Vault as "portal_cron_secret").
   v394: GitHub only fires the every-5/10-minute schedules every few HOURS under load, so the
   frequent jobs run from pg_cron; the GitHub workflows stay as a backup. */
export function cronAuthorized(req: Request): boolean {
  const got = req.headers.get("x-snapshot-secret") || "";
  if (!got) return false;
  const a = Deno.env.get("SNAPSHOT_SECRET"), b = Deno.env.get("CRON_SECRET");
  return (!!a && got === a) || (!!b && got === b);
}
