"use client";

/**
 * Step 4 of Train AI — learn from real inbox conversations.
 *
 * Pick a chat your team handled well; every customer question and the
 * reply that followed it becomes a suggested Q&A pair. Tick the good
 * ones and save — they go into `ai_training_examples` with
 * source = 'conversation'.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, MessagesSquare, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { pairsFromTurns } from "@/lib/ai/training";
import { cn } from "@/lib/utils";

interface ConversationOption {
  id: string;
  last_message_text: string | null;
  last_message_at: string | null;
  contact: { name: string | null; phone: string | null } | null;
}

interface Suggestion {
  question: string;
  answer: string;
  picked: boolean;
}

export function LearnFromChats({ canEdit, onSaved }: { canEdit: boolean; onSaved: () => Promise<void> }) {
  const t = useTranslations("TrainAi.learn");
  const { accountId, user } = useAuth();
  const [conversations, setConversations] = useState<ConversationOption[]>([]);
  const [selected, setSelected] = useState<ConversationOption | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("conversations")
        .select("id, last_message_text, last_message_at, contact:contacts(name, phone)")
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(40);
      if (!cancelled && data) setConversations(data as unknown as ConversationOption[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = async (c: ConversationOption) => {
    setSelected(c);
    setLoading(true);
    const { data } = await createClient()
      .from("messages")
      .select("sender_type, content_text, content_type")
      .eq("conversation_id", c.id)
      .order("created_at", { ascending: true })
      .limit(400);
    const turns = ((data ?? []) as { sender_type: string; content_text: string | null; content_type: string }[])
      .filter((m) => m.content_text)
      .map((m) => ({ fromCustomer: m.sender_type === "customer", text: m.content_text ?? "" }));
    setSuggestions(pairsFromTurns(turns).map((p) => ({ ...p, picked: true })));
    setLoading(false);
  };

  const save = async () => {
    if (!accountId) return;
    const picked = suggestions.filter((s) => s.picked && s.question.trim() && s.answer.trim());
    if (picked.length === 0) return;
    setSaving(true);
    const { error } = await createClient()
      .from("ai_training_examples")
      .insert(
        picked.map((s) => ({
          account_id: accountId,
          kind: "qa",
          question: s.question.trim(),
          answer: s.answer.trim(),
          category: selected?.contact?.name ?? null,
          source: "conversation",
          created_by: user?.id,
        })),
      );
    setSaving(false);
    if (error) {
      console.error("[train ai] learn save failed:", error);
      toast.error(t("saveFailed"));
      return;
    }
    toast.success(t("saved", { count: picked.length }));
    setSuggestions([]);
    setSelected(null);
    await onSaved();
  };

  const pickedCount = suggestions.filter((s) => s.picked).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="max-h-[480px] space-y-1 overflow-y-auto rounded-xl border border-border bg-card p-2">
          {conversations.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">{t("noChats")}</p>
          ) : (
            conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => void pick(c)}
                className={cn(
                  "w-full rounded-lg px-3 py-2 text-left transition-colors",
                  selected?.id === c.id ? "bg-primary/10" : "hover:bg-muted",
                )}
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {c.contact?.name || c.contact?.phone || t("unknownContact")}
                </p>
                <p className="truncate text-xs text-muted-foreground">{c.last_message_text ?? ""}</p>
              </button>
            ))
          )}
        </div>

        <div className="min-w-0">
          {!selected ? (
            <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              <MessagesSquare className="mb-2 h-6 w-6" />
              {t("pickChat")}
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("reading")}
            </div>
          ) : suggestions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              {t("noPairs")}
            </p>
          ) : (
            <div className="space-y-3">
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  className={cn("rounded-xl border bg-card p-3", s.picked ? "border-primary/40" : "border-border opacity-70")}
                >
                  <label className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={s.picked}
                      onCheckedChange={(v) =>
                        setSuggestions((prev) => prev.map((x, j) => (j === i ? { ...x, picked: !!v } : x)))
                      }
                    />
                    {t("usePair")}
                  </label>
                  <Textarea
                    rows={2}
                    value={s.question}
                    onChange={(e) =>
                      setSuggestions((prev) => prev.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))
                    }
                    aria-label={t("question")}
                  />
                  <Textarea
                    rows={3}
                    className="mt-2"
                    value={s.answer}
                    onChange={(e) =>
                      setSuggestions((prev) => prev.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)))
                    }
                    aria-label={t("answer")}
                  />
                </div>
              ))}
              {canEdit && (
                <Button onClick={() => void save()} disabled={saving || pickedCount === 0}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {t("savePicked", { count: pickedCount })}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
