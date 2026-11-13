'use client';

import { Copy, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

/** One-time display of MFA recovery codes, with copy and download. */
export function RecoveryCodesView({ codes }: { codes: string[] }) {
  const t = useTranslations('AccountSecurity.recovery');
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${t('fileHeader')}\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted p-3 font-mono text-sm text-foreground">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          <Copy className="size-4" />
          {t('copy')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <Download className="size-4" />
          {t('download')}
        </Button>
      </div>
    </div>
  );
}
