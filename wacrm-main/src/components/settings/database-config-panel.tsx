'use client';

// ============================================================
// Settings → Backup → Database config  (Super admin only)
//
// Lists every table in the database with its columns, types, keys and
// row counts, and lets the Super admin empty tables:
//   1. tick the tables to empty (tables that depend on them are added
//      automatically — Postgres would refuse otherwise);
//   2. type TRUNCATE to confirm;
//   3. a .sql backup of exactly those tables (secrets included, so a
//      restore is exact) downloads FIRST — if it fails, nothing is
//      truncated;
//   4. only then is the truncate sent. It is recorded in the history.
// accounts, profiles, platform_users and the history itself are locked.
// Data: GET /api/db-config, POST /api/db-config/truncate,
//       GET /api/backup?scope=full&format=sql&tables=…&secrets=1
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Database,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SettingsPanelHead } from './settings-panel-head';
import { saveBlob } from '@/lib/excel-client';
import {
  TRUNCATE_CONFIRM_WORD,
  isProtectedTable,
  planTruncate,
  type DbTable,
} from '@/lib/db-config/tables';

interface LogEntry {
  id: string;
  action: string;
  tables: string[];
  row_counts: Record<string, number>;
  performed_by_email: string | null;
  created_at: string;
}

type Step = 'idle' | 'backup' | 'truncate';

const nf = new Intl.NumberFormat();

