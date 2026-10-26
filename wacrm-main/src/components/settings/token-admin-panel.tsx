'use client';

// ============================================================
// Settings → Platform → Token admin
//
//   Recharges   approval queue (admin + super admin)
//   Accounts    balances, 30-day usage, grant / deduct with a reason,
//               feature switches (grant / deduct / switches: super admin)
//   Review      charges whose send outcome is unknown (super admin)
//   Reports     ledger with account / date / type filters, CSV export
//   Rate & GPay tokens per rupee and payment instructions (super admin)
//
// The server re-checks every permission (/api/wallet/admin); controls
// an admin can't use are simply not shown.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SettingsPanelHead } from './settings-panel-head';
import { cn } from '@/lib/utils';
import { formatRupees, formatTokens, unitsForPaise } from '@/lib/wallet/units';
import { LEDGER_ENTRY_TYPES } from '@/lib/wallet/report';
import { WALLET_FEATURES, type WalletFeature } from '@/lib/wallet/policy';

type Tab = 'requests' | 'accounts' | 'review' | 'reports' | 'settings';

interface Overview {
  me: { role: string | null };
  accounts: {
    id: string;
    name: string;
    owner_email: string | null;
    balance_units: number;
    messages_30d: number;
    features: Record<WalletFeature, boolean>;
  }[];
  requests: {
    id: string;
    account_id: string;
    account_name: string | null;
    amount_paise: number;
    tokens_units: number;
    rate_tokens_per_rupee_num: number;
    rate_tokens_per_rupee_den: number;
    status: 'pending' | 'approved' | 'rejected';
    payment_reference: string | null;
    decided_at: string | null;
    decision_note: string | null;
    created_at: string;
    has_proof: boolean;
  }[];
  review_queue: {
    message_id: string;
    account_name: string | null;
    source: string;
    detail: string | null;
    updated_at: string;
  }[];
  settings: {
    rate_num: number;
    rate_den: number;
    gpay_upi_id: string | null;
    gpay_payee_name: string | null;
    gpay_instructions: string | null;
  } | null;
  rate_history: { rate_num: number; rate_den: number; created_at: string }[];
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch('/api/wallet/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? 'Request failed');
  return json;
}

export function TokenAdminPanel() {
  const t = useTranslations('Settings.tokenAdmin');
  const [tab, setTab] = useState<Tab>('requests');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/wallet/admin', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t('loadFailed'));
      setData(json as Overview);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await post(body);
      toast.success(ok);
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const isSuper = data?.me.role === 'super_admin';
  const pending = data?.requests.filter((r) => r.status === 'pending').length ?? 0;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {error && (
        <div className="mb-4 flex gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      )}

      <div className="mb-4 flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1">
        {(['requests', 'accounts', 'review', 'reports', 'settings'] as Tab[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              'shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap',
              tab === k ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted',
            )}
          >
            {t(`tabs.${k}`)}
            {k === 'requests' && pending > 0 ? ` (${pending})` : ''}
            {k === 'review' && (data?.review_queue.length ?? 0) > 0 ? ` (${data!.review_queue.length})` : ''}
          </button>
        ))}
      </div>

      {!data ? (
        !error && <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : tab === 'requests' ? (
        <RequestsTab data={data} busy={busy} run={run} />
      ) : tab === 'accounts' ? (
        <AccountsTab data={data} busy={busy} run={run} isSuper={isSuper} />
      ) : tab === 'review' ? (
        <ReviewTab data={data} busy={busy} run={run} isSuper={isSuper} />
      ) : tab === 'reports' ? (
        <ReportsTab accounts={data.accounts} />
      ) : (
        <SettingsTab data={data} busy={busy} run={run} isSuper={isSuper} />
      )}
    </section>
  );
}

type Run = (body: Record<string, unknown>, ok: string) => Promise<boolean>;

function RequestsTab({ data, busy, run }: { data: Overview; busy: boolean; run: Run }) {
  const t = useTranslations('Settings.tokenAdmin');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showDecided, setShowDecided] = useState(false);
  const list = data.requests.filter((r) => showDecided || r.status === 'pending');

