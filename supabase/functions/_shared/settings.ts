/* Global portal settings — the single source of truth for the email/link toggles.
   Stored in app_state at (client_id='_settings', scope='clients') so no migration is
   needed (the 'clients' scope already exists) and RLS already lets admin write it +
   staff read it. Functions read it here via the service role. Defaults are TRUE
   (emails on) so behaviour is unchanged until someone flips a slider. */
import { createClient } from "npm:@supabase/supabase-js@2";

export type PortalSettings = {
  deliverableEmails: boolean;   // Present Docs sends + client-review notifications
  signupEmails: boolean;        // the client invite / set-password email
};

export async function portalSettings(): Promise<PortalSettings> {
  try {
    const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data } = await svc.from("app_state").select("data")
      .eq("client_id", "_settings").eq("scope", "clients").maybeSingle();
    const s = (data?.data ?? {}) as Partial<PortalSettings>;
    return {
      deliverableEmails: s.deliverableEmails !== false,   // default ON
      signupEmails: s.signupEmails !== false,             // default ON
    };
  } catch {
    return { deliverableEmails: true, signupEmails: true };
  }
}
