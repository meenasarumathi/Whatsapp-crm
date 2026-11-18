'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { createBrowserDb } from "@/lib/db/browser";
import { MessageTemplate } from '@/types';
import { Button, buttonVariants } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight, RefreshCw, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface Step1Props {
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notApproved, setNotApproved] = useState<MessageTemplate[]>([]);
  const [syncing, setSyncing] = useState(false);

  const fetchTemplates = useCallback(async () => {
    try {
      const db = createBrowserDb();
      // Only APPROVED templates can be sent via Meta — anything else
      // would 400 at broadcast time. Hide them rather than letting
      // the user pick a template that will fail; the others are only
      // listed in the empty state so the user knows they are waiting.
      const { data, error: fetchError } = await db
        .from('message_templates')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      const all = (data ?? []) as MessageTemplate[];
      setTemplates(all.filter((tpl) => tpl.status === 'APPROVED'));
      setNotApproved(all.filter((tpl) => tpl.status !== 'APPROVED'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('chooseTemplate.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchTemplates();
  }, [fetchTemplates]);

  // Pulls the templates already approved in WhatsApp Manager, so an
  // account connected with existing templates can broadcast right away.
  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/templates/sync', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? t('chooseTemplate.syncFailed'));
      toast.success(t('chooseTemplate.synced', { count: body?.total ?? 0 }));
      await fetchTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chooseTemplate.syncFailed'));
    } finally {
      setSyncing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('chooseTemplate.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('chooseTemplate.subtitle')}
        </p>
      </div>

      {templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card/50 px-6 py-10 text-center">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('chooseTemplate.noTemplates')}</p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('chooseTemplate.howTo')}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => void handleSync()} disabled={syncing} variant="outline">
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {t('chooseTemplate.sync')}
            </Button>
            <Link href="/settings?tab=templates" className={buttonVariants()}>
              <Plus className="h-4 w-4" />
              {t('chooseTemplate.create')}
            </Link>
          </div>
          {notApproved.length > 0 && (
            <div className="mt-5 w-full max-w-md text-left">
              <p className="text-xs font-medium text-foreground">{t('chooseTemplate.waiting')}</p>
              <ul className="mt-1 space-y-1">
                {notApproved.slice(0, 5).map((tpl) => (
                  <li key={tpl.id} className="flex justify-between text-xs text-muted-foreground">
                    <span className="truncate">{tpl.name}</span>
                    <span>{tpl.status}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {/* Status is omitted on purpose — every template
                      shown here is already filtered to APPROVED,
                      so the chip carried no information. */}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
