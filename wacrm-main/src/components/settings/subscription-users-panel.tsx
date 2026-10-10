'use client';

// ============================================================
// Settings → Subscription users (platform admins only)
//
// One list of every user of the CRM with:
//   - their platform role (Super admin / Admin 1 / Admin 2 /
//     Subscription user) — only the Super admin can change it;
//   - their subscription: free trial of 1, 7 or 15 days, paid
//     (active), expired or suspended;
//   - which left-sidebar tabs they may open (checkboxes).
//
// Row checkboxes select one or many users; the bulk bar then applies
// a trial, a status, a role or a tab set to all of them at once.
// What each admin may change is decided by `canChangePlatformUser`
// and re-checked by PATCH /api/platform/users.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Crown,
  Hourglass,
  Loader2,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  User,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';
import { usePlatform } from '@/hooks/use-platform';
import { cn } from '@/lib/utils';
import {
  ALL_TAB_KEYS,
  ASSIGNABLE_ROLES,
  TRIAL_OPTIONS,
  canChangePlatformUser,
  canCreatePlatformUser,
  type CrmTab,
  type PlatformChange,
  type PlatformRole,
  type SubscriptionStatus,
  type TrialDays,
} from '@/lib/platform/access';

interface PlatformUser {
  user_id: string;
  full_name: string;
  email: string;
  joined_at: string;
  platform_role: PlatformRole;
  status: SubscriptionStatus;
  trial_days: number | null;
  trial_ends_at: string | null;
  days_left: number | null;
  allowed_tabs: CrmTab[];
  all_tabs: boolean;
  notes: string;
  is_self: boolean;
}

/** Sidebar label key for each tab, so names match the left menu. */
const TAB_LABEL_KEY: Record<CrmTab, string> = {
  dashboard: 'dashboard',
  inbox: 'inbox',
  'train-ai': 'trainAi',
  notifications: 'notifications',
  contacts: 'contacts',
  pipelines: 'pipelines',
  broadcasts: 'broadcasts',
  automations: 'automations',
  flows: 'flows',
  agents: 'aiAgents',
  demo: 'demo',
  guide: 'guide',
};

const ROLE_STYLE: Record<PlatformRole, { icon: typeof Crown; className: string }> = {
  super_admin: { icon: Crown, className: 'border-amber-500/40 bg-amber-500/10 text-amber-300' },
  admin1: { icon: ShieldCheck, className: 'border-primary/40 bg-primary/10 text-primary' },
  admin2: { icon: Shield, className: 'border-sky-500/40 bg-sky-500/10 text-sky-300' },
  subscriber: { icon: User, className: 'border-border bg-muted text-foreground' },
};

const STATUS_STYLE: Record<SubscriptionStatus, string> = {
  trial: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  active: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  expired: 'border-red-500/40 bg-red-500/10 text-red-300',
  suspended: 'border-border bg-muted text-muted-foreground',
};

const SELECT_CLASS =
  'h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-60';

type Patch = {
  platform_role?: PlatformRole;
  allowed_tabs?: CrmTab[] | null;
  subscription_status?: Exclude<SubscriptionStatus, 'trial'>;
  trial_days?: TrialDays;
  notes?: string;
};

function changesOf(patch: Patch): PlatformChange[] {
  const out: PlatformChange[] = [];
  if (patch.platform_role) out.push('role');
  if (patch.allowed_tabs !== undefined) out.push('tabs');
  if (patch.trial_days) out.push('trial');
  else if (patch.subscription_status) out.push('status');
  if (patch.notes !== undefined) out.push('notes');
  return out;
}

