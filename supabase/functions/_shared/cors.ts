/* CORS for the portal's Edge Functions.
   Origins are listed ONCE here — when the portal moves to a custom domain
   (e.g. portal.thejamesagency.com), add it to this array and redeploy the
   functions; nothing else in the backend changes. */
const ALLOWED_ORIGINS = [
  "https://thejamesagencyoperations.github.io",
  "http://localhost:8082",
  "http://localhost:8080",
];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// Standard preflight short-circuit — call first in every function.
export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  return null;
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}
