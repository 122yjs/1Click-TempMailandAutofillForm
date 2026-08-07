import { describe, expect, test } from 'bun:test';
import {
  isDomainAllowedForSender,
  senderTabHostname,
} from '@/entrypoints/background/runtime/message-handler';
import type { RuntimeMessageSender } from '@/utils/types.js';

function contentSender(hostname: string, tabUrl?: string): RuntimeMessageSender {
  return {
    id: 'test-extension',
    url: tabUrl ?? `https://${hostname}/signup`,
    tab: { id: 1, url: tabUrl ?? `https://${hostname}/signup` },
  };
}

describe('senderTabHostname', () => {
  test('returns hostname from tab URL', () => {
    expect(senderTabHostname(contentSender('example.com'))).toBe('example.com');
  });

  test('returns null when tab URL is missing', () => {
    expect(senderTabHostname({ id: 'x' })).toBeNull();
  });
});

describe('isDomainAllowedForSender', () => {
  test('allows matching domain from content script tab', () => {
    expect(isDomainAllowedForSender('example.com', contentSender('example.com'))).toBe(true);
    expect(isDomainAllowedForSender('www.example.com', contentSender('example.com'))).toBe(true);
  });

  test('rejects cross-site domain queries from content scripts', () => {
    expect(isDomainAllowedForSender('evil.com', contentSender('example.com'))).toBe(false);
  });
});
