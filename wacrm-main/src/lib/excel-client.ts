"use client";

// ============================================================
// Browser-side Excel helpers (exceljs, loaded on demand so it never
// weighs on first page load). Used by the inbox "Data sheet" tab and
// the Train AI Q&A import / export.
// ============================================================

import { parseCsv } from "@/lib/inbox/conversation-sheet";

type ExcelJs = typeof import("exceljs");

/** exceljs ships CommonJS; depending on the bundler the API sits on
 *  `default` or on the namespace itself. */
async function loadExcel(): Promise<ExcelJs> {
  const mod = await import("exceljs");
  return (mod as unknown as { default?: ExcelJs }).default ?? mod;
}

export interface SheetSpec {
  name: string;
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, string | number>[];
}

/** Build an .xlsx with one or more sheets and trigger a download. */
export async function downloadWorkbook(filename: string, sheets: SheetSpec[]): Promise<void> {
  const { Workbook } = await loadExcel();
  const wb = new Workbook();
  wb.creator = "WhatsApp CRM";
  wb.created = new Date();
  for (const spec of sheets) {
    const ws = wb.addWorksheet(spec.name.slice(0, 31));
    ws.columns = spec.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 16 }));
    ws.addRows(spec.rows);
    const header = ws.getRow(1);
    header.font = { bold: true, color: { argb: "FFFFFFFF" } };
    header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF128C7E" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    ws.eachRow((row, i) => {
      if (i > 1) row.alignment = { vertical: "top", wrapText: true };
    });
  }
  const buffer = await wb.xlsx.writeBuffer();
  saveBlob(
    new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`,
  );
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Max upload size — a chat export is tiny; this only stops accidents. */
export const MAX_SHEET_BYTES = 5 * 1024 * 1024;

/**
 * Read the first worksheet of an .xlsx, or a .csv, into a table of
 * strings. Dates become YYYY-MM-DD, rich text is flattened.
 */
export async function readSheetFile(file: File): Promise<string[][]> {
  if (file.size > MAX_SHEET_BYTES) throw new Error("file_too_large");
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || file.type === "text/csv") {
    return parseCsv(await file.text());
  }
  if (!name.endsWith(".xlsx")) throw new Error("unsupported_type");

  const { Workbook } = await loadExcel();
  const wb = new Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const table: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    const count = row.cellCount;
    for (let i = 1; i <= count; i++) cells.push(cellText(row.getCell(i).value));
    table.push(cells);
  });
  return table;
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const v = value as {
      richText?: { text: string }[];
      text?: string;
      result?: unknown;
      hyperlink?: string;
    };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if (typeof v.text === "string") return v.text;
    if (v.result !== undefined) return cellText(v.result);
    if (typeof v.hyperlink === "string") return v.hyperlink;
    return "";
  }
  return String(value);
}
