import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { VaultError } from './errors.js';
import {
  DEFAULT_SCRYPT,
  decryptSecret,
  encryptSecret,
  generateAccessToken,
  generateSessionId,
  hashPassword,
  hashToken,
  safeEqualHex,
  verifyPassword,
  type ScryptParams,
} from './crypto.js';

export type CredentialStatus = 'active' | 'inactive';

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  credentialCount: number;
  inactiveCount: number;
}

/** Credential metadata. Never contains the secret. */
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

export interface CredentialWithSecret extends Credential {
  secret: string;
}

export interface CredentialInput {
  service: string;
  name: string;
  secret: string;
  status?: CredentialStatus;
}

export interface CredentialPatch {
  service?: string;
  name?: string;
  /** Empty string or undefined keeps the stored secret. */
  secret?: string;
  status?: CredentialStatus;
}

export const LIMITS = { projectName: 100, service: 100, keyName: 200, secret: 64 * 1024, email: 254 };
const KEY_CHECK_PLAINTEXT = 'project-vault-key-check';
const KEY_CHECK_AAD = 'key-check';

export const normalize = (s: string) => s.trim().normalize('NFKC').toLocaleLowerCase('ru-RU');

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new VaultError('VALIDATION_ERROR', `Field "${field}" must be a string`);
  const v = value.trim();
  if (!v) throw new VaultError('VALIDATION_ERROR', `Field "${field}" must not be empty`);
  if (v.length > max) throw new VaultError('VALIDATION_ERROR', `Field "${field}" is longer than ${max} characters`);
  return v;
}

function requireSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VaultError('VALIDATION_ERROR', 'Field "secret" must be a non-empty string');
  }
  if (value.length > LIMITS.secret) throw new VaultError('VALIDATION_ERROR', `Field "secret" is longer than ${LIMITS.secret} characters`);
  return value;
}

function requireStatus(value: unknown): CredentialStatus {
  if (value !== 'active' && value !== 'inactive') {
    throw new VaultError('VALIDATION_ERROR', 'Field "status" must be "active" or "inactive"');
  }
  return value;
}

