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
                "role": "client" }, ...]
   - Idempotent: existing users get their password + metadata updated;
     profiles are upserted. Safe to re-run.
   - The admin user (clientservices@) already exists — leave it out of
     users.json unless you intend to reset its password.
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

async function upsertUser(u) {
  const meta = { role: u.role || "client", client_id: u.client_id };
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
for (const u of users) {
  if (!u.email || !u.password || !u.client_id) { console.error(`✗ skipped (missing fields): ${JSON.stringify(u)}`); fail++; continue; }
  try { console.log(`✓ ${await upsertUser(u)}  ${u.email} → ${u.client_id}`); ok++; }
  catch (e) { console.error(`✗ ${e.message}`); fail++; }
}
console.log(`\nDone: ${ok} ok, ${fail} failed.`);
process.exit(fail ? 1 : 0);