export function SubscriptionUsersPanel() {
  const t = useTranslations('Platform.panel');
  const tRole = useTranslations('Platform.roles');
  const { role: myRole, migrated, loading: platformLoading, isPlatformAdmin } = usePlatform();

  const [users, setUsers] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notMigrated, setNotMigrated] = useState(false);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<PlatformRole | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [bulkTabsOpen, setBulkTabsOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/platform/users', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (data?.code === 'not_migrated') {
        setNotMigrated(true);
        return;
      }
      if (!res.ok) throw new Error(data?.error ?? t('loadFailed'));
      setUsers(data.users ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (platformLoading || !isPlatformAdmin) return;
    void load();
  }, [platformLoading, isPlatformAdmin, load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter(
      (u) =>
        (roleFilter === 'all' || u.platform_role === roleFilter) &&
        (!q || u.full_name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)),
    );
  }, [users, query, roleFilter]);

  const counts = useMemo(
    () => ({
      total: users.length,
      trial: users.filter((u) => u.status === 'trial').length,
      active: users.filter((u) => u.status === 'active' && u.platform_role === 'subscriber').length,
      ended: users.filter((u) => u.status === 'expired' || u.status === 'suspended').length,
    }),
    [users],
  );

  const apply = useCallback(
    async (userIds: string[], patch: Patch, okMessage: string) => {
      if (!myRole || userIds.length === 0) return false;
      const targets = users.filter((u) => userIds.includes(u.user_id));
      const blocked = targets.find((u) =>
        changesOf(patch).some((c) => !canChangePlatformUser(myRole, u.platform_role, c)),
      );
      if (blocked) {
        toast.error(t('notAllowedFor', { name: blocked.full_name || blocked.email }));
        return false;
      }
      setBusy(true);
      try {
        const res = await fetch('/api/platform/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_ids: userIds, ...patch }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error ?? t('saveFailed'));
        toast.success(okMessage);
        await load();
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('saveFailed'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [myRole, users, load, t],
  );

  if (platformLoading) {
    return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  }

  if (!migrated || notMigrated) {
    return (
      <section>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t('notMigratedTitle')}</p>
            <p className="mt-1 text-amber-200/80">{t('notMigratedBody')}</p>
          </div>
        </div>
      </section>
    );
  }

  if (!isPlatformAdmin || !myRole) {
    return (
      <section>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <p className="text-sm text-muted-foreground">{t('adminsOnly')}</p>
      </section>
    );
  }

  const selectedIds = [...selected];
  const allVisibleSelected =
    visible.length > 0 && visible.every((u) => selected.has(u.user_id));
  const someVisibleSelected = visible.some((u) => selected.has(u.user_id));
  const canCreateAny = ASSIGNABLE_ROLES.some((r) => canCreatePlatformUser(myRole, r));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((u) => next.delete(u.user_id));
      else visible.forEach((u) => next.add(u.user_id));
      return next;
    });
  };

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canCreateAny ? (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="size-4" /> {t('addUser')}
            </Button>
          ) : null
        }
      />

      {/* Who can do what — the role ladder in one glance. */}
      <div className="mb-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {(['super_admin', 'admin1', 'admin2', 'subscriber'] as PlatformRole[]).map((r) => {
          const style = ROLE_STYLE[r];
          const Icon = style.icon;
          return (
            <div key={r} className="rounded-xl border border-border bg-card p-3">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                  style.className,
                )}
              >
                <Icon className="size-3" /> {tRole(r)}
              </span>
              <p className="mt-2 text-xs text-muted-foreground">{t(`roleHelp.${r}`)}</p>
            </div>
          );
        })}
      </div>

      {/* Summary */}
      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label={t('statTotal')} value={counts.total} />
        <Stat label={t('statTrial')} value={counts.trial} tone="amber" />
        <Stat label={t('statPaid')} value={counts.active} tone="green" />
        <Stat label={t('statEnded')} value={counts.ended} tone="red" />
      </div>

      {/* Filters */}
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as PlatformRole | 'all')}
          className={cn(SELECT_CLASS, 'h-9 text-sm')}
          aria-label={t('filterRole')}
        >
          <option value="all">{t('allRoles')}</option>
          {(['super_admin', 'admin1', 'admin2', 'subscriber'] as PlatformRole[]).map((r) => (
            <option key={r} value={r}>
              {tRole(r)}
            </option>
          ))}
        </select>
      </div>

      {/* Bulk bar */}
      {selectedIds.length > 0 && (
        <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-primary/10 p-3 text-sm">
          <span className="font-medium text-foreground">
            {t('selectedCount', { count: selectedIds.length })}
          </span>
          <span className="mx-1 h-4 w-px bg-border" />
          <span className="text-xs text-muted-foreground">{t('giveTrial')}</span>
          {TRIAL_OPTIONS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void apply(selectedIds, { trial_days: d }, t('trialStarted', { count: d }))
              }
            >
              {t('trialDays', { count: d })}
            </Button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void apply(selectedIds, { subscription_status: 'active' }, t('markedPaid'))
            }
          >
            {t('markPaid')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void apply(selectedIds, { subscription_status: 'suspended' }, t('suspended'))
            }
          >
            {t('suspend')}
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setBulkTabsOpen(true)}>
            {t('setTabs')}
          </Button>
          {myRole === 'super_admin' && (
            <select
              className={SELECT_CLASS}
              value=""
              disabled={busy}
              aria-label={t('setRole')}
              onChange={(e) => {
                const r = e.target.value as PlatformRole;
                if (r) void apply(selectedIds, { platform_role: r }, t('roleChanged'));
              }}
            >
              <option value="">{t('setRole')}</option>
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {tRole(r)}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setSelected(new Set())}
          >
            {t('clearSelection')}
          </Button>
        </div>
      )}

      {/* List */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          <Checkbox
            checked={allVisibleSelected}
            indeterminate={!allVisibleSelected && someVisibleSelected}
            onCheckedChange={toggleAll}
            aria-label={t('selectAll')}
          />
          <span className="flex-1">{t('colUser')}</span>
          <span className="hidden w-32 sm:block">{t('colRole')}</span>
          <span className="hidden w-36 md:block">{t('colPlan')}</span>
          <span className="hidden w-24 lg:block">{t('colTabs')}</span>
          <span className="w-6" />
        </div>

        {loading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {t('loading')}
          </div>
        ) : error ? (
          <div className="p-4 text-sm text-red-400">{error}</div>
        ) : visible.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{t('empty')}</div>
        ) : (
          visible.map((u) => (
            <UserRow
              key={u.user_id}
              user={u}
              myRole={myRole}
              checked={selected.has(u.user_id)}
              onToggle={() => toggleOne(u.user_id)}
              open={expanded === u.user_id}
              onOpen={() => setExpanded((cur) => (cur === u.user_id ? null : u.user_id))}
              busy={busy}
              apply={apply}
            />
          ))
        )}
      </div>

      <AddUserDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        myRole={myRole}
        onCreated={() => void load()}
      />

      <Dialog open={bulkTabsOpen} onOpenChange={setBulkTabsOpen}>
        <DialogContent className="bg-popover border-border sm:max-w-lg">
          <BulkTabsForm
            count={selectedIds.length}
            busy={busy}
            onCancel={() => setBulkTabsOpen(false)}
            onSave={async (tabs) => {
              const ok = await apply(
                selectedIds,
                { allowed_tabs: tabs.length === ALL_TAB_KEYS.length ? null : tabs },
                t('tabsSaved'),
              );
              if (ok) setBulkTabsOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>

      <p className="mt-3 text-xs text-muted-foreground">{t('settingsAlwaysOn')}</p>
    </section>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'amber' | 'green' | 'red';
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-xl font-semibold text-foreground',
          tone === 'amber' && 'text-amber-300',
          tone === 'green' && 'text-emerald-300',
          tone === 'red' && 'text-red-300',
        )}
      >
        {value}
      </div>
    </div>
  );
}

