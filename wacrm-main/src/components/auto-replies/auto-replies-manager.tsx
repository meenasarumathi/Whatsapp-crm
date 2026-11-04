"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  Clock,
  ListPlus,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
  Users,
} from "lucide-react"

import { createBrowserDb } from "@/lib/db/browser"
import { useAuth } from "@/hooks/use-auth"
import { useCan } from "@/hooks/use-can"
import type { MessageTemplate } from "@/types"
import type { AutoReplyRule } from "@/lib/auto-replies/schedule"
import { ALL_DAYS } from "@/lib/auto-replies/schedule"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface ListRow {
  id: string
  name: string
  color: string
  is_list: boolean
  count: number
}

interface SendRow {
  id: string
  rule_id: string
  contact_id: string
  status: "sent" | "failed"
  error: string | null
  created_at: string
}

type RuleDraft = Omit<
  AutoReplyRule,
  "id" | "account_id" | "user_id" | "sent_count" | "last_sent_at" | "created_at" | "updated_at"
> & { id?: string }

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

const COOLDOWNS = [0, 60, 360, 720, 1440, 10080] as const

const TIMEZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Seoul",
  "Australia/Sydney",
  "UTC",
]

function browserTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata"
    // Older alias some browsers still report.
    return tz === "Asia/Calcutta" ? "Asia/Kolkata" : tz
  } catch {
    return "Asia/Kolkata"
  }
}

function emptyRule(): RuleDraft {
  return {
    name: "",
    is_active: true,
    tag_ids: [],
    days: [1, 2, 3, 4, 5, 6],
    start_time: "09:00",
    end_time: "21:00",
    timezone: browserTimezone(),
    reply_kind: "template",
    template_name: null,
    template_language: null,
    template_variables: {},
    message_text: null,
    cooldown_minutes: 720,
    priority: 100,
  }
}

