"use client";

/**
 * Support — complaints / tickets.
 *
 *   Users:            raise a ticket, follow its status, reply, close it,
 *                     or reopen it if the fix didn't work.
 *   Platform admins:  a queue of every ticket (filter by status), reply,
 *                     mark In progress / Resolved (with a note) / Closed.
 *
 * The raiser gets an in-app notification for every admin reply and
 * status change. Rules are enforced by /api/support; the UI mirrors them.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  LifeBuoy,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  SUBJECT_MAX,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  isSupportAdmin,
  type TicketStatus,
} from "@/lib/support/policy";
import { usePlatform } from "@/hooks/use-platform";

interface Ticket {
  id: string;
  ticket_number: number;
  subject: string;
  category: string;
  priority: string;
  status: TicketStatus;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  raised_by: string | null;
  account_name?: string | null;
  raised_by_name?: string | null;
  raised_by_email?: string | null;
  resolved_by_name?: string | null;
}

interface Message {
  id: string;
  author_user_id: string | null;
  author_name: string | null;
  from_admin: boolean;
  kind: "message" | "event";
  body: string;
  created_at: string;
}

interface ListResponse {
  is_admin: boolean;
  counts: Record<string, number>;
  tickets: Ticket[];
}

interface DetailResponse {
  is_admin: boolean;
  me: string;
  ticket: Ticket;
  messages: Message[];
}

const STATUS_STYLE: Record<TicketStatus, string> = {
  open: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300",
  in_progress: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  resolved: "border-emerald-600/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  closed: "border-border bg-muted text-muted-foreground",
};

const PRIORITY_STYLE: Record<string, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: "text-amber-600 dark:text-amber-300",
  urgent: "text-red-600 dark:text-red-400 font-semibold",
};

const FILTERS = ["active", "open", "in_progress", "resolved", "closed", "all"] as const;

const selectClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";

function StatusChip({ status }: { status: TicketStatus }) {
  const t = useTranslations("Support");
  return (
    <span className={cn("whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[status])}>
      {t(`status.${status}`)}
    </span>
  );
}

export function SupportCenter() {
  const t = useTranslations("Support");
  const router = useRouter();
  const params = useSearchParams();
  const selected = params.get("t");
  const { role } = usePlatform();
  const admin = isSupportAdmin(role);

  const [filter, setFilter] = useState<(typeof FILTERS)[number]>(admin ? "active" : "all");
  const [list, setList] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notMigrated, setNotMigrated] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/support?status=${filter}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (res.status === 503) {
        setNotMigrated(true);
        return;
      }
      if (!res.ok) throw new Error(json?.error ?? t("loadFailed"));
      setList(json as ListResponse);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = (id: string | null) => router.push(id ? `/support?t=${id}` : "/support");

  if (notMigrated) {
    return (
      <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>{t("notMigrated")}</p>
      </div>
    );
  }

  if (selected) {
    return <TicketDetail id={selected} onBack={() => { open(null); void load(); }} />;
  }

  const isAdminView = list?.is_admin ?? admin;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <LifeBuoy className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              {isAdminView ? t("adminTitle") : t("title")}
            </h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {isAdminView ? t("adminDescription") : t("description")}
          </p>
        </div>
        {!isAdminView && !showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="h-4 w-4" />
            {t("raise")}
          </Button>
        )}
      </div>

      {!isAdminView && showForm && (
        <NewTicketForm
          onCancel={() => setShowForm(false)}
          onCreated={(id) => {
            setShowForm(false);
            open(id);
          }}
        />
      )}

      {isAdminView && list && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["open", "in_progress", "resolved", "closed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={cn(
                "rounded-xl border p-3 text-left transition-colors hover:bg-muted/60",
                filter === s ? "border-primary/50 bg-primary/5" : "border-border bg-card",
              )}
            >
              <p className="text-[11px] text-muted-foreground">{t(`status.${s}`)}</p>
              <p className="mt-0.5 text-2xl font-semibold tabular-nums">{list.counts[s] ?? 0}</p>
            </button>
          ))}
        </div>
      )}

      <section className="rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap gap-1 border-b border-border p-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium",
                filter === f ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f === "active" ? t("filterActive") : f === "all" ? t("filterAll") : t(`status.${f}`)}
              {list?.counts[f] !== undefined && <span className="ml-1 tabular-nums opacity-70">{list.counts[f]}</span>}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="p-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !list || list.tickets.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">{isAdminView ? t("emptyAdmin") : t("empty")}</p>
        ) : (
          <ul className="divide-y divide-border">
            {list.tickets.map((tk) => (
              <li key={tk.id}>
                <button
                  type="button"
                  onClick={() => open(tk.id)}
                  className="flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-4"
                >
                  <span className="w-16 shrink-0 font-mono text-xs text-muted-foreground">#{tk.ticket_number}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{tk.subject}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {t(`category.${tk.category}`)}
                      {isAdminView && (tk.account_name || tk.raised_by_email) && (
                        <> · {tk.account_name ?? ""}{tk.raised_by_email ? ` (${tk.raised_by_email})` : ""}</>
                      )}
                    </span>
                  </span>
                  <span className={cn("w-16 shrink-0 text-xs", PRIORITY_STYLE[tk.priority])}>{t(`priority.${tk.priority}`)}</span>
                  <span className="w-28 shrink-0"><StatusChip status={tk.status} /></span>
                  <span className="w-36 shrink-0 text-xs text-muted-foreground">{new Date(tk.updated_at).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NewTicketForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const t = useTranslations("Support");
  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState<string>("bug");
  const [priority, setPriority] = useState<string>("normal");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, category, priority, description }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("submitFailed"));
      toast.success(t("submitted", { number: json.ticket.ticket_number }));
      onCreated(json.ticket.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("submitFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="text-base font-semibold text-foreground">{t("formTitle")}</h2>
      <div className="mt-4 grid gap-3">
        <div className="grid gap-1.5">
          <Label>{t("subject")}</Label>
          <Input value={subject} maxLength={SUBJECT_MAX} onChange={(e) => setSubject(e.target.value)} placeholder={t("subjectPlaceholder")} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>{t("categoryLabel")}</Label>
            <select className={selectClass} value={category} onChange={(e) => setCategory(e.target.value)}>
              {TICKET_CATEGORIES.map((c) => (
                <option key={c} value={c}>{t(`category.${c}`)}</option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("priorityLabel")}</Label>
            <select className={selectClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>{t(`priority.${p}`)}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-1.5">
          <Label>{t("descriptionLabel")}</Label>
          <Textarea rows={6} value={description} maxLength={5000} onChange={(e) => setDescription(e.target.value)} placeholder={t("descriptionPlaceholder")} />
        </div>
        <div className="flex gap-2">
          <Button disabled={saving || subject.trim().length < 3 || !description.trim()} onClick={() => void submit()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {t("submit")}
          </Button>
          <Button variant="outline" onClick={onCancel}>{t("cancel")}</Button>
        </div>
      </div>
    </section>
  );
}

function TicketDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useTranslations("Support");
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/support/${id}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("loadFailed"));
      setData(json as DetailResponse);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("loadFailed"));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (payload: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/support/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t("actionFailed"));
      setData(json as DetailResponse);
      toast.success(success);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("actionFailed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />;
  if (!data) {
    return (
      <Button variant="outline" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        {t("back")}
      </Button>
    );
  }

  const tk = data.ticket;
  const staff = data.is_admin && tk.raised_by !== data.me;
  const isRaiser = tk.raised_by === data.me;

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" />
        {t("back")}
      </Button>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-muted-foreground">#{tk.ticket_number}</p>
            <h1 className="mt-0.5 text-xl font-semibold text-foreground">{tk.subject}</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(`category.${tk.category}`)} · <span className={PRIORITY_STYLE[tk.priority]}>{t(`priority.${tk.priority}`)}</span> ·{" "}
              {t("raisedOn", { date: new Date(tk.created_at).toLocaleString() })}
              {staff && (
                <> · {tk.raised_by_name || tk.raised_by_email}{tk.account_name ? ` — ${tk.account_name}` : ""}</>
              )}
            </p>
          </div>
          <StatusChip status={tk.status} />
        </div>

        {tk.status === "resolved" && tk.resolution_note && (
          <div className="mt-4 rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              {t("resolvedBanner", { date: tk.resolved_at ? new Date(tk.resolved_at).toLocaleString() : "" })}
            </p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{tk.resolution_note}</p>
            {isRaiser && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" disabled={busy} onClick={() => void act({ action: "status", status: "closed" }, t("closedToast"))}>
                  <CheckCircle2 className="h-4 w-4" />
                  {t("confirmFixed")}
                </Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "status", status: "open" }, t("reopenedToast"))}>
                  <RotateCcw className="h-4 w-4" />
                  {t("notFixed")}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-base font-semibold text-foreground">{t("conversation")}</h2>
        <ol className="mt-4 space-y-3">
          {data.messages.map((m) =>
            m.kind === "event" ? (
              <li key={m.id} className="text-center text-xs text-muted-foreground">
                {m.body} · {new Date(m.created_at).toLocaleString()}
              </li>
            ) : (
              <li
                key={m.id}
                className={cn(
                  "max-w-[85%] rounded-xl border p-3",
                  m.from_admin ? "mr-auto border-primary/30 bg-primary/5" : "ml-auto border-border bg-muted/40",
                )}
              >
                <p className="text-xs font-medium text-muted-foreground">
                  {m.from_admin ? m.author_name || t("supportTeam") : m.author_name || t("you")} ·{" "}
                  {new Date(m.created_at).toLocaleString()}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{m.body}</p>
              </li>
            ),
          )}
        </ol>

        {tk.status !== "closed" ? (
          <div className="mt-4 grid gap-2">
            <Textarea rows={3} value={reply} maxLength={5000} onChange={(e) => setReply(e.target.value)} placeholder={staff ? t("replyPlaceholderAdmin") : t("replyPlaceholder")} />
            <div>
              <Button
                disabled={busy || !reply.trim()}
                onClick={async () => {
                  if (await act({ action: "reply", body: reply }, t("replySent"))) setReply("");
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t("sendReply")}
              </Button>
            </div>
            {isRaiser && tk.status === "resolved" && <p className="text-xs text-muted-foreground">{t("replyReopens")}</p>}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">{t("closedNote")}</p>
        )}
      </section>

      {staff && (
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-base font-semibold text-foreground">{t("adminActions")}</h2>
          <div className="mt-3 grid gap-2">
            <Label>{t("resolutionNote")}</Label>
            <Textarea rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={t("resolutionPlaceholder")} />
            <div className="flex flex-wrap gap-2">
              {tk.status !== "in_progress" && tk.status !== "closed" && (
                <Button variant="outline" disabled={busy} onClick={() => void act({ action: "status", status: "in_progress", note }, t("statusSaved"))}>
                  {t("markInProgress")}
                </Button>
              )}
              {tk.status !== "resolved" && tk.status !== "closed" && (
                <Button
                  disabled={busy || !note.trim()}
                  onClick={async () => {
                    if (await act({ action: "status", status: "resolved", note }, t("resolvedToast"))) setNote("");
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {t("markResolved")}
                </Button>
              )}
              {tk.status !== "closed" ? (
                <Button variant="outline" disabled={busy} onClick={() => void act({ action: "status", status: "closed", note }, t("closedToast"))}>
                  <XCircle className="h-4 w-4" />
                  {t("close")}
                </Button>
              ) : (
                <Button variant="outline" disabled={busy} onClick={() => void act({ action: "status", status: "open", note }, t("reopenedToast"))}>
                  <RotateCcw className="h-4 w-4" />
                  {t("reopen")}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("notifyHint")}</p>
          </div>
        </section>
      )}

      {isRaiser && !staff && (tk.status === "open" || tk.status === "in_progress") && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void act({ action: "status", status: "closed" }, t("closedToast"))}>
          <XCircle className="h-4 w-4" />
          {t("closeMine")}
        </Button>
      )}
    </div>
  );
}