export function DatabaseConfigPanel() {
  const t = useTranslations('Settings.dbConfig');
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [step, setStep] = useState<Step>('idle');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/db-config', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? t('loadFailed'));
      setTables(data.tables as DbTable[]);
      setLog((data.log ?? []) as LogEntry[]);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = useMemo(() => {
    const list = tables ?? [];
    return {
      tables: list.length,
      columns: list.reduce((n, x) => n + x.columns.length, 0),
      rows: list.reduce((n, x) => n + x.rows, 0),
    };
  }, [tables]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!tables) return [];
    if (!q) return tables;
    return tables.filter(
      (x) =>
        x.name.toLowerCase().includes(q) ||
        x.columns.some((c) => c.name.toLowerCase().includes(q))
    );
  }, [tables, query]);

  const plan = useMemo(
    () => (tables ? planTruncate([...selected], tables) : null),
    [selected, tables]
  );

  const toggleOpen = (name: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleSelect = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const closeDialog = () => {
    if (step !== 'idle') return;
    setDialog(false);
    setConfirm('');
  };

  const runTruncate = async () => {
    if (!plan || plan.blocked.length > 0 || confirm !== TRUNCATE_CONFIRM_WORD)
      return;

    // Step 1 — the backup. Nothing is truncated unless this succeeds.
    setStep('backup');
    try {
      const qs = new URLSearchParams({
        scope: 'full',
        format: 'sql',
        tables: plan.tables.join(','),
        secrets: '1',
      });
      const res = await fetch(`/api/backup?${qs.toString()}`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? t('backupFailed'));
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error(t('backupFailed'));
      const match = /filename="([^"]+)"/.exec(
        res.headers.get('Content-Disposition') ?? ''
      );
      saveBlob(blob, match?.[1] ?? 'wacrm-backup-before-truncate.sql');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('backupFailed'));
      setStep('idle');
      return;
    }

    // Step 2 — the truncate.
    setStep('truncate');
    try {
      const res = await fetch('/api/db-config/truncate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tables: plan.tables,
          confirm,
          backup_confirmed: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? t('failed'));
      toast.success(
        t('success', {
          tables: (data.truncated as string[]).length,
          rows: nf.format(data.rows_removed ?? 0),
        })
      );
      setDialog(false);
      setConfirm('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setStep('idle');
    }
  };

  if (loading && !tables) {
    return (
      <section className="space-y-4">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </p>
      </section>
    );
  }

  if (error && !tables) {
    return (
      <section className="space-y-4">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="rounded-xl border border-amber-600/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            <RefreshCw className="size-4" /> {t('refresh')}
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {t('refresh')}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          {t('summary', {
            tables: totals.tables,
            columns: nf.format(totals.columns),
            rows: nf.format(totals.rows),
          })}
        </p>
      </div>

      {selected.size > 0 && plan && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-600/40 bg-red-500/10 px-4 py-3 text-sm">
          <span className="font-medium text-red-300">
            {t('selected', { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
            >
              {t('clearSelection')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setDialog(true)}
            >
              <Trash2 className="size-4" /> {t('truncateSelected')}
            </Button>
          </div>
        </div>
      )}

      <div className="border-border bg-card overflow-hidden rounded-xl border">
        <div className="border-border bg-muted/40 text-muted-foreground grid grid-cols-[2rem_1.5rem_1fr_5rem_5rem] items-center gap-2 border-b px-3 py-2 text-xs font-medium sm:grid-cols-[2rem_1.5rem_1fr_6rem_6rem]">
          <span />
          <span />
          <span>{t('colTable')}</span>
          <span className="text-right">{t('colRows')}</span>
          <span className="text-right">{t('colColumns')}</span>
        </div>

        {visible.length === 0 && (
          <p className="text-muted-foreground px-4 py-6 text-center text-sm">
            {t('noMatches')}
          </p>
        )}

        {visible.map((table) => {
          const locked = isProtectedTable(table.name);
          const isOpen = open.has(table.name);
          return (
            <div
              key={table.name}
              className="border-border border-b last:border-b-0"
            >
              <div className="grid grid-cols-[2rem_1.5rem_1fr_5rem_5rem] items-center gap-2 px-3 py-2 text-sm sm:grid-cols-[2rem_1.5rem_1fr_6rem_6rem]">
                {locked ? (
                  <span
                    title={t('lockedHint')}
                    className="text-muted-foreground flex justify-center"
                  >
                    <Lock className="size-4" />
                  </span>
                ) : (
                  <Checkbox
                    checked={selected.has(table.name)}
                    onCheckedChange={() => toggleSelect(table.name)}
                    aria-label={table.name}
                  />
                )}
                <button
                  type="button"
                  onClick={() => toggleOpen(table.name)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={table.name}
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => toggleOpen(table.name)}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <Database className="text-muted-foreground size-4 shrink-0" />
                  <span className="text-foreground truncate font-mono text-[13px]">
                    {table.name}
                  </span>
                  {table.rls && (
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      {t('rls')}
                    </Badge>
                  )}
                  {locked && <Badge variant="secondary">{t('locked')}</Badge>}
                </button>
                <span className="text-foreground text-right tabular-nums">
                  {nf.format(table.rows)}
                </span>
                <span className="text-muted-foreground text-right tabular-nums">
                  {table.columns.length}
                </span>
              </div>

              {isOpen && (
                <div className="border-border bg-muted/20 border-t px-3 py-3 sm:pl-14">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[520px] text-left text-xs">
                      <thead>
                        <tr className="text-muted-foreground">
                          <th className="py-1 pr-3 font-medium">
                            {t('colName')}
                          </th>
                          <th className="py-1 pr-3 font-medium">
                            {t('colType')}
                          </th>
                          <th className="py-1 pr-3 font-medium">
                            {t('colNull')}
                          </th>
                          <th className="py-1 pr-3 font-medium">
                            {t('colDefault')}
                          </th>
                          <th className="py-1 font-medium">{t('colKey')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {table.columns.map((col) => (
                          <tr
                            key={col.name}
                            className="border-border/60 border-t align-top"
                          >
                            <td className="text-foreground py-1 pr-3 font-mono">
                              {col.name}
                            </td>
                            <td className="text-muted-foreground py-1 pr-3 font-mono">
                              {col.type}
                            </td>
                            <td className="text-muted-foreground py-1 pr-3">
                              {col.nullable ? 'YES' : 'NO'}
                            </td>
                            <td
                              className="text-muted-foreground max-w-[220px] truncate py-1 pr-3 font-mono"
                              title={col.default ?? ''}
                            >
                              {col.default ?? ''}
                            </td>
                            <td className="py-1">
                              <span className="flex flex-wrap gap-1">
                                {col.primary_key && (
                                  <Badge variant="default">
                                    {t('primaryKey')}
                                  </Badge>
                                )}
                                {col.generated && (
                                  <Badge variant="outline">
                                    {t('generated')}
                                  </Badge>
                                )}
                                {col.identity && (
                                  <Badge variant="outline">
                                    {t('identity')}
                                  </Badge>
                                )}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {table.referenced_by.length > 0 && (
                    <p className="text-muted-foreground mt-2 text-xs">
                      {t('referencedBy', {
                        tables: table.referenced_by.join(', '),
                      })}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-border bg-card rounded-xl border p-4 text-sm">
        <p className="text-foreground font-medium">{t('historyTitle')}</p>
        {log.length === 0 ? (
          <p className="text-muted-foreground mt-1 text-xs">
            {t('historyEmpty')}
          </p>
        ) : (
          <ul className="text-muted-foreground mt-2 space-y-1.5 text-xs">
            {log.map((entry) => (
              <li key={entry.id}>
                <span className="text-foreground">
                  {new Date(entry.created_at).toLocaleString()}
                </span>
                {' — '}
                {t('historyLine', {
                  who: entry.performed_by_email ?? '—',
                  tables: entry.tables.length,
                  rows: nf.format(
                    Object.values(entry.row_counts ?? {}).reduce(
                      (a, b) => a + Number(b || 0),
                      0
                    )
                  ),
                })}
                <span className="ml-1 font-mono">
                  ({entry.tables.join(', ')})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Dialog
        open={dialog}
        onOpenChange={(next) => (next ? setDialog(true) : closeDialog())}
      >
        <DialogContent className="bg-popover border-border sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground flex items-center gap-2">
              <AlertTriangle className="size-5 text-red-400" />{' '}
              {t('dialogTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('dialogWarning')}
            </DialogDescription>
          </DialogHeader>

          {plan && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-foreground font-medium">
                  {t('dialogTables', { count: plan.tables.length })}
                </p>
                <p className="text-muted-foreground mt-1 max-h-32 overflow-y-auto font-mono text-xs">
                  {plan.tables.join(', ')}
                </p>
              </div>
              {plan.added.length > 0 && (
                <p className="rounded-lg border border-amber-600/40 bg-amber-500/10 p-2 text-xs text-amber-200">
                  {t('dialogAdded', { tables: plan.added.join(', ') })}
                </p>
              )}
              <p className="font-medium text-red-300">
                {t('dialogRows', { rows: nf.format(plan.rows) })}
              </p>
              <p className="text-muted-foreground text-xs">
                {t('dialogBackupNote')}
              </p>
              <label className="text-muted-foreground block text-xs">
                {t('confirmLabel', { word: TRUNCATE_CONFIRM_WORD })}
                <Input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={TRUNCATE_CONFIRM_WORD}
                  autoComplete="off"
                  disabled={step !== 'idle'}
                  className="mt-1"
                />
              </label>
              {step !== 'idle' && (
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Loader2 className="size-3.5 animate-spin" />
                  {step === 'backup' ? t('stepBackup') : t('stepTruncate')}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t('restoreHint')}
              </p>
            </div>
          )}

          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={closeDialog}
              disabled={step !== 'idle'}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void runTruncate()}
              disabled={
                step !== 'idle' ||
                confirm !== TRUNCATE_CONFIRM_WORD ||
                !plan ||
                plan.blocked.length > 0
              }
            >
              {step !== 'idle' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {t('runButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
