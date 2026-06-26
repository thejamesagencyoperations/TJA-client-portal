/* ============================================================
   CLIENT STORE — the persistent client registry
   Source of truth for "which client workspaces exist". Merges:
     1. built-in seed list  (window.TJA_CLIENTS, from clients.js)
     2. admin-added clients  (localStorage "tja_clients")
   and, when Supabase is configured, the "_registry / clients"
   scope so the roster syncs across devices.

   Each entry: { id, name, initials, logo, tagline, engagements,
                 kind, login:{email,password}, createdAt, builtin }
   Exposed as window.TJA_STORE.
   ============================================================ */
window.TJA_STORE = (function () {
  const LS_KEY = "tja_clients";
  const REG_CLIENT = "_registry";   // pseudo client_id for the roster row
  const REG_SCOPE = "clients";

  function readAdded() {
    try { const a = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function writeAdded(arr) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) { console.warn("client store full", e); }
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(REG_CLIENT, REG_SCOPE, arr);
  }

  // built-in seed clients (cannot be deleted) flagged so the UI can hide destructive controls
  function builtins() {
    return (window.TJA_CLIENTS || []).map(c => Object.assign({ builtin: true }, c));
  }

  // merged roster: built-ins first, then added (added wins on id collision, e.g. edited built-in)
  function list() {
    const added = readAdded();
    const map = new Map();
    builtins().forEach(c => map.set(c.id, c));
    added.forEach(c => map.set(c.id, Object.assign({}, map.get(c.id), c, { builtin: !!(map.get(c.id) && map.get(c.id).builtin) })));
    return [...map.values()];
  }
  function get(id) { return list().find(c => c.id === id) || null; }
  function exists(id) { return !!get(id); }

  function uniqueId(base) {
    let id = base, n = 2;
    while (exists(id)) id = base + "-" + (n++);
    return id;
  }

  // meta: { name, initials?, logo?, tagline?, engagements?, kind?, login? }
  function add(meta) {
    const name = (meta.name || "").trim();
    const id = uniqueId(window.tjaSlugify(name));
    const entry = {
      id,
      name,
      initials: (meta.initials || window.tjaInitialsFrom(name)).trim().slice(0, 3).toUpperCase(),
      logo: meta.logo || "",
      tagline: meta.tagline || "",
      engagements: meta.engagements || (meta.kind === "both" ? "Monthly Services · 1 project"
        : meta.kind === "project" ? "1 project" : "Monthly Services"),
      kind: meta.kind || "retainer",
      login: meta.login || { email: id.replace(/-/g, "") + "@client.tja", password: id.slice(0, 6) + Math.floor(Math.random() * 90 + 10) },
      createdAt: new Date().toISOString(),
    };
    const added = readAdded();
    added.push(entry);
    writeAdded(added);
    return entry;
  }

  function update(id, patch) {
    const added = readAdded();
    const i = added.findIndex(c => c.id === id);
    if (i >= 0) { added[i] = Object.assign({}, added[i], patch); }
    else {
      // editing a built-in: store an override entry that list() merges on top
      const b = get(id); if (!b) return null;
      added.push(Object.assign({}, b, patch, { id }));
    }
    writeAdded(added);
    return get(id);
  }

  function remove(id) {
    const added = readAdded().filter(c => c.id !== id);
    writeAdded(added);
    // wipe this client's workspace data locally + in Supabase
    ["tja_dashboard_", "tja_files_", "tja_deliverables_"].forEach(p => { try { localStorage.removeItem(p + id); } catch {} });
    if (window.SUPA && window.SUPA.enabled && window.SUPA.removeClient) window.SUPA.removeClient(id);
  }

  // write the initial blank workspace for a freshly-added client so the
  // dashboard's loadState() finds it (instead of falling back to a seed)
  function seedWorkspace(entry) {
    const data = window.makeClientData({ name: entry.name, initials: entry.initials, logo: entry.logo, kind: entry.kind });
    const state = { engagements: data.engagements };
    try { localStorage.setItem("tja_dashboard_" + entry.id, JSON.stringify(state)); } catch {}
    if (window.SUPA && window.SUPA.enabled) window.SUPA.pushScope(entry.id, "dashboard", state);
    return data;
  }

  // pull the roster from Supabase (if configured) and merge into localStorage
  async function hydrate() {
    if (!(window.SUPA && window.SUPA.enabled)) return;
    try {
      const remote = await window.SUPA.pullScope(REG_CLIENT, REG_SCOPE);
      if (Array.isArray(remote) && remote.length) {
        const local = readAdded();
        const map = new Map(local.map(c => [c.id, c]));
        remote.forEach(c => { if (!map.has(c.id)) map.set(c.id, c); });
        try { localStorage.setItem(LS_KEY, JSON.stringify([...map.values()])); } catch {}
      }
    } catch (e) { console.warn("roster hydrate", e); }
  }

  return { list, get, exists, add, update, remove, seedWorkspace, hydrate, uniqueId };
})();
