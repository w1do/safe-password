export type CredentialStatus = 'active' | 'inactive';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  credentialCount: number;
  inactiveCount: number;
}

export interface Credential {
  id: string;
  projectId: string;
  projectName: string;
  service: string;
  name: string;
  status: CredentialStatus;
  createdAt: string;
  updatedAt: string;
}

const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'Неверный email, пароль или токен доступа',
  RATE_LIMITED: 'Слишком много попыток. Попробуйте позже',
  UNAUTHORIZED: 'Сессия завершена. Войдите снова',
  PROJECT_EXISTS: 'Проект с таким названием уже существует',
  CREDENTIAL_EXISTS: 'В проекте уже есть ключ с таким сервисом и названием',
  PROJECT_NOT_FOUND: 'Проект не найден',
  CREDENTIAL_NOT_FOUND: 'Запись не найдена',
  VALIDATION_ERROR: 'Проверьте заполнение полей',
  INTERNAL_ERROR: 'Внутренняя ошибка сервера',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
/** Called when any authenticated request gets 401 (session expired or token rotated elsewhere). */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'X-Vault-Request': '1', Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Сервер недоступен');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) {
    const code = data.error?.code ?? 'INTERNAL_ERROR';
    if (res.status === 401 && code === 'UNAUTHORIZED') onUnauthorized?.();
    const translated = code === 'VALIDATION_ERROR' && data.error?.message ? `${MESSAGES[code]}: ${data.error.message}` : MESSAGES[code];
    throw new ApiError(res.status, code, translated ?? data.error?.message ?? `Ошибка ${res.status}`);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  me: () => request<{ email: string }>('GET', '/api/auth/me'),
  login: (email: string, password: string, token: string) => request<{ email: string }>('POST', '/api/auth/login', { email, password, token }),
  logout: () => request<void>('POST', '/api/auth/logout'),
  rotateToken: (password: string) => request<{ token: string }>('POST', '/api/auth/rotate-token', { password }),

  listProjects: () => request<{ projects: Project[] }>('GET', '/api/projects').then((r) => r.projects),
  createProject: (name: string) => request<{ project: Project }>('POST', '/api/projects', { name }).then((r) => r.project),
  renameProject: (id: string, name: string) => request<{ project: Project }>('PATCH', `/api/projects/${enc(id)}`, { name }).then((r) => r.project),
  deleteProject: (id: string) => request<{ deleted: number }>('DELETE', `/api/projects/${enc(id)}`).then((r) => r.deleted),

  listCredentials: (projectId: string) =>
    request<{ credentials: Credential[] }>('GET', `/api/projects/${enc(projectId)}/credentials`).then((r) => r.credentials),
  searchCredentials: (q: string) => request<{ credentials: Credential[] }>('GET', `/api/credentials?q=${enc(q)}`).then((r) => r.credentials),
  revealSecret: (id: string) => request<{ secret: string }>('GET', `/api/credentials/${enc(id)}/secret`).then((r) => r.secret),
  createCredential: (projectId: string, input: { service: string; name: string; secret: string; status: CredentialStatus }) =>
    request<{ credential: Credential }>('POST', `/api/projects/${enc(projectId)}/credentials`, input).then((r) => r.credential),
  updateCredential: (id: string, patch: { projectId?: string; service?: string; name?: string; secret?: string; status?: CredentialStatus }) =>
    request<{ credential: Credential }>('PATCH', `/api/credentials/${enc(id)}`, patch).then((r) => r.credential),
  deleteCredential: (id: string) => request<void>('DELETE', `/api/credentials/${enc(id)}`),
  deleteInactive: (projectId: string) =>
    request<{ deleted: number }>('DELETE', `/api/projects/${enc(projectId)}/credentials/inactive`).then((r) => r.deleted),
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Неизвестная ошибка';
}
