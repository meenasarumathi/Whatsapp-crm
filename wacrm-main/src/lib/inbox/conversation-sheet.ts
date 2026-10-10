// ============================================================
// Conversation ⇄ spreadsheet — pure helpers behind the inbox
// "Data sheet" tab (download a chat as Excel / CSV, upload one back).
//
// The workbook itself is built with exceljs in the component; this file
// only decides the columns, turns messages into rows and parses rows
// (from .xlsx or .csv) back into messages, so it stays unit-testable.
// ============================================================

import type { Message } from "@/types";

export const SHEET_COLUMNS = [
  { key: "date", header: "Date", width: 12 },
  { key: "time", header: "Time", width: 9 },
  { key: "from", header: "From", width: 14 },
  { key: "type", header: "Type", width: 12 },
  { key: "message", header: "Message", width: 70 },
  { key: "status", header: "Status", width: 11 },
  { key: "template", header: "Template", width: 18 },
  { key: "media", header: "Media URL", width: 40 },
] as const;

export type SheetColumnKey = (typeof SHEET_COLUMNS)[number]["key"];
export type SheetRow = Record<SheetColumnKey, string>;

export type SheetSender = "Customer" | "Agent" | "Bot" | "AI";

/** A message read back from an uploaded sheet. */
export interface SheetMessage {
  date: string;
  time: string;
  from: SheetSender | string;
  type: string;
  text: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function senderLabel(m: Pick<Message, "sender_type" | "ai_generated">): SheetSender {
  if (m.sender_type === "customer") return "Customer";
  if (m.ai_generated) return "AI";
  return m.sender_type === "bot" ? "Bot" : "Agent";
}

/** Best readable text for any message type. */
export function messageText(m: Message): string {
  if (m.content_text && m.content_text.trim()) return m.content_text.trim();
  if (m.content_type === "template" && m.template_name) return `[Template: ${m.template_name}]`;
  if (m.content_type !== "text") return `[${m.content_type}]`;
  return "";
}

/** One spreadsheet row per message, oldest first, in local time. */
export function conversationToRows(messages: Message[]): SheetRow[] {
  return [...messages]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((m) => {
      const d = new Date(m.created_at);
      return {
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
        from: senderLabel(m),
        type: m.content_type,
        message: messageText(m),
        status: m.sender_type === "customer" ? "" : m.status,
        template: m.template_name ?? "",
        media: m.media_url ?? "",
      };
    });
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** CSV with a UTF-8 BOM so Excel opens non-English text correctly. */
export function rowsToCsv(rows: SheetRow[]): string {
  const lines = [
    SHEET_COLUMNS.map((c) => c.header).join(","),
    ...rows.map((r) => SHEET_COLUMNS.map((c) => csvCell(r[c.key] ?? "")).join(",")),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type ParseSheetResult =
  | { ok: true; messages: SheetMessage[] }
  | { ok: false; error: "no_header" | "empty" };

/**
 * Turn a table (from an uploaded .xlsx or .csv) into messages. Needs a
 * header row with at least a "Message" column; "From", "Date", "Time"
 * and "Type" are used when present. Header names are matched without
 * regard to case, so a sheet exported here or typed by hand both work.
 */
export function sheetToMessages(table: string[][]): ParseSheetResult {
  const headerIdx = table.findIndex((r) =>
    r.some((c) => c.trim().toLowerCase() === "message"),
  );
  if (headerIdx === -1) return { ok: false, error: "no_header" };
  const header = table[headerIdx].map((c) => c.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iMsg = col("message");
  const iFrom = col("from");
  const iDate = col("date");
  const iTime = col("time");
  const iType = col("type");

  const messages = table
    .slice(headerIdx + 1)
    .map((r) => ({
      date: iDate >= 0 ? (r[iDate] ?? "").trim() : "",
      time: iTime >= 0 ? (r[iTime] ?? "").trim() : "",
      from: iFrom >= 0 ? normaliseSender(r[iFrom] ?? "") : "Customer",
      type: iType >= 0 ? (r[iType] ?? "").trim() || "text" : "text",
      text: (r[iMsg] ?? "").trim(),
    }))
    .filter((m) => m.text);

  return messages.length > 0 ? { ok: true, messages } : { ok: false, error: "empty" };
}

function normaliseSender(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (["customer", "client", "contact", "user", "lead"].includes(v)) return "Customer";
  if (v === "ai") return "AI";
  if (v === "bot") return "Bot";
  if (["agent", "business", "staff", "me", "us"].includes(v)) return "Agent";
  return raw.trim() || "Customer";
}

export function isCustomer(from: string): boolean {
  return from === "Customer";
}

/** Plain-text transcript, e.g. for saving an upload as a contact note. */
export function transcript(messages: SheetMessage[], maxChars = 8000): string {
  const out = messages
    .map((m) => `${[m.date, m.time].filter(Boolean).join(" ")} ${m.from}: ${m.text}`.trim())
    .join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…` : out;
}

/** Safe filename stem for a contact, e.g. "chat-gru-2026-10-10". */
export function sheetFileStem(contactName: string, now: Date = new Date()): string {
  const slug =
    contactName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "contact";
  return `chat-${slug}-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
