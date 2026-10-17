import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

export const KEY_LENGTH = 32; // AES-256
const NONCE_LENGTH = 12; // 96-bit nonce, recommended for GCM
const TAG_LENGTH = 16;
const FORMAT_VERSION = 1;

/**
 * Encrypts a secret with AES-256-GCM. A fresh random nonce is generated for every call.
 * `aad` binds the ciphertext to its record (credential id), so blobs cannot be swapped between rows.
 * Layout: [version:1][nonce:12][tag:16][ciphertext:n]
 */
export function encryptSecret(key: Buffer, plaintext: string, aad: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptSecret(key: Buffer, blob: Buffer, aad: string): string {
  assertKey(key);
  if (blob.length < 1 + NONCE_LENGTH + TAG_LENGTH || blob[0] !== FORMAT_VERSION) {
    throw new Error('Unsupported ciphertext format');
  }
  const nonce = blob.subarray(1, 1 + NONCE_LENGTH);
  const tag = blob.subarray(1 + NONCE_LENGTH, 1 + NONCE_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(1 + NONCE_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_LENGTH) throw new Error('Encryption key must be 32 bytes');
}

// ---------- Password hashing (scrypt) ----------

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_KEYLEN = 64;

function scrypt(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * params.N * params.r + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Returns `scrypt$N$r$p$salt$hash` (base64url parts). */
export async function hashPassword(password: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const actual = await scrypt(password, salt, params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- Tokens ----------

/** Access tokens are high-entropy random values, so a plain SHA-256 is an adequate one-way hash. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function generateAccessToken(): string {
  return `vlt_${randomBytes(32).toString('base64url')}`;
}

export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export function generateSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}