function RoleChip({ role }: { role: PlatformRole }) {
  const tRole = useTranslations('Platform.roles');
  const style = ROLE_STYLE[role];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        style.className,
      )}
    >
      <Icon className="size-3" /> {tRole(role)}
    </span>
  );
}

function PlanChip({ user }: { user: PlatformUser }) {
  const t = useTranslations('Platform.panel');
  const tStatus = useTranslations('Platform.statuses');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATUS_STYLE[user.status],
      )}
    >
      {user.status === 'trial' && <Hourglass className="size-3" />}
      {tStatus(user.status)}
      {user.status === 'trial' && user.days_left != null
        ? ` · ${t('daysLeft', { count: user.days_left })}`
        : ''}
    </span>
  );
}

function UserRow({
  user,
  myRole,
  checked,
  onToggle,
  open,
  onOpen,
  busy,
  apply,
}: {
  user: PlatformUser;
  myRole: PlatformRole;
  checked: boolean;
  onToggle: () => void;
  open: boolean;
  onOpen: () => void;
  busy: boolean;
  apply: (ids: string[], patch: Patch, ok: string) => Promise<boolean>;
}) {
  const t = useTranslations('Platform.panel');
  const tRole = useTranslations('Platform.roles');
  const tSidebar = useTranslations('Sidebar');
  const [tabs, setTabs] = useState<CrmTab[]>(user.allowed_tabs);
  const [notes, setNotes] = useState(user.notes);

  // Re-sync the draft when a save reloads the list.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTabs(user.allowed_tabs);
    setNotes(user.notes);
  }, [user.allowed_tabs, user.notes]);

  const can = (c: PlatformChange) => canChangePlatformUser(myRole, user.platform_role, c);
  const ids = [user.user_id];
  const tabsDirty =
    tabs.length !== user.allowed_tabs.length || tabs.some((x) => !user.allowed_tabs.includes(x));

  return (
    <div className="border-b border-border last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <Checkbox checked={checked} onCheckedChange={onToggle} aria-label={user.email} />
        <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm font-medium text-foreground">
            {user.full_name || user.email}
            {user.is_self && (
              <span className="ml-1.5 text-xs text-muted-foreground">{t('you')}</span>
            )}
          </div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
          {/* Compact role/plan for narrow screens. */}
          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
            <RoleChip role={user.platform_role} />
            <PlanChip user={user} />
          </div>
        </button>
        <div className="hidden w-32 sm:block">
          {can('role') ? (
            <select
              className={SELECT_CLASS}
              value={user.platform_role}
              disabled={busy}
              aria-label={t('colRole')}
              onChange={(e) =>
                void apply(ids, { platform_role: e.target.value as PlatformRole }, t('roleChanged'))
              }
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {tRole(r)}
                </option>
              ))}
            </select>
          ) : (
            <RoleChip role={user.platform_role} />
          )}
        </div>
        <div className="hidden w-36 md:block">
          <PlanChip user={user} />
        </div>
        <div className="hidden w-24 text-xs text-muted-foreground lg:block">
          {user.all_tabs
            ? t('allTabs')
            : t('tabsOf', { count: user.allowed_tabs.length, total: ALL_TAB_KEYS.length })}
        </div>
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('editAccess')}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted"
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      </div>

      {open && (
        <div className="space-y-4 border-t border-border bg-card-2 px-4 py-4">
          {user.platform_role === 'super_admin' ? (
            <p className="text-sm text-muted-foreground">{t('superAdminLocked')}</p>
          ) : (
            <>
              {/* Trial + status */}
              {user.platform_role === 'subscriber' && (
                <div>
                  <Label className="text-xs text-muted-foreground">{t('subscription')}</Label>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {TRIAL_OPTIONS.map((d) => (
                      <Button
                        key={d}
                        size="sm"
                        variant={user.status === 'trial' && user.trial_days === d ? 'default' : 'outline'}
                        disabled={busy || !can('trial')}
                        onClick={() =>
                          void apply(ids, { trial_days: d }, t('trialStarted', { count: d }))
                        }
                      >
                        {t('trialDays', { count: d })}
                      </Button>
                    ))}
                    <span className="mx-1 h-4 w-px bg-border" />
                    <Button
                      size="sm"
                      variant={user.status === 'active' ? 'default' : 'outline'}
                      disabled={busy || !can('status')}
                      onClick={() => void apply(ids, { subscription_status: 'active' }, t('markedPaid'))}
                    >
                      {t('markPaid')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !can('status')}
                      onClick={() => void apply(ids, { subscription_status: 'expired' }, t('expiredNow'))}
                    >
                      {t('endNow')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !can('status')}
                      onClick={() => void apply(ids, { subscription_status: 'suspended' }, t('suspended'))}
                    >
                      {t('suspend')}
                    </Button>
                  </div>
                  {user.trial_ends_at && user.status === 'trial' && (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {t('trialEnds', { date: new Date(user.trial_ends_at).toLocaleString() })}
                    </p>
                  )}
                </div>
              )}

              {/* Tabs */}
              <div>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">{t('tabAccess')}</Label>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                    disabled={!can('tabs')}
                    onClick={() => setTabs([...ALL_TAB_KEYS])}
                  >
                    {t('selectAllTabs')}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline disabled:opacity-50"
                    disabled={!can('tabs')}
                    onClick={() => setTabs([])}
                  >
                    {t('clearTabs')}
                  </button>
                </div>
                <TabGrid
                  value={tabs}
                  onChange={setTabs}
                  disabled={!can('tabs')}
                  labelFor={(k) => tSidebar(TAB_LABEL_KEY[k])}
                />
                {can('tabs') && (
                  <Button
                    size="sm"
                    className="mt-3"
                    disabled={busy || !tabsDirty}
                    onClick={() =>
                      void apply(
                        ids,
                        { allowed_tabs: tabs.length === ALL_TAB_KEYS.length ? null : tabs },
                        t('tabsSaved'),
                      )
                    }
                  >
                    {t('saveTabs')}
                  </Button>
                )}
              </div>

              {/* Notes */}
              <div>
                <Label className="text-xs text-muted-foreground">{t('notes')}</Label>
                <div className="mt-2 flex gap-2">
                  <Input
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t('notesPlaceholder')}
                    disabled={!can('notes')}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !can('notes') || notes === user.notes}
                    onClick={() => void apply(ids, { notes }, t('notesSaved'))}
                  >
                    {t('save')}
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TabGrid({
  value,
  onChange,
  disabled,
  labelFor,
}: {
  value: CrmTab[];
  onChange: (next: CrmTab[]) => void;
  disabled?: boolean;
  labelFor: (tab: CrmTab) => string;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {ALL_TAB_KEYS.map((tab) => {
        const on = value.includes(tab);
        return (
          <label
            key={tab}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-sm transition-colors',
              on ? 'border-primary/50 bg-primary/5 text-foreground' : 'border-border text-muted-foreground',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <Checkbox
              checked={on}
              disabled={disabled}
              onCheckedChange={(next) =>
                onChange(next ? [...value, tab] : value.filter((x) => x !== tab))
              }
            />
            {labelFor(tab)}
          </label>
        );
      })}
    </div>
  );
}

function BulkTabsForm({
  count,
  busy,
  onCancel,
  onSave,
}: {
  count: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (tabs: CrmTab[]) => void;
}) {
  const t = useTranslations('Platform.panel');
  const tSidebar = useTranslations('Sidebar');
  const [tabs, setTabs] = useState<CrmTab[]>([...ALL_TAB_KEYS]);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-popover-foreground">{t('setTabs')}</DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {t('bulkTabsDesc', { count })}
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-3">
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setTabs([...ALL_TAB_KEYS])}>
          {t('selectAllTabs')}
        </button>
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setTabs([])}>
          {t('clearTabs')}
        </button>
      </div>
      <TabGrid value={tabs} onChange={setTabs} labelFor={(k) => tSidebar(TAB_LABEL_KEY[k])} />
      <DialogFooter className="bg-popover border-border">
        <Button variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button disabled={busy} onClick={() => onSave(tabs)}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('applyToSelected', { count })}
        </Button>
      </DialogFooter>
    </>
  );
}

