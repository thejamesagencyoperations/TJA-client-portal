/* ============================================================
   MOCK AUTH + ROLES — SANDBOX ONLY (NOT SECURE)
   Client-side demo gate so the team can click through the concept.
   Roles:
     • admin  → internal TJA team: full edit, upload, manage versions
     • client → read-only on data tabs; may upload Files + review Present Docs
   In production these become Firebase Auth custom claims, enforced
   server-side. Here they just shape the UI.
   ============================================================ */

// Reserved workspace id for the admin. The admin owns NO client workspace — this is a
// sentinel (like _registry) that is never a real client, so the admin can never be
// confused with, or land inside, an actual client's data. Admins always route to the
// client picker; their data access comes from role === "admin" (RLS), not this id.
const ADMIN_CLIENT_ID = "_admin";

const ACCOUNTS = {
  "celticelevator@thejamesagency.com": {
    password: "celticelevator",
    client: "celtic-elevator",   // the real Celtic Elevator CLIENT login
    name: "Celtic Elevator",
    role: "client",
  },
  "clientservices@thejamesagency.com": {
    password: "admin",
    client: ADMIN_CLIENT_ID,     // standalone admin — not tied to any client workspace
    name: "TJA Client Services",
    role: "admin",
  },
};

const SESSION_KEY = "tja_portal_session";
const PREVIEW_KEY = "tja_preview_client";   // admin-only "view as client" flag

// Look up a mock client account generated for an admin-added client.
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
function resolveIdentity(email, profile) {
  const em = (email || "").trim().toLowerCase();
  const hard = ACCOUNTS[em];
  if (hard) return { email: em, client: hard.client, name: hard.name, role: hard.role };
  const reg = registryAccount(em);
  if (reg) return { email: em, client: reg.client, name: reg.name, role: reg.role };
  if (profile && profile.client_id) return { email: em, client: profile.client_id, name: profile.role === "admin" ? "TJA Client Services" : "Client", role: profile.role || "client" };
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
        const who = resolveIdentity(email, res.profile);
        if (who) { setSession(who); return true; }
        console.warn("login: authenticated but no workspace mapping for", email);
        try { window.SUPA.signOut(); } catch (e) {}
        return false;
      }
    } catch (e) { /* fall through to mock */ }
  }
  return attemptLogin(email, password);   // sandbox fallback (synchronous)
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
    const who = resolveIdentity(cur.user.email, cur.profile);
    if (!who) return false;
    setSession(who);
    return true;
  } catch (e) { return false; }
}

function requireAuth() {
  if (!getSession()) window.location.replace("index.html");
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

/* ---------- roles ---------- */
// The account's REAL role (drives whether the admin tools exist at all).
function isAdmin() { const s = getSession(); return !!s && s.role === "admin"; }

// Admin-only toggle: preview the client experience without logging out.
function isPreviewing() { return isAdmin() && sessionStorage.getItem(PREVIEW_KEY) === "1"; }
function setPreview(on) {
  if (!isAdmin()) return;
  if (on) sessionStorage.setItem(PREVIEW_KEY, "1");
  else sessionStorage.removeItem(PREVIEW_KEY);
}

// The EFFECTIVE role the UI should render as right now.
function effectiveRole() { return isPreviewing() ? "client" : (getSession() ? getSession().role : "client"); }
function canEdit() { return effectiveRole() === "admin"; }
