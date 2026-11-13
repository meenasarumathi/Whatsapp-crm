'use client';

import { useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RecoveryCodesView } from './recovery-codes-view';

async function post(path: string, body: unknown = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const err = res.ok ? null : ((json.error as { message?: string } | undefined)?.message ?? 'Request failed');
  return { json, err };
}

/**
 * Authenticator-app set-up: secret → first code → recovery codes.
 * Used on /account-security (mandatory for admins) and in Settings.
 */
export function MfaSetup({ onDone }: { onDone: () => void }) {
  const t = useTranslations('AccountSecurity.mfa');
  const [step, setStep] = useState<'start' | 'verify' | 'codes'>('start');
  const [secret, setSecret] = useState('');
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    const { json, err } = await post('/api/auth/mfa/enroll');
    setBusy(false);
    if (err) return setError(err);
    setSecret(String(json.secret ?? ''));
    setUri(String(json.otpauthUri ?? ''));
    setStep('verify');
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { json, err } = await post('/api/auth/mfa/confirm', { code });
    setBusy(false);
    if (err) return setError(err);
    setCodes((json.recoveryCodes as string[]) ?? []);
    setSecret('');
    setStep('codes');
  };

  if (step === 'start') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('startIntro')}</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="button" onClick={() => void start()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {t('startButton')}
        </Button>
      </div>
    );
  }

  if (step === 'verify') {
    return (
      <form onSubmit={confirm} className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t('stepApp')}</li>
          <li>{t('stepKey')}</li>
          <li>{t('stepCode')}</li>
        </ol>
        <div className="rounded-lg border border-border bg-muted p-3">
          <div className="text-xs text-muted-foreground">{t('keyLabel')}</div>
          <div className="mt-1 break-all font-mono text-sm tracking-wider text-foreground">
            {secret.match(/.{1,4}/g)?.join(' ')}
          </div>
          <a href={uri} className="mt-2 inline-block text-xs text-primary hover:underline">
            {t('openInApp')}
          </a>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mfa-code" className="text-muted-foreground">
            {t('codeLabel')}
          </Label>
          <Input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            required
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <Button type="submit" disabled={busy || code.replace(/\s/g, '').length !== 6}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          {t('verifyButton')}
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm font-medium text-foreground">{t('enabled')}</p>
      <RecoveryCodesView codes={codes} />
      <Button type="button" onClick={onDone}>
        {t('savedContinue')}
      </Button>
    </div>
  );
}
