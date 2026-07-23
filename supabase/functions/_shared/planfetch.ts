/* Shared: read a project-plan file from Drive and parse it. ONE place for the read + the
   hidden-row handling so plan-refresh, plan-fetch and the Drive-push webhook stay identical. */
import * as XLSX from "npm:xlsx@0.18.5";
import { driveGetMeta, driveExportBytes, driveDownloadBytes, sheetsHiddenRowSet } from "./google.ts";
import { parseProjectPlanRows, dropHiddenRows } from "./plan.ts";

export function pickSheetName(names: string[]): string {
  return names.find((n) => /plan/i.test(n)) || names[names.length - 1] || names[0];
}

export async function fetchPlanFromDrive(token: string, fileId: string) {
  const meta = await driveGetMeta(token, fileId);
  const bytes = (meta.mimeType === "application/vnd.google-apps.spreadsheet")
    ? await driveExportBytes(token, fileId, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    : await driveDownloadBytes(token, fileId);
  const wb = XLSX.read(bytes, { type: "array", cellDates: true });
  const names: string[] = wb.SheetNames || [];
  if (!names.length) return null;
  const sheetName = pickSheetName(names);
  const ws = wb.Sheets[sheetName];
  const startRow = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]).s.r : 0;
  let rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: "m/d/yyyy", defval: "", blankrows: true }) as unknown[][];
  if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
    const hidden = await sheetsHiddenRowSet(fileId, sheetName);
    if (hidden.size) rows = rows.filter((_, i) => !hidden.has(startRow + i));
  } else {
    rows = dropHiddenRows(rows, ws["!rows"], startRow);
  }
  return parseProjectPlanRows(rows);
}

// Order-INSENSITIVE serialization for change detection (jsonb doesn't preserve key order, so a
// plain stringify reports false changes on every run). Same helper plan-refresh uses.
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + (v as unknown[]).map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}
