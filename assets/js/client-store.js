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
/* One-time clean slate (2026-07): wipe the auto-created client roster + every
   client's stored workspace/files/deliverables so we can re-implement the data
   from the revised Workamajig sheets. Runs once per browser (gated by the flag);
   bump PURGE_TAG to force another clean sweep. */
(function () {
  const PURGE_TAG = "2026-07-clean-slate";
  try {
    if (localStorage.getItem("tja_purge") !== PURGE_TAG) {
      localStorage.removeItem("tja_clients");
      localStorage.removeItem("tja_wmj_last_sync");
      Object.keys(localStorage)
        .filter(k => /^tja_(dashboard|files|deliverables)_/.test(k))
        .forEach(k => localStorage.removeItem(k));
      localStorage.setItem("tja_purge", PURGE_TAG);
    }
  } catch (e) {}
})();

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
      code: (meta.code || "").trim(),   // WMJ client code (leading token of Campaign_Name); shown instead of initials
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

  // ----- reference layout (copy the team's Celtic monthly-services layout) -----
  const REFERENCE_ID = "celtic-elevator";
  const BAKED_H = { burn: 525, service: 474, milestones: 284, todos: 186, dependencies: 176, kpis: 185, pr: 558 };
  // Celtic's saved layout stores x/y/w but lets height follow content. Give every
  // tile an explicit height so a (blank) new client's boxes are the SAME SIZE:
  // derive each tile's height from the gap to the next tile in its column; the
  // last tile in a column falls back to the captured baked height.
  function completeHeights(free) {
    const GAP = 16, cols = {};
    Object.keys(free).forEach(k => { const x = Math.round(free[k].x || 0); (cols[x] = cols[x] || []).push(k); });
    Object.keys(cols).forEach(x => {
      const keys = cols[x].sort((a, b) => (free[a].y || 0) - (free[b].y || 0));
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (free[k].h) continue;
        free[k].h = (i < keys.length - 1)
          ? Math.max(80, (free[keys[i + 1]].y || 0) - (free[k].y || 0) - GAP)
          : (BAKED_H[k] || 200);
      }
    });
  }
  // The retainer layout to hand new clients: a clone of the reference client's
  // CURRENT layout (so it matches whatever the team's Celtic looks like in this
  // browser), with every box given an explicit size. null if none saved yet.
  function referenceRetainerLayout() {
    try {
      const ref = JSON.parse(localStorage.getItem("tja_dashboard_" + REFERENCE_ID));
      const lay = ref && ref.engagements && ref.engagements.retainer && ref.engagements.retainer.layout;
      if (lay && lay.free && Object.keys(lay.free).length) {
        const out = JSON.parse(JSON.stringify(lay));
        out.locked = false;            // new clients start unlocked
        completeHeights(out.free);
        return out;
      }
    } catch (e) {}
    return null;
  }

  // Project layout: every project mirrors a designated TEMPLATE project that the
  // team arranged (DNA Stratagem). Read that project's saved layout straight from
  // localStorage (so it matches whatever it looks like in THIS browser); fall back
  // to the monthly-services reference. PR Coverage + KPIs are hidden on projects.
  const REFERENCE_PROJECT_ID = "wmj_rcswebsiteredesigndevelopment";   // the arranged template project
  const PROJECT_HIDDEN = ["pr", "kpis"];
  function readProjectLayoutById(pid) {
    try {
      for (const k of Object.keys(localStorage)) {
        if (!/^tja_dashboard_/.test(k)) continue;
        const s = JSON.parse(localStorage.getItem(k));
        const p = ((s && s.engagements && s.engagements.projects) || [])
          .find(x => x.id === pid && x.layout && x.layout.free && Object.keys(x.layout.free).length);
        if (p) return JSON.parse(JSON.stringify(p.layout));
      }
    } catch (e) {}
    return null;
  }
  function referenceProjectLayout() {
    const lay = readProjectLayoutById(REFERENCE_PROJECT_ID) || referenceRetainerLayout();
    if (!lay) return null;
    lay.locked = true;   // projects are locked in to the template arrangement by default
    lay.free = lay.free || {};
    PROJECT_HIDDEN.forEach(k => { delete lay.free[k]; });
    lay.hidden = [...new Set([...(Array.isArray(lay.hidden) ? lay.hidden : []), ...PROJECT_HIDDEN])];
    return lay;
  }

  // write the initial blank workspace for a freshly-added client so the
  // dashboard's loadState() finds it (instead of falling back to a seed)
  function seedWorkspace(entry) {
    const data = window.makeClientData({ name: entry.name, initials: entry.initials, code: entry.code, logo: entry.logo, kind: entry.kind });
    const refLay = referenceRetainerLayout();
    if (refLay && data.engagements.retainer) data.engagements.retainer.layout = refLay;
    const projLay = referenceProjectLayout();
    if (projLay && Array.isArray(data.engagements.projects))
      data.engagements.projects.forEach(p => { p.layout = JSON.parse(JSON.stringify(projLay)); });
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

  return { list, get, exists, add, update, remove, seedWorkspace, hydrate, uniqueId, referenceRetainerLayout, referenceProjectLayout };
})();
