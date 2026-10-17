import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { errorMessage, type Credential, type CredentialStatus } from '@/lib/api';

export interface CredentialFormValues {
  service: string;
  name: string;
  /** Empty when editing means "keep the current secret". */
  secret: string;
  status: CredentialStatus;
}

interface Props {
  open: boolean;
  credential: Credential | null; // null → create
  projectName: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CredentialFormValues) => Promise<void>;
}

const SERVICE_SUGGESTIONS = ['GitHub', 'GitLab', 'Сервер', 'База данных', 'AWS', 'Docker Registry', 'SMTP'];

export function CredentialDialog({ open, credential, projectName, onOpenChange, onSubmit }: Props) {
  const editing = credential !== null;
  const [values, setValues] = useState<CredentialFormValues>({ service: '', name: '', secret: '', status: 'active' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({ service: credential?.service ?? '', name: credential?.name ?? '', secret: '', status: credential?.status ?? 'active' });
      setError(null);
    }
  }, [open, credential]);

  const set = <K extends keyof CredentialFormValues>(key: K, value: CredentialFormValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const valid = values.service.trim() && values.name.trim() && (editing || values.secret.length > 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ ...values, service: values.service.trim(), name: values.name.trim() });
      setValues((v) => ({ ...v, secret: '' }));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? 'Изменить доступ' : 'Новый доступ'}</DialogTitle>
            <DialogDescription>Проект «{projectName}»</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="cred-service">Сервис</Label>
              <Input
                id="cred-service"
                list="service-suggestions"
                autoFocus
                maxLength={100}
                placeholder="GitHub"
                value={values.service}
                onChange={(e) => set('service', e.target.value)}
              />
              <datalist id="service-suggestions">
                {SERVICE_SUGGESTIONS.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="cred-name">Название ключа</Label>
              <Input id="cred-name" maxLength={200} placeholder="Production API" value={values.name} onChange={(e) => set('name', e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cred-secret">Секрет</Label>
            <Textarea
              id="cred-secret"
              rows={4}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              placeholder={editing ? 'Оставьте пустым, чтобы сохранить прежний секрет' : 'Токен, пароль, SSH-ключ…'}
              value={values.secret}
              onChange={(e) => set('secret', e.target.value)}
            />
            {editing && <p className="text-xs text-muted-foreground">Пустое поле — прежний секрет сохранится.</p>}
          </div>
          <div className="flex items-center gap-3">
            <Switch id="cred-status" checked={values.status === 'active'} onCheckedChange={(c) => set('status', c ? 'active' : 'inactive')} />
            <Label htmlFor="cred-status">{values.status === 'active' ? 'Активен' : 'Неактивен'}</Label>
          </div>
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy && <Loader2 className="animate-spin" />}
              {editing ? 'Сохранить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
