import { describe, expect, test } from 'bun:test';
import { generatePassword } from '@/entrypoints/content/autofill/generators.js';

describe('password strength match', () => {
  test('generated password meets min length and classes', () => {
    const pw = generatePassword({
      minLength: 14,
      maxLength: 18,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
      requireSpecial: true,
    });
    expect(pw.length).toBeGreaterThanOrEqual(14);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/\d/.test(pw)).toBe(true);
  });

  test('can disable special characters', () => {
    const pw = generatePassword({
      minLength: 10,
      maxLength: 12,
      requireSpecial: false,
      requireUpper: true,
      requireLower: true,
      requireDigit: true,
    });
    expect(pw.length).toBeGreaterThanOrEqual(10);
  });
});
