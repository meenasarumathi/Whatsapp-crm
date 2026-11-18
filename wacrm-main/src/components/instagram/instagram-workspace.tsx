"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { AlertTriangle, Bot, CheckCircle2, Copy, Eye, EyeOff, FlaskConical, Inbox, Link2, Loader2, Send, XCircle, Zap } from "lucide-react"

import { createBrowserDb } from "@/lib/db/browser"
import { useCan } from "@/hooks/use-can"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { SettingsPanelHead } from "@/components/settings/settings-panel-head"
import type { InstagramAutomation, InstagramAutomationConfig } from "@/lib/instagram/rules"

type Section = "inbox" | "automations" | "connect"

interface Settings {
  connected: boolean
  ig_user_id: string | null
  username: string | null
  has_app_secret: boolean
  /** Admins only. */
  verify_token: string | null
  ai_auto_reply: boolean
  last_event_at: string | null
  webhook_subscribed_at: string | null
  webhook_error: string | null
  token_health?: "none" | "ok" | "invalid" | "unreachable"
}

interface Contact {
  id: string
  igsid: string
  username: string | null
  last_message_text: string | null
  last_message_at: string | null
  unread_count: number
}

interface Message {
  id: string
  direction: "inbound" | "outbound"
  kind: string
  text: string | null
  status: string
  sent_by: string | null
  error: string | null
  created_at: string
}

interface QuickReply {
  id: string
  title: string
}

const SELECT_CLASS =
  "w-full rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none"

export function InstagramWorkspace() {
  const t = useTranslations("Instagram")
  // Lives in Settings → Instagram (next to WhatsApp): set up first, then
  // automations, then the conversations it has handled.
  const [section, setSection] = useState<Section>("connect")
  const [settings, setSettings] = useState<Settings | null>(null)

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/instagram/settings?check=1", { cache: "no-store" })
    if (res.ok) setSettings((await res.json()) as Settings)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadSettings()
  }, [loadSettings])

  const sections: { key: Section; icon: typeof Inbox }[] = [
    { key: "connect", icon: Link2 },
    { key: "automations", icon: Zap },
    { key: "inbox", icon: Inbox },
  ]

  return (
    <div className="space-y-5">
      <SettingsPanelHead
        title={t("title")}
        description={t("subtitle")}
        className="mb-0"
        action={
          settings && (
            <span
              className={cn(
                "whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium",
                settings.connected && settings.token_health === "ok" ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400" : "border-amber-500/40 bg-amber-500/10 text-amber-400",
              )}
            >
              {!settings.connected
                ? t("status.simulation")
                : settings.token_health === "ok"
                  ? t("status.connected", { username: settings.username ?? "" })
                  : t("status.needsReconnecting")}
            </span>
          )
        }
      />

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {sections.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setSection(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors",
              section === key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {t(`sections.${key}`)}
          </button>
        ))}
      </div>

      {section === "inbox" && <InstagramInbox />}
      {section === "automations" && <InstagramAutomations />}
      {section === "connect" && settings && <InstagramConnect settings={settings} onChange={setSettings} />}
    </div>
  )
}

