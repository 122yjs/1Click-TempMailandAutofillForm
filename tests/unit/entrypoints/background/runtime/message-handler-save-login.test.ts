import { describe, expect, test } from 'bun:test';
import {
  normalizeSavedLoginCredential,
  senderTabHostname,
} from '@/entrypoints/background/runtime/message-handler';
import type { RuntimeMessageSender } from '@/utils/types.js';

describe('normalizeSavedLoginCredential', () => {
  test('accepts minimal valid credential', () => {
    const cred = normalizeSavedLoginCredential({
      email: 'user@temp.mail',
      domain: 'signup.example.com',
      timestamp: 1_700_000_000_000,
    });
    expect(cred).toEqual({
      domain: 'signup.example.com',
      timestamp: 1_700_000_000_000,
      email: 'user@temp.mail',
      username: null,
    });
  });

  test('rejects missing domain or identity', () => {
    expect(normalizeSavedLoginCredential({ email: 'a@b.com' })).toBeNull();
    expect(normalizeSavedLoginCredential({ domain: 'example.com' })).toBeNull();
  });

  test('strips unknown fields', () => {
    const cred = normalizeSavedLoginCredential({
      email: 'user@temp.mail',
      domain: 'example.com',
      evil: '<script>',
      password: 'secret',
      signupStatus: 'pending_submit',
      policyUrls: ['https://example.com/terms'],
      filledFields: ['email', 'password'],
    });
    expect(cred?.password).toBe('secret');
    expect(cred?.signupStatus).toBe('pending_submit');
    expect(cred?.policyUrls).toEqual(['https://example.com/terms']);
    expect((cred as Record<string, unknown>).evil).toBeUndefined();
  });

  test('rejects invalid signupStatus', () => {
    const cred = normalizeSavedLoginCredential({
      email: 'user@temp.mail',
      domain: 'example.com',
      signupStatus: 'hacked',
    });
    expect(cred?.signupStatus).toBeUndefined();
  });
});

describe('senderTabHostname', () => {
  test('extracts hostname from tab URL', () => {
    const sender: RuntimeMessageSender = {
      tab: { id: 1, url: 'https://accounts.example.com/signup' },
    };
    expect(senderTabHostname(sender)).toBe('accounts.example.com');
  });
});
