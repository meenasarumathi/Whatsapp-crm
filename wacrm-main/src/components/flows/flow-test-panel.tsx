"use client";

/**
 * "Test flow" — a sandbox chat that runs the flow being edited (unsaved
 * changes included) entirely in the browser via `@/lib/flows/simulate`.
 *
 * Nothing goes to WhatsApp: no message is sent through Meta, no
 * conversation is opened, so testing never costs anything on the
 * WhatsApp bill. Tags and variables only change on the fake test
 * contact shown in the panel.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Bot,
  CheckCircle2,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  List,
  RotateCcw,
  Send,
  ShieldCheck,
  Tag as TagIcon,
  Video,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  replyTap,
  replyText,
  startSimulation,
  type SimContact,
  type SimEvent,
  type SimFlow,
  type SimState,
} from "@/lib/flows/simulate";
import { useFlowEditor } from "./flow-editor-state";

interface TagRow {
  id: string;
  name: string;
  color: string;
}

const DEFAULT_CONTACT: SimContact = {
  name: "Test customer",
  email: "",
  phone: "+10000000000",
  company: "",
  tagIds: [],
};

export function FlowTestPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("Flows.test");
  const { flow, state, requestFlash } = useFlowEditor();
  const [tags, setTags] = useState<TagRow[]>([]);
  const [contact, setContact] = useState<SimContact>(DEFAULT_CONTACT);
  const [firstMessage, setFirstMessage] = useState("");
  const [sim, setSim] = useState<SimState | null>(null);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // The flow as currently edited — the test always reflects unsaved work.
  const simFlow: SimFlow = useMemo(
    () => ({
      nodes: state.nodes,
      trigger_type: state.trigger_type,
      trigger_config: state.trigger_config,
      fallback_policy: flow.fallback_policy,
    }),
    [state.nodes, state.trigger_type, state.trigger_config, flow.fallback_policy],
  );

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient()
        .from("tags")
        .select("id, name, color")
        .order("name");
      if (!cancelled && data) setTags(data as TagRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Pre-fill the opening message with the first trigger keyword.
  useEffect(() => {
    if (!open || sim) return;
    const keywords = (state.trigger_config?.keywords as string[] | undefined) ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFirstMessage(state.trigger_type === "keyword" ? (keywords[0] ?? "") : "Hi");
  }, [open, sim, state.trigger_type, state.trigger_config]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [sim?.events.length]);

  const tagName = (id: string) => tags.find((x) => x.id === id)?.name ?? id;

  const start = () => setSim(startSimulation(simFlow, contact, firstMessage));
  const restart = () => {
    setSim(null);
    setDraft("");
  };
  const send = () => {
    if (!sim || !draft.trim()) return;
    setSim(replyText(simFlow, sim, draft));
    setDraft("");
  };

  // Only the newest prompt's buttons are tappable, like a real chat.
  let lastPromptIndex = -1;
  sim?.events.forEach((e, i) => {
    if (e.kind === "bot_buttons" || e.kind === "bot_list") lastPromptIndex = i;
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b border-border p-4">
          <SheetTitle className="flex items-center gap-2 text-popover-foreground">
            <FlaskConical className="h-4 w-4 text-primary" />
            {t("title")}
          </SheetTitle>
          <SheetDescription className="text-muted-foreground">{t("description")}</SheetDescription>
          <div className="mt-2 inline-flex w-fit items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
            <ShieldCheck className="h-3.5 w-3.5" />
            {t("freeBadge")}
          </div>
        </SheetHeader>

        {!sim ? (
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <p className="text-xs text-muted-foreground">{t("setupHint")}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("contactName")}>
                <Input value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
              </Field>
              <Field label={t("contactPhone")}>
                <Input value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} />
              </Field>
              <Field label={t("contactEmail")}>
                <Input value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} />
              </Field>
              <Field label={t("contactCompany")}>
                <Input value={contact.company} onChange={(e) => setContact({ ...contact, company: e.target.value })} />
              </Field>
            </div>
            {tags.length > 0 && (
              <Field label={t("startingTags")}>
                <div className="flex flex-wrap gap-2">
                  {tags.map((tag) => {
                    const on = contact.tagIds.includes(tag.id);
                    return (
                      <label
                        key={tag.id}
                        className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs"
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={(next) =>
                            setContact({
                              ...contact,
                              tagIds: next
                                ? [...contact.tagIds, tag.id]
                                : contact.tagIds.filter((x) => x !== tag.id),
                            })
                          }
                        />
                        <span style={{ color: tag.color }}>{tag.name}</span>
                      </label>
                    );
                  })}
                </div>
              </Field>
            )}
            <Field label={t("firstMessage")}>
              <Input
                value={firstMessage}
                onChange={(e) => setFirstMessage(e.target.value)}
                placeholder={t("firstMessagePlaceholder")}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">{t("firstMessageHint")}</p>
            </Field>
            <Button className="w-full" onClick={start}>
              <FlaskConical className="h-4 w-4" />
              {t("start")}
            </Button>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto bg-card-2 p-4">
              {sim.events.map((event, i) => (
                <EventBubble
                  key={i}
                  event={event}
                  interactive={i === lastPromptIndex && sim.status === "waiting"}
                  onTap={(id, title) => setSim(replyTap(simFlow, sim, id, title))}
                  onJump={requestFlash}
                  tagName={tagName}
                />
              ))}
              {sim.status !== "waiting" && (
                <div className="pt-2 text-center">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {t(`ended.${sim.status}`)}
                  </span>
                </div>
              )}
            </div>

            <div className="border-t border-border p-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
              >
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={sim.status === "waiting" ? t("replyPlaceholder") : t("finished")}
                  disabled={sim.status !== "waiting"}
                />
                <Button type="submit" size="icon" disabled={sim.status !== "waiting" || !draft.trim()} aria-label={t("send")}>
                  <Send className="h-4 w-4" />
                </Button>
              </form>
              <div className="mt-3 flex flex-wrap items-start gap-2 text-[11px] text-muted-foreground">
                <div className="min-w-0 flex-1 space-y-1">
                  <div>
                    <span className="font-medium text-foreground">{t("variables")}:</span>{" "}
                    {Object.keys(sim.vars).length === 0
                      ? t("none")
                      : Object.entries(sim.vars).map(([k, v]) => `${k}=${v}`).join(" · ")}
                  </div>
                  <div>
                    <span className="font-medium text-foreground">{t("tags")}:</span>{" "}
                    {sim.contact.tagIds.length === 0 ? t("none") : sim.contact.tagIds.map(tagName).join(", ")}
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={restart}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {t("restart")}
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function EventBubble({
  event,
  interactive,
  onTap,
  onJump,
  tagName,
}: {
  event: SimEvent;
  interactive: boolean;
  onTap: (replyId: string, title: string) => void;
  onJump: (nodeKey: string) => void;
  tagName: (id: string) => string;
}) {
  const t = useTranslations("Flows.test");

  if (event.kind === "customer_text" || event.kind === "customer_tap") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-foreground">
          {event.kind === "customer_text" ? event.text : `↩ ${event.title}`}
        </div>
      </div>
    );
  }

  if (event.kind === "notice") {
    // Every placeholder a notice can use gets a default, so a notice
    // without (say) a handoff note never renders a raw keypath.
    const params: Record<string, string> = {
      note: "",
      keywords: "",
      ...(event.params ?? {}),
    };
    if (event.code === "handoff" && params.note) params.note = `— ${params.note}`;
    if (params.tag) params.tag = tagName(params.tag);
    if (event.code === "condition" && params.subject === "tag") params.key = tagName(params.key ?? "");
    return (
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => event.node_key && onJump(event.node_key)}
          className={cn(
            "max-w-[90%] rounded-full border px-2.5 py-0.5 text-center text-[11px]",
            event.code === "trigger_not_matched" || event.code === "node_missing" || event.code === "loop_guard"
              ? "border-red-500/40 bg-red-500/10 text-red-300"
              : event.code === "handoff" || event.code === "fallback_handoff" || event.code === "reprompt"
                ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                : "border-border bg-muted text-muted-foreground",
            event.node_key && "cursor-pointer hover:underline",
          )}
          title={event.node_key ? t("showNode") : undefined}
        >
          {event.code === "tag_added" || event.code === "tag_removed" ? (
            <TagIcon className="mr-1 inline h-3 w-3" />
          ) : null}
          {t(`notice.${event.code}`, params)}
        </button>
      </div>
    );
  }

  const botHeader = (
    <div className="mb-1 flex items-center gap-1 text-[10px] text-muted-foreground">
      <Bot className="h-3 w-3" />
      <button type="button" className="hover:underline" onClick={() => onJump(event.node_key)}>
        {event.node_key}
      </button>
    </div>
  );

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2 text-sm text-foreground">
        {botHeader}
        {event.kind === "bot_media" ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {event.media_type === "image" ? (
                <ImageIcon className="h-4 w-4" />
              ) : event.media_type === "video" ? (
                <Video className="h-4 w-4" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {event.filename || event.media_type}
            </div>
            {event.media_type === "image" && event.media_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={event.media_url} alt="" className="max-h-40 rounded-lg" />
            ) : null}
            {event.caption ? <p className="whitespace-pre-wrap">{event.caption}</p> : null}
          </div>
        ) : (
          <>
            {"header" in event && event.header ? (
              <p className="mb-1 font-semibold">{event.header}</p>
            ) : null}
            <p className="whitespace-pre-wrap">{event.text || <span className="text-muted-foreground">{t("emptyText")}</span>}</p>
            {"footer" in event && event.footer ? (
              <p className="mt-1 text-[11px] text-muted-foreground">{event.footer}</p>
            ) : null}
          </>
        )}

        {event.kind === "bot_buttons" && (
          <div className="mt-2 flex flex-col gap-1">
            {event.buttons.map((b) => (
              <button
                key={b.reply_id}
                type="button"
                disabled={!interactive}
                onClick={() => onTap(b.reply_id, b.title)}
                className="rounded-lg border border-primary/40 px-2 py-1 text-xs font-medium text-primary transition-colors enabled:hover:bg-primary/10 disabled:opacity-50"
              >
                {b.title || b.reply_id}
              </button>
            ))}
          </div>
        )}

        {event.kind === "bot_list" && (
          <div className="mt-2 space-y-1.5">
            <div className="flex items-center gap-1 text-xs font-medium text-primary">
              <List className="h-3.5 w-3.5" />
              {event.button_label}
            </div>
            {event.sections.map((section, si) => (
              <div key={si} className="space-y-1">
                {section.title ? (
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {section.title}
                  </p>
                ) : null}
                {section.rows.map((row) => (
                  <button
                    key={row.reply_id}
                    type="button"
                    disabled={!interactive}
                    onClick={() => onTap(row.reply_id, row.title)}
                    className="block w-full rounded-lg border border-border px-2 py-1 text-left text-xs transition-colors enabled:hover:border-primary/50 enabled:hover:bg-primary/5 disabled:opacity-50"
                  >
                    <span className="font-medium">{row.title || row.reply_id}</span>
                    {row.description ? (
                      <span className="block text-[11px] text-muted-foreground">{row.description}</span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