function InstagramInbox() {
  const t = useTranslations("Instagram.inbox")
  const canReply = useCan("send-messages")
  const [contacts, setContacts] = useState<Contact[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)

  const loadContacts = useCallback(async () => {
    const { data } = await createBrowserDb()
      .from("instagram_contacts")
      .select("*")
      .order("last_message_at", { ascending: false })
      .limit(100)
    setContacts((data ?? []) as Contact[])
  }, [])

  const loadThread = useCallback(async (id: string) => {
    const { data } = await createBrowserDb()
      .from("instagram_messages")
      .select("*")
      .eq("contact_id", id)
      .order("created_at", { ascending: true })
      .limit(200)
    setMessages((data ?? []) as Message[])
  }, [])

  // Light polling keeps the inbox current without a realtime channel.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadContacts()
    const timer = setInterval(() => void loadContacts(), 5000)
    return () => clearInterval(timer)
  }, [loadContacts])

  useEffect(() => {
    if (!selected) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadThread(selected)
    const timer = setInterval(() => void loadThread(selected), 5000)
    return () => clearInterval(timer)
  }, [selected, loadThread])

  async function send() {
    if (!selected || !draft.trim()) return
    setSending(true)
    const res = await fetch("/api/instagram/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contact_id: selected, text: draft }),
    })
    const body = await res.json().catch(() => ({}))
    setSending(false)
    if (!res.ok) return toast.error(body?.error ?? t("sendFailed"))
    if (body.status === "simulated") toast.info(t("simulatedSend"))
    setDraft("")
    void loadThread(selected)
    void loadContacts()
  }

  const current = contacts.find((c) => c.id === selected)

  return (
    <div className="grid min-h-[480px] gap-3 xl:grid-cols-[260px_1fr]">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {contacts.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ul className="max-h-[560px] divide-y divide-border overflow-y-auto">
            {contacts.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c.id)}
                  className={cn("flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-muted", selected === c.id && "bg-primary/10")}
                >
                  <span className="bg-brand-gradient flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white">
                    {(c.username ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">@{c.username ?? c.igsid.slice(0, 8)}</span>
                      {c.unread_count > 0 && (
                        <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">{c.unread_count}</span>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">{c.last_message_text}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col rounded-xl border border-border bg-card">
        {!current ? (
          <p className="m-auto p-6 text-sm text-muted-foreground">{t("pick")}</p>
        ) : (
          <>
            <div className="border-b border-border px-4 py-3 text-sm font-semibold text-foreground">@{current.username ?? current.igsid}</div>
            <div className="flex max-h-[460px] flex-1 flex-col gap-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", m.direction === "inbound" ? "self-start bg-muted text-foreground" : "self-end bg-primary/15 text-foreground")}>
                  {m.kind !== "dm" && <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">{t(`kinds.${m.kind}`)}</p>}
                  <p className="whitespace-pre-wrap">{m.text || (m.kind === "story_mention" ? t("storyMention") : "")}</p>
                  {m.direction === "outbound" && (
                    <p className={cn("mt-1 text-[10px]", m.status === "failed" ? "text-red-400" : "text-muted-foreground")} title={m.error ?? undefined}>
                      {t(`by.${m.sent_by ?? "agent"}`)} · {t(`statuses.${m.status}`)}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="flex gap-2 border-t border-border p-3">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void send()}
                placeholder={t("placeholder")}
                disabled={!canReply}
              />
              <Button onClick={() => void send()} disabled={!canReply || sending || !draft.trim()}>
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function InstagramAutomations() {
  const t = useTranslations("Instagram.automations")
  const canEdit = useCan("send-messages")
  const [rows, setRows] = useState<InstagramAutomation[]>([])
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([])
  const [dirty, setDirty] = useState<Record<string, boolean>>({})

  const load = useCallback(async () => {
    const db = createBrowserDb()
    const [a, q] = await Promise.all([
      db.from("instagram_automations").select("*").order("priority"),
      db.from("quick_replies").select("id, title").eq("kind", "text").order("title"),
    ])
    setRows((a.data ?? []) as InstagramAutomation[])
    setQuickReplies((q.data ?? []) as QuickReply[])
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])

  function patch(id: string, cfg: Partial<InstagramAutomationConfig>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, config: { ...r.config, ...cfg } } : r)))
    setDirty((d) => ({ ...d, [id]: true }))
  }

  async function save(row: InstagramAutomation, extra: Partial<InstagramAutomation> = {}) {
    const { error } = await createBrowserDb()
      .from("instagram_automations")
      .update({ config: row.config, is_active: extra.is_active ?? row.is_active })
      .eq("id", row.id)
    if (error) return toast.error(t("saveFailed"))
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...extra } : r)))
    setDirty((d) => ({ ...d, [row.id]: false }))
    toast.success(t("saved"))
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("intro")}</p>
      <div className="grid gap-3 xl:grid-cols-2">
        {rows.map((row) => (
          <div key={row.id} className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{t(`kinds.${row.kind}.title`)}</p>
                <p className="text-xs text-muted-foreground">{t(`kinds.${row.kind}.desc`)}</p>
              </div>
              <Switch checked={row.is_active} disabled={!canEdit} onCheckedChange={(v) => void save(row, { is_active: v })} />
            </div>

            {(row.kind === "keyword" || row.kind === "comment_to_dm") && (
              <label className="block space-y-1 text-xs text-muted-foreground">
                {row.kind === "comment_to_dm" ? t("fields.commentKeywords") : t("fields.keywords")}
                <Input
                  value={(row.config.keywords ?? []).join(", ")}
                  onChange={(e) => patch(row.id, { keywords: e.target.value.split(",").map((k) => k.trim()).filter(Boolean) })}
                  disabled={!canEdit}
                />
              </label>
            )}
            {row.kind === "comment_to_dm" && (
              <label className="block space-y-1 text-xs text-muted-foreground">
                {t("fields.mediaId")}
                <Input value={row.config.media_id ?? ""} onChange={(e) => patch(row.id, { media_id: e.target.value.trim() || null })} placeholder={t("fields.anyPost")} disabled={!canEdit} />
              </label>
            )}
            {row.kind === "away" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("fields.from")}
                  <Input type="time" value={row.config.start_time ?? "21:00"} onChange={(e) => patch(row.id, { start_time: e.target.value })} disabled={!canEdit} />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  {t("fields.to")}
                  <Input type="time" value={row.config.end_time ?? "09:00"} onChange={(e) => patch(row.id, { end_time: e.target.value })} disabled={!canEdit} />
                </label>
              </div>
            )}

            <label className="block space-y-1 text-xs text-muted-foreground">
              {t("fields.replyFrom")}
              <select
                value={row.config.quick_reply_id ?? ""}
                onChange={(e) => patch(row.id, { quick_reply_id: e.target.value || null })}
                className={SELECT_CLASS}
                disabled={!canEdit}
              >
                <option value="">{t("fields.customText")}</option>
                {quickReplies.map((q) => (
                  <option key={q.id} value={q.id}>
                    {t("fields.quickReply", { title: q.title })}
                  </option>
                ))}
              </select>
            </label>
            {!row.config.quick_reply_id && (
              <Textarea rows={3} value={row.config.reply_text ?? ""} onChange={(e) => patch(row.id, { reply_text: e.target.value })} disabled={!canEdit} />
            )}
            {row.kind === "comment_to_dm" && (
              <label className="block space-y-1 text-xs text-muted-foreground">
                {t("fields.publicReply")}
                <Input value={row.config.public_reply ?? ""} onChange={(e) => patch(row.id, { public_reply: e.target.value })} disabled={!canEdit} />
              </label>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-muted-foreground">{t("sent", { count: row.sent_count })}</span>
              <Button size="sm" variant="outline" disabled={!canEdit || !dirty[row.id]} onClick={() => void save(row)}>
                {t("save")}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{t.raw("placeholderHint") as string}</p>
    </div>
  )
}

function InstagramConnect({ settings, onChange }: { settings: Settings; onChange: (s: Settings) => void }) {
  const t = useTranslations("Instagram.connect")
  const canAdmin = useCan("edit-settings")
  const canTest = useCan("send-messages")
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [secret, setSecret] = useState("")
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [sim, setSim] = useState({ kind: "dm", text: "Hi! What is the price?", username: "test_customer" })
  const [simResult, setSimResult] = useState<string | null>(null)
  const origin = useMemo(() => (typeof window === "undefined" ? "" : window.location.origin), [])
  const webhookUrl = `${origin}/api/instagram/webhook`
  // Meta only calls public HTTPS URLs, so a local address can never receive events.
  const isLocal = /^https?:\/\/(localhost|127\.|\[::1\])/.test(origin) || origin.startsWith("http:")

  async function put(body: Record<string, unknown>) {
    const res = await fetch("/api/instagram/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(json?.error ?? t("saveFailed"))
      return null
    }
    onChange(json as Settings)
    return json as Settings
  }

  async function save(body: Record<string, unknown>) {
    setBusy(true)
    const saved = await put(body)
    setBusy(false)
    if (!saved) return
    setToken("")
    setSecret("")
    toast.success(t("saved"))
  }

  async function verify() {
    setVerifying(true)
    const saved = await put({ verify: true })
    setVerifying(false)
    if (saved) toast[saved.webhook_subscribed_at ? "success" : "error"](saved.webhook_subscribed_at ? t("verifyOk") : t("verifyFailed"))
  }

  async function simulate() {
    setBusy(true)
    const res = await fetch("/api/instagram/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sim) })
    const json = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) return toast.error(json?.error ?? t("simFailed"))
    setSimResult(json.reply ? t("simReplied", { by: json.reply.by }) : t("simNoReply"))
  }

  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v)
    toast.success(t("copied"))
  }

  const tokenOk = settings.connected && settings.token_health === "ok"
  const subscribed = Boolean(settings.webhook_subscribed_at)

  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Alert className="border-border bg-card">
          <div className="flex items-center gap-2">
            {tokenOk ? <CheckCircle2 className="size-4 text-primary" /> : <XCircle className="size-4 text-red-500" />}
            <AlertTitle className="mb-0 text-foreground">
              {tokenOk ? t("credentialsValid", { username: settings.username ?? "" }) : settings.connected ? t("needsReconnecting") : t("notConnected")}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {tokenOk ? t("credentialsValidDesc") : settings.connected ? t(settings.token_health === "unreachable" ? "unreachableDesc" : "invalidDesc") : t("notConnectedDesc")}
          </AlertDescription>
        </Alert>

        {settings.connected && (
          <Alert className={subscribed ? "border-emerald-700/50 bg-emerald-950/30" : "border-amber-700/50 bg-amber-950/30"}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {subscribed ? <CheckCircle2 className="size-4 text-emerald-400" /> : <AlertTriangle className="size-4 text-amber-400" />}
                <AlertTitle className={cn("mb-0", subscribed ? "text-emerald-200" : "text-amber-200")}>{subscribed ? t("subscribed") : t("notSubscribed")}</AlertTitle>
              </div>
              <Button variant="outline" size="sm" disabled={!canAdmin || verifying} onClick={() => void verify()} className="h-7 border-border bg-transparent text-foreground hover:bg-muted">
                {verifying ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                {t("verify")}
              </Button>
            </div>
            <AlertDescription className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {subscribed ? (
                <>
                  {t("subscribedSince", { date: new Date(settings.webhook_subscribed_at as string).toLocaleString() })}{" "}
                  {settings.last_event_at ? t("lastEvent", { date: new Date(settings.last_event_at).toLocaleString() }) : t("noEventYet")}
                </>
              ) : (
                <>
                  {t("notSubscribedDesc")}
                  {settings.webhook_error && <span className="mt-1 block break-all text-red-300">{settings.webhook_error}</span>}
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t("title")}</CardTitle>
            <CardDescription className="text-muted-foreground">{t("credentialsDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("token")}</Label>
              <div className="relative">
                <Input
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={settings.connected ? t("tokenSaved") : "IGAA…"}
                  disabled={!canAdmin}
                  className="border-border bg-muted pr-10 text-foreground placeholder:text-muted-foreground"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  aria-label={t("toggleToken")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{t("tokenHint")}</p>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t("appSecret")}</Label>
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={settings.has_app_secret ? t("secretSaved") : t("secretOptional")}
                disabled={!canAdmin}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!canAdmin || busy || (!token.trim() && !secret.trim())} onClick={() => void save({ access_token: token || undefined, app_secret: secret || undefined })}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("connect")}
              </Button>
              {settings.connected && (
                <Button
                  variant="outline"
                  disabled={!canAdmin || busy}
                  onClick={() => {
                    if (window.confirm(t("disconnectConfirm"))) void save({ disconnect: true })
                  }}
                >
                  {t("disconnect")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {canAdmin && settings.verify_token && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t("webhookTitle")}</CardTitle>
              <CardDescription className="text-muted-foreground">{t("webhookDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isLocal && <p className="rounded-md border border-amber-700/50 bg-amber-950/30 p-2 text-xs text-amber-200">{t("localWarning")}</p>}
              {[
                { label: t("webhookUrl"), value: webhookUrl },
                { label: t("verifyToken"), value: settings.verify_token },
                { label: t("fields"), value: "messages, comments" },
              ].map((f) => (
                <div key={f.label} className="space-y-2">
                  <Label className="text-muted-foreground">{f.label}</Label>
                  <div className="flex gap-2">
                    <Input readOnly value={f.value} className="border-border bg-muted font-mono text-xs text-foreground" />
                    <Button size="icon" variant="outline" onClick={() => copy(f.value)} aria-label={t("copy")}>
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Bot className="size-4 text-primary" />
              {t("ai")}
            </p>
            <p className="text-xs text-muted-foreground">{t("aiDesc")}</p>
          </div>
          <Switch checked={settings.ai_auto_reply} disabled={!canAdmin || busy} onCheckedChange={(v) => void save({ ai_auto_reply: v })} />
        </div>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t("setupTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted-foreground">
              {(["s1", "s2", "s3", "s4", "s5"] as const).map((k) => (
                <li key={k}>{t(`steps.${k}`)}</li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <FlaskConical className="size-4 text-primary" />
            {t("simTitle")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("simDesc")}</p>
          <select value={sim.kind} onChange={(e) => setSim({ ...sim, kind: e.target.value })} className={SELECT_CLASS}>
            {(["dm", "comment", "story_mention", "story_reply"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`simKinds.${k}`)}
              </option>
            ))}
          </select>
          <Input value={sim.username} onChange={(e) => setSim({ ...sim, username: e.target.value })} placeholder="@username" />
          <Textarea rows={3} value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} />
          <Button onClick={() => void simulate()} disabled={!canTest || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("simSend")}
          </Button>
          {simResult && <p className="rounded-md bg-muted p-2 text-xs text-foreground">{simResult}</p>}
        </div>
      </div>
    </div>
  )
}
