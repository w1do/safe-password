import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/auth.js';
import { ADMIN, createTestContext, login, type TestContext } from './helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
});
afterEach(() => ctx.close());

describe('authentication', () => {
  it('requires email, password and token together', async () => {
    const post = (body: object) => request(ctx.app).post('/api/auth/login').set('X-Vault-Request', '1').send(body);
    expect((await post({ email: ADMIN.email, password: ADMIN.password })).status).toBe(401);
    expect((await post({ email: ADMIN.email, token: ADMIN.token })).status).toBe(401);
    expect((await post({ password: ADMIN.password, token: ADMIN.token })).status).toBe(401);
    expect((await post({ ...ADMIN, token: 'vlt_wrong_token_wrong_token_wrong_token' })).status).toBe(401);

    const ok = await post(ADMIN);
    expect(ok.status).toBe(200);
    const cookie = ok.headers['set-cookie'][0] as string;
    expect(cookie).toMatch(/^vault_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('protects API routes with the session', async () => {
    expect((await request(ctx.app).get('/api/projects')).status).toBe(401);
    const s = await login(ctx);
    expect((await s.get('/api/auth/me')).body).toEqual({ email: ADMIN.email });
    await s.post('/api/auth/logout');
    expect((await s.get('/api/projects')).status).toBe(401);
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const s = await login(ctx);
    const res = await s.agent.post('/api/projects').send({ name: 'CRM' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('limits login attempts', async () => {
    ctx.close();
    ctx = await createTestContext({ loginLimiter: new FailureLimiter(3, 100, 60_000) });
    const post = (body: object) => request(ctx.app).post('/api/auth/login').set('X-Vault-Request', '1').send(body);
    for (let i = 0; i < 3; i++) expect((await post({ ...ADMIN, password: 'nope' })).status).toBe(401);
    const blocked = await post(ADMIN);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('projects and credentials', () => {
  it('creates CRM with several credentials and never returns secrets in lists', async () => {
    const s = await login(ctx);
    const project = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    expect(project.name).toBe('CRM');
    expect((await s.post('/api/projects', { name: 'crm' })).status).toBe(409);

    const items = [
      { service: 'GitHub', name: 'Production API', secret: 'ghp_prod_secret_1' },
      { service: 'GitHub', name: 'CI deploy', secret: 'ghp_ci_secret_2' },
      { service: 'GitLab', name: 'Mirror', secret: 'glpat_secret_3' },
      { service: 'Сервер', name: 'root SSH', secret: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n' },
    ];
    for (const item of items) {
      const res = await s.post(`/api/projects/${project.id}/credentials`, item);
      expect(res.status).toBe(201);
      expect(res.body.credential).not.toHaveProperty('secret');
      expect(res.body.credential.status).toBe('active');
    }
    expect((await s.post(`/api/projects/${project.id}/credentials`, items[0])).status).toBe(409);

    const list = await s.get(`/api/projects/${project.id}/credentials`);
    expect(list.body.credentials).toHaveLength(4);
    const raw = JSON.stringify(list.body);
    for (const item of items) expect(raw).not.toContain(item.secret.slice(0, 10));
    expect(list.body.credentials.every((c: object) => !('secret' in c))).toBe(true);

    const projects = await s.get('/api/projects');
    expect(projects.body.projects[0]).toMatchObject({ name: 'CRM', credentialCount: 4 });
  });

  it('reveals a single secret only through the dedicated endpoint', async () => {
    const s = await login(ctx);
    const p = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'GitHub', name: 'Prod', secret: 'top-secret' })).body.credential;
    expect((await s.get(`/api/credentials/${c.id}`)).body.credential).not.toHaveProperty('secret');
    const res = await s.get(`/api/credentials/${c.id}/secret`);
    expect(res.body).toEqual({ secret: 'top-secret' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect((await request(ctx.app).get(`/api/credentials/${c.id}/secret`)).status).toBe(401);
  });

  it('keeps the old secret when the edit form sends an empty secret', async () => {
    const s = await login(ctx);
    const p = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'GitHub', name: 'Prod', secret: 'first' })).body.credential;

    const upd = await s.patch(`/api/credentials/${c.id}`, { service: 'GitHub', name: 'Production', secret: '' });
    expect(upd.status).toBe(200);
    expect(upd.body.credential.name).toBe('Production');
    expect((await s.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe('first');

    await s.patch(`/api/credentials/${c.id}`, { secret: 'second' });
    expect((await s.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe('second');
  });

  it('renames projects, changes status, deletes one record and bulk-deletes only inactive ones', async () => {
    const s = await login(ctx);
    const p = (await s.post('/api/projects', { name: 'Shop' })).body.project;
    expect((await s.patch(`/api/projects/${p.id}`, { name: 'Магазин' })).body.project.name).toBe('Магазин');

    const ids: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) {
      ids.push((await s.post(`/api/projects/${p.id}/credentials`, { service: 'DB', name, secret: `secret-${name}` })).body.credential.id);
    }
    expect((await s.patch(`/api/credentials/${ids[0]}`, { status: 'inactive' })).body.credential.status).toBe('inactive');
    await s.patch(`/api/credentials/${ids[1]}`, { status: 'inactive' });
    expect((await s.patch(`/api/credentials/${ids[2]}`, { status: 'paused' })).status).toBe(400);

    expect((await s.del(`/api/credentials/${ids[3]}`)).status).toBe(204);
    expect((await s.get(`/api/credentials/${ids[3]}`)).status).toBe(404);

    const bulk = await s.del(`/api/projects/${p.id}/credentials/inactive`);
    expect(bulk.body).toEqual({ deleted: 2 });
    const left = (await s.get(`/api/projects/${p.id}/credentials`)).body.credentials;
    expect(left.map((c: { id: string }) => c.id)).toEqual([ids[2]]);
    expect(left[0].status).toBe('active');
  });

  it('deletes a project with all its credentials', async () => {
    const s = await login(ctx);
    const p = (await s.post('/api/projects', { name: 'Old' })).body.project;
    const keep = (await s.post('/api/projects', { name: 'Keep' })).body.project;
    const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'DB', name: 'a', secret: 's1' })).body.credential;
    await s.post(`/api/projects/${p.id}/credentials`, { service: 'DB', name: 'b', secret: 's2' });
    await s.post(`/api/projects/${keep.id}/credentials`, { service: 'DB', name: 'a', secret: 's3' });

    const res = await s.del(`/api/projects/${p.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2 });
    expect((await s.get('/api/projects')).body.projects.map((x: { name: string }) => x.name)).toEqual(['Keep']);
    expect((await s.get(`/api/credentials/${c.id}`)).status).toBe(404);
    expect((await s.get(`/api/projects/${keep.id}/credentials`)).body.credentials).toHaveLength(1);
    expect((await s.del(`/api/projects/${p.id}`)).body.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('moves a credential to another project and keeps its secret', async () => {
    const s = await login(ctx);
    const from = (await s.post('/api/projects', { name: 'From' })).body.project;
    const to = (await s.post('/api/projects', { name: 'To' })).body.project;
    const c = (await s.post(`/api/projects/${from.id}/credentials`, { service: 'GitHub', name: 'Prod', secret: 'moved-secret' })).body.credential;

    const res = await s.patch(`/api/credentials/${c.id}`, { projectId: to.id });
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatchObject({ projectId: to.id, projectName: 'To', service: 'GitHub', name: 'Prod' });
    expect((await s.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe('moved-secret');
    expect((await s.get(`/api/projects/${from.id}/credentials`)).body.credentials).toHaveLength(0);

    // A record with the same service and name in the target project blocks the move.
    const dup = (await s.post(`/api/projects/${from.id}/credentials`, { service: 'github', name: 'prod', secret: 'x' })).body.credential;
    expect((await s.patch(`/api/credentials/${dup.id}`, { projectId: to.id })).body.error.code).toBe('CREDENTIAL_EXISTS');
    expect((await s.patch(`/api/credentials/${dup.id}`, { projectId: 'nope' })).body.error.code).toBe('PROJECT_NOT_FOUND');
    expect((await s.get(`/api/credentials/${dup.id}`)).body.credential.projectId).toBe(from.id);
  });

  it('searches by project, service and key name', async () => {
    const s = await login(ctx);
    const crm = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    const site = (await s.post('/api/projects', { name: 'Личный сайт' })).body.project;
    await s.post(`/api/projects/${crm.id}/credentials`, { service: 'GitHub', name: 'Production API', secret: 'x1' });
    await s.post(`/api/projects/${crm.id}/credentials`, { service: 'PostgreSQL', name: 'readonly', secret: 'x2' });
    await s.post(`/api/projects/${site.id}/credentials`, { service: 'Хостинг', name: 'FTP', secret: 'x3' });

    const names = async (q: string) =>
      (await s.get(`/api/credentials?q=${encodeURIComponent(q)}`)).body.credentials.map((c: { name: string }) => c.name).sort();
    expect(await names('github')).toEqual(['Production API']);
    expect(await names('сайт')).toEqual(['FTP']);
    expect(await names('ХОСТ')).toEqual(['FTP']);
    expect(await names('readonly')).toEqual(['readonly']);
    expect(await names('crm')).toEqual(['Production API', 'readonly']);
    expect(await names('%')).toEqual([]);
    expect((await s.get(`/api/projects/${crm.id}/credentials?q=postgres`)).body.credentials).toHaveLength(1);
  });

  it('returns clear errors for missing objects and bad input', async () => {
    const s = await login(ctx);
    expect((await s.get('/api/projects/nope/credentials')).body.error.code).toBe('PROJECT_NOT_FOUND');
    expect((await s.get('/api/credentials/nope/secret')).body.error.code).toBe('CREDENTIAL_NOT_FOUND');
    expect((await s.post('/api/projects', { name: '   ' })).body.error.code).toBe('VALIDATION_ERROR');
    const p = (await s.post('/api/projects', { name: 'X' })).body.project;
    expect((await s.post(`/api/projects/${p.id}/credentials`, { service: 'A', name: 'B', secret: '' })).status).toBe(400);
  });
});

describe('access token rotation', () => {
  it('requires the password, ends all sessions and replaces the token', async () => {
    const s1 = await login(ctx);
    const s2 = await login(ctx);
    expect((await s1.post('/api/auth/rotate-token', { password: 'wrong' })).status).toBe(401);

    const res = await s1.post('/api/auth/rotate-token', { password: ADMIN.password });
    expect(res.status).toBe(200);
    const newToken = res.body.token as string;
    expect(newToken).toMatch(/^vlt_/);

    expect((await s1.get('/api/projects')).status).toBe(401);
    expect((await s2.get('/api/projects')).status).toBe(401);
    await expect(login(ctx)).rejects.toThrow();
    await expect(login(ctx, { ...ADMIN, token: newToken })).resolves.toBeDefined();
    expect(ctx.vault.verifyAccessToken(ADMIN.token)).toBe(false);
    expect(ctx.vault.verifyAccessToken(newToken)).toBe(true);
  });
});
