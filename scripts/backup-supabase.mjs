#!/usr/bin/env node
/* ============================================================
   BACKUP SUPABASE — full snapshot of the portal's backend
   ------------------------------------------------------------
   Dumps every table (profiles, app_state) plus all auth users to
   timestamped JSON files in ~/TJA-portal-backups/<date>/ — OUTSIDE
   the repo, so client data and user records never touch git.

   Usage:
     node scripts/backup-supabase.mjs

   The service-role key is read from (in order):
     1. the SUPABASE_SERVICE_ROLE_KEY environment variable
     2. ~/.tja-supabase.env  (a line: SUPABASE_SERVICE_ROLE_KEY=...)
   Keep the key in that file and never commit or paste it anywhere.

   Restore notes live in the RESTORE.txt written alongside each
   backup. Run this before any risky change — it's cheap.
   ============================================================ */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const cfgSrc = readFileSync(join(ROOT, "assets/js/supabase-config.js"), "utf8");
const BASE = (cfgSrc.match(/url:\s*"([^"]+)"/) || [])[1]?.replace(/\/$/, "");
if (!BASE) { console.error("Could not read the Supabase URL from assets/js/supabase-config.js"); process.exit(1); }

let KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) {
  try {
    const env = readFileSync(join(homedir(), ".tja-supabase.env"), "utf8");
    KEY = (env.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*"?([^"\n]+)"?/) || [])[1];
  } catch {}
}
if (!KEY) {
  console.error("No service-role key. Either:");
  console.error('  export SUPABASE_SERVICE_ROLE_KEY="..."   (this terminal only), or');
  console.error('  echo \'SUPABASE_SERVICE_ROLE_KEY="..."\' > ~/.tja-supabase.env   (persistent)');
  process.exit(1);
}

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const DIR = join(homedir(), "TJA-portal-backups", stamp);
mkdirSync(DIR, { recursive: true });

async function dumpTable(name) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${BASE}/rest/v1/${name}?select=*`, { headers: { ...H, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${name}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) break;
  }
  writeFileSync(join(DIR, `${name}.json`), JSON.stringify(rows, null, 2));
  console.log(`✓ ${name}: ${rows.length} rows`);
  return rows.length;
}

async function dumpAuthUsers() {
  const users = [];
  for (let page = 1; ; page++) {
    const r = await fetch(`${BASE}/auth/v1/admin/users?page=${page}&per_page=200`, { headers: H });
    if (!r.ok) throw new Error(`auth users: ${r.status} ${await r.text()}`);
    const j = await r.json();
    const batch = j.users || [];
    users.push(...batch.map(u => ({ id: u.id, email: u.email, created_at: u.created_at, user_metadata: u.user_metadata })));
    if (batch.length < 200) break;
  }
  writeFileSync(join(DIR, "auth-users.json"), JSON.stringify(users, null, 2));
  console.log(`✓ auth users: ${users.length}`);
  return users.length;
}

try {
  const p = await dumpTable("profiles");
  const a = await dumpTable("app_state");
  const u = await dumpAuthUsers();
  writeFileSync(join(DIR, "RESTORE.txt"),
`TJA portal backend snapshot — ${stamp}
Project: ${BASE}

Contents: profiles.json (${p}), app_state.json (${a}), auth-users.json (${u}).

RESTORE (rarely needed — ask Claude to script it against these files):
- profiles/app_state rows: upsert each JSON row back via the REST API with the
  service-role key (Prefer: resolution=merge-duplicates), or paste small sets
  into the SQL editor as INSERT ... ON CONFLICT DO UPDATE.
- auth users: passwords are NOT recoverable from a backup (hashes stay in
  Supabase). Recreate users with scripts/provision-supabase-users.mjs, which
  is idempotent and re-links profiles by email.
`);
  console.log(`\nBackup complete → ${DIR}`);
} catch (e) {
  console.error("✗ backup failed:", e.message);
  process.exit(1);
}
