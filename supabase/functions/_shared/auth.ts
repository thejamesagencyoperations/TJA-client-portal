/* Caller identity for the portal's Edge Functions.
   The platform's verify_jwt already rejected unsigned requests; this resolves
   WHO the caller is and what the portal thinks of them. NEVER trust identity
   fields from the request body — the profile row is the only authority. */
import { createClient } from "npm:@supabase/supabase-js@2";

export type Caller = { userId: string; email: string; role: string; clientId: string };

export async function getCaller(req: Request): Promise<Caller | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error } = await anon.auth.getUser(jwt);
  if (error || !user) return null;

  // profiles lookup with the service role (RLS-free, and the row is the truth)
  const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prof } = await svc.from("profiles")
    .select("role,client_id").eq("id", user.id).single();
  if (!prof) return null;

  return { userId: user.id, email: user.email ?? "", role: prof.role, clientId: prof.client_id };
}
