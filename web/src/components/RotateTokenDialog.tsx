import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRotated: (token: string) => void;
}

/** Step 1: confirm with the current password. The new token is shown by NewTokenDialog. */
export function RotateTokenDialog({ open, onOpenChange, onRotated }: Props) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError(null);
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.rotateToken(password);
      setPassword('');
      onRotated(token);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Сменить токен доступа</DialogTitle>
            <DialogDescription>Токен используется для входа в панель и для подключения агентов через MCP.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <ul className="list-disc space-y-1 pl-4">
              <li>старый токен сразу перестанет работать — у всех агентов;</li>
              <li>все сессии панели будут завершены, включая текущую;</li>
              <li>новый токен будет показан только один раз.</li>
            </ul>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rotate-password">Текущий пароль</Label>
            <Input id="rotate-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !password}>
              {busy && <Loader2 className="animate-spin" />}
              Сменить токен
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
