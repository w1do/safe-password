import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { copyText } from '@/lib/clipboard';

/** Shows a freshly rotated token exactly once. It cannot be dismissed by clicking outside. */
export function NewTokenDialog({ token, onDone }: { token: string | null; onDone: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!token) return;
    try {
      await copyText(token);
      setCopied(true);
      toast.success('Токен скопирован');
    } catch {
      toast.error('Не удалось скопировать — выделите токен вручную');
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={() => undefined}>
      <DialogContent className="sm:max-w-lg [&>button:last-child]:hidden" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Новый токен доступа</DialogTitle>
          <DialogDescription>
            Сохраните токен в менеджере паролей и обновите переменную окружения у агентов. Больше он показан не будет. Все сессии
            завершены — войдите заново с новым токеном.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code data-testid="new-token" className="flex-1 select-all break-all rounded-md border bg-muted px-3 py-2 font-mono text-sm">
            {token}
          </code>
          <Button variant="outline" size="icon" onClick={copy} aria-label="Копировать токен">
            {copied ? <Check /> : <Copy />}
          </Button>
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              setCopied(false);
              onDone();
            }}
          >
            Я сохранил токен
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
