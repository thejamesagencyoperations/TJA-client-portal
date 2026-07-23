/* ============================================================
   AUTH + ROLES  — four tiers, each a real role in the database (schema-v7).
     • admin    → THE AGENCY ACCOUNT. Everything a manager can do, PLUS the
                  things that are nobody else's business: managing logins
                  (Admin Center), Backup & Sync, and DELETING anything.
     • manager  → AM/PM. Full edit on every client's work, uploads, and
                  releases waiting-room drafts to the client. Reads every
                  client (agencies cover for each other; the Clients page
                  merely DEFAULTS to their tagged ones). Deletes nothing.
     • creative → opens ANY client read-only and uploads Present Docs into
                  the waiting room (never straight to the client — an admin
                  or manager sends). No other edit rights.
     • client   → read-only on data tabs; may upload Files + review Present Docs

   The admin/manager split is enforced in RLS, not just here: a manager's JWT
   is refused on DELETE and on profiles, so hiding a button is not the wall.
   There is no separate "owner" concept any more — role=admin IS that tier.

   Production: real Supabase auth (every account provisioned). The mock
   password path below is now GATED OFF on any Supabase-configured
   deployment (ALLOW_MOCK_FALLBACK = false) — real credentials only. It
   is kept, not deleted, so an offline/no-Supabase build still works and
   so it can be re-enabled in one line if ever needed.
   ============================================================ */

// When Supabase is configured, accept ONLY real Supabase auth (no derivable
// sandbox passwords). Flip to true only for offline demos with no backend.
const ALLOW_MOCK_FALLBACK = false;

// Reserved workspace id for the admin. The admin owns NO client workspace — this is a
// sentinel (like _registry) that is never a real client, so the admin can never be
// confused with, or land inside, an actual client's data. Admins always route to the
// client picker; their data access comes from role === "admin" (RLS), not this id.
const ADMIN_CLIENT_ID = "_admin";
// Same idea for creatives: staff sentinel, never a real client workspace.
const CREATIVE_CLIENT_ID = "_creative";

const ACCOUNTS = {
  // Only the agency's own account is hardcoded, and only so a fresh/offline build has a
  // way in. Every real person — clients AND staff — resolves from Supabase.
  "clientservices@thejamesagency.com": {
    password: "admin",
    client: ADMIN_CLIENT_ID,     // standalone admin — not tied to any client workspace
    name: "TJA Client Services",
    role: "admin",
  },
};

const SESSION_KEY = "tja_portal_session";
const PREVIEW_KEY = "tja_preview_client";   // admin-only "view as client" flag

/* Map a client's login EMAIL → their workspace. Identity resolution only — this has
   nothing to do with authentication any more.
   The registry used to also carry login.password in plaintext; those were purged
   (2026-07-16) once the mock auth path was switched off, because they were dead
   credentials readable by every staff login. `password` therefore comes back
   undefined, which is fine: the only consumer is attemptLogin(), and that path is
   gated off whenever Supabase is configured (ALLOW_MOCK_FALLBACK = false). Real
   passwords live hashed in Supabase and are never readable from anywhere. */
function registryAccount(email) {
  if (!(window.TJA_STORE && typeof window.TJA_STORE.list === "function")) return null;
  const e = (email || "").trim().toLowerCase();
  const c = window.TJA_STORE.list().find(x => x.login && (x.login.email || "").toLowerCase() === e);
  return c ? { password: c.login.password, client: c.id, name: c.name, role: "client" } : null;
}

function attemptLogin(email, password) {
  const acct = ACCOUNTS[(email || "").trim().toLowerCase()] || registryAccount(email);
  if (!acct || acct.password !== password) return false;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    email: email.trim().toLowerCase(),
    client: acct.client,
    name: acct.name,
    role: acct.role,
  }));
  sessionStorage.removeItem(PREVIEW_KEY);
  return true;
}

function getSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); }
  catch { return null; }
}

/* ---------- identity resolution ----------
   WHO a signed-in email is (role + which workspace they own). Order of truth:
     1. hardcoded accounts (admin + Celtic demo)
     2. the client registry (TJA_STORE) — email→workspace for every auto-created client
     3. a real Supabase `profiles` row (future-provisioned users not in the roster)
   The roster outranks the profile because existing profile rows carry the signup
   trigger's old celtic-elevator default; once profiles are provisioned correctly
   (scripts/provision-supabase-users.mjs + schema v2) this order can flip.
   Returns null when the email maps to nothing — callers must DENY, never default. */
