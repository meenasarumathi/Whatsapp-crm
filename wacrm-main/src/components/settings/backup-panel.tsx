'use client';

// ============================================================
// Settings → Backup
//
// One click backs up the database and downloads it:
//   - "Backup & download" — a JSON file with every table's rows
//     (the complete, restorable copy).
//   - "Download as Excel" — the same backup as a workbook, one sheet
//     per table, for reading or sharing.
// Owners / Admins back up their own account; the Super admin can also
// back up the whole database (every account). Built by GET /api/backup.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FileJson,
  FileSpreadsheet,
  Loader2,
  ShieldCheck,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SettingsPanelHead } from './settings-panel-head';
import { useAuth } from '@/hooks/use-auth';
import { usePlatform } from '@/hooks/use-platform';
import { canEditSettings } from '@/lib/auth/roles';
import { downloadWorkbook, saveBlob } from '@/lib/excel-client';
import type { BackupFile, BackupScope } from '@/lib/backup/tables';

const LAST_BACKUP_KEY = 'wacrm.lastBackup';
/** Excel caps a cell at 32,767 characters. */
const MAX_CELL = 32_000;

type Busy = `${BackupScope}:${'json' | 'xlsx'}` | null;

interface Summary {
  scope: BackupScope;
  file: string;
  rows: number;
  tables: number;
  skipped: string[];
  truncated: string[];
  at: string;
}

function cell(value: unknown): string | number {
  if (value == null) return '';
  if (typeof value === 'number') return value;
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}

export function BackupPanel() {
  const t = useTranslations('Settings.backup');
  const { accountRole } = useAuth();
  const { role: platformRole } = usePlatform();
  const canBackup = accountRole ? canEditSettings(accountRole) : false;
  const isSuperAdmin = platformRole === 'super_admin';
  const [busy, setBusy] = useState<Busy>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [lastBackup, setLastBackup] = useState<string | null>(null);

  useEffect(() => {
    try {
      setLastBackup(window.localStorage.getItem(LAST_BACKUP_KEY));
    } catch {
      // Storage blocked — the "last backup" hint is optional.
    }
  }, []);

  const run = async (scope: BackupScope, format: 'json' | 'xlsx') => {
    setBusy(`${scope}:${format}`);
    try {
      const res = await fetch(`/api/backup?scope=${scope}`, { cache: 'no-store' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? t('failed'));
      }
      const blob = await res.blob();
      const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
      const jsonName = match?.[1] ?? `wacrm-backup-${scope}.json`;
      const backup = JSON.parse(await blob.text()) as BackupFile;

      let file = jsonName;
      if (format === 'json') {
        saveBlob(blob, jsonName);
      } else {
        file = jsonName.replace(/\.json$/, '.xlsx');
        const sheets = Object.entries(backup.tables)
          .filter(([, rows]) => rows.length > 0)
          .map(([name, rows]) => {
            const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
            return {
              name,
              columns: keys.map((k) => ({ header: k, key: k, width: 18 })),
              rows: rows.map((r) => Object.fromEntries(keys.map((k) => [k, cell(r[k])]))),
            };
          });
        sheets.unshift({
          name: 'About this backup',
          columns: [
            { header: 'Field', key: 'field', width: 22 },
            { header: 'Value', key: 'value', width: 80 },
          ],
          rows: [
            { field: 'Created', value: new Date(backup.created_at).toLocaleString() },
            { field: 'Scope', value: backup.scope },
            { field: 'Account', value: backup.account?.name ?? 'All accounts' },
            ...Object.entries(backup.counts).map(([k, v]) => ({ field: k, value: `${v} rows` })),
            ...backup.notes.map((n) => ({ field: 'Note', value: n })),
          ],
        });
        await downloadWorkbook(file, sheets);
      }

      const rows = Object.values(backup.counts).reduce((a, b) => a + b, 0);
      const at = new Date().toISOString();
      setSummary({
        scope,
        file,
        rows,
        tables: Object.keys(backup.counts).length,
        skipped: Object.keys(backup.skipped),
        truncated: backup.truncated,
        at,
      });
      setLastBackup(at);
      try {
        window.localStorage.setItem(LAST_BACKUP_KEY, at);
      } catch {
        // ignore
      }
      toast.success(t('done', { rows }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setBusy(null);
    }
  };

  if (!canBackup) {
    return (
      <section>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="text-sm text-muted-foreground">{t('adminsOnly')}</p>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200 space-y-4">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <BackupCard
        icon={<DatabaseBackup className="size-5" />}
        title={t('accountTitle')}
        body={t('accountBody')}
        busy={busy}
        scope="account"
        onRun={run}
        jsonLabel={t('backupButton')}
        xlsxLabel={t('excelButton')}
      />

      {isSuperAdmin && (
        <BackupCard
          icon={<ShieldCheck className="size-5" />}
          title={t('fullTitle')}
          body={t('fullBody')}
          busy={busy}
          scope="full"
          onRun={run}
          jsonLabel={t('fullButton')}
          xlsxLabel={t('excelButton')}
        />
      )}

      {busy && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('working')}
        </p>
      )}

      {summary && !busy && (
        <div className="rounded-xl border border-emerald-600/40 bg-emerald-500/10 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-emerald-300">
            <CheckCircle2 className="size-4" />
            {t('summaryTitle', { file: summary.file })}
          </p>
          <p className="mt-1 text-emerald-200/80">
            {t('summaryBody', { rows: summary.rows, tables: summary.tables })}
          </p>
          {summary.skipped.length > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t('skipped', { tables: summary.skipped.join(', ') })}
            </p>
          )}
          {summary.truncated.length > 0 && (
            <p className="mt-1 text-xs text-amber-300">
              {t('truncated', { tables: summary.truncated.join(', ') })}
            </p>
          )}
        </div>
      )}

      {lastBackup && (
        <p className="text-xs text-muted-foreground">
          {t('lastBackup', { date: new Date(lastBackup).toLocaleString() })}
        </p>
      )}

      <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{t('includedTitle')}</p>
        <p className="mt-1">{t('included')}</p>
        <p className="mt-3 font-medium text-foreground">{t('notIncludedTitle')}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          <li>{t('notSecrets')}</li>
          <li>{t('notMedia')}</li>
          <li>{t('notEmbeddings')}</li>
        </ul>
        <p className="mt-3">{t('keepSafe')}</p>
      </div>
    </section>
  );
}

function BackupCard({
  icon,
  title,
  body,
  busy,
  scope,
  onRun,
  jsonLabel,
  xlsxLabel,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  busy: Busy;
  scope: BackupScope;
  onRun: (scope: BackupScope, format: 'json' | 'xlsx') => void;
  jsonLabel: string;
  xlsxLabel: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button disabled={busy !== null} onClick={() => onRun(scope, 'json')}>
              {busy === `${scope}:json` ? <Loader2 className="size-4 animate-spin" /> : <FileJson className="size-4" />}
              {jsonLabel}
            </Button>
            <Button variant="outline" disabled={busy !== null} onClick={() => onRun(scope, 'xlsx')}>
              {busy === `${scope}:xlsx` ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
              {xlsxLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
