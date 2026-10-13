/* Server-side read of the client registry (the '_registry'/'clients' app_state row)
   — the single per-client integrations map every function derives destinations from.
   Deriving here (not from the request body) is the security boundary: a client's JWT
   can only ever route to ITS OWN configured Drive folder / recipients. */
import { createClient } from "npm:@supabase/supabase-js@2";

export type Integrations = {
  driveFolderId?: string;
  slackChannel?: string;
  emailRecipients?: string[];
  domains?: string[];
  notifyOff?: string[];        // client-login emails toggled OFF (default: everyone notified)
  approvalOff?: string[];      // client logins NOT required to review Present Docs (default: everyone required)
  deliverableEmails?: boolean;  // per-client: email on deliverable send + review (default true)
  signupEmails?: boolean;       // per-client: email the client their signup/invite link (default true)
};
export type RegistryEntry = {
  id: string; name: string;
  login?: { email?: string };
  integrations?: Integrations;
  am?: string;                 // Account Manager (full login name — assign-sync / Admin Center)
  pm?: string;                 // Project Manager  (ditto)
  managers?: string[];         // the edit-access tags; usually [am, pm]
};

export async function registryEntry(clientId: string): Promise<RegistryEntry | null> {
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data } = await svc.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: RegistryEntry[] = Array.isArray(data?.data) ? data!.data : [];
  return roster.find((c) => c.id === clientId) ?? null;
}

/* CONFLICT-SAFE registry write (2026-10-13). The registry is ONE row holding every client, and
   several actors rewrite it (the daily assignment sync, Drive provisioning, Admin Center, the
   Clients page). Each used to read it, change it and write the WHOLE row back blind — so two
   writers overlapping meant one silently undid the other (managers vanishing, reviewer toggles
   reverting). This re-reads the row, lets `mutate` apply ONLY its own change to that fresh copy,
   and writes it back only if nobody saved in between (compare-and-set on updated_at), retrying
   otherwise. `mutate` must be safe to run more than once. */
export async function updateRegistry<T>(
  mutate: (roster: any[]) => T,
): Promise<{ ok: boolean; result?: T; error?: string }> {
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let lastErr = "conflict";
  for (let i = 0; i < 8; i++) {
    const { data: row, error } = await svc.from("app_state").select("data,updated_at")
      .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
    if (error) { lastErr = error.message; continue; }
    const roster: any[] = Array.isArray(row?.data) ? JSON.parse(JSON.stringify(row!.data)) : [];
    const result = mutate(roster);
    const stamp = new Date().toISOString();
    const w = row
      ? await svc.from("app_state").update({ data: roster, updated_at: stamp })
          .eq("client_id", "_registry").eq("scope", "clients").eq("updated_at", row.updated_at).select("updated_at")
      : await svc.from("app_state").insert({ client_id: "_registry", scope: "clients", data: roster, updated_at: stamp }).select("updated_at");
    if (!w.error && w.data && w.data.length) return { ok: true, result };
    lastErr = w.error ? w.error.message : "someone else saved first";
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 200 * (i + 1)));
  }
  return { ok: false, error: lastErr };
}

/* Managers = the sheet's AM + PM, PLUS anyone pinned by hand (integrations.managersPinned).
   Pins are what make a manually-added manager survive every sheet sync. */
export function managersFor(am: string | null | undefined, pm: string | null | undefined, c: any, extraAms: string[] = []): string[] {
  const pinned: string[] = Array.isArray(c?.integrations?.managersPinned) ? c.integrations.managersPinned : [];
  return [...new Set([am, ...extraAms, pm, ...pinned].filter(Boolean).map((x) => String(x).trim()).filter(Boolean))] as string[];
}
