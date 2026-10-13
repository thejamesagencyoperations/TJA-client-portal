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

/* One-time targeted sweep (2026-07): remove junk clients that a malformed WMJ
   sheet row auto-created before the DROP_ROW time-pattern guard existed (e.g.
   "10am-3:45pm (removed an hour for that lunch slot 12-1)"). Runs once per
   browser; the transform guard prevents them from ever coming back. */
(function () {
  // v2: the guard was only on the projects transform, so the retainers sheet kept
  // re-creating the junk client. Both transforms now drop it — sweep once more.
  const SWEEP_TAG = "2026-07-junk-clients-v2";
  const JUNK = (c) => /\b\d{1,2}(:\d{2})?\s*(a|p)m\b/i.test((c && c.name) || "");
  try {
    if (localStorage.getItem("tja_junk_sweep") === SWEEP_TAG) return;
    const arr = JSON.parse(localStorage.getItem("tja_clients") || "[]");
    if (Array.isArray(arr)) {
      const junk = arr.filter(JUNK);
      if (junk.length) {
        localStorage.setItem("tja_clients", JSON.stringify(arr.filter(c => !JUNK(c))));
        junk.forEach(c => ["tja_dashboard_", "tja_files_", "tja_deliverables_"]
          .forEach(p => localStorage.removeItem(p + c.id)));
      }
    }
    localStorage.setItem("tja_junk_sweep", SWEEP_TAG);
  } catch (e) {}
})();

/* One-time Celtic cleanup (2026-07): Celtic is a PROJECT client (real
   engagement = the WMJ "CEL Stratagem" project). Remove leftover demo
   content from any browser that has it — the hand-made "New Project"
   and the placeholder monthly-services disciplines — so only the real,
   live project data shows. Runs once per browser. */
(function () {
  const TAG = "2026-07-celtic-clean-v1";
  try {
    if (localStorage.getItem("tja_celtic_clean") === TAG) return;
    const k = "tja_dashboard_celtic-elevator";
    const s = JSON.parse(localStorage.getItem(k) || "null");
    if (s && s.engagements) {
      const e = s.engagements;
      // keep only real WMJ projects; drop any hand-made mock project
      if (Array.isArray(e.projects)) e.projects = e.projects.filter(p => String((p && p.id) || "").indexOf("wmj_") === 0);
      // clear the placeholder retainer — Celtic has no monthly-services engagement
      if (e.retainer) {
        e.retainer.projectOnly = true;
        e.retainer.serviceDisciplines = [];
        e.retainer.serviceLines = [];
        e.retainer.burn = { usedHours: 0, contractedHours: 0, periodLabel: "" };
      }
      localStorage.setItem(k, JSON.stringify(s));
    }
    localStorage.setItem("tja_celtic_clean", TAG);
  } catch (e) {}
})();

