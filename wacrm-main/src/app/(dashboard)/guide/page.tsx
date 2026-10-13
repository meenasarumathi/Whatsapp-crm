import Link from "next/link";
import { getTranslations } from "next-intl/server";
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Bot,
  BookOpen,
  Coins,
  FileText,
  GitBranch,
  GraduationCap,
  HelpCircle,
  LayoutDashboard,
  MessageSquare,
  Presentation,
  Radio,
  Rocket,
  Route,
  Settings,
  Sparkles,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { loadGuide, type GuideDoc } from "@/lib/guide/load";
import { parseMarkdown } from "@/lib/guide/markdown";
import { GuideMarkdown } from "@/components/guide/guide-markdown";

// Chapter icons mirror the sidebar so users can match a chapter to its
// tab at a glance. Keyed on the part of the filename after `NN-`;
// unknown chapters fall back to a generic page icon.
const CHAPTER_ICONS: Record<string, LucideIcon> = {
  "getting-started": Rocket,
  dashboard: LayoutDashboard,
  inbox: MessageSquare,
  notifications: Bell,
  contacts: Users,
  pipelines: GitBranch,
  broadcasts: Radio,
  automations: Zap,
  flows: Workflow,
  "ai-agents": Bot,
  settings: Settings,
  workflows: Route,
  "faq-troubleshooting": HelpCircle,
  "train-ai": GraduationCap,
  demo: Presentation,
  "token-wallet": Coins,
};

function chapterIcon(slug: string): LucideIcon {
  return CHAPTER_ICONS[slug.replace(/^\d+-/, "")] ?? FileText;
}

function RailLink({
  doc,
  active,
  icon: Icon,
  hint,
}: {
  doc: GuideDoc;
  active: boolean;
  icon: LucideIcon;
  hint?: string;
}) {
  return (
    <Link
      href={`/guide?topic=${encodeURIComponent(doc.slug)}`}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors lg:w-full lg:whitespace-normal",
        active
          ? "bg-primary-soft text-primary"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1">{doc.title}</span>
      {hint ? (
        <span className="hidden text-xs text-muted-foreground lg:inline">
          {hint}
        </span>
      ) : null}
    </Link>
  );
}

export default async function GuidePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const t = await getTranslations("Guide");
  const { topic } = await searchParams;
  const { chapters, updates } = await loadGuide();

  // Reading order for prev/next: chapters first, then the change log.
  const all = [...chapters, ...updates];
  const current =
    all.find((d) => d.slug === topic) ?? chapters[0] ?? updates[0];

  if (!current) {
    return (
      <div className="flex flex-col items-center gap-2 py-24 text-center">
        <BookOpen className="size-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      </div>
    );
  }

  const blocks = parseMarkdown(current.body);
  const sections = blocks.filter(
    (b): b is Extract<typeof b, { type: "heading" }> =>
      b.type === "heading" && b.level === 2,
  );
  const index = all.indexOf(current);
  const prev = all[index - 1];
  const next = all[index + 1];
  const isUpdate = updates.includes(current);

  return (
    <div>
      <div className="flex items-center gap-2">
        <BookOpen className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t("title")}
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <nav
          aria-label={t("chapters")}
          className="flex gap-1 overflow-x-auto border-b border-border pb-2 [scrollbar-width:none] lg:sticky lg:top-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:pb-0 [&::-webkit-scrollbar]:hidden"
        >
          <div className="hidden px-3 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block">
            {t("chapters")}
          </div>
          {chapters.map((doc) => (
            <RailLink
              key={doc.slug}
              doc={doc}
              active={doc === current}
              icon={chapterIcon(doc.slug)}
            />
          ))}
          {updates.length > 0 ? (
            <>
              <div className="hidden px-3 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.09em] text-muted-foreground uppercase lg:block">
                {t("whatsNew")}
              </div>
              {updates.map((doc) => (
                <RailLink
                  key={doc.slug}
                  doc={doc}
                  active={doc === current}
                  icon={Sparkles}
                  hint={doc.date}
                />
              ))}
            </>
          ) : null}
        </nav>

        <article className="min-w-0 rounded-xl border border-border bg-card p-5 sm:p-7">
          <header className="mb-6">
            {isUpdate && current.date ? (
              <p className="mb-1 text-xs font-semibold tracking-wider text-primary uppercase">
                {t("whatsNew")} · {current.date}
              </p>
            ) : null}
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {current.title}
            </h2>
            {sections.length > 1 ? (
              <div className="mt-4 rounded-lg bg-muted/40 p-3">
                <p className="mb-1.5 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  {t("inThisChapter")}
                </p>
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {sections.map((s) => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        {s.text.replace(/\*\*|`/g, "")}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </header>

          <GuideMarkdown blocks={blocks} />

          {prev || next ? (
            <footer className="mt-8 flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
              {prev ? (
                <Link
                  href={`/guide?topic=${encodeURIComponent(prev.slug)}`}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="size-4" />
                  <span>
                    <span className="block text-xs">{t("previous")}</span>
                    <span className="font-medium text-foreground">
                      {prev.title}
                    </span>
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {next ? (
                <Link
                  href={`/guide?topic=${encodeURIComponent(next.slug)}`}
                  className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground sm:text-right"
                >
                  <span>
                    <span className="block text-xs">{t("next")}</span>
                    <span className="font-medium text-foreground">
                      {next.title}
                    </span>
                  </span>
                  <ArrowRight className="size-4" />
                </Link>
              ) : null}
            </footer>
          ) : null}
        </article>
      </div>
    </div>
  );
}