function likePattern(q: string): string {
  return `%${normalize(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface CredentialRow {
  id: string;
  project_id: string;
  project_name: string;
  service: string;
  name: string;
  active: number;
  created_at: string;
  updated_at: string;
}

const CREDENTIAL_COLUMNS = `c.id, c.project_id, p.name AS project_name, c.service, c.name, c.active, c.created_at, c.updated_at`;

function toCredential(row: CredentialRow): Credential {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    service: row.service,
    name: row.name,
    status: row.active ? 'active' : 'inactive',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface VaultOptions {
  scrypt?: ScryptParams;
  now?: () => Date;
}

export class Vault {
  private readonly scryptParams: ScryptParams;
  private readonly now: () => Date;

  constructor(
    private readonly db: DB,
    private readonly key: Buffer,
    options: VaultOptions = {},
  ) {
    this.scryptParams = options.scrypt ?? DEFAULT_SCRYPT;
    this.now = options.now ?? (() => new Date());
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- admin

  isInitialized(): boolean {
    return !!this.db.prepare('SELECT 1 FROM admin WHERE id = 1').get();
  }

  async initializeAdmin(email: string, password: string, token: string): Promise<void> {
    if (this.isInitialized()) throw new Error('Admin is already initialized');
    const ts = this.ts();
    this.db
      .prepare(
        `INSERT INTO admin (id, email, password_hash, token_hash, key_check, created_at, token_rotated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        email.trim().toLowerCase(),
        await hashPassword(password, this.scryptParams),
        hashToken(token),
        encryptSecret(this.key, KEY_CHECK_PLAINTEXT, KEY_CHECK_AAD),
        ts,
        ts,
      );
  }

  /** Throws if the loaded encryption key is not the one the database was created with. */
  assertKeyMatches(): void {
    const row = this.db.prepare('SELECT key_check FROM admin WHERE id = 1').get() as { key_check: Buffer } | undefined;
    if (!row) return;
    let ok = false;
    try {
      ok = decryptSecret(this.key, row.key_check, KEY_CHECK_AAD) === KEY_CHECK_PLAINTEXT;
    } catch {
      ok = false;
    }
    if (!ok) throw new Error('Encryption key does not match the database (wrong or replaced master.key)');
  }

  getAdminEmail(): string {
    const row = this.db.prepare('SELECT email FROM admin WHERE id = 1').get() as { email: string } | undefined;
    if (!row) throw new Error('Admin is not initialized');
    return row.email;
  }

  verifyAccessToken(token: string | undefined | null): boolean {
    if (!token) return false;
    const row = this.db.prepare('SELECT token_hash FROM admin WHERE id = 1').get() as { token_hash: string } | undefined;
    return !!row && safeEqualHex(hashToken(token), row.token_hash);
  }

  /** Checks email + password + access token together. Always runs the password hash to keep timing uniform. */
  async verifyLogin(email: unknown, password: unknown, token: unknown): Promise<boolean> {
    const row = this.db.prepare('SELECT email, password_hash, token_hash FROM admin WHERE id = 1').get() as
      | { email: string; password_hash: string; token_hash: string }
      | undefined;
    if (!row) return false;
    const e = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const p = typeof password === 'string' ? password : '';
    const t = typeof token === 'string' ? token.trim() : '';
    const passwordOk = await verifyPassword(p, row.password_hash);
    const tokenOk = t.length > 0 && safeEqualHex(hashToken(t), row.token_hash);
    return passwordOk && tokenOk && e === row.email;
  }

  async verifyAdminPassword(password: unknown): Promise<boolean> {
    const row = this.db.prepare('SELECT password_hash FROM admin WHERE id = 1').get() as { password_hash: string } | undefined;
    return !!row && typeof password === 'string' && (await verifyPassword(password, row.password_hash));
  }

  /** Replaces the access token and ends every panel session. Returns the new token (shown once). */
  rotateAccessToken(): string {
    const token = generateAccessToken();
    this.db.transaction(() => {
      this.db.prepare('UPDATE admin SET token_hash = ?, token_rotated_at = ? WHERE id = 1').run(hashToken(token), this.ts());
      this.db.prepare('DELETE FROM sessions').run();
    })();
    return token;
  }

  // ---------------------------------------------------------------- sessions

  createSession(ttlMs: number): string {
    const id = generateSessionId();
    const now = this.now().getTime();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)').run(hashToken(id), now, now + ttlMs);
    return id;
  }

  isSessionValid(id: string | undefined): boolean {
    if (!id) return false;
    const row = this.db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(hashToken(id)) as
      | { expires_at: number }
      | undefined;
    return !!row && row.expires_at > this.now().getTime();
  }

  deleteSession(id: string | undefined): void {
    if (id) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(id));
  }

  // ---------------------------------------------------------------- projects

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.name, p.created_at, p.updated_at,
                COUNT(c.id) AS credential_count,
                COALESCE(SUM(CASE WHEN c.active = 0 THEN 1 ELSE 0 END), 0) AS inactive_count
         FROM projects p LEFT JOIN credentials c ON c.project_id = p.id
         GROUP BY p.id
         ORDER BY p.name_norm`,
      )
      .all() as Array<{ id: string; name: string; created_at: string; updated_at: string; credential_count: number; inactive_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      credentialCount: r.credential_count,
      inactiveCount: r.inactive_count,
    }));
  }

  getProject(id: string): Project {
    const p = this.listProjects().find((x) => x.id === id);
    if (!p) throw new VaultError('PROJECT_NOT_FOUND', `Project with id "${id}" not found`);
    return p;
  }

  /** Resolves a project by id or by (case-insensitive) name. */
  resolveProject(ref: unknown): Project {
    const name = requireText(ref, 'project', 200);
    const row = this.db
      .prepare('SELECT id FROM projects WHERE id = ? OR name_norm = ? ORDER BY id = ? DESC LIMIT 1')
      .get(name, normalize(name), name) as { id: string } | undefined;
    if (!row) throw new VaultError('PROJECT_NOT_FOUND', `Project "${name}" not found`);
    return this.getProject(row.id);
  }

  createProject(name: unknown): Project {
    const n = requireText(name, 'name', LIMITS.projectName);
    const id = randomUUID();
    const ts = this.ts();
    try {
      this.db.prepare('INSERT INTO projects (id, name, name_norm, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, n, normalize(n), ts, ts);
    } catch (e) {
      if (isUniqueViolation(e)) throw new VaultError('PROJECT_EXISTS', `Project "${n}" already exists`);
      throw e;
    }
    return this.getProject(id);
  }

  renameProject(id: string, name: unknown): Project {
    this.getProject(id);
    const n = requireText(name, 'name', LIMITS.projectName);
    try {
      this.db.prepare('UPDATE projects SET name = ?, name_norm = ?, updated_at = ? WHERE id = ?').run(n, normalize(n), this.ts(), id);
    } catch (e) {
      if (isUniqueViolation(e)) throw new VaultError('PROJECT_EXISTS', `Project "${n}" already exists`);
      throw e;
    }
    return this.getProject(id);
  }

  // ---------------------------------------------------------------- credentials

  /**
   * Lists credentials (without secrets). `projectId` limits to one project;
   * `query` matches project name, service and key name.
   */
  listCredentials(opts: { projectId?: string; query?: string; status?: CredentialStatus | 'all' } = {}): Credential[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.projectId) {
      this.getProject(opts.projectId);
      where.push('c.project_id = ?');
      params.push(opts.projectId);
    }
    if (opts.query && opts.query.trim()) {
      const pattern = likePattern(opts.query);
      where.push(`(p.name_norm LIKE ? ESCAPE '\\' OR c.service_norm LIKE ? ESCAPE '\\' OR c.name_norm LIKE ? ESCAPE '\\')`);
      params.push(pattern, pattern, pattern);
    }
    if (opts.status && opts.status !== 'all') {
      where.push('c.active = ?');
      params.push(requireStatus(opts.status) === 'active' ? 1 : 0);
    }
    const sql = `SELECT ${CREDENTIAL_COLUMNS} FROM credentials c JOIN projects p ON p.id = c.project_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY p.name_norm, c.service_norm, c.name_norm`;
    return (this.db.prepare(sql).all(...params) as CredentialRow[]).map(toCredential);
  }

  getCredential(id: unknown): Credential {
    const cid = requireText(id, 'id', 100);
    const row = this.db
      .prepare(`SELECT ${CREDENTIAL_COLUMNS} FROM credentials c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`)
      .get(cid) as CredentialRow | undefined;
    if (!row) throw new VaultError('CREDENTIAL_NOT_FOUND', `Credential with id "${cid}" not found`);
    return toCredential(row);
  }

  findCredential(projectId: string, service: unknown, name: unknown): Credential | null {
    const s = requireText(service, 'service', LIMITS.service);
    const n = requireText(name, 'name', LIMITS.keyName);
    const row = this.db
      .prepare(
        `SELECT ${CREDENTIAL_COLUMNS} FROM credentials c JOIN projects p ON p.id = c.project_id
         WHERE c.project_id = ? AND c.service_norm = ? AND c.name_norm = ?`,
      )
      .get(projectId, normalize(s), normalize(n)) as CredentialRow | undefined;
    return row ? toCredential(row) : null;
  }

  /** The only method that decrypts a secret. */
  revealCredential(id: unknown): CredentialWithSecret {
    const meta = this.getCredential(id);
    const row = this.db.prepare('SELECT secret FROM credentials WHERE id = ?').get(meta.id) as { secret: Buffer };
    return { ...meta, secret: decryptSecret(this.key, row.secret, meta.id) };
  }

  createCredential(projectId: string, input: CredentialInput): Credential {
    this.getProject(projectId);
    const service = requireText(input.service, 'service', LIMITS.service);
    const name = requireText(input.name, 'name', LIMITS.keyName);
    const secret = requireSecret(input.secret);
    const status = input.status === undefined ? 'active' : requireStatus(input.status);
    const id = randomUUID();
    const ts = this.ts();
    try {
      this.db
        .prepare(
          `INSERT INTO credentials (id, project_id, service, service_norm, name, name_norm, secret, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, projectId, service, normalize(service), name, normalize(name), encryptSecret(this.key, secret, id), status === 'active' ? 1 : 0, ts, ts);
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateCredential(service, name);
      throw e;
    }
    this.touchProject(projectId);
    return this.getCredential(id);
  }

  updateCredential(id: unknown, patch: CredentialPatch): Credential {
    const current = this.getCredential(id);
    const service = patch.service === undefined ? current.service : requireText(patch.service, 'service', LIMITS.service);
    const name = patch.name === undefined ? current.name : requireText(patch.name, 'name', LIMITS.keyName);
    const status = patch.status === undefined ? current.status : requireStatus(patch.status);
    const newSecret = patch.secret === undefined || patch.secret === '' ? null : requireSecret(patch.secret);
    const ts = this.ts();
    try {
      if (newSecret === null) {
        this.db
          .prepare('UPDATE credentials SET service = ?, service_norm = ?, name = ?, name_norm = ?, active = ?, updated_at = ? WHERE id = ?')
          .run(service, normalize(service), name, normalize(name), status === 'active' ? 1 : 0, ts, current.id);
      } else {
        this.db
          .prepare(
            'UPDATE credentials SET service = ?, service_norm = ?, name = ?, name_norm = ?, active = ?, secret = ?, updated_at = ? WHERE id = ?',
          )
          .run(service, normalize(service), name, normalize(name), status === 'active' ? 1 : 0, encryptSecret(this.key, newSecret, current.id), ts, current.id);
      }
    } catch (e) {
      if (isUniqueViolation(e)) throw duplicateCredential(service, name);
      throw e;
    }
    this.touchProject(current.projectId);
    return this.getCredential(current.id);
  }

  /**
   * Creates or updates a credential. With `id` the record is updated; otherwise the record is
   * matched by (project, service, name), updated if found and created if not.
   */
  upsertCredential(
    projectRef: unknown,
    input: { id?: string; service: string; name: string; secret?: string; status?: CredentialStatus },
  ): { created: boolean; credential: Credential } {
    const project = this.resolveProject(projectRef);
    if (input.id) {
      const existing = this.getCredential(input.id);
      if (existing.projectId !== project.id) {
        throw new VaultError('VALIDATION_ERROR', `Credential "${input.id}" belongs to project "${existing.projectName}", not "${project.name}"`);
      }
      return { created: false, credential: this.updateCredential(existing.id, input) };
    }
    const existing = this.findCredential(project.id, input.service, input.name);
    if (existing) return { created: false, credential: this.updateCredential(existing.id, input) };
    if (input.secret === undefined || input.secret === '') {
      throw new VaultError('VALIDATION_ERROR', 'Field "secret" is required when creating a new credential');
    }
    return { created: true, credential: this.createCredential(project.id, { ...input, secret: input.secret }) };
  }

  setCredentialStatus(id: unknown, status: unknown): Credential {
    return this.updateCredential(id, { status: requireStatus(status) });
  }

  deleteCredential(id: unknown): Credential {
    const current = this.getCredential(id);
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(current.id);
    this.touchProject(current.projectId);
    return current;
  }

  /** Deletes only inactive credentials of the project and returns how many were removed. */
  deleteInactiveCredentials(projectId: string): number {
    this.getProject(projectId);
    const { changes } = this.db.prepare('DELETE FROM credentials WHERE project_id = ? AND active = 0').run(projectId);
    if (changes) this.touchProject(projectId);
    return changes;
  }

  private touchProject(projectId: string): void {
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(this.ts(), projectId);
  }
}

function duplicateCredential(service: string, name: string): VaultError {
  return new VaultError('CREDENTIAL_EXISTS', `Credential "${name}" for service "${service}" already exists in this project`);
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}
