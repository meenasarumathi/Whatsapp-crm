"use client";

/**
 * Steps 2 and 3 of Train AI — teach the AI by example.
 *
 *   kind="qa"   — "When a customer asks … reply …" pairs. Searchable,
 *                 switch on/off, edit, delete; import / export as Excel
 *                 (Question, Answer, Category columns).
 *   kind="rule" — short do / don't instructions, with one-click
 *                 suggestions to get started.
 *
 * Rows live in `ai_training_examples` (migration 044).
 */

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Check,
  Download,
  Loader2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { createBrowserDb } from "@/lib/db/browser";
import { downloadWorkbook, readSheetFile } from "@/lib/excel-client";
import { cn } from "@/lib/utils";
import type { TrainingRow } from "./use-training";

const RULE_SUGGESTIONS = [
  "ruleGreet",
  "ruleNoDiscount",
  "ruleOrderNumber",
  "ruleNoMedical",
  "ruleConfirm",
  "ruleHuman",
] as const;

export function ExamplesManager({
  kind,
  rows,
  canEdit,
  onChanged,
}: {
  kind: "qa" | "rule";
  rows: TrainingRow[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const t = useTranslations("TrainAi.examples");
  const { accountId, user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ question: "", answer: "" });

  const mine = useMemo(() => rows.filter((r) => r.kind === kind), [rows, kind]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return mine;
    return mine.filter((r) =>
      `${r.question ?? ""} ${r.answer} ${r.category ?? ""}`.toLowerCase().includes(q),
    );
  }, [mine, query]);

  const insert = async (
    items: { question?: string | null; answer: string; category?: string | null; source?: TrainingRow["source"] }[],
  ) => {
    if (!accountId || items.length === 0) return false;
    setBusy(true);
    const { error } = await createBrowserDb()
      .from("ai_training_examples")
      .insert(
        items.map((i) => ({
          account_id: accountId,
          kind,
          question: kind === "qa" ? i.question : null,
          answer: i.answer,
          category: i.category || null,
          source: i.source ?? "manual",
          created_by: user?.id,
        })),
      );
    setBusy(false);
    if (error) {
      console.error("[train ai] insert failed:", error);
      toast.error(t("saveFailed"));
      return false;
    }
    await onChanged();
    return true;
  };

  const add = async () => {
    if (!answer.trim() || (kind === "qa" && !question.trim())) return;
    const ok = await insert([{ question: question.trim(), answer: answer.trim(), category: category.trim() }]);
    if (ok) {
      setQuestion("");
      setAnswer("");
      toast.success(kind === "qa" ? t("qaAdded") : t("ruleAdded"));
    }
  };

  const update = async (id: string, patch: Partial<TrainingRow>) => {
    const { error } = await createBrowserDb().from("ai_training_examples").update(patch).eq("id", id);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    await onChanged();
  };

  const remove = async (id: string) => {
    const { error } = await createBrowserDb().from("ai_training_examples").delete().eq("id", id);
    if (error) {
      toast.error(t("saveFailed"));
      return;
    }
    await onChanged();
  };

  const exportSheet = () =>
    void downloadWorkbook(kind === "qa" ? "ai-training-qa" : "ai-training-rules", [
      {
        name: kind === "qa" ? "Q&A" : "Rules",
        columns:
          kind === "qa"
            ? [
                { header: "Question", key: "question", width: 50 },
                { header: "Answer", key: "answer", width: 70 },
                { header: "Category", key: "category", width: 18 },
                { header: "Active", key: "active", width: 8 },
                { header: "Times used", key: "uses", width: 11 },
              ]
            : [
                { header: "Rule", key: "answer", width: 80 },
                { header: "Active", key: "active", width: 8 },
              ],
        rows: (mine.length ? mine : []).map((r) => ({
          question: r.question ?? "",
          answer: r.answer,
          category: r.category ?? "",
          active: r.is_active ? "yes" : "no",
          uses: r.use_count,
        })),
      },
    ]);

  const importSheet = async (file: File | undefined) => {
    if (!file) return;
    try {
      const table = await readSheetFile(file);
      const header = (table[0] ?? []).map((c) => c.trim().toLowerCase());
      const iQ = header.indexOf("question");
      const iA = header.indexOf(kind === "qa" ? "answer" : "rule");
      const iC = header.indexOf("category");
      if (iA === -1 || (kind === "qa" && iQ === -1)) {
        toast.error(kind === "qa" ? t("importNeedsQa") : t("importNeedsRule"));
        return;
      }
      const items = table
        .slice(1)
        .map((r) => ({
          question: iQ >= 0 ? (r[iQ] ?? "").trim() : null,
          answer: (r[iA] ?? "").trim(),
          category: iC >= 0 ? (r[iC] ?? "").trim() : null,
          source: "import" as const,
        }))
        .filter((i) => i.answer && (kind === "rule" || i.question));
      if (items.length === 0) {
        toast.error(t("importEmpty"));
        return;
      }
      if (await insert(items)) toast.success(t("imported", { count: items.length }));
    } catch {
      toast.error(t("importFailed"));
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{kind === "qa" ? t("qaIntro") : t("ruleIntro")}</p>

      {canEdit && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          {kind === "qa" ? (
            <>
              <Input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={t("questionPlaceholder")}
              />
              <Textarea
                rows={3}
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t("answerPlaceholder")}
              />
              <Input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder={t("categoryPlaceholder")}
                className="sm:max-w-xs"
              />
            </>
          ) : (
            <>
              <Input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder={t("rulePlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
              <div className="flex flex-wrap gap-1.5">
                {RULE_SUGGESTIONS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setAnswer(t(`suggestions.${key}`))}
                    className="rounded-full border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
                  >
                    + {t(`suggestions.${key}`)}
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !answer.trim() || (kind === "qa" && !question.trim())} onClick={() => void add()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {kind === "qa" ? t("addQa") : t("addRule")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={(e) => void importSheet(e.target.files?.[0])}
            />
            <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" />
              {t("importExcel")}
            </Button>
            <Button size="sm" variant="outline" onClick={exportSheet}>
              <Download className="h-4 w-4" />
              {mine.length ? t("exportExcel") : t("downloadTemplate")}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("search")} className="pl-8" />
        </div>
        <span className="text-xs text-muted-foreground">{t("count", { count: mine.length })}</span>
      </div>

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {kind === "qa" ? t("emptyQa") : t("emptyRules")}
        </p>
      ) : (
        <ul className="space-y-2">
          {visible.map((r) => (
            <li
              key={r.id}
              className={cn(
                "rounded-xl border border-border bg-card p-3",
                !r.is_active && "opacity-60",
              )}
            >
              {editing === r.id ? (
                <div className="space-y-2">
                  {kind === "qa" && (
                    <Input
                      value={editDraft.question}
                      onChange={(e) => setEditDraft({ ...editDraft, question: e.target.value })}
                    />
                  )}
                  <Textarea
                    rows={3}
                    value={editDraft.answer}
                    onChange={(e) => setEditDraft({ ...editDraft, answer: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={async () => {
                        await update(r.id, {
                          question: kind === "qa" ? editDraft.question.trim() : null,
                          answer: editDraft.answer.trim(),
                        });
                        setEditing(null);
                      }}
                      disabled={!editDraft.answer.trim() || (kind === "qa" && !editDraft.question.trim())}
                    >
                      <Check className="h-4 w-4" /> {t("save")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      <X className="h-4 w-4" /> {t("cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    {kind === "qa" && (
                      <p className="text-sm font-medium text-foreground">
                        <span className="mr-1 text-primary">Q:</span>
                        {r.question}
                      </p>
                    )}
                    <p className={cn("whitespace-pre-wrap text-sm", kind === "qa" ? "mt-1 text-muted-foreground" : "text-foreground")}>
                      {kind === "qa" && <span className="mr-1 text-emerald-400">A:</span>}
                      {r.answer}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                      {r.category && <span className="rounded-full bg-muted px-2 py-0.5">{r.category}</span>}
                      <span className="rounded-full bg-muted px-2 py-0.5">{t(`source.${r.source}`)}</span>
                      {kind === "qa" && (
                        <span className="rounded-full bg-muted px-2 py-0.5">{t("used", { count: r.use_count })}</span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Switch
                        checked={r.is_active}
                        onCheckedChange={(v) => void update(r.id, { is_active: v })}
                        aria-label={t("active")}
                      />
                      <button
                        type="button"
                        aria-label={t("edit")}
                        onClick={() => {
                          setEditing(r.id);
                          setEditDraft({ question: r.question ?? "", answer: r.answer });
                        }}
                        className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={t("delete")}
                        onClick={() => void remove(r.id)}
                        className="rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