/** Placeholder numbers used in a template body, e.g. "Hi {{1}}" → ["1"]. */
function templatePlaceholders(body: string | null | undefined): string[] {
  const found = new Set<string>()
  for (const m of (body ?? "").matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(m[1])
  return [...found].sort((a, b) => Number(a) - Number(b))
}

export function AutoRepliesManager() {
  const t = useTranslations("AutoReplies")
  const { user, accountId } = useAuth()
  const canEdit = useCan("send-messages")

  const [loading, setLoading] = useState(true)
  const [lists, setLists] = useState<ListRow[]>([])
  const [allTags, setAllTags] = useState<ListRow[]>([])
  const [rules, setRules] = useState<AutoReplyRule[]>([])
  const [templates, setTemplates] = useState<MessageTemplate[]>([])
  const [sends, setSends] = useState<SendRow[]>([])
  const [contactNames, setContactNames] = useState<Record<string, string>>({})

  const [importOpen, setImportOpen] = useState(false)
  const [importTarget, setImportTarget] = useState<ListRow | null>(null)
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null)

  const load = useCallback(async () => {
    const db = createBrowserDb()
    const [tagsRes, rulesRes, tplRes, sendsRes] = await Promise.all([
      db.from("tags").select("id, name, color, is_list").order("name"),
      db.from("auto_reply_rules").select("*").order("priority").order("created_at"),
      db.from("message_templates").select("*").eq("status", "APPROVED").order("name"),
      db.from("auto_reply_sends").select("*").order("created_at", { ascending: false }).limit(20),
    ])
    const tags = (tagsRes.data ?? []) as Omit<ListRow, "count">[]
    // One count query per list keeps this simple; lists are few.
    const counts = await Promise.all(
      tags
        .filter((tg) => tg.is_list)
        .map(async (tg) => {
          const { count } = await db
            .from("contact_tags")
            .select("id", { count: "exact", head: true })
            .eq("tag_id", tg.id)
          return [tg.id, count ?? 0] as const
        }),
    )
    const countBy = new Map(counts)
    const rows = tags.map((tg) => ({ ...tg, count: countBy.get(tg.id) ?? 0 }))
    setAllTags(rows)
    setLists(rows.filter((r) => r.is_list))
    setRules((rulesRes.data ?? []) as AutoReplyRule[])
    setTemplates((tplRes.data ?? []) as MessageTemplate[])
    const sendRows = (sendsRes.data ?? []) as SendRow[]
    setSends(sendRows)
    const ids = [...new Set(sendRows.map((s) => s.contact_id))]
    if (ids.length > 0) {
      const { data: contacts } = await db.from("contacts").select("id, name, phone").in("id", ids)
      setContactNames(
        Object.fromEntries(
          ((contacts ?? []) as { id: string; name: string | null; phone: string }[]).map((c) => [
            c.id,
            c.name || c.phone,
          ]),
        ),
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const tagName = useMemo(() => new Map(allTags.map((tg) => [tg.id, tg.name])), [allTags])
  const ruleName = useMemo(() => new Map(rules.map((r) => [r.id, r.name])), [rules])

  async function toggleRule(rule: AutoReplyRule, on: boolean) {
    const { error } = await createBrowserDb().from("auto_reply_rules").update({ is_active: on }).eq("id", rule.id)
    if (error) return toast.error(t("toasts.saveFailed"))
    setRules((prev) => prev.map((r) => (r.id === rule.id ? { ...r, is_active: on } : r)))
  }

  async function deleteRule(rule: AutoReplyRule) {
    if (!window.confirm(t("rules.confirmDelete", { name: rule.name }))) return
    const { error } = await createBrowserDb().from("auto_reply_rules").delete().eq("id", rule.id)
    if (error) return toast.error(t("toasts.deleteFailed"))
    toast.success(t("toasts.deleted"))
    void load()
  }

  async function deleteList(list: ListRow) {
    if (!window.confirm(t("lists.confirmDelete", { name: list.name }))) return
    const { error } = await createBrowserDb().from("tags").delete().eq("id", list.id)
    if (error) return toast.error(t("toasts.deleteFailed"))
    toast.success(t("toasts.deleted"))
    void load()
  }

  async function saveRule(draft: RuleDraft) {
    if (!user || !accountId) return
    if (!draft.name.trim()) return toast.error(t("rules.errors.name"))
    if (draft.days.length === 0) return toast.error(t("rules.errors.days"))
    if (draft.reply_kind === "template" && !draft.template_name) return toast.error(t("rules.errors.template"))
    if (draft.reply_kind === "text" && !draft.message_text?.trim()) return toast.error(t("rules.errors.text"))
    const row = {
      name: draft.name.trim(),
      is_active: draft.is_active,
      tag_ids: draft.tag_ids,
      days: [...draft.days].sort(),
      start_time: draft.start_time,
      end_time: draft.end_time,
      timezone: draft.timezone,
      reply_kind: draft.reply_kind,
      template_name: draft.reply_kind === "template" ? draft.template_name : null,
      template_language: draft.reply_kind === "template" ? draft.template_language : null,
      template_variables: draft.reply_kind === "template" ? draft.template_variables : {},
      message_text: draft.reply_kind === "text" ? draft.message_text : null,
      cooldown_minutes: draft.cooldown_minutes,
      priority: draft.priority,
    }
    const db = createBrowserDb()
    const { error } = draft.id
      ? await db.from("auto_reply_rules").update(row).eq("id", draft.id)
      : await db.from("auto_reply_rules").insert({ ...row, user_id: user.id, account_id: accountId })
    if (error) {
      console.error("[auto-replies] save failed", error)
      return toast.error(t("toasts.saveFailed"))
    }
    toast.success(t("toasts.saved"))
    setRuleDraft(null)
    void load()
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Contact lists */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t("lists.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("lists.subtitle")}</p>
          </div>
          <Button
            variant="outline"
            disabled={!canEdit}
            onClick={() => {
              setImportTarget(null)
              setImportOpen(true)
            }}
          >
            <ListPlus className="h-4 w-4" />
            {t("lists.new")}
          </Button>
        </div>
        {lists.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("lists.empty")}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {lists.map((list) => (
              <div key={list.id} className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{list.name}</p>
                  <p className="text-xs text-muted-foreground">{t("lists.count", { count: list.count })}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canEdit}
                    onClick={() => {
                      setImportTarget(list)
                      setImportOpen(true)
                    }}
                  >
                    <Upload className="h-4 w-4" />
                    {t("lists.addNumbers")}
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={!canEdit} onClick={() => void deleteList(list)} aria-label={t("lists.delete")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Rules */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-foreground">{t("rules.title")}</h2>
            <p className="text-sm text-muted-foreground">{t("rules.subtitle")}</p>
          </div>
          <Button disabled={!canEdit} onClick={() => setRuleDraft(emptyRule())}>
            <Plus className="h-4 w-4" />
            {t("rules.new")}
          </Button>
        </div>
        {rules.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            {t("rules.empty")}
          </p>
        ) : (
          <div className="space-y-2">
            {rules.map((rule) => (
              <div key={rule.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-semibold text-foreground">{rule.name}</p>
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users className="h-3 w-3" />
                      {rule.tag_ids.length === 0
                        ? t("rules.everyone")
                        : rule.tag_ids.map((id) => tagName.get(id) ?? "?").join(", ")}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {rule.days.map((d) => t(`days.${d}`)).join(" ")} · {rule.start_time}–{rule.end_time} ({rule.timezone})
                    </span>
                    <span>
                      {rule.reply_kind === "template"
                        ? t("rules.replyTemplate", { name: rule.template_name ?? "" })
                        : t("rules.replyText")}
                    </span>
                    <span>{t("rules.sent", { count: rule.sent_count })}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch checked={rule.is_active} disabled={!canEdit} onCheckedChange={(v) => void toggleRule(rule, v)} />
                  <Button size="icon-sm" variant="ghost" disabled={!canEdit} onClick={() => setRuleDraft({ ...rule })} aria-label={t("rules.edit")}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" disabled={!canEdit} onClick={() => void deleteRule(rule)} aria-label={t("rules.delete")}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Activity */}
      <section className="space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t("activity.title")}</h2>
        {sends.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("activity.empty")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {sends.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                <span className="truncate text-foreground">{contactNames[s.contact_id] ?? s.contact_id.slice(0, 8)}</span>
                <span className="truncate text-muted-foreground">{ruleName.get(s.rule_id) ?? ""}</span>
                <span className={cn(s.status === "sent" ? "text-emerald-500" : "text-red-400")} title={s.error ?? undefined}>
                  {t(`activity.${s.status}`)}
                </span>
                <span className="shrink-0 text-muted-foreground">{new Date(s.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ImportDialog
        open={importOpen}
        target={importTarget}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          setImportOpen(false)
          void load()
        }}
      />

      {ruleDraft && (
        <RuleDialog
          draft={ruleDraft}
          lists={allTags}
          templates={templates}
          onChange={setRuleDraft}
          onClose={() => setRuleDraft(null)}
          onSave={(d) => void saveRule(d)}
        />
      )}
    </div>
  )
}

function ImportDialog({
  open,
  target,
  onClose,
  onDone,
}: {
  open: boolean
  target: ListRow | null
  onClose: () => void
  onDone: () => void
}) {
  const t = useTranslations("AutoReplies.import")
  const [name, setName] = useState("")
  const [numbers, setNumbers] = useState("")
  const [countryCode, setCountryCode] = useState("91")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) {
      setName("")
      setNumbers("")
    }
  }, [open])

  async function onFile(file: File | undefined) {
    if (!file) return
    const text = await file.text()
    setNumbers((prev) => (prev ? `${prev}\n${text}` : text))
  }

  async function submit() {
    setBusy(true)
    try {
      const res = await fetch("/api/contact-lists/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag_id: target?.id, name: target ? undefined : name, numbers, country_code: countryCode }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error ?? t("failed"))
      toast.success(t("done", { numbers: body.numbers, created: body.created_contacts }))
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("failed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{target ? t("addTitle", { name: target.name }) : t("newTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!target && (
            <label className="block space-y-1 text-sm">
              <span className="text-foreground">{t("name")}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
            </label>
          )}
          <label className="block space-y-1 text-sm">
            <span className="text-foreground">{t("numbers")}</span>
            <Textarea
              rows={7}
              value={numbers}
              onChange={(e) => setNumbers(e.target.value)}
              placeholder={"98765 43210\nAsha, +91 91234 56789"}
              className="font-mono text-xs"
            />
          </label>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="text-foreground">{t("countryCode")}</span>
              <Input value={countryCode} onChange={(e) => setCountryCode(e.target.value.replace(/\D/g, "").slice(0, 4))} className="w-24" />
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-muted">
              <Upload className="h-4 w-4" />
              {t("csv")}
              <input type="file" accept=".csv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !numbers.trim() || (!target && !name.trim())}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RuleDialog({
  draft,
  lists,
  templates,
  onChange,
  onClose,
  onSave,
}: {
  draft: RuleDraft
  lists: ListRow[]
  templates: MessageTemplate[]
  onChange: (d: RuleDraft) => void
  onClose: () => void
  onSave: (d: RuleDraft) => void
}) {
  const t = useTranslations("AutoReplies")
  const set = (patch: Partial<RuleDraft>) => onChange({ ...draft, ...patch })
  const template = templates.find((tpl) => tpl.name === draft.template_name)
  const placeholders = templatePlaceholders(template?.body_text)
  // Lists first, then other tags — any tag can target a rule.
  const ordered = [...lists].sort((a, b) => Number(b.is_list) - Number(a.is_list) || a.name.localeCompare(b.name))
  const zones = TIMEZONES.includes(draft.timezone) ? TIMEZONES : [draft.timezone, ...TIMEZONES]

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft.id ? t("rules.editTitle") : t("rules.newTitle")}</DialogTitle>
          <DialogDescription>{t("rules.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <label className="block space-y-1 text-sm">
            <span className="text-foreground">{t("rules.name")}</span>
            <Input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder={t("rules.namePlaceholder")} />
          </label>

          <div className="space-y-2">
            <p className="text-sm text-foreground">{t("rules.who")}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => set({ tag_ids: [] })}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs",
                  draft.tag_ids.length === 0 ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                )}
              >
                {t("rules.everyone")}
              </button>
              {ordered.map((tg) => {
                const on = draft.tag_ids.includes(tg.id)
                return (
                  <button
                    key={tg.id}
                    type="button"
                    onClick={() => set({ tag_ids: on ? draft.tag_ids.filter((x) => x !== tg.id) : [...draft.tag_ids, tg.id] })}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs",
                      on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                    )}
                  >
                    {tg.name}
                    {tg.is_list ? ` · ${tg.count}` : ""}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-foreground">{t("rules.when")}</p>
            <div className="flex flex-wrap gap-1.5">
              {ALL_DAYS.map((d) => {
                const on = draft.days.includes(d)
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d] })}
                    className={cn(
                      "w-12 rounded-md border py-1 text-xs",
                      on ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                    )}
                  >
                    {t(`days.${d}`)}
                  </button>
                )
              })}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-xs text-muted-foreground">
                {t("rules.from")}
                <Input type="time" value={draft.start_time} onChange={(e) => set({ start_time: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                {t("rules.to")}
                <Input type="time" value={draft.end_time} onChange={(e) => set({ end_time: e.target.value })} />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                {t("rules.timezone")}
                <select value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} className={SELECT_CLASS}>
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t("rules.windowHint")}</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm text-foreground">{t("rules.reply")}</p>
            <div className="flex gap-2">
              {(["template", "text"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => set({ reply_kind: kind })}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs",
                    draft.reply_kind === kind ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground",
                  )}
                >
                  {t(`rules.kind.${kind}`)}
                </button>
              ))}
            </div>
            {draft.reply_kind === "template" ? (
              <div className="space-y-2">
                {templates.length === 0 ? (
                  <p className="text-xs text-amber-500">{t("rules.noTemplates")}</p>
                ) : (
                  <select
                    value={draft.template_name ?? ""}
                    onChange={(e) => {
                      const tpl = templates.find((x) => x.name === e.target.value)
                      set({ template_name: tpl?.name ?? null, template_language: tpl?.language ?? null, template_variables: {} })
                    }}
                    className={SELECT_CLASS}
                  >
                    <option value="">{t("rules.pickTemplate")}</option>
                    {templates.map((tpl) => (
                      <option key={tpl.id} value={tpl.name}>
                        {tpl.name} ({tpl.language})
                      </option>
                    ))}
                  </select>
                )}
                {template && <p className="whitespace-pre-wrap rounded-md bg-muted p-2 text-xs text-muted-foreground">{template.body_text}</p>}
                {placeholders.map((n) => (
                  <label key={n} className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="w-10 shrink-0 font-mono">{`{{${n}}}`}</span>
                    <Input
                      value={draft.template_variables[n] ?? ""}
                      onChange={(e) => set({ template_variables: { ...draft.template_variables, [n]: e.target.value } })}
                      placeholder="{{contact.name}}"
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="space-y-1">
                <Textarea
                  rows={4}
                  value={draft.message_text ?? ""}
                  onChange={(e) => set({ message_text: e.target.value })}
                  placeholder={t.raw("rules.textPlaceholder") as string}
                />
                <p className="text-xs text-muted-foreground">{t.raw("rules.textHint") as string}</p>
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              {t("rules.cooldown")}
              <select
                value={draft.cooldown_minutes}
                onChange={(e) => set({ cooldown_minutes: Number(e.target.value) })}
                className={SELECT_CLASS}
              >
                {COOLDOWNS.map((m) => (
                  <option key={m} value={m}>
                    {t(`cooldowns.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              {t("rules.priority")}
              <Input type="number" min={0} max={1000} value={draft.priority} onChange={(e) => set({ priority: Number(e.target.value) || 0 })} />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={draft.is_active} onCheckedChange={(v) => set({ is_active: v })} />
            {t("rules.active")}
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("import.cancel")}
          </Button>
          <Button onClick={() => onSave(draft)}>{t("rules.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
