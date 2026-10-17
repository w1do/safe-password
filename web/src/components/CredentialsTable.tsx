import { Pencil, Trash2 } from 'lucide-react';
import { SecretCell } from '@/components/SecretCell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Credential, CredentialStatus } from '@/lib/api';

interface Props {
  credentials: Credential[];
  showProject?: boolean;
  onEdit: (c: Credential) => void;
  onDelete: (c: Credential) => void;
  onStatusChange: (c: Credential, status: CredentialStatus) => void;
  onOpenProject?: (projectId: string) => void;
}

export function CredentialsTable({ credentials, showProject, onEdit, onDelete, onStatusChange, onOpenProject }: Props) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {showProject && <TableHead>Проект</TableHead>}
          <TableHead>Сервис</TableHead>
          <TableHead>Название ключа</TableHead>
          <TableHead>Секрет</TableHead>
          <TableHead className="w-[150px]">Статус</TableHead>
          <TableHead className="w-[96px] text-right">Действия</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {credentials.map((c) => {
          const active = c.status === 'active';
          return (
            <TableRow key={c.id} className={active ? undefined : 'text-muted-foreground'}>
              {showProject && (
                <TableCell>
                  <button className="font-medium underline-offset-4 hover:underline" onClick={() => onOpenProject?.(c.projectId)}>
                    {c.projectName}
                  </button>
                </TableCell>
              )}
              <TableCell className="font-medium">{c.service}</TableCell>
              <TableCell>
                <div>{c.name}</div>
                <div className="text-xs text-muted-foreground" title={`Создан: ${formatDate(c.createdAt)}`}>
                  изменён {formatDate(c.updatedAt)}
                </div>
              </TableCell>
              <TableCell>
                <SecretCell credentialId={c.id} label={`${c.service} · ${c.name}`} />
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={active}
                    onCheckedChange={(checked) => onStatusChange(c, checked ? 'active' : 'inactive')}
                    aria-label={`Статус ${c.name}`}
                  />
                  <Badge variant={active ? 'success' : 'secondary'}>{active ? 'Активен' : 'Неактивен'}</Badge>
                </div>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm" onClick={() => onEdit(c)} aria-label={`Изменить ${c.name}`}>
                        <Pencil />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Изменить</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => onDelete(c)}
                        aria-label={`Удалить ${c.name}`}
                      >
                        <Trash2 />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Удалить</TooltipContent>
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}