window.TJA_STORE = (function () {
  const LS_KEY = "tja_clients";
  const REG_CLIENT = "_registry";   // pseudo client_id for the roster row
  /* WORKSPACE-WIDE SETTINGS — one sentinel row, same pattern as the roster ("_settings" is
     skipped by every client loop because it is "_"-prefixed). Cached in localStorage so
     canEdit() can consult it SYNCHRONOUSLY during the first render; refreshed by hydrate().
     Every staff role can READ app_state, so a manager sees the flag that governs them. */
  const SET_CLIENT = "_settings", SET_KEY = "tja_settings";
  const SETTING_DEFAULTS = {
    // false = an AM/PM may edit ANY client (assignments still drive filtering + ownership
    // display). true = they may only edit clients they're assigned to. Default OFF per
    // Cameron 2026-08-03 — off is the deliberate current policy, so a MISSING row must read
    // as off, not as restricted.
    restrictManagerEdits: false,
  };
  function readSettings() {
    try {
      const o = JSON.parse(localStorage.getItem(SET_KEY) || "null");
      return Object.assign({}, SETTING_DEFAULTS, (o && typeof o === "object") ? o : {});
    } catch (e) { return Object.assign({}, SETTING_DEFAULTS); }
  }
  function writeSettingsLocal(o) {
    try { localStorage.setItem(SET_KEY, JSON.stringify(Object.assign({}, SETTING_DEFAULTS, o || {}))); } catch (e) {}
  }
  // ADMIN write path (server first, then cache — a failed push must not leave a local lie)
  async function setSetting(key, value) {
    if (!(key in SETTING_DEFAULTS)) throw new Error("unknown setting: " + key);
    const next = Object.assign(readSettings(), { [key]: value });
    if (window.SUPA && window.SUPA.enabled && window.SUPA.pushScopeNow) {
      const r = await window.SUPA.pushScopeNow(SET_CLIENT, REG_SCOPE, next);
      if (!r || !r.ok) throw new Error("couldn't save the setting");
    }
    writeSettingsLocal(next);
    return next;
  }
  const REG_SCOPE = "clients";

  function readAdded() {
    try { const a = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  function writeAdded(arr) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(arr)); } catch (e) { console.warn("client store full", e); }
  }
  /* ---------- registry writes: OPERATIONS, not whole-roster pushes (2026-10-13) ----------
     This browser used to push its WHOLE local copy of every client whenever any one changed —
     so a tab opened hours earlier wrote its stale managers / am / pm / reviewer toggles back over
     everyone ("I keep getting kicked off as a Manager", reviewer toggles reverting). Now each
     add / update / remove is queued as an operation carrying ONLY the fields that were edited,
     and replayed onto a FRESH server copy with a compare-and-set write (SUPA.casUpdate). A
     stale tab can no longer touch a field it didn't change. The queue lives in localStorage, so
     an edit made just before a reload still lands. */
  const OPS_KEY = "tja_clients_ops";
  function readOps() { try { const a = JSON.parse(localStorage.getItem(OPS_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function writeOps(a) { try { localStorage.setItem(OPS_KEY, JSON.stringify(a)); } catch (e) {} }
  function queueOp(op) { const a = readOps(); a.push(Object.assign({ at: Date.now() }, op)); writeOps(a); schedulePush(); }
  const lowerName = (x) => String(x || "").trim().toLowerCase();
  // replay queued operations onto `roster` (the fresh server copy); returns it
  function applyOps(roster, ops) {
    ops.forEach(op => {
      if (op.t === "add") { if (!roster.some(c => c.id === op.entry.id)) roster.push(op.entry); return; }
      if (op.t === "rm") { const i = roster.findIndex(c => c.id === op.id); if (i > -1) roster.splice(i, 1); return; }
      if (op.t !== "patch") return;
      let c = roster.find(x => x.id === op.id);
      if (!c) { if (!op.seed) return; c = Object.assign({}, op.seed); roster.push(c); }   // a built-in being edited first time
      const patch = Object.assign({}, op.patch);
      // integrations: only the KEYS this edit touched
      if (patch.integrations) { c.integrations = Object.assign({}, c.integrations, patch.integrations); delete patch.integrations; }
      // managers edited BY HAND → record pins, so the daily sheet sync never drops someone added
      // here, and un-pin anyone removed here
      if (Array.isArray(patch.managers) && op.manual) {
        const before = (Array.isArray(c.managers) ? c.managers : []).map(lowerName);
        const after = patch.managers.map(lowerName);
        const ig = Object.assign({}, c.integrations);
        let pins = Array.isArray(ig.managersPinned) ? ig.managersPinned.slice() : [];
        patch.managers.forEach(m => { if (before.indexOf(lowerName(m)) === -1 && !pins.some(p => lowerName(p) === lowerName(m))) pins.push(m); });
        pins = pins.filter(p => after.indexOf(lowerName(p)) > -1);
        ig.managersPinned = pins; c.integrations = ig;
      }
      Object.assign(c, patch);
    });
    return roster;
  }
  let pushTimer = null, pushing = false, pushFails = 0;
  function schedulePush(ms) { clearTimeout(pushTimer); pushTimer = setTimeout(pushOps, ms == null ? 500 : ms); }
  async function pushOps() {
    if (!(window.SUPA && window.SUPA.enabled && window.SUPA.casUpdate)) return;
    if (pushing) { schedulePush(800); return; }
    const ops = readOps(); if (!ops.length) return;
    pushing = true;
    try {
      const r = await window.SUPA.casUpdate(REG_CLIENT, REG_SCOPE, (fresh) => applyOps(Array.isArray(fresh) ? fresh : [], ops));
      if (r.ok) {
        // drop exactly the ops we applied (more may have been queued meanwhile)
        const done = new Set(ops.map(o => o.at + ":" + (o.id || (o.entry && o.entry.id))));
        writeOps(readOps().filter(o => !done.has(o.at + ":" + (o.id || (o.entry && o.entry.id)))));
        adoptRemote(r.data);
        pushFails = 0;
        if (readOps().length) schedulePush(200);
      } else { pushFails++; schedulePush(Math.min(30000, 2000 * Math.pow(2, pushFails - 1))); console.warn("roster save failed — retrying", r.error); }
    } finally { pushing = false; }
  }
  // overlay the server roster onto the local cache, then re-apply anything still queued
  function adoptRemote(remote) {
    if (!Array.isArray(remote) || !remote.length) return;
    const map = new Map(readAdded().map(c => [c.id, c]));
    remote.forEach(c => { const cur = map.get(c.id); map.set(c.id, cur ? Object.assign({}, cur, c) : c); });
    const arr = applyOps([...map.values()], readOps());
    writeAdded(arr);
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
      // Distribution address (the TJA team inbox for this client), by the SAME convention
      // WMJ uses: <name, lowercased, alphanumeric>@thejamesagency.com. This is where the
      // client-response email goes — so every manually-added client gets one automatically,
      // just like WMJ-synced ones (no per-client setup). It is NOT a sign-in — real logins
      // are Supabase users made in the Admin Center. (Was a dead "@client.tja" mock.)
      login: meta.login || { email: window.tjaSlugify(name).replace(/-/g, "") + "@thejamesagency.com" },
      createdAt: new Date().toISOString(),
    };
    const added = readAdded();
    added.push(entry);
    writeAdded(added);
    queueOp({ t: "add", entry });
    return entry;
  }

  // opts.manual = a person edited this by hand (managers changes become pins — see applyOps)
  function update(id, patch, opts) {
    const added = readAdded();
    const i = added.findIndex(c => c.id === id);
    let seed = null;
    if (i >= 0) { added[i] = Object.assign({}, added[i], patch); }
    else {
      // editing a built-in: store an override entry that list() merges on top
      const b = get(id); if (!b) return null;
      seed = Object.assign({}, b, { id }); delete seed.builtin;
      added.push(Object.assign({}, b, patch, { id }));
    }
    writeAdded(added);
    queueOp({ t: "patch", id, patch, seed, manual: !!(opts && opts.manual) });
    return get(id);
  }

  function remove(id) {
    const added = readAdded().filter(c => c.id !== id);
    writeAdded(added);
    queueOp({ t: "rm", id });
    // wipe this client's workspace data locally + in Supabase
    ["tja_dashboard_", "tja_files_", "tja_deliverables_"].forEach(p => { try { localStorage.removeItem(p + id); } catch {} });
    if (window.SUPA && window.SUPA.enabled && window.SUPA.removeClient) window.SUPA.removeClient(id);
  }

  // ----- reference layout (copy the team's Celtic monthly-services layout) -----
  const REFERENCE_ID = "celtic-elevator";   // reverted: retainers use the standard DEFAULT_RETAINER_FREE layout
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
    // settings ride along in PARALLEL — the roster read already gates first paint, so this
    // costs no extra latency, and canEdit() must not run against a stale flag
    const setP = window.SUPA.pullScope(SET_CLIENT, REG_SCOPE)
      .then((o) => { if (o && typeof o === "object" && !Array.isArray(o)) writeSettingsLocal(o); })
      .catch(() => {});
    try {
      const remote = await window.SUPA.pullScope(REG_CLIENT, REG_SCOPE);
      // OVERLAY remote onto local — the registry is the server-owned truth for managers, am/pm,
      // integrations — then re-apply this browser's still-unsaved edits on top (and send them).
      if (Array.isArray(remote) && remote.length) adoptRemote(remote);
      if (readOps().length) schedulePush(0);
    } catch (e) { console.warn("roster hydrate", e); }
    await setP;
  }

  // Public surface — only what other modules actually consume (exists/uniqueId/referenceRetainerLayout are internal-only).
  return { list, get, add, update, remove, seedWorkspace, hydrate, referenceProjectLayout,
           settings: readSettings, setSetting };
})();
