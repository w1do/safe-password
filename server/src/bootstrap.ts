import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { KEY_LENGTH, generateAccessToken, generateKey, generatePassword, type ScryptParams } from './crypto.js';
import { openDatabase, type DB } from './db.js';
import type { Logger } from './logger.js';
import { LIMITS, Vault } from './vault.js';

export const KEY_FILE = 'master.key';
export const CREDENTIALS_FILE = 'initial-credentials.txt';
const DEFAULT_EMAIL = 'admin@vault.local';

export interface Bootstrapped {
  db: DB;
  vault: Vault;
}

/**
 * Opens (or creates) the database and the encryption key, and initializes the admin on first run.
 * Re-running never changes the existing credentials, token or key.
 */
export async function bootstrap(config: AppConfig, log: Logger, opts: { scrypt?: ScryptParams } = {}): Promise<Bootstrapped> {
  fs.mkdirSync(config.configDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  try {
    const initialized = !!db.prepare('SELECT 1 FROM admin WHERE id = 1').get();
    const key = loadOrCreateKey(config.configDir, initialized, log);
    const vault = new Vault(db, key, { scrypt: opts.scrypt });

    if (initialized) {
      vault.assertKeyMatches();
      const { email, password, token } = config.initial;
      if (email || password || token) {
        log.info('Admin already initialized; VAULT_ADMIN_* / VAULT_ACCESS_TOKEN environment values are ignored');
      }
    } else {
      await initializeAdmin(vault, config, log);
    }
    return { db, vault };
  } catch (e) {
    db.close();
    throw e;
  }
}

function loadOrCreateKey(configDir: string, dbInitialized: boolean, log: Logger): Buffer {
  const keyPath = path.join(configDir, KEY_FILE);
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (key.length !== KEY_LENGTH) throw new Error(`${keyPath} must contain a base64-encoded 32-byte key`);
    tightenPermissions(keyPath);
    return key;
  }
  if (dbInitialized) {
    // Generating a new key here would make every stored secret undecryptable.
    throw new Error(`Encryption key ${keyPath} is missing but the database already contains data. Restore master.key from backup.`);
  }
  const key = generateKey();
  fs.writeFileSync(keyPath, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  log.info('Generated new encryption key', { file: keyPath });
  return key;
}

async function initializeAdmin(vault: Vault, config: AppConfig, log: Logger): Promise<void> {
  const env = config.initial;
  const email = (env.email ?? DEFAULT_EMAIL).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > LIMITS.email) throw new Error('VAULT_ADMIN_EMAIL is not a valid email');
  if (env.password !== undefined && env.password.length < 12) throw new Error('VAULT_ADMIN_PASSWORD must be at least 12 characters');
  if (env.token !== undefined && (env.token.length < 32 || /\s/.test(env.token))) {
    throw new Error('VAULT_ACCESS_TOKEN must be at least 32 characters without whitespace');
  }
  const password = env.password ?? generatePassword();
  const token = env.token ?? generateAccessToken();

  await vault.initializeAdmin(email, password, token);

  const file = path.join(config.configDir, CREDENTIALS_FILE);
  const lines = [
    '# Project Vault — initial administrator credentials',
    `# Created: ${new Date().toISOString()}`,
    '# Delete this file after saving the values in a password manager.',
    '# After the access token is rotated in the panel, the token below no longer works.',
    '',
    `EMAIL=${email}`,
    `PASSWORD=${env.password ? '(set via VAULT_ADMIN_PASSWORD)' : password}`,
    `ACCESS_TOKEN=${env.token ? '(set via VAULT_ACCESS_TOKEN)' : token}`,
    '',
  ];
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
  tightenPermissions(file);
  log.info('Admin initialized; initial credentials written to a protected file', { file });
}

function tightenPermissions(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* read-only filesystem or foreign owner — not fatal */
  }
}
