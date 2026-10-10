"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { PROFILE_FIELDS, type ReplyLength, type TrainingProfile } from "@/lib/ai/training";

/** Step 1 — the business profile, asked as plain questions. */
export function ProfileForm({
  profile,
  canEdit,
  onSaved,
}: {
  profile: TrainingProfile;
  canEdit: boolean;
  onSaved: (p: TrainingProfile) => void;
}) {
  const t = useTranslations("TrainAi.profile");
  const { accountId, user } = useAuth();
  const [draft, setDraft] = useState<TrainingProfile>(profile);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(profile);
  }, [profile]);

  const save = async () => {
    if (!accountId) return;
    setSaving(true);
    const { error } = await createClient()
      .from("ai_training_profiles")
      .upsert(
        { account_id: accountId, profile: draft, updated_by: user?.id },
        { onConflict: "account_id" },
      );
    setSaving(false);
    if (error) {
      console.error("[train ai] profile save failed:", error);
      toast.error(t("saveFailed"));
      return;
    }
    onSaved(draft);
    toast.success(t("saved"));
  };

  const filled = PROFILE_FIELDS.filter((f) => (draft[f.key] ?? "").trim()).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t("intro")}</p>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          {t("filled", { count: filled, total: PROFILE_FIELDS.length })}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {PROFILE_FIELDS.map((f) => (
          <div key={f.key} className={f.multiline ? "grid gap-1.5 md:col-span-2" : "grid gap-1.5"}>
            <Label className="text-sm text-foreground">{t(`fields.${f.key}.label`)}</Label>
            {f.multiline ? (
              <Textarea
                rows={3}
                value={draft[f.key] ?? ""}
                disabled={!canEdit}
                placeholder={t(`fields.${f.key}.placeholder`)}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            ) : (
              <Input
                value={draft[f.key] ?? ""}
                disabled={!canEdit}
                placeholder={t(`fields.${f.key}.placeholder`)}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            )}
            <p className="text-[11px] text-muted-foreground">{t(`fields.${f.key}.help`)}</p>
          </div>
        ))}

        <div className="grid gap-1.5">
          <Label className="text-sm text-foreground">{t("replyLength")}</Label>
          <select
            value={draft.replyLength ?? "medium"}
            disabled={!canEdit}
            onChange={(e) => setDraft({ ...draft, replyLength: e.target.value as ReplyLength })}
            className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="short">{t("lengthShort")}</option>
            <option value="medium">{t("lengthMedium")}</option>
            <option value="detailed">{t("lengthDetailed")}</option>
          </select>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
          <div>
            <Label className="text-sm text-foreground">{t("emojis")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("emojisHelp")}</p>
          </div>
          <Switch
            checked={draft.useEmojis ?? true}
            disabled={!canEdit}
            onCheckedChange={(v) => setDraft({ ...draft, useEmojis: v })}
          />
        </div>
      </div>

      {canEdit && (
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {t("save")}
        </Button>
      )}
    </div>
  );
}
