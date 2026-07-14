#!/usr/bin/env node
/* ============================================================
   PROVISION SUPABASE USERS — one real auth user per client
   ------------------------------------------------------------
   Creates (or updates) a Supabase auth user + `profiles` row for
   every entry in scripts/users.json, so client logins stop relying
   on the mock passwords baked into the public front-end code.

   Usage:
     export SUPABASE_SERVICE_ROLE_KEY="...service role key..."
     node scripts/provision-supabase-users.mjs

   - The URL comes from assets/js/supabase-config.js automatically.
   - The service-role key comes ONLY from the environment. It grants
     god-mode on the database: NEVER paste it into any file in this
     repo and never commit it.
   - scripts/users.json is gitignored (it holds plaintext passwords).
     Format: [{ "email": "...", "password": "...", "client_id": "...",
                "role": "client", "name": "Jane Doe" }, ...]
   - Roles: "client" (client_id = their workspace id), "admin"
     (client_id "_admin" — managers go here), "creative" (client_id
     "_creative"). admin/creative roles REQUIRE schema-v6 to be run
     first or the profiles upsert 400s on the role CHECK.
   - "name" (optional) becomes user_metadata.name → the portal display
     name. FOR MANAGERS IT MUST EXACTLY MATCH their manager-tag
     spelling on the Clients page — it drives the default "my clients"
     filter (a mismatch just fails open to All).
   - Idempotent: existing users get their password + metadata updated;
     profiles are upserted. Safe to re-run.
   - The admin user (clientservices@) already exists — leave it out of
     users.json unless you intend to reset its password.
   - Collision guard: any users.json email that is ALSO a client
     login.email in the portal registry gets flagged and skipped —
     the front-end roster outranks the Supabase profile and hardcodes
     role "client", so that person would log in AS the client.
   ============================================================ */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const cfgSrc = readFileSync(join(ROOT, "assets/js/supabase-config.js"), "utf8");
const URL_M = cfgSrc.match(/url:\s*"([^"]+)"/);
if (!URL_M) { console.error("Could not read the Supabase URL from assets/js/supabase-config.js"); process.exit(1); }
const BASE = URL_M[1].replace(/\/$/, "");

let KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  // fall back to the local key file (outside the repo): ~/.tja-supabase.env
  try {
    const { readFileSync: rf } = await import("node:fs");
    const { homedir } = await import("node:os");
    const env = rf(`${homedir()}/.tja-supabase.env`, "utf8");
    KEY = (env.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\n]+)"?/) || [])[1];
  } catch {}
}
if (!KEY) { console.error("Set SUPABASE_SERVICE_ROLE_KEY (env var or ~/.tja-supabase.env). Supabase → Project Settings → API → service_role."); process.exit(1); }

let users;
try { users = JSON.parse(readFileSync(join(ROOT, "scripts/users.json"), "utf8")); }
catch { console.error("scripts/users.json not found or invalid — see the header for the format."); process.exit(1); }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

// Load the full auth-user roster ONCE and match locally. The GoTrue admin list
// endpoint ignores the ?email= filter (it returns page 1 regardless), so filtering
// server-side silently found nothing and every re-run tried to CREATE existing users
// → 422 email_exists. Paginating + matching here makes the script truly idempotent.
let _allUsers = null;
async function allUsers() {
  if (_allUsers) return _allUsers;
  _allUsers = [];
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (!r.ok) break;
    const j = await r.json();
    const arr = j.users || [];
    _allUsers.push(...arr);
    if (arr.length < 200) break;
  }
  return _allUsers;
}
async function findUser(email) {
  const target = (email || "").toLowerCase();
  return (await allUsers()).find(u => (u.email || "").toLowerCase() === target) || null;
}

// Registry client login emails — auth.js's registryAccount() resolves these FIRST
// (before the Supabase profile) and hardcodes role "client". A staff account on a
// colliding email would silently log in as that client, so we refuse to provision it.
async function registryLoginEmails() {
  try {
    const r = await fetch(`${BASE}/rest/v1/app_state?client_id=eq._registry&scope=eq.clients&select=data`, { headers: H });
    if (!r.ok) return new Set();
    const rows = await r.json();
    const arr = (rows[0] && rows[0].data) || [];
    return new Set(arr.map(c => (c.login && c.login.email || "").toLowerCase()).filter(Boolean));
  } catch { return new Set(); }
}

async function upsertUser(u) {
  const meta = { role: u.role || "client", client_id: u.client_id };
  if (u.name) meta.name = u.name;
  const existing = await findUser(u.email);
  let id;
  if (existing) {
    const r = await fetch(`${BASE}/auth/v1/admin/users/${existing.id}`, {
      method: "PUT", headers: H,
      body: JSON.stringify({ password: u.password, email_confirm: true, user_metadata: meta }),
    });
    if (!r.ok) throw new Error(`update ${u.email}: ${r.status} ${await r.text()}`);
    id = existing.id;
  } else {
    const r = await fetch(`${BASE}/auth/v1/admin/users`, {
      method: "POST", headers: H,
      body: JSON.stringify({ email: u.email, password: u.password, email_confirm: true, user_metadata: meta }),
    });
    if (!r.ok) throw new Error(`create ${u.email}: ${r.status} ${await r.text()}`);
    id = (await r.json()).id;
  }
  // Upsert the profiles row (the signup trigger only fires on INSERT and won't fix old rows).
  const r2 = await fetch(`${BASE}/rest/v1/profiles?on_conflict=id`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ id, email: u.email, role: meta.role, client_id: meta.client_id }]),
  });
  if (!r2.ok) throw new Error(`profile ${u.email}: ${r2.status} ${await r2.text()}`);
  return existing ? "updated" : "created";
}

let ok = 0, fail = 0;
const regEmails = await registryLoginEmails();
for (const u of users) {
  if (!u.email || !u.password || !u.client_id) { console.error(`✗ skipped (missing fields): ${JSON.stringify({ ...u, password: "***" })}`); fail++; continue; }
  const role = u.role || "client";
  if (role !== "client" && regEmails.has((u.email || "").toLowerCase())) {
    console.error(`✗ COLLISION: ${u.email} is a registry client login — a ${role} account on this email would log in AS that client. Use a different email.`);
    fail++; continue;
  }
  try { console.log(`✓ ${await upsertUser(u)}  ${u.email} → ${u.client_id}${u.name ? ` (${u.name})` : ""}`); ok++; }
  catch (e) { console.error(`✗ ${e.message}`); fail++; }
}
console.log(`\nDone: ${ok} ok, ${fail} failed.`);
process.exit(fail ? 1 : 0);
