import { useCallback, useEffect, useMemo, useState } from 'react';
import { FolderClosed, FolderPlus, KeyRound, Loader2, LockKeyhole, LogOut, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CredentialDialog, type CredentialFormValues } from '@/components/CredentialDialog';
import { CREDENTIAL_DRAG_TYPE, CredentialsTable } from '@/components/CredentialsTable';
import { ProjectDialog } from '@/components/ProjectDialog';
import { RotateTokenDialog } from '@/components/RotateTokenDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage, type Credential, type CredentialStatus, type Project } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Props {
  email: string;
  onSignedOut: () => void;
  onTokenRotated: (token: string) => void;
}

type ProjectDialogState = { open: false } | { open: true; project: Project | null };
type CredentialDialogState = { open: false } | { open: true; credential: Credential | null };

export function Dashboard({ email, onSignedOut, onTokenRotated }: Props) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const [projectDialog, setProjectDialog] = useState<ProjectDialogState>({ open: false });
  const [credentialDialog, setCredentialDialog] = useState<CredentialDialogState>({ open: false });
  const [toDelete, setToDelete] = useState<Credential | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [dragged, setDragged] = useState<Credential | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [rotateOpen, setRotateOpen] = useState(false);

  const selected = useMemo(() => projects?.find((p) => p.id === selectedId) ?? null, [projects, selectedId]);
  const searching = debouncedQuery.trim().length > 0;

  const loadProjects = useCallback(async () => {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setSelectedId((cur) => (cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);

  const loadCredentials = useCallback(async () => {
    try {
      if (searching) setCredentials(await api.searchCredentials(debouncedQuery.trim()));
      else if (selectedId) setCredentials(await api.listCredentials(selectedId));
      else setCredentials([]);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [searching, debouncedQuery, selectedId]);

  const refresh = useCallback(() => Promise.all([loadProjects(), loadCredentials()]), [loadProjects, loadCredentials]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    setCredentials(null);
    void loadCredentials();
  }, [loadCredentials]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  async function logout() {
    await api.logout().catch(() => undefined);
    onSignedOut();
  }

  async function saveProject(name: string) {
    if (projectDialog.open && projectDialog.project) {
      await api.renameProject(projectDialog.project.id, name);
      toast.success('Проект переименован');
    } else {
      const p = await api.createProject(name);
      setSelectedId(p.id);
      setQuery('');
      toast.success(`Проект «${p.name}» создан`);
    }
    await refresh();
  }

  async function saveCredential(values: CredentialFormValues) {
    if (credentialDialog.open && credentialDialog.credential) {
      const { secret, ...rest } = values;
      // An empty secret is not sent, so the server keeps the previous one.
      await api.updateCredential(credentialDialog.credential.id, secret ? values : rest);
      toast.success('Запись обновлена');
    } else if (selected) {
      await api.createCredential(selected.id, values);
      toast.success('Доступ добавлен');
    }
    await refresh();
  }

  async function changeStatus(c: Credential, status: CredentialStatus) {
    setCredentials((list) => list?.map((x) => (x.id === c.id ? { ...x, status } : x)) ?? null);
    try {
      await api.updateCredential(c.id, { status });
    } catch (e) {
      toast.error(errorMessage(e));
    }
    await refresh();
  }

  async function deleteCredential() {
    if (!toDelete) return;
    try {
      await api.deleteCredential(toDelete.id);
      toast.success('Запись удалена');
    } catch (e) {
      toast.error(errorMessage(e));
    }
    setToDelete(null);
    await refresh();
  }

  async function deleteInactive() {
    if (!selected) return;
    try {
      const n = await api.deleteInactive(selected.id);
      toast.success(`Удалено неактивных записей: ${n}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    await refresh();
  }

  async function deleteProject() {
    if (!projectToDelete) return;
    const p = projectToDelete;
    setProjectToDelete(null);
    try {
      const n = await api.deleteProject(p.id);
      toast.success(n > 0 ? `Проект «${p.name}» удалён вместе с записями: ${n}` : `Проект «${p.name}» удалён`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    await refresh();
  }

  async function moveCredential(c: Credential, target: Project) {
    if (c.projectId === target.id) return;
    // Outside search the moved record leaves the current list right away.
    if (!searching) setCredentials((list) => list?.filter((x) => x.id !== c.id) ?? null);
    try {
      await api.updateCredential(c.id, { projectId: target.id });
      toast.success(`«${c.service} · ${c.name}» перенесена в «${target.name}»`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
    await refresh();
  }

  function endDrag() {
    setDragged(null);
    setDropTargetId(null);
  }

  const editingProjectName =
    credentialDialog.open && credentialDialog.credential ? credentialDialog.credential.projectName : (selected?.name ?? '');

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur">
        <div className="flex items-center gap-2 font-semibold">
          <LockKeyhole className="h-5 w-5" />
          <span className="hidden sm:inline">Project Vault</span>
        </div>
        <div className="relative ml-2 max-w-md flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Поиск"
            placeholder="Поиск по проекту, сервису, названию ключа…"
            className="pl-8"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-sm text-muted-foreground md:inline">{email}</span>
          <Button variant="outline" size="sm" onClick={() => setRotateOpen(true)}>
            <KeyRound />
            <span className="hidden sm:inline">Сменить токен</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={logout}>
            <LogOut />
            <span className="hidden sm:inline">Выйти</span>
          </Button>
        </div>
      </header>

      <div className="grid flex-1 md:grid-cols-[260px_1fr]">
        <aside className="border-b bg-muted/30 p-3 md:border-b-0 md:border-r">
          <Button className="mb-3 w-full" onClick={() => setProjectDialog({ open: true, project: null })}>
            <FolderPlus />
            Создать проект
          </Button>
          <nav aria-label="Проекты" className="grid gap-0.5">
            {projects === null && <Loader2 className="mx-auto my-4 h-5 w-5 animate-spin text-muted-foreground" />}
            {projects?.length === 0 && <p className="px-2 py-4 text-center text-sm text-muted-foreground">Проектов пока нет</p>}
            {dragged && <p className="px-2 pb-1 text-xs text-muted-foreground">Перетащите запись на проект, чтобы перенести её</p>}
            {projects?.map((p) => {
              const isSelected = p.id === selectedId && !searching;
              const canDrop = dragged !== null && dragged.projectId !== p.id;
              return (
                <div
                  key={p.id}
                  data-testid={`project-${p.id}`}
                  className={cn(
                    'group flex items-center rounded-md pr-1 text-sm transition-colors',
                    isSelected ? 'bg-accent font-medium' : 'hover:bg-accent/60',
                    canDrop && 'outline-dashed outline-1 -outline-offset-1 outline-muted-foreground/40',
                    canDrop && dropTargetId === p.id && 'bg-primary/10 outline outline-2 outline-primary',
                  )}
                  onDragOver={(e) => {
                    if (!canDrop || !e.dataTransfer.types.includes(CREDENTIAL_DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setDropTargetId(p.id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTargetId((cur) => (cur === p.id ? null : cur));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const c = dragged;
                    endDrag();
                    if (c && c.id === e.dataTransfer.getData(CREDENTIAL_DRAG_TYPE)) void moveCredential(c, p);
                  }}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
                    aria-current={isSelected ? 'page' : undefined}
                    onClick={() => {
                      setSelectedId(p.id);
                      setQuery('');
                    }}
                  >
                    <FolderClosed className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{p.name}</span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">{p.credentialCount}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Переименовать ${p.name}`}
                    onClick={() => setProjectDialog({ open: true, project: p })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="h-7 w-7 text-destructive opacity-0 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Удалить проект ${p.name}`}
                    onClick={() => setProjectToDelete(p)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 p-4 md:p-6">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {searching ? 'Результаты поиска' : (selected?.name ?? 'Выберите проект')}
              </h1>
              {searching && (
                <button className="mt-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setQuery('')}>
                  <X className="h-3 w-3" />«{debouncedQuery.trim()}» — сбросить
                </button>
              )}
            </div>
            {!searching && selected && (
              <>
                <Button
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={selected.inactiveCount === 0}
                  onClick={() => setConfirmBulk(true)}
                >
                  <Trash2 />
                  Удалить неактивные{selected.inactiveCount > 0 ? ` (${selected.inactiveCount})` : ''}
                </Button>
                <Button onClick={() => setCredentialDialog({ open: true, credential: null })}>
                  <Plus />
                  Добавить доступ
                </Button>
              </>
            )}
          </div>

          <div className="rounded-lg border bg-card">
            {credentials === null ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : credentials.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {searching ? 'Ничего не найдено' : selected ? 'В проекте пока нет доступов' : 'Создайте первый проект'}
              </div>
            ) : (
              <CredentialsTable
                credentials={credentials}
                showProject={searching}
                onEdit={(c) => setCredentialDialog({ open: true, credential: c })}
                onDelete={setToDelete}
                onStatusChange={changeStatus}
                onOpenProject={(id) => {
                  setSelectedId(id);
                  setQuery('');
                }}
                onDragStart={setDragged}
                onDragEnd={endDrag}
              />
            )}
          </div>
        </main>
      </div>

      <ProjectDialog
        open={projectDialog.open}
        project={projectDialog.open ? projectDialog.project : null}
        onOpenChange={(open) => !open && setProjectDialog({ open: false })}
        onSubmit={saveProject}
      />
      <CredentialDialog
        open={credentialDialog.open}
        credential={credentialDialog.open ? credentialDialog.credential : null}
        projectName={editingProjectName}
        onOpenChange={(open) => !open && setCredentialDialog({ open: false })}
        onSubmit={saveCredential}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title="Удалить запись?"
        description={toDelete ? `«${toDelete.service} · ${toDelete.name}» будет удалена без возможности восстановления.` : ''}
        confirmLabel="Удалить"
        onOpenChange={(open) => !open && setToDelete(null)}
        onConfirm={deleteCredential}
      />
      <ConfirmDialog
        open={confirmBulk}
        title="Удалить все неактивные записи?"
        description={`В проекте «${selected?.name ?? ''}» будет удалено неактивных записей: ${selected?.inactiveCount ?? 0}. Активные записи не затрагиваются.`}
        confirmLabel="Удалить неактивные"
        onOpenChange={setConfirmBulk}
        onConfirm={deleteInactive}
      />
      <ConfirmDialog
        open={projectToDelete !== null}
        title="Удалить проект?"
        description={
          projectToDelete
            ? projectToDelete.credentialCount > 0
              ? `Проект «${projectToDelete.name}» и все его записи (${projectToDelete.credentialCount}) будут удалены без возможности восстановления. Чтобы сохранить нужные записи, сначала перетащите их в другой проект.`
              : `Пустой проект «${projectToDelete.name}» будет удалён.`
            : ''
        }
        confirmLabel="Удалить проект"
        onOpenChange={(open) => !open && setProjectToDelete(null)}
        onConfirm={deleteProject}
      />
      <RotateTokenDialog open={rotateOpen} onOpenChange={setRotateOpen} onRotated={onTokenRotated} />
    </div>
  );
}