function AddUserDialog({
  open,
  onOpenChange,
  myRole,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  myRole: PlatformRole;
  onCreated: () => void;
}) {
  const t = useTranslations('Platform.panel');
  const tRole = useTranslations('Platform.roles');
  const tSidebar = useTranslations('Sidebar');
  const roles = ASSIGNABLE_ROLES.filter((r) => canCreatePlatformUser(myRole, r));
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<PlatformRole>('subscriber');
  const [trial, setTrial] = useState<TrialDays | 0>(7);
  const [tabs, setTabs] = useState<CrmTab[]>([...ALL_TAB_KEYS]);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setFullName('');
    setEmail('');
    setPassword('');
    setRole('subscriber');
    setTrial(7);
    setTabs([...ALL_TAB_KEYS]);
  };

  const submit = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/platform/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: fullName,
          email,
          password,
          platform_role: role,
          trial_days: role === 'subscriber' && trial ? trial : null,
          allowed_tabs: tabs.length === ALL_TAB_KEYS.length ? null : tabs,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? t('saveFailed'));
      toast.success(t('userCreated', { email }));
      reset();
      onOpenChange(false);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="bg-popover border-border sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('addUser')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('addUserDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>{t('fullName')}</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t('email')}</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>{t('tempPassword')}</Label>
            <Input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('tempPasswordHint')}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t('colRole')}</Label>
              <select
                className={cn(SELECT_CLASS, 'h-9 text-sm')}
                value={role}
                onChange={(e) => setRole(e.target.value as PlatformRole)}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {tRole(r)}
                  </option>
                ))}
              </select>
            </div>
            {role === 'subscriber' && (
              <div className="grid gap-1.5">
                <Label>{t('freeTrial')}</Label>
                <select
                  className={cn(SELECT_CLASS, 'h-9 text-sm')}
                  value={trial}
                  onChange={(e) => setTrial(Number(e.target.value) as TrialDays | 0)}
                >
                  {TRIAL_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {t('trialDays', { count: d })}
                    </option>
                  ))}
                  <option value={0}>{t('noTrialPaid')}</option>
                </select>
              </div>
            )}
          </div>
          <div>
            <Label>{t('tabAccess')}</Label>
            <TabGrid value={tabs} onChange={setTabs} labelFor={(k) => tSidebar(TAB_LABEL_KEY[k])} />
          </div>
        </div>
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button disabled={saving || !email || password.length < 8} onClick={() => void submit()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('createUser')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
