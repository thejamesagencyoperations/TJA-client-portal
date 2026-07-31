/* ============================================================
   DRIVE TREE — the shared shape of the portal's Drive storage, and the helpers that
   guarantee it exists. Used by drive-provision (bulk/cron) and drive-upload (on demand),
   so the folder list has exactly ONE definition.

     TJA Client Portal Storage/          <- DRIVE_ROOT_FOLDER_ID (Shared Drive folder)
       <Client Name>/
         Present Docs/ Reporting/ Monthly Snapshots/ Files/ Media Requests/ History/ Misc./

   APPEND-ONLY list: adding an entry and re-running drive-provision back-fills every existing
   client, which is the requirement (Cameron 2026-07-31 — folders must be updated for all
   clients, existing and future, whenever a feature adds a type).
   ============================================================ */
import { createClient } from "npm:@supabase/supabase-js@2";

export const ASSET_FOLDERS = [
  "Present Docs",
  "Reporting",
  "Monthly Snapshots",
  "Files",
  "Media Requests",
  "History",
  "Misc.",
] as const;

/* Upload categories (what callers pass) → the Drive folder they belong in. Anything unmapped
   lands in Misc. rather than the client's root, so nothing is ever loose or lost. */
const CATEGORY_FOLDER: Record<string, string> = {
  "present-docs": "Present Docs",
  "presentdocs": "Present Docs",
  "proof": "Present Docs",
  "keywords": "Present Docs",
  "files": "Files",
  "file": "Files",
  "media-intake": "Media Requests",
  "media": "Media Requests",
  "reporting": "Reporting",
  "report": "Reporting",
  "snapshot": "Monthly Snapshots",
  "monthly-snapshots": "Monthly Snapshots",
  "history": "History",
};
export function folderForCategory(category?: string): string {
  const key = String(category || "").trim().toLowerCase();
  return CATEGORY_FOLDER[key] || "Misc.";
}

const DRIVE = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function findChildFolder(token: string, parentId: string, name: string): Promise<string | null> {
  const q = `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' ` +
            `and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const u = new URL(DRIVE + "/files");
  u.searchParams.set("q", q);
  u.searchParams.set("fields", "files(id,name)");
  u.searchParams.set("supportsAllDrives", "true");
  u.searchParams.set("includeItemsFromAllDrives", "true");
  u.searchParams.set("pageSize", "10");
  const r = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`drive list ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).files?.[0]?.id ?? null;
}

async function createFolder(token: string, parentId: string, name: string): Promise<string> {
  const r = await fetch(DRIVE + "/files?supportsAllDrives=true&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  if (!r.ok) throw new Error(`drive create ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).id;
}

// Drive has no upsert, and a concurrent double-run would happily create duplicates — always look
// before creating.
export async function ensureFolder(token: string, parentId: string, name: string): Promise<string> {
  return (await findChildFolder(token, parentId, name)) ?? (await createFolder(token, parentId, name));
}

export async function ensureClientTree(
  token: string, rootId: string, clientName: string, known?: Record<string, string>,
) {
  const created: string[] = [];
  const folderId = await ensureFolder(token, rootId, clientName);
  const folders: Record<string, string> = {};
  for (const name of ASSET_FOLDERS) {
    if (known && known[name]) { folders[name] = known[name]; continue; }   // trust recorded ids
    const existing = await findChildFolder(token, folderId, name);
    folders[name] = existing ?? await createFolder(token, folderId, name);
    if (!existing) created.push(`${clientName}/${name}`);
  }
  return { folderId, folders, created };
}

/* Resolve ONE client's folder ids, provisioning + recording them if they're missing. Lets an
   upload for a brand-new client succeed on the first try instead of failing until the nightly
   provision runs. Read-modify-write of the single registry row (service role). */
export async function ensureClientFolders(token: string, rootId: string, clientId: string) {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: row } = await db.from("app_state").select("data")
    .eq("client_id", "_registry").eq("scope", "clients").maybeSingle();
  const roster: Array<Record<string, unknown>> = Array.isArray(row?.data) ? row!.data : [];
  const c = roster.find((x) => String(x.id) === clientId);
  if (!c) return null;

  const integ = (c.integrations && typeof c.integrations === "object" ? c.integrations : {}) as Record<string, unknown>;
  const known = (integ.driveFolders as Record<string, string>) || {};
  if (integ.driveFolderId && ASSET_FOLDERS.every((n) => known[n])) {
    return { folderId: String(integ.driveFolderId), folders: known };      // already complete
  }
  const tree = await ensureClientTree(token, rootId, String(c.name || clientId), known);
  integ.driveFolderId = tree.folderId;
  integ.driveFolders = tree.folders;
  c.integrations = integ;
  await db.from("app_state").upsert(
    { client_id: "_registry", scope: "clients", data: roster, updated_at: new Date().toISOString() },
    { onConflict: "client_id,scope" },
  );
  return { folderId: tree.folderId, folders: tree.folders };
}
