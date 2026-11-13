'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { MfaSetup } from '@/components/auth/mfa-setup';
import { RecoveryCodesView } from '@/components/auth/recovery-codes-view';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface MfaStatus {
  enabled: boolean;
  mandatory: boolean;
  canDisable: boolean;
  recoveryCodesLeft: number;
}

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, json, err: (json.error as { message?: string } | undefined)?.message ?? null };
}

/** Settings → Login & security → Two-step verification. Rules are enforced by the API. */
export function MfaCard() {
  const t = useTranslations('AccountSecurity.mfa');
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [mode, setMode] = useState<'idle' | 'setup' | 'regen' | 'disable'>('idle');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch('/api/auth/mfa', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) setStatus((await res.json()) as MfaStatus);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const reset = () => {
    setMode('idle');
    setCode('');
    setPassword('');
  };

  const regenerate = async () => {
    setBusy(true);
    const r = await post('/api/auth/mfa/recovery-codes', { code });
    setBusy(false);
    if (!r.ok) return toast.error(r.err ?? t('failed'));
    setCodes((r.json.recoveryCodes as string[]) ?? []);
    reset();
    void load();
  };

  const disable = async () => {
    setBusy(true);
    const r = await post('/api/auth/mfa/disable', { password, code });
    setBusy(false);
    if (!r.ok) return toast.error(r.err ?? t('failed'));
    toast.success(t('disabled'));
    reset();
    void load();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <ShieldCheck className="size-4 text-primary" />
          {t('cardTitle')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {status?.mandatory ? t('cardMandatory') : t('cardOptional')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : !status.enabled ? (
          mode === 'setup' ? (
            <MfaSetup
              onDone={() => {
                reset();
                void load();
              }}
            />
          ) : (
            <Button type="button" onClick={() => setMode('setup')}>
              {t('turnOn')}
            </Button>
          )
        ) : (
          <>
            <p className="text-sm text-foreground">
              {t('statusOn')}{' '}
              <span className="text-muted-foreground">{t('codesLeft', { count: status.recoveryCodesLeft })}</span>
            </p>
            {codes && <RecoveryCodesView codes={codes} />}
            {mode === 'idle' ? (
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => { setCodes(null); setMode('regen'); }}>
                  {t('newCodes')}
                </Button>
                {status.canDisable && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setMode('disable')}>
                    {t('turnOff')}
                  </Button>
                )}
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-border p-3">
                {mode === 'disable' && (
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="mfa-pw">{t('passwordLabel')}</Label>
                    <Input id="mfa-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mfa-c">{t('codeLabel')}</Label>
                  <Input id="mfa-c" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="sm" onClick={reset} disabled={busy}>
                    {t('cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || code.replace(/\s/g, '').length !== 6 || (mode === 'disable' && !password)}
                    onClick={() => void (mode === 'regen' ? regenerate() : disable())}
                  >
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {mode === 'regen' ? t('newCodes') : t('turnOff')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