function resolveIdentity(email, profile, meta) {
  const em = (email || "").trim().toLowerCase();
  const hard = ACCOUNTS[em];
  if (hard) return { email: em, client: hard.client, name: hard.name, role: hard.role };
  // ⚠ The roster hardcodes role:"client" and outranks the profile — a staff email must
  //   never double as a registry client login.email, or that person logs in AS the client
  //   (the provisioning script warns on collisions).
  const reg = registryAccount(em);
  if (reg) return { email: em, client: reg.client, name: reg.name, role: reg.role };
  if (profile && profile.client_id) {
    // Display name: user_metadata.name when provisioned (managers get their real
    // name — it also drives the Clients-page default filter), else a role default.
    const fallback = profile.role === "admin" ? "TJA Team"
      : profile.role === "creative" ? "TJA Creative"
      : profile.role === "media" ? "TJA Paid Media" : "Client";
    return { email: em, client: profile.client_id,
             name: (meta && meta.name) || fallback, role: profile.role || "client" };
  }
  return null;
}
function setSession(identity) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(identity));
  sessionStorage.removeItem(PREVIEW_KEY);
}

/* ---------- unified login ----------
   1. Supabase auth first (REAL credentials — the production path; the admin's real
      password lives there, not in this public file).
   2. Mock/roster fallback (sandbox demo creds) so clients without a Supabase user
      yet can still sign in, and `admin` keeps working for the demo.
   Identity always comes from resolveIdentity() — an authenticated user whose email
   maps to no workspace is signed out and denied (no celtic-elevator default). */
async function login(email, password) {
  // Roster must be loaded before identity lookups (added clients live in the store).
  if (window.TJA_STORE && window.TJA_STORE.hydrate) { try { await window.TJA_STORE.hydrate(); } catch (e) {} }

  if (window.SUPA && window.SUPA.enabled) {
    try {
      const res = await window.SUPA.signIn(email, password);
      if (res.ok) {
        const who = resolveIdentity(email, res.profile, res.user && res.user.user_metadata);
        if (who) { setSession(who); return true; }
        console.warn("login: authenticated but no workspace mapping for", email);
        try { window.SUPA.signOut(); } catch (e) {}
        return false;
      }
    } catch (e) { /* auth error — handled below */ }
    // Supabase is configured: real credentials are the ONLY accepted path
    // unless the mock fallback is explicitly enabled.
    if (!ALLOW_MOCK_FALLBACK) return false;
  }
  return attemptLogin(email, password);   // offline / no-backend fallback
}

/* ---------- session restore ----------
   The mock session lives in sessionStorage (per-tab); the Supabase session persists
   in localStorage. A new tab therefore lands on the login page even though Supabase
   still knows the user — rebuild the session instead of making them re-type. */
async function restoreSession() {
  if (getSession()) return true;
  if (!(window.SUPA && window.SUPA.enabled)) return false;
  try {
    if (window.TJA_STORE && window.TJA_STORE.hydrate) { try { await window.TJA_STORE.hydrate(); } catch (e) {} }
    const cur = await window.SUPA.currentSession();
    if (!cur || !cur.user || !cur.user.email) return false;
    const who = resolveIdentity(cur.user.email, cur.profile, cur.user.user_metadata);
    if (!who) return false;
    setSession(who);
    return true;
  } catch (e) { return false; }
}

function requireAuth() {
  if (!getSession()) window.location.replace("index.html");
}

/* ---------- ghost-session guard ----------
   The per-tab session (sessionStorage) SURVIVES a hard refresh, but says nothing about
   whether the Supabase session behind it is still alive. A tab whose Supabase auth has
   died renders the full signed-in UI while every RLS-gated read quietly returns zero
   rows — no error, no banner — so the page falls back to this device's cached copy and
   the user stares at stale (or empty) data with no clue why. Found the hard way on
   2026-07-17: after the admin password reset, a machine holding a pre-reset tab showed
   an empty portal through multiple hard refreshes.
   Returns: "ok" (live, or Supabase not configured), "ghost" (portal session with no
   live Supabase session — caller should force a re-login), "nolib" (Supabase IS
   configured but the client library never loaded: CDN blocked/offline — cached-only). */
async function ensureLiveSession() {
  const configured = !!(window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url);
  if (!configured || !getSession()) return "ok";
  if (!(window.SUPA && window.SUPA.enabled && window.SUPA.client)) return "nolib";
  try {
    const { data } = await window.SUPA.client.auth.getSession();
    if (data && data.session) return "ok";
  } catch (e) { /* treat as ghost — an erroring auth layer can't back a session */ }
  return "ghost";
}

