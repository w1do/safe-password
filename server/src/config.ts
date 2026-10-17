import path from 'node:path';
import type { LogLevel } from './logger.js';

export interface AppConfig {
  port: number;
  host: string;
  dbPath: string;
  configDir: string;
  webDir: string | null;
  /** Value for Express `trust proxy`; enable only behind a reverse proxy. */
  trustProxy: boolean | number | string;
  /** `auto` sets Secure on the cookie when the request arrived over HTTPS. */
  cookieSecure: 'auto' | boolean;
  sessionTtlMs: number;
  logLevel: LogLevel;
  initial: {
    email?: string;
    password?: string;
    token?: string;
  };
}

function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  const n = Number(raw);
  return Number.isInteger(n) ? n : raw;
}

function parseCookieSecure(raw: string | undefined): 'auto' | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return 'auto';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.VAULT_DATA_DIR ?? '/data';
  const webDir = env.VAULT_WEB_DIR ?? path.resolve(process.cwd(), 'public');
  return {
    port: Number(env.PORT ?? 8089),
    host: env.HOST ?? '0.0.0.0',
    dbPath: env.VAULT_DB_PATH ?? path.join(dataDir, 'db', 'vault.sqlite'),
    configDir: env.VAULT_CONFIG_DIR ?? path.join(dataDir, 'config'),
    webDir: webDir || null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    cookieSecure: parseCookieSecure(env.COOKIE_SECURE),
    sessionTtlMs: Number(env.SESSION_TTL_HOURS ?? 12) * 3600_000,
    logLevel: (env.LOG_LEVEL as LogLevel) ?? 'info',
    initial: {
      email: env.VAULT_ADMIN_EMAIL || undefined,
      password: env.VAULT_ADMIN_PASSWORD || undefined,
      token: env.VAULT_ACCESS_TOKEN || undefined,
    },
  };
}
