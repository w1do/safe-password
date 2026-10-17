import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIALS_FILE, KEY_FILE } from '../src/bootstrap.js';
import { ADMIN, createTestContext, login, tempDir } from './helpers.js';

const SECRETS = ['ghp_PLAINTEXT_MARKER_123456', 'пароль-маркер-Ω-987', 'AKIA_MARKER_SHOULD_NOT_LEAK'];

function readAllDbFiles(dir: string): Buffer {
  const dbDir = path.join(dir, 'db');
  return Buffer.concat(fs.readdirSync(dbDir).map((f) => fs.readFileSync(path.join(dbDir, f))));
}

describe('storage security and persistence', () => {
  it('stores no plaintext secrets in the database or logs', async () => {
    const ctx = await createTestContext();
    const s = await login(ctx);
    const p = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    for (const [i, secret] of SECRETS.entries()) {
      const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'GitHub', name: `k${i}`, secret })).body.credential;
      expect((await s.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe(secret);
    }
    await s.post('/api/auth/rotate-token', { password: ADMIN.password });
    ctx.close(); // checkpoints the WAL into the main file

    const bytes = readAllDbFiles(ctx.dir);
    for (const secret of [...SECRETS, ADMIN.password, ADMIN.token]) {
      expect(bytes.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    }

    const logs = ctx.logs.join('\n');
    expect(logs).toContain('"path":"/api/projects"');
    for (const secret of [...SECRETS, ADMIN.password, ADMIN.token]) expect(logs).not.toContain(secret);
  });

  it('keeps data, credentials and the key across restarts', async () => {
    const dir = tempDir();
    const first = await createTestContext({ dir });
    const s = await login(first);
    const p = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'DB', name: 'prod', secret: 'persisted-secret' })).body.credential;
    const key = fs.readFileSync(path.join(dir, 'config', KEY_FILE), 'utf8');
    first.close();

    // Restart with different ENV values: they must be ignored.
    const second = await createTestContext({
      dir,
      env: { VAULT_ADMIN_PASSWORD: 'another-password-123', VAULT_ACCESS_TOKEN: 'vlt_another_token_another_token_xxxx' },
    });
    expect(fs.readFileSync(path.join(dir, 'config', KEY_FILE), 'utf8')).toBe(key);
    expect(second.logs.join('\n')).toContain('ignored');
    const s2 = await login(second);
    expect((await s2.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe('persisted-secret');
    second.close();
  });

  it('generates admin credentials into a protected file when ENV is not set', async () => {
    const ctx = await createTestContext({
      env: { VAULT_ADMIN_EMAIL: undefined, VAULT_ADMIN_PASSWORD: undefined, VAULT_ACCESS_TOKEN: undefined },
    });
    const file = path.join(ctx.dir, 'config', CREDENTIALS_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(ctx.dir, 'config', KEY_FILE)).mode & 0o777).toBe(0o600);

    const text = fs.readFileSync(file, 'utf8');
    const value = (k: string) => new RegExp(`^${k}=(.+)$`, 'm').exec(text)![1];
    const creds = { email: value('EMAIL'), password: value('PASSWORD'), token: value('ACCESS_TOKEN') };
    expect(creds.token).toMatch(/^vlt_/);
    for (const v of [creds.password, creds.token]) expect(ctx.logs.join('\n')).not.toContain(v);
    await expect(login(ctx, creds)).resolves.toBeDefined();
    ctx.close();
  });

  it('refuses to start with a missing or foreign encryption key', async () => {
    const dir = tempDir();
    (await createTestContext({ dir })).close();
    const keyPath = path.join(dir, 'config', KEY_FILE);

    fs.renameSync(keyPath, keyPath + '.bak');
    await expect(createTestContext({ dir })).rejects.toThrow(/missing/);

    fs.writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64'));
    await expect(createTestContext({ dir })).rejects.toThrow(/does not match/);
  });
});

describe('backup and restore', () => {
  it('restores records from a database snapshot plus master.key into a fresh data directory', async () => {
    const { backupDatabase } = await import('../src/backup.js');
    const src = await createTestContext();
    const s = await login(src);
    const p = (await s.post('/api/projects', { name: 'CRM' })).body.project;
    const c = (await s.post(`/api/projects/${p.id}/credentials`, { service: 'GitHub', name: 'Prod', secret: 'restored-secret' })).body.credential;

    // Snapshot while the source is still open (online backup).
    const backupDir = tempDir();
    await backupDatabase(src.config.dbPath, path.join(backupDir, 'vault.sqlite'));
    fs.copyFileSync(path.join(src.config.configDir, KEY_FILE), path.join(backupDir, KEY_FILE));
    src.close();

    const target = tempDir();
    fs.mkdirSync(path.join(target, 'db'));
    fs.mkdirSync(path.join(target, 'config'));
    fs.copyFileSync(path.join(backupDir, 'vault.sqlite'), path.join(target, 'db', 'vault.sqlite'));
    fs.copyFileSync(path.join(backupDir, KEY_FILE), path.join(target, 'config', KEY_FILE));

    const restored = await createTestContext({ dir: target });
    const s2 = await login(restored);
    expect((await s2.get(`/api/credentials/${c.id}/secret`)).body.secret).toBe('restored-secret');
    restored.close();
  });
});
