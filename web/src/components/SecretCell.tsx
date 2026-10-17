import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { copyText } from '@/lib/clipboard';

const AUTO_HIDE_MS = 30_000;

/** Secrets are never part of list data: each one is fetched on demand and hidden again after 30 s. */
export function SecretCell({ credentialId, label }: { credentialId: string; label: string }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<'reveal' | 'copy' | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);
  // Drop the cached secret when the row starts pointing at another record.
  useEffect(() => setSecret(null), [credentialId]);

  async function toggle() {
    if (secret !== null) {
      clearTimeout(timer.current);
      setSecret(null);
      return;
    }
    setBusy('reveal');
    try {
      setSecret(await api.revealSecret(credentialId));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setSecret(null), AUTO_HIDE_MS);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    setBusy('copy');
    try {
      await copyText(secret ?? (await api.revealSecret(credentialId)));
      toast.success('Секрет скопирован', { description: label });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code
        data-testid="secret-value"
        title={secret ?? undefined}
        className="block max-w-[16rem] truncate rounded bg-muted px-2 py-1 font-mono text-xs"
      >
        {secret ?? '••••••••••••'}
      </code>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={toggle} disabled={busy !== null} aria-label={secret ? 'Скрыть секрет' : 'Показать секрет'}>
            {busy === 'reveal' ? <Loader2 className="animate-spin" /> : secret ? <EyeOff /> : <Eye />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{secret ? 'Скрыть' : 'Показать'}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={copy} disabled={busy !== null} aria-label="Копировать секрет">
            {busy === 'copy' ? <Loader2 className="animate-spin" /> : <Copy />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Копировать</TooltipContent>
      </Tooltip>
    </div>
  );
}
