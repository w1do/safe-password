import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from './config.js';
import { VaultError } from './errors.js';
import type { Vault } from './vault.js';

export const SESSION_COOKIE = 'vault_session';
export const CSRF_HEADER = 'x-vault-request';

/**
 * Sliding-window failure counter. Locks a client out after `perClient` failures and
 * everyone out after `global` failures within `windowMs`.
 */
export class FailureLimiter {
  private readonly clients = new Map<string, number[]>();
  private global: number[] = [];

  constructor(
    private readonly perClient: number,
    private readonly globalLimit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until the client may try again, or 0 if allowed. */
  retryAfter(client: string): number {
    const now = this.now();
    const hits = this.prune(this.clients.get(client) ?? [], now);
    this.global = this.prune(this.global, now);
    const waits: number[] = [];
    if (hits.length >= this.perClient) waits.push(hits[0] + this.windowMs - now);
    if (this.global.length >= this.globalLimit) waits.push(this.global[0] + this.windowMs - now);
    return waits.length ? Math.max(1, Math.ceil(Math.max(...waits) / 1000)) : 0;
  }

  fail(client: string): void {
    const now = this.now();
    const hits = this.prune(this.clients.get(client) ?? [], now);
    hits.push(now);
    this.clients.set(client, hits);
    this.global.push(now);
    if (this.clients.size > 10_000) this.clients.clear();
  }

  reset(client: string): void {
    this.clients.delete(client);
  }

  private prune(hits: number[], now: number): number[] {
    return hits.filter((t) => now - t < this.windowMs);
  }
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function cookieAttributes(req: Request, config: AppConfig): string {
  const secure = config.cookieSecure === 'auto' ? req.secure : config.cookieSecure;
  return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

export function setSessionCookie(req: Request, res: Response, config: AppConfig, id: string): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(id)}; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}; ${cookieAttributes(req, config)}`);
}

export function clearSessionCookie(req: Request, res: Response, config: AppConfig): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieAttributes(req, config)}`);
}

export function requireSession(vault: Vault) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!vault.isSessionValid(readCookie(req, SESSION_COOKIE))) {
      return next(new VaultError('UNAUTHORIZED', 'Session is missing or expired'));
    }
    next();
  };
}

/**
 * CSRF protection for cookie-authenticated requests: state-changing calls must carry a custom header,
 * which browsers never attach cross-site without a CORS preflight (and no CORS is enabled).
 */
export function requireCsrfHeader(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get(CSRF_HEADER) !== '1') return next(new VaultError('CSRF_REJECTED', `Missing ${CSRF_HEADER} header`));
  next();
}

export function extractBearer(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1] : null;
}
