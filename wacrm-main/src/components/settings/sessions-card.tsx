'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, LogOut, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIst } from '@/lib/ist-time';

interface SessionItem {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip_address: string | null;
  user_agent: string | null;
  current: boolean;
}

/** "Chrome on macOS" style label from a user-agent string (display only). */
function deviceLabel(ua: string | null, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} · ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}

export function SessionsCard() {
  const t = useTranslations('AccountSecurity.sessions');
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [signingOut, setSigningOut] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/sessions', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) return setSessions([]);
    const j = (await res.json()) as { sessions: SessionItem[] };
    setSessions(j.sessions);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const revoke = async (s: SessionItem) => {
    setBusyId(s.id);
    const res = await fetch(`/api/auth/sessions/${s.id}`, { method: 'DELETE', credentials: 'same-origin' });
    setBusyId(null);
    if (!res.ok) return toast.error(t('revokeFailed'));
    if (s.current) {
      // Full page load: the session cookie is gone, the middleware must see that.
      window.location.assign('/login');
      return;
    }
    toast.success(t('revoked'));
    void load();
  };

  const revokeAll = async () => {
    setSigningOut(true);
    const res = await fetch('/api/auth/sessions/revoke-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
      credentials: 'same-origin',
    });
    setSigningOut(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      return toast.error(j.error?.message ?? t('revokeFailed'));
    }
    window.location.assign('/login');
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <LogOut className="size-4 text-primary" />
            {t('title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!sessions ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                  <Monitor className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">
                      {deviceLabel(s.user_agent, t('unknownDevice'))}
                      {s.current && <span className="ml-1.5 text-xs text-primary">{t('thisDevice')}</span>}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {t('lastActive', { when: formatIst(s.last_seen_at) })}
                      {s.ip_address ? ` · ${s.ip_address}` : ''}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busyId === s.id}
                    onClick={() => void revoke(s)}
                  >
                    {busyId === s.id ? <Loader2 className="size-4 animate-spin" /> : t('signOut')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button type="button" variant="outline" onClick={() => setOpen(true)}>
            <LogOut className="size-4" />
            {t('signOutAll')}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('confirmTitle')}</DialogTitle>
            <DialogDescription>{t('confirmDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="revoke-reason">{t('reasonLabel')}</Label>
            <Input
              id="revoke-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              maxLength={1000}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={signingOut}>
              {t('cancel')}
            </Button>
            <Button type="button" onClick={() => void revokeAll()} disabled={signingOut || reason.trim().length < 3}>
              {signingOut && <Loader2 className="size-4 animate-spin" />}
              {t('confirmButton')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
