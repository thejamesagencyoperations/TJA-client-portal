/* ============================================================
   MOCK AUTH + ROLES — SANDBOX ONLY (NOT SECURE)
   Client-side demo gate so the team can click through the concept.
   Roles:
     • admin  → internal TJA team: full edit, upload, manage versions
     • client → read-only on data tabs; may upload Files + review Present Docs
   In production these become Firebase Auth custom claims, enforced
   server-side. Here they just shape the UI.
   ============================================================ */

const ACCOUNTS = {
  "celticelevator@thejamesagency.com": {
    password: "celticelevator",
    client: "celtic-elevator",
    name: "Celtic Elevator",
    role: "client",
  },
  "clientservices@thejamesagency.com": {
    password: "admin",
    client: "celtic-elevator",   // admin views this client's workspace in the beta
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

// Unified login. Identity (who you are + which workspace you own) is resolved from the
// mock roster — the two hardcoded accounts PLUS the client registry (window.TJA_STORE),
// which holds every admin-added client's email→workspace mapping. Supabase auth is used
// ONLY as a best-effort background data-sync session; it must NOT decide identity, because
// its `profiles` table has no per-client rows yet and was therefore sending EVERY client to
// the hard-coded celtic-elevator fallback (that was the "all logins open Celtic" bug). The
// Step-6 backend will replace this with real server-side claims.
async function login(email, password) {
  // Ensure the client roster is loaded so per-client logins resolve (added clients live in
  // the store, not the two hardcoded accounts). No-op if the store isn't on this page.
  if (window.TJA_STORE && window.TJA_STORE.hydrate) { try { await window.TJA_STORE.hydrate(); } catch (e) {} }

  const ok = attemptLogin(email, password);
  if (ok && window.SUPA && window.SUPA.enabled) {
    try { await window.SUPA.signIn(email, password); } catch (e) { /* sync-only; identity already set */ }
  }
  return ok;
}

function requireAuth() {
  if (!getSession()) window.location.replace("index.html");
}

function logout() {
  if (window.SUPA && window.SUPA.enabled) { try { window.SUPA.signOut(); } catch {} }
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
