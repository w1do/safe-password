import { Router, type Request, type Response } from 'express';
import {
  FailureLimiter,
  SESSION_COOKIE,
  clearSessionCookie,
  readCookie,
  requireCsrfHeader,
  requireSession,
  setSessionCookie,
} from './auth.js';
import type { AppConfig } from './config.js';
import { VaultError } from './errors.js';
import type { Logger } from './logger.js';
import type { CredentialStatus, Vault } from './vault.js';

function body(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new VaultError('VALIDATION_ERROR', `Field "${field}" must be a string`);
  return v;
}

function optionalStatus(v: unknown): CredentialStatus | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== 'active' && v !== 'inactive') throw new VaultError('VALIDATION_ERROR', 'Field "status" must be "active" or "inactive"');
  return v;
}

export function apiRouter(vault: Vault, config: AppConfig, log: Logger, loginLimiter: FailureLimiter): Router {
  const r = Router();
  r.use(requireCsrfHeader);

  r.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ auth

  r.post('/auth/login', async (req, res) => {
    const client = req.ip ?? 'unknown';
    const wait = loginLimiter.retryAfter(client);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new VaultError('RATE_LIMITED', `Too many login attempts. Try again in ${wait} s`, { retryAfter: wait });
    }
    const b = body(req);
    const ok = await vault.verifyLogin(b.email, b.password, b.token);
    if (!ok) {
      loginLimiter.fail(client);
      log.warn('Login failed', { ip: client });
      throw new VaultError('INVALID_CREDENTIALS', 'Invalid email, password or access token');
    }
    loginLimiter.reset(client);
    setSessionCookie(req, res, config, vault.createSession(config.sessionTtlMs));
    log.info('Login succeeded', { ip: client });
    res.json({ email: vault.getAdminEmail() });
  });

  r.post('/auth/logout', (req, res) => {
    vault.deleteSession(readCookie(req, SESSION_COOKIE));
    clearSessionCookie(req, res, config);
    res.status(204).end();
  });

  // Everything below requires a valid panel session.
  r.use(requireSession(vault));

  r.get('/auth/me', (_req, res) => {
    res.json({ email: vault.getAdminEmail() });
  });

  r.post('/auth/rotate-token', async (req, res) => {
    const client = req.ip ?? 'unknown';
    const wait = loginLimiter.retryAfter(client);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      throw new VaultError('RATE_LIMITED', `Too many attempts. Try again in ${wait} s`, { retryAfter: wait });
    }
    if (!(await vault.verifyAdminPassword(body(req).password))) {
      loginLimiter.fail(client);
      throw new VaultError('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    const token = vault.rotateAccessToken();
    clearSessionCookie(req, res, config);
    log.info('Access token rotated; all panel sessions ended');
    res.json({ token });
  });

  // ------------------------------------------------------------ projects

  r.get('/projects', (_req, res) => {
    res.json({ projects: vault.listProjects() });
  });

  r.post('/projects', (req, res) => {
    res.status(201).json({ project: vault.createProject(body(req).name) });
  });

  r.patch('/projects/:id', (req, res) => {
    res.json({ project: vault.renameProject(req.params.id, body(req).name) });
  });

  r.get('/projects/:id/credentials', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ credentials: vault.listCredentials({ projectId: req.params.id, query }) });
  });

  r.post('/projects/:id/credentials', (req, res) => {
    const b = body(req);
    const credential = vault.createCredential(req.params.id, {
      service: b.service as string,
      name: b.name as string,
      secret: b.secret as string,
      status: optionalStatus(b.status),
    });
    res.status(201).json({ credential });
  });

  r.delete('/projects/:id/credentials/inactive', (req, res) => {
    res.json({ deleted: vault.deleteInactiveCredentials(req.params.id) });
  });

  // ------------------------------------------------------------ credentials

  /** Search across all projects by project name, service and key name. */
  r.get('/credentials', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json({ credentials: vault.listCredentials({ query }) });
  });

  r.get('/credentials/:id', (req, res) => {
    res.json({ credential: vault.getCredential(req.params.id) });
  });

  /** The only endpoint that returns a secret; responses are never cached. */
  r.get('/credentials/:id/secret', (req, res) => {
    const { secret } = vault.revealCredential(req.params.id);
    res.json({ secret });
  });

  r.patch('/credentials/:id', (req, res) => {
    const b = body(req);
    const credential = vault.updateCredential(req.params.id, {
      service: optionalString(b.service, 'service'),
      name: optionalString(b.name, 'name'),
      secret: optionalString(b.secret, 'secret'),
      status: optionalStatus(b.status),
    });
    res.json({ credential });
  });

  r.delete('/credentials/:id', (req, res) => {
    vault.deleteCredential(req.params.id);
    res.status(204).end();
  });

  r.use((_req: Request, _res: Response) => {
    throw new VaultError('NOT_FOUND', 'Unknown API endpoint');
  });

  return r;
}
