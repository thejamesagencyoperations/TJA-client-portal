/* Caller identity for the portal's Edge Functions.
   The platform's verify_jwt already rejected unsigned requests; this resolves
   WHO the caller is and what the portal thinks of them. NEVER trust identity
   fields from the request body — the profile row is the only authority. */
import { createClient } from "npm:@supabase/supabase-js@2";

export type Caller = { userId: string; email: string; role: string; clientId: string };

// base64url helpers
function b64urlToStr(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s = s.padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  return atob(s);
}
function b64urlToBytes(s: string): Uint8Array {
  const bin = b64urlToStr(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// JWKS cache (public ES256 keys). Verifying the token OURSELVES against the project's asymmetric
// signing key is robust to Supabase's HS256→ES256 JWT migration — the old path (auth.getUser)
// throws "unrecognized JWT kid <nil> for algorithm ES256" and broke every function that identifies
// its caller (Admin Center list, invite/signup emails, media, etc.).
let JWKS_CACHE: any[] | null = null;
async function jwks(): Promise<any[]> {
  if (JWKS_CACHE) return JWKS_CACHE;
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const r = await fetch(`${url}/auth/v1/.well-known/jwks.json`, { headers: { apikey: anon } });
  const body = await r.json();
  JWKS_CACHE = body.keys || [];
  return JWKS_CACHE!;
}

// Verify the JWT locally. Returns {userId,email} ONLY on a valid, unexpired ES256 signature; null
// otherwise (caller then falls back to auth.getUser). It never returns an identity for an
// unverified token — the signature must check out — so this cannot be spoofed.
async function verifyLocally(jwt: string): Promise<{ userId: string; email: string } | null> {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header: any, payload: any;
  try { header = JSON.parse(b64urlToStr(parts[0])); payload = JSON.parse(b64urlToStr(parts[1])); }
  catch { return null; }
  if (header.alg !== "ES256") return null;                        // HS256/legacy → let getUser handle it
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  try {
    const keys = await jwks();
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const data = new TextEncoder().encode(parts[0] + "." + parts[1]);
    const sig = b64urlToBytes(parts[2]);                          // ES256 sig is raw r||s (P1363) — WebCrypto's format
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data);
    if (!ok) { JWKS_CACHE = null; return null; }                  // maybe rotated — drop cache so next call refetches
    if (!payload.sub) return null;
    return { userId: payload.sub, email: payload.email ?? "" };
  } catch { JWKS_CACHE = null; return null; }
}

export async function getCaller(req: Request): Promise<Caller | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;

  const url = Deno.env.get("SUPABASE_URL")!;

  // 1) verify the token ourselves against the JWKS (robust to the ES256 signing-key migration)
  let userId: string | null = null, email = "";
  const local = await verifyLocally(jwt);
  if (local) { userId = local.userId; email = local.email; }
  else {
    // 2) fallback: ask GoTrue (handles HS256 / whatever the server still accepts)
    const anon = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: { user } } = await anon.auth.getUser(jwt);
    if (user) { userId = user.id; email = user.email ?? ""; }
  }
  if (!userId) return null;

  // profiles lookup with the service role (RLS-free, and the row is the truth)
  const svc = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: prof } = await svc.from("profiles")
    .select("role,client_id").eq("id", userId).single();
  if (!prof) return null;

  return { userId, email, role: prof.role, clientId: prof.client_id };
}
