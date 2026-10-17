import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { FailureLimiter } from '../src/auth.js';
import { bootstrap } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const ADMIN = {
  email: 'admin@example.com',
  password: 'correct-horse-battery',
  token: 'vlt_test_token_0123456789abcdefghijklmnop',
};

/** Cheap scrypt cost for tests; production uses N=2^15. */
export const TEST_SCRYPT = { N: 2 ** 10, r: 8, p: 1 };

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
}

export interface TestContext {
  dir: string;
  config: AppConfig;
  app: ReturnType<typeof createApp>;
  vault: Awaited<ReturnType<typeof bootstrap>>['vault'];
  logs: string[];
  close: () => void;
}

export async function createTestContext(
  opts: { dir?: string; env?: Record<string, string | undefined>; loginLimiter?: FailureLimiter } = {},
): Promise<TestContext> {
  const dir = opts.dir ?? tempDir();
  const config = loadConfig({
    VAULT_DATA_DIR: dir,
    VAULT_WEB_DIR: '',
    VAULT_ADMIN_EMAIL: ADMIN.email,
    VAULT_ADMIN_PASSWORD: ADMIN.password,
    VAULT_ACCESS_TOKEN: ADMIN.token,
    ...opts.env,
  });
  const logs: string[] = [];
  const log = createLogger('debug', (line) => logs.push(line));
  const { db, vault } = await bootstrap(config, log, { scrypt: TEST_SCRYPT });
  const app = createApp({ vault, config, log, loginLimiter: opts.loginLimiter });
  return { dir, config, app, vault, logs, close: () => db.close() };
}

/** Logs in and returns an agent that keeps the session cookie and sends the CSRF header. */
export async function login(ctx: TestContext, creds: { email: string; password: string; token: string } = ADMIN) {
  const agent = request.agent(ctx.app);
  const res = await agent.post('/api/auth/login').set('X-Vault-Request', '1').send(creds);
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    agent,
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => agent.post(url).set('X-Vault-Request', '1').send(body ?? {}),
    patch: (url: string, body?: object) => agent.patch(url).set('X-Vault-Request', '1').send(body ?? {}),
    del: (url: string) => agent.delete(url).set('X-Vault-Request', '1'),
  };
}

export async function listen(app: TestContext['app']): Promise<{ url: string; server: Server }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}
