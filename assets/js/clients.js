/* ============================================================
   BUILT-IN CLIENT REGISTRY — intentionally empty.

   Celtic Elevator used to be hardcoded here as the demo client. That
   made it the only "builtin" workspace: no delete button on its tile,
   and its name/logo/tagline duplicated between this file and the real
   registry. It is a REAL client with real data, so it now lives in the
   registry like every other client — its registry entry already carried
   the logo, tagline, code and initials, so nothing was lost.

   Every client workspace now comes from ONE place: the `clients` scope
   in Supabase (window.TJA_STORE). Leave this empty.

   An entry here still works — client-store merges it in and flags it
   `builtin: true`, which makes the tile undeletable. That should be a
   deliberate choice (a client that must exist with no backend), never
   the default.
   ============================================================ */
window.TJA_CLIENTS = [];