  const openProof = async (id: string) => {
    const res = await fetch(`/api/wallet/admin/proof/${id}`);
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.url) window.open(json.url, '_blank', 'noopener,noreferrer');
    else toast.error(json?.error ?? t('failed'));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('verifyHint')}</p>
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showDecided} onCheckedChange={setShowDecided} />
          {t('showDecided')}
        </label>
      </div>
      {list.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('noRequests')}</p>
      ) : (
        list.map((r) => (
          <div key={r.id} className="rounded-xl border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">{r.account_name ?? r.account_id}</p>
                <p className="text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</p>
              </div>
              <div className="text-right">
                <p className="text-lg font-bold tabular-nums">{formatRupees(r.amount_paise)}</p>
                <p className="text-xs text-muted-foreground">
                  → {formatTokens(r.tokens_units)} {t('tokensAtRate', { num: r.rate_tokens_per_rupee_num, den: r.rate_tokens_per_rupee_den })}
                </p>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('reference')}: {r.payment_reference ?? '—'}
              {r.has_proof && (
                <button type="button" className="ml-3 text-primary hover:underline" onClick={() => void openProof(r.id)}>
                  {t('viewProof')}
                </button>
              )}
            </p>
            {r.status === 'pending' ? (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder={t('notePlaceholder')}
                  value={notes[r.id] ?? ''}
                  onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })}
                />
                <Button
                  disabled={busy}
                  onClick={() => void run({ action: 'decide', request_id: r.id, approve: true, note: notes[r.id] ?? '' }, t('approved'))}
                >
                  {t('approve')}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !(notes[r.id] ?? '').trim()}
                  title={t('rejectNeedsNote')}
                  onClick={() => void run({ action: 'decide', request_id: r.id, approve: false, note: notes[r.id] }, t('rejected'))}
                >
                  {t('reject')}
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-xs">
                <span className={r.status === 'approved' ? 'text-emerald-600 dark:text-emerald-300' : 'text-red-600 dark:text-red-300'}>{t(`status.${r.status}`)}</span>
                {r.decided_at ? ` · ${new Date(r.decided_at).toLocaleString()}` : ''}
                {r.decision_note ? ` · ${r.decision_note}` : ''}
              </p>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function AccountsTab({ data, busy, run, isSuper }: { data: Overview; busy: boolean; run: Run; isSuper: boolean }) {
  const t = useTranslations('Settings.tokenAdmin');
  const [open, setOpen] = useState<string | null>(null);
  const [tokens, setTokens] = useState('');
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const list = data.accounts.filter((a) =>
    `${a.name} ${a.owner_email ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const adjust = async (kind: 'grant' | 'deduct', accountId: string) => {
    const ok = await run({ action: kind, account_id: accountId, tokens, reason }, kind === 'grant' ? t('granted') : t('deducted'));
    if (ok) {
      setTokens('');
      setReason('');
    }
  };

  return (
    <div className="space-y-3">
      <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchAccounts')} />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {list.map((a) => (
          <div key={a.id} className="border-b border-border last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen(open === a.id ? null : a.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
                <p className="truncate text-xs text-muted-foreground">{a.owner_email ?? '—'}</p>
              </div>
              <div className="text-right">
                <p className={cn('text-sm font-semibold tabular-nums', a.balance_units < 500 ? 'text-red-600 dark:text-red-300' : 'text-foreground')}>
                  {formatTokens(a.balance_units)}
                </p>
                <p className="text-[11px] text-muted-foreground">{t('messages30d', { count: a.messages_30d })}</p>
              </div>
            </button>
            {open === a.id && (
              <div className="space-y-4 border-t border-border bg-card-2 px-4 py-4">
                <div>
                  <Label className="text-xs text-muted-foreground">{t('features')}</Label>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {WALLET_FEATURES.map((f) => (
                      <label key={f} className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={a.features[f]}
                          disabled={!isSuper || busy}
                          onCheckedChange={(v) =>
                            void run({ action: 'set_feature', account_id: a.id, feature: f, enabled: v }, t('featureSaved'))
                          }
                        />
                        {t(`feature.${f}`)}
                      </label>
                    ))}
                  </div>
                </div>
                {isSuper ? (
                  <div className="grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto_auto]">
                    <Input inputMode="decimal" placeholder={t('tokensPlaceholder')} value={tokens} onChange={(e) => setTokens(e.target.value)} />
                    <Input placeholder={t('reasonPlaceholder')} value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Button disabled={busy || !tokens || !reason.trim()} onClick={() => void adjust('grant', a.id)}>
                      {t('grant')}
                    </Button>
                    <Button variant="outline" disabled={busy || !tokens || !reason.trim()} onClick={() => void adjust('deduct', a.id)}>
                      {t('deduct')}
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('superOnly')}</p>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewTab({ data, busy, run, isSuper }: { data: Overview; busy: boolean; run: Run; isSuper: boolean }) {
  const t = useTranslations('Settings.tokenAdmin');
  const [reason, setReason] = useState<Record<string, string>>({});
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('reviewIntro')}</p>
      {data.review_queue.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t('reviewEmpty')}</p>
      ) : (
        data.review_queue.map((c) => (
          <div key={c.message_id} className="rounded-xl border border-amber-500/40 bg-card p-4">
            <p className="text-sm font-medium text-foreground">
              {c.account_name ?? '—'} · {t(`feature.${c.source}`)}
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{c.message_id}</p>
            <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
            {isSuper && (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input
                  placeholder={t('reviewReason')}
                  value={reason[c.message_id] ?? ''}
                  onChange={(e) => setReason({ ...reason, [c.message_id]: e.target.value })}
                />
                <Button
                  disabled={busy || !(reason[c.message_id] ?? '').trim()}
                  onClick={() => void run({ action: 'resolve', message_id: c.message_id, outcome: 'sent', reason: reason[c.message_id] }, t('resolved'))}
                >
                  {t('markSent')}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !(reason[c.message_id] ?? '').trim()}
                  onClick={() => void run({ action: 'resolve', message_id: c.message_id, outcome: 'released', reason: reason[c.message_id] }, t('resolved'))}
                >
                  {t('markNotSent')}
                </Button>
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

function ReportsTab({ accounts }: { accounts: Overview['accounts'] }) {
  const t = useTranslations('Settings.tokenAdmin');
  const tw = useTranslations('Wallet');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [types, setTypes] = useState<string[]>([]);
  const [rows, setRows] = useState<{ id: string; created_at: string; account_name: string | null; entry_type: string; amount_units: number; balance_after_units: number; reason: string | null }[] | null>(null);
  const [totals, setTotals] = useState<Record<string, number>>({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  const query = () => {
    const p = new URLSearchParams();
    if (accountId) p.set('account_id', accountId);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (types.length) p.set('type', types.join(','));
    return p;
  };

  const runReport = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/wallet/admin/ledger?${query().toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? t('failed'));
      setRows(json.rows);
      setTotals(json.totals ?? {});
      setTotal(json.total_rows ?? 0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('failed'));
    } finally {
      setLoading(false);
    }
  };

  const csvHref = () => {
    const p = query();
    p.set('format', 'csv');
    return `/api/wallet/admin/ledger?${p.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('account')}</Label>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="h-9 rounded-lg border border-border bg-muted px-2 text-sm"
          >
            <option value="">{t('allAccounts')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('from')}</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs text-muted-foreground">{t('to')}</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {LEDGER_ENTRY_TYPES.map((type) => {
          const on = types.includes(type);
          return (
            <button
              key={type}
              type="button"
              onClick={() => setTypes(on ? types.filter((x) => x !== type) : [...types, type])}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs',
                on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground',
              )}
            >
              {tw(`entry.${type}`)}
            </button>
          );
        })}
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void runReport()} disabled={loading}>
          {loading && <Loader2 className="size-4 animate-spin" />}
          {t('runReport')}
        </Button>
        <a href={csvHref()} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-muted">
          <Download className="size-4" /> {t('exportCsv')}
        </a>
      </div>
      {rows && (
        <>
          <p className="text-xs text-muted-foreground">
            {t('rowsFound', { count: total })} ·{' '}
            {Object.entries(totals)
              .map(([k, v]) => `${tw(`entry.${k}`)} ${formatTokens(v)}`)
              .join(' · ')}
          </p>
          <div className="max-h-[480px] overflow-auto rounded-xl border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-1.5">{r.account_name}</td>
                    <td className="px-3 py-1.5">{tw(`entry.${r.entry_type}`)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatTokens(r.amount_units)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatTokens(r.balance_after_units)}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{r.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SettingsTab({ data, busy, run, isSuper }: { data: Overview; busy: boolean; run: Run; isSuper: boolean }) {
  const t = useTranslations('Settings.tokenAdmin');
  const s = data.settings;
  const [num, setNum] = useState(String(s?.rate_num ?? 1));
  const [den, setDen] = useState(String(s?.rate_den ?? 1));
  const [upi, setUpi] = useState(s?.gpay_upi_id ?? '');
  const [payee, setPayee] = useState(s?.gpay_payee_name ?? '');
  const [instructions, setInstructions] = useState(s?.gpay_instructions ?? '');
  const perRupee = /^\d+$/.test(num) && /^\d+$/.test(den) && Number(den) > 0
    ? formatTokens(unitsForPaise(100, { num: Number(num), den: Number(den) }))
    : '—';

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{t('rateTitle')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('rateHelp')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">{t('rateTokens')}</Label>
            <Input className="w-28" value={num} disabled={!isSuper} onChange={(e) => setNum(e.target.value)} />
          </div>
          <span className="pb-2 text-sm text-muted-foreground">{t('per')}</span>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">{t('rateRupees')}</Label>
            <Input className="w-28" value={den} disabled={!isSuper} onChange={(e) => setDen(e.target.value)} />
          </div>
          <span className="pb-2 text-sm text-muted-foreground">= {t('perRupee', { tokens: perRupee })}</span>
          {isSuper && (
            <Button disabled={busy} onClick={() => void run({ action: 'set_rate', rate_num: num, rate_den: den }, t('rateSaved'))}>
              {t('save')}
            </Button>
          )}
        </div>
        {data.rate_history.length > 0 && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            {t('rateHistory')}{' '}
            {data.rate_history
              .slice(0, 5)
              .map((r) => `${r.rate_num}/${r.rate_den} (${new Date(r.created_at).toLocaleDateString()})`)
              .join(' · ')}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{t('gpayTitle')}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">{t('upiId')}</Label>
            <Input value={upi} disabled={!isSuper} onChange={(e) => setUpi(e.target.value)} placeholder="yourname@okaxis" />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">{t('payee')}</Label>
            <Input value={payee} disabled={!isSuper} onChange={(e) => setPayee(e.target.value)} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label className="text-xs text-muted-foreground">{t('instructions')}</Label>
            <Textarea rows={3} value={instructions} disabled={!isSuper} onChange={(e) => setInstructions(e.target.value)} />
          </div>
        </div>
        {isSuper && (
          <Button
            className="mt-3"
            disabled={busy}
            onClick={() =>
              void run(
                { action: 'set_gpay', gpay_upi_id: upi, gpay_payee_name: payee, gpay_instructions: instructions },
                t('gpaySaved'),
              )
            }
          >
            {t('save')}
          </Button>
        )}
      </div>
    </div>
  );
}
