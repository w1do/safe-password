import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateKey, hashPassword, verifyPassword } from '../src/crypto.js';
import { TEST_SCRYPT } from './helpers.js';

describe('AES-256-GCM', () => {
  const key = generateKey();

  it('round-trips and uses a fresh nonce every time', () => {
    const a = encryptSecret(key, 'ghp_secret', 'id-1');
    const b = encryptSecret(key, 'ghp_secret', 'id-1');
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(1, 13).equals(b.subarray(1, 13))).toBe(false);
    expect(decryptSecret(key, a, 'id-1')).toBe('ghp_secret');
    expect(a.includes(Buffer.from('ghp_secret'))).toBe(false);
  });

  it('rejects a wrong key, wrong AAD and tampered ciphertext', () => {
    const blob = encryptSecret(key, 'пароль', 'id-1');
    expect(() => decryptSecret(generateKey(), blob, 'id-1')).toThrow();
    expect(() => decryptSecret(key, blob, 'id-2')).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(key, tampered, 'id-1')).toThrow();
  });
});

describe('password hashing', () => {
  it('verifies only the right password', async () => {
    const hash = await hashPassword('s3cret-password', TEST_SCRYPT);
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('s3cret-password');
    expect(await verifyPassword('s3cret-password', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});
