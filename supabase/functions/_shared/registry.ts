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
  deliverableEmails?: boolean;  // per-client: email on deliverable send + review (default true)
  signupEmails?: boolean;       // per-client: email the client their signup/invite link (default true)
};
export type RegistryEntry = {
  id: string; name: string;
  login?: { email?: string };
  integrations?: Integrations;
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
