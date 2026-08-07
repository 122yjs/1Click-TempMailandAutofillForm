import { describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword } from '@/utils/crypto';

describe('hashPassword', () => {
  test('returns salt:iterations:key format with hex chars only', async () => {
    const hash = await hashPassword('hello');
    expect(hash).toMatch(/^[0-9a-f]+:\d+:[0-9a-f]+$/);
  });

  test('salt and key segments have correct lengths', async () => {
    const hash = await hashPassword('hello');
    const [salt, iterations, key] = hash.split(':');
    expect(salt.length).toBe(32); // 16 bytes × 2
    expect(Number(iterations)).toBeGreaterThan(0);
    expect(key.length).toBe(64); // 32 bytes × 2
  });

  test('produces different hashes for same input (random salt)', async () => {
    const h1 = await hashPassword('password123');
    const h2 = await hashPassword('password123');
    expect(h1).not.toBe(h2); // Different salt each time
  });

  test('produces different hashes for different inputs', async () => {
    const [, , k1] = (await hashPassword('abc')).split(':');
    const [, , k2] = (await hashPassword('def')).split(':');
    expect(k1).not.toBe(k2);
  });

  test('is deterministic when same salt is supplied', async () => {
    const first = await hashPassword('hello');
    const [saltHex] = first.split(':');
    const second = await hashPassword('hello', saltHex);
    expect(first).toBe(second);
  });

  test('handles empty string', async () => {
    const hash = await hashPassword('');
    expect(hash).toMatch(/^[0-9a-f]+:\d+:[0-9a-f]+$/);
  });

  test('handles unicode characters', async () => {
    const hash = await hashPassword('héllo wörld');
    expect(hash).toMatch(/^[0-9a-f]+:\d+:[0-9a-f]+$/);
  });

  test('handles long input', async () => {
    const hash = await hashPassword('x'.repeat(10000));
    expect(hash).toMatch(/^[0-9a-f]+:\d+:[0-9a-f]+$/);
  });
});

describe('verifyPassword', () => {
  test('correct password verifies', async () => {
    const hash = await hashPassword('secret');
    expect(await verifyPassword('secret', hash)).toBe(true);
  });

  test('wrong password fails', async () => {
    const hash = await hashPassword('secret');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  test('verifies a legacy salt:key hash (pre-iteration-embedding)', async () => {
    // Legacy hashes were `salt:key` derived with the old 210k iteration count.
    const legacySalt = 'a'.repeat(32);
    const full = await hashPassword('legacy-pass', legacySalt, 210_000);
    const legacyHash = `${legacySalt}:${full.split(':')[2]}`;
    expect(legacyHash.split(':')).toHaveLength(2);
    expect(await verifyPassword('legacy-pass', legacyHash)).toBe(true);
    expect(await verifyPassword('wrong', legacyHash)).toBe(false);
  });

  test('returns false for malformed hash', async () => {
    expect(await verifyPassword('anything', 'notahash')).toBe(false);
  });
});
