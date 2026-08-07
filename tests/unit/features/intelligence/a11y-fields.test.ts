import { describe, expect, test } from 'bun:test';
import { matchKindFromTextExport } from './a11y-test-helpers.js';

// Pure text matching (no DOM) — classifyFieldA11y needs document in real env
describe('a11y field text matching', () => {
  test('detects email wording', () => {
    expect(matchKindFromTextExport('your email address')?.kind).toBe('email');
  });
  test('detects phone wording', () => {
    expect(matchKindFromTextExport('mobile phone number')?.kind).toBe('phone');
  });
  test('detects password wording', () => {
    expect(matchKindFromTextExport('create a password')?.kind).toBe('password');
  });
  test('returns null for empty', () => {
    expect(matchKindFromTextExport('')).toBeNull();
  });
});
