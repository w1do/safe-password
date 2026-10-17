import { vi } from 'vitest';

interface StoredCredential {
  id: string;
  projectId: string;
  service: string;
  name: string;
  secret: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}

/** In-memory stand-in for the server API, installed as global fetch. */
export function installFakeBackend(opts: { signedIn?: boolean } = {}) {
  const creds = { email: 'admin@example.com', password: 'pw-1234567890', token: 'vlt_old' };
  let session = opts.signedIn ?? false;
  let seq = 0;
  const now = '2026-10-17T10:00:00.000Z';
  const projects: Array<{ id: string; name: string; createdAt: string; updatedAt: string }> = [];
  const credentials: StoredCredential[] = [];
  const requests: RecordedRequest[] = [];
  const responses: Array<{ path: string; text: string }> = [];

  const json = (status: number, data?: unknown) =>
    new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const err = (status: number, code: string, message = code) => json(status, { error: { code, message } });
  const meta = ({ secret: _secret, ...c }: StoredCredential) => ({
    ...c,
    projectName: projects.find((p) => p.id === c.projectId)!.name,
  });
  const projectDto = (p: (typeof projects)[number]) => ({
    ...p,
    credentialCount: credentials.filter((c) => c.projectId === p.id).length,
    inactiveCount: credentials.filter((c) => c.projectId === p.id && c.status === 'inactive').length,
  });

  function handle(method: string, url: URL, body: Record<string, unknown> | undefined): Response {
    const path = url.pathname;
    if (method === 'POST' && path === '/api/auth/login') {
      if (body?.email === creds.email && body?.password === creds.password && body?.token === creds.token) {
        session = true;
        return json(200, { email: creds.email });
      }
      return err(401, 'INVALID_CREDENTIALS');
    }
    if (method === 'POST' && path === '/api/auth/logout') {
      session = false;
      return json(204);
    }
    if (!session) return err(401, 'UNAUTHORIZED');

    if (method === 'GET' && path === '/api/auth/me') return json(200, { email: creds.email });
    if (method === 'POST' && path === '/api/auth/rotate-token') {
      if (body?.password !== creds.password) return err(401, 'INVALID_CREDENTIALS');
      creds.token = 'vlt_new_token_value';
      session = false;
      return json(200, { token: creds.token });
    }
    if (method === 'GET' && path === '/api/projects') return json(200, { projects: projects.map(projectDto) });
    if (method === 'POST' && path === '/api/projects') {
      const name = String(body?.name ?? '');
      if (projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return err(409, 'PROJECT_EXISTS');
      const p = { id: `p${++seq}`, name, createdAt: now, updatedAt: now };
      projects.push(p);
      return json(201, { project: projectDto(p) });
    }
    let m = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (m && method === 'PATCH') {
      const p = projects.find((x) => x.id === m![1])!;
      p.name = String(body?.name);
      return json(200, { project: projectDto(p) });
    }
    if (m && method === 'DELETE') {
      const i = projects.findIndex((x) => x.id === m![1]);
      if (i < 0) return err(404, 'PROJECT_NOT_FOUND');
      projects.splice(i, 1);
      const before = credentials.length;
      for (let j = credentials.length - 1; j >= 0; j--) if (credentials[j].projectId === m[1]) credentials.splice(j, 1);
      return json(200, { deleted: before - credentials.length });
    }
    m = /^\/api\/projects\/([^/]+)\/credentials$/.exec(path);
    if (m && method === 'GET') return json(200, { credentials: credentials.filter((c) => c.projectId === m![1]).map(meta) });
    if (m && method === 'POST') {
      const c: StoredCredential = {
        id: `c${++seq}`,
        projectId: m[1],
        service: String(body?.service),
        name: String(body?.name),
        secret: String(body?.secret),
        status: (body?.status as 'active') ?? 'active',
        createdAt: now,
        updatedAt: now,
      };
      credentials.push(c);
      return json(201, { credential: meta(c) });
    }
    m = /^\/api\/projects\/([^/]+)\/credentials\/inactive$/.exec(path);
    if (m && method === 'DELETE') {
      const before = credentials.length;
      for (let i = credentials.length - 1; i >= 0; i--) {
        if (credentials[i].projectId === m[1] && credentials[i].status === 'inactive') credentials.splice(i, 1);
      }
      return json(200, { deleted: before - credentials.length });
    }
    if (method === 'GET' && path === '/api/credentials') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const found = credentials.map(meta).filter((c) => [c.projectName, c.service, c.name].some((v) => v.toLowerCase().includes(q)));
      return json(200, { credentials: found });
    }
    m = /^\/api\/credentials\/([^/]+)\/secret$/.exec(path);
    if (m && method === 'GET') {
      const c = credentials.find((x) => x.id === m![1]);
      return c ? json(200, { secret: c.secret }) : err(404, 'CREDENTIAL_NOT_FOUND');
    }
    m = /^\/api\/credentials\/([^/]+)$/.exec(path);
    if (m && method === 'PATCH') {
      const c = credentials.find((x) => x.id === m![1])!;
      if (body?.projectId !== undefined) c.projectId = String(body.projectId);
      if (body?.service !== undefined) c.service = String(body.service);
      if (body?.name !== undefined) c.name = String(body.name);
      if (body?.status !== undefined) c.status = body.status as 'active';
      if (typeof body?.secret === 'string' && body.secret !== '') c.secret = body.secret;
      return json(200, { credential: meta(c) });
    }
    if (m && method === 'DELETE') {
      credentials.splice(
        credentials.findIndex((x) => x.id === m![1]),
        1,
      );
      return json(204);
    }
    return err(404, 'NOT_FOUND');
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, path: url.pathname + url.search, body, headers: { ...(init?.headers as Record<string, string>) } });
    const res = handle(method, url, body);
    responses.push({ path: url.pathname, text: await res.clone().text() });
    return res;
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    creds,
    projects,
    requests,
    responses,
    credentials,
    seedProject(name: string) {
      const p = { id: `p${++seq}`, name, createdAt: now, updatedAt: now };
      projects.push(p);
      return p.id;
    },
    seedCredential(projectId: string, service: string, name: string, secret: string, status: 'active' | 'inactive' = 'active') {
      const c = { id: `c${++seq}`, projectId, service, name, secret, status, createdAt: now, updatedAt: now };
      credentials.push(c);
      return c.id;
    },
  };
}
