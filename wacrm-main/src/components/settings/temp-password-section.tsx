'use client';

import { useState } from 'react';
import { Copy, KeyRound, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatIst } from '@/lib/ist-time';

/**
 * Admin action: set a one-off password (valid 72 hours) that the user must
 * change at their next sign-in. Their open sessions end. The password is
 * shown here once and never stored or logged in plain text.
 */
export function TempPasswordSection({ userId, email }: { userId: string; email: string }) {
  const t = useTranslations('AccountSecurity.tempPassword');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ password: string; expiresAt: string } | null>(null);

  const issue = async () => {
    setBusy(true);
    const res = await fetch(`/api/platform/users/${userId}/temp-password`, { method: 'POST', credentials: 'same-origin' });
    const j = (await res.json().catch(() => ({}))) as { password?: string; expiresAt?: string; error?: { message?: string } };
    setBusy(false);
    setConfirming(false);
    if (!res.ok || !j.password || !j.expiresAt) return toast.error(j.error?.message ?? t('failed'));
    setIssued({ password: j.password, expiresAt: j.expiresAt });
  };

  const copy = async () => {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.password);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };

  return (
    <div>
      <Label className="text-xs text-muted-foreground">{t('label')}</Label>
      {issued ? (
        <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted p-3">
          <p className="text-xs text-muted-foreground">{t('shownOnce', { email })}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all font-mono text-sm text-foreground">{issued.password}</code>
            <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
              <Copy className="size-4" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('expires', { when: formatIst(issued.expiresAt) })}</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setIssued(null)}>
            {t('done')}
          </Button>
        </div>
      ) : confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('confirm')}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button type="button" size="sm" onClick={() => void issue()} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('issue')}
          </Button>
        </div>
      ) : (
        <div className="mt-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(true)}>
            <KeyRound className="size-4" />
            {t('issue')}
          </Button>
        </div>
      )}
    </div>
  );
}
