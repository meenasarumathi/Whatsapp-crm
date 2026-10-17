"use client";

/**
 * Inbox → contact panel → "Data sheet" tab.
 *
 *   Download — the whole conversation as an Excel workbook (.xlsx, a
 *              "Conversation" sheet plus a "Contact" sheet) or as CSV,
 *              ready to share.
 *   Upload   — an .xlsx / .csv conversation (one exported here, or any
 *              sheet with a "Message" column and optionally "From",
 *              "Date", "Time"). It opens in a preview, and can be saved
 *              to this contact's notes or used to teach the AI
 *              (customer question → your reply become Q&A pairs in
 *              Train AI).
 *
 * Nothing here sends a WhatsApp message.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Download,
  FileSpreadsheet,
  GraduationCap,
  Loader2,
  StickyNote,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/hooks/use-auth";
import { createBrowserDb } from "@/lib/db/browser";
import { cn } from "@/lib/utils";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { downloadWorkbook, readSheetFile, saveBlob } from "@/lib/excel-client";
import {
  SHEET_COLUMNS,
  conversationToRows,
  isCustomer,
  rowsToCsv,
  sheetFileStem,
  sheetToMessages,
  transcript,
  type SheetMessage,
} from "@/lib/inbox/conversation-sheet";
import { pairsFromTurns } from "@/lib/ai/training";
import type { Contact, Message } from "@/types";

const PAGE = 1000;
const MAX_MESSAGES = 10_000;

async function fetchAllMessages(conversationId: string): Promise<Message[]> {
  const db = createBrowserDb();
  const all: Message[] = [];
  for (let from = 0; from < MAX_MESSAGES; from += PAGE) {
    const { data, error } = await db
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    all.push(...((data ?? []) as Message[]));
    if (!data || data.length < PAGE) break;
  }
  return all;
}

export function ConversationDataSheet({
  conversationId,
  contact,
}: {
  conversationId: string | null;
  contact: Contact;
}) {
  const t = useTranslations("Inbox.dataSheet");
  const { accountId, user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"xlsx" | "csv" | "upload" | "note" | "train" | null>(null);
  const [preview, setPreview] = useState<{ fileName: string; messages: SheetMessage[] } | null>(null);

  const displayName = contact.name || contactHandle(contact);

  const download = async (kind: "xlsx" | "csv") => {
    if (!conversationId) return;
    setBusy(kind);
    try {
      const messages = await fetchAllMessages(conversationId);
      const rows = conversationToRows(messages);
      const stem = sheetFileStem(displayName);
      if (kind === "csv") {
        saveBlob(new Blob([rowsToCsv(rows)], { type: "text/csv;charset=utf-8" }), `${stem}.csv`);
      } else {
        await downloadWorkbook(stem, [
          {
            name: "Conversation",
            columns: SHEET_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width })),
            rows,
          },
          {
            name: "Contact",
            columns: [
              { header: "Field", key: "field", width: 18 },
              { header: "Value", key: "value", width: 50 },
            ],
            rows: [
              { field: "Name", value: contact.name ?? "" },
              { field: "WhatsApp", value: contactHandle(contact) },
              { field: "Email", value: contact.email ?? "" },
              { field: "Company", value: contact.company ?? "" },
              { field: "Messages", value: rows.length },
              { field: "Exported at", value: new Date().toLocaleString() },
            ],
          },
        ]);
      }
      toast.success(t("downloaded", { count: rows.length }));
    } catch (err) {
      console.error("[data sheet] download failed:", err);
      toast.error(t("downloadFailed"));
    } finally {
      setBusy(null);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy("upload");
    try {
      const table = await readSheetFile(file);
      const parsed = sheetToMessages(table);
      if (!parsed.ok) {
        toast.error(parsed.error === "no_header" ? t("noMessageColumn") : t("emptySheet"));
        return;
      }
      setPreview({ fileName: file.name, messages: parsed.messages });
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      toast.error(
        code === "file_too_large"
          ? t("tooLarge")
          : code === "unsupported_type"
            ? t("unsupportedType")
            : t("readFailed"),
      );
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const pairs = preview
    ? pairsFromTurns(preview.messages.map((m) => ({ fromCustomer: isCustomer(m.from), text: m.text })))
    : [];

  const saveAsNote = async () => {
    if (!preview || !accountId) return;
    setBusy("note");
    const { error } = await createBrowserDb()
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: `${t("noteHeading", { file: preview.fileName })}\n\n${transcript(preview.messages)}`,
      });
    setBusy(null);
    if (error) {
      toast.error(t("noteFailed"));
      return;
    }
    toast.success(t("noteSaved"));
    setPreview(null);
  };

  const teachAi = async () => {
    if (!accountId || pairs.length === 0) return;
    setBusy("train");
    const { error } = await createBrowserDb()
      .from("ai_training_examples")
      .insert(
        pairs.map((p) => ({
          account_id: accountId,
          kind: "qa",
          question: p.question,
          answer: p.answer,
          category: displayName,
          source: "import",
          created_by: user?.id,
        })),
      );
    setBusy(null);
    if (error) {
      console.error("[data sheet] teach AI failed:", error);
      toast.error(t("trainFailed"));
      return;
    }
    toast.success(t("trainSaved", { count: pairs.length }));
    setPreview(null);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Download className="h-4 w-4 text-primary" />
          {t("downloadTitle")}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("downloadDesc")}</p>
        <div className="mt-3 grid gap-2">
          <Button size="sm" disabled={!conversationId || busy !== null} onClick={() => void download("xlsx")}>
            {busy === "xlsx" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
            {t("downloadExcel")}
          </Button>
          <Button size="sm" variant="outline" disabled={!conversationId || busy !== null} onClick={() => void download("csv")}>
            {busy === "csv" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {t("downloadCsv")}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Upload className="h-4 w-4 text-primary" />
          {t("uploadTitle")}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("uploadDesc")}</p>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-3 w-full"
          disabled={busy !== null}
          onClick={() => fileRef.current?.click()}
        >
          {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t("uploadButton")}
        </Button>
        <p className="mt-2 text-[11px] text-muted-foreground">{t("uploadFormat")}</p>
      </div>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="bg-popover border-border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <FileSpreadsheet className="h-4 w-4 text-primary" />
              {preview?.fileName}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("previewDesc", { count: preview?.messages.length ?? 0, pairs: pairs.length })}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto rounded-lg bg-card-2 p-3">
            {preview?.messages.map((m, i) => {
              const mine = !isCustomer(m.from);
              return (
                <div key={i} className={cn("flex", mine ? "justify-end" : "justify-start")}>
                  <div
                    className={cn(
                      "max-w-[85%] rounded-2xl px-3 py-1.5 text-xs",
                      mine ? "rounded-br-sm bg-primary text-primary-foreground" : "rounded-bl-sm border border-border bg-card text-foreground",
                    )}
                  >
                    <p className="whitespace-pre-wrap">{m.text}</p>
                    <p className={cn("mt-0.5 text-[10px]", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>
                      {[m.from, m.date, m.time].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter className="bg-popover border-border gap-2 sm:flex-wrap">
            <Button variant="outline" disabled={busy !== null} onClick={() => void saveAsNote()}>
              {busy === "note" ? <Loader2 className="h-4 w-4 animate-spin" /> : <StickyNote className="h-4 w-4" />}
              {t("saveNote")}
            </Button>
            <Button disabled={busy !== null || pairs.length === 0} onClick={() => void teachAi()}>
              {busy === "train" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GraduationCap className="h-4 w-4" />}
              {t("teachAi", { count: pairs.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