async function logout() {
  // AWAIT the Supabase sign-out before navigating — firing it and immediately
  // redirecting aborts the call, leaving the Supabase session alive, and the
  // login page's restoreSession() then signs the "signed-out" user straight
  // back in.
  if (window.SUPA && window.SUPA.enabled) { try { await window.SUPA.signOut(); } catch {} }
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(PREVIEW_KEY);
  window.location.replace("index.html");
}

/* ---------- roles ----------
   Read these carefully — isAdmin() is NOT "can edit". It is the agency account.
   Use canEdit() for client work; use isAdmin() only for things an AM/PM must
   not do (logins, backup, deleting). */
const role = () => { const s = getSession(); return s ? s.role : null; };
// THE AGENCY ACCOUNT. Logins, Backup & Sync, deleting. Not the AM/PMs.
function isAdmin() { return role() === "admin"; }
// AM/PM — full admin over client WORK, no destructive powers.
function isManager() { return role() === "manager"; }
function isCreative() { return role() === "creative"; }
// Paid-media team. Staff-tier (sees the picker + reads every client) but view-only
// on all client work — their ONE edit power is triaging Media Creative Asset
// Requests (status). They never upload docs, never send, never edit dashboards.
function isMedia() { return role() === "media"; }
// Runs the client work: the agency account + the AM/PMs. Gates the bell,
// Notification Center, WMJ sync, tile actions, dashboard writes.
function isAdminOrManager() { return isAdmin() || isManager(); }
// Any internal TJA person — gates the client picker + read-all. NOTE this now
// includes paid-media: they must reach the picker and read every client. Powers
// that must NOT extend to them (doc upload) test canUploadDocs(), which excludes
// media explicitly — do not assume isStaff() means "can edit or upload".
function isStaff() { return isAdminOrManager() || isCreative() || isMedia(); }

// Staff toggle: preview the client experience without logging out. For a creative
// this IS the client view — drafts and the upload button vanish, exactly what
// the client would see.
function isPreviewing() { return isStaff() && sessionStorage.getItem(PREVIEW_KEY) === "1"; }
function setPreview(on) {
  if (!isStaff()) return;
  if (on) sessionStorage.setItem(PREVIEW_KEY, "1");
  else sessionStorage.removeItem(PREVIEW_KEY);
}

// The EFFECTIVE role the UI should render as right now.
function effectiveRole() { return isPreviewing() ? "client" : (getSession() ? getSession().role : "client"); }
// Does the AM/PM own the client they're looking at? An AM/PM can VIEW every client but only
// EDITS the ones they're tagged on (client.managers, matched to their login name). Admins own
// everything. Matching is trim + case-insensitive; the login name must match the manager tag
// (the Admin Center create form enforces "must match their manager tag exactly").
function ownsCurrentClient() {
  if (isAdmin()) return true;
  try {
    const s = getSession(); if (!s) return false;
    const myName = String(s.name || "").trim().toLowerCase();
    if (!myName) return false;
    const c = (window.TJA_STORE && typeof window.TJA_STORE.get === "function") ? window.TJA_STORE.get(s.client) : null;
    const mgrs = (c && Array.isArray(c.managers)) ? c.managers : [];
    return mgrs.some(m => String(m).trim().toLowerCase() === myName);
  } catch (e) { return false; }
}
// Can edit CLIENT WORK — the agency account (every client) and an AM/PM (only THEIR clients;
// they still view all others). Creatives edit nothing (they only upload); clients edit nothing.
function canEdit() {
  const r = effectiveRole();
  if (r === "admin") return true;
  if (r === "manager") return ownsCurrentClient();
  return false;
}

// What a role is CALLED in the UI. One definition — the topbar pill exists on two
// separate pages and they were already drifting (a manager read "Admin" on one and
// "Creative" on the other, because both just tested `isAdmin() ? … : …`).
const ROLE_LABELS = { admin: "Admin", manager: "AM/PM", creative: "Creative", media: "Paid Media", client: "Client" };
function roleLabel(r) { return ROLE_LABELS[r || effectiveRole()] || "Client"; }
// Present Docs. Upload = any staff (admin/manager → straight to the client,
// creative → into the waiting room). Releasing a draft = whoever can edit, i.e.
// the AM/PM whose job it is — never the creative who uploaded it.
// Paid-media is staff but explicitly NOT an uploader — they only triage media
// requests. Excluding isMedia() here keeps Present Docs fully view-only for them.
// Upload = admin (any client) or creative (any client, into the waiting room) or an AM/PM but
// ONLY on their own clients. Paid-media never uploads. Managers on someone else's client can't.
function canUploadDocs() { return !isPreviewing() && isStaff() && !isMedia() && (!isManager() || ownsCurrentClient()); }
function canSendDocs() { return canEdit(); }
