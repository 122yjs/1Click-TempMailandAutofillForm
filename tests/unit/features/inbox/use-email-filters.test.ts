import { describe, expect, test } from 'bun:test';
import { applySearchShortcuts, type FilterCriteria } from '@/features/inbox/use-email-filters.js';

const base: FilterCriteria = {
  searchQuery: '',
  otpOnly: false,
  hasAttachment: false,
  senderDomain: '',
  senderEmail: '',
  recipient: '',
  subject: '',
  notSenderDomain: '',
  notSenderEmail: '',
  notRecipient: '',
  notSubject: '',
  selectedSenders: [],
  dateFrom: '',
  dateTo: '',
  sortBy: 'newest',
};

describe('applySearchShortcuts', () => {
  test('is:otp turns the filter on and keeps the search text', () => {
    const out = applySearchShortcuts('is:otp welcome', base);
    expect(out.otpOnly).toBe(true);
    expect(out.searchQuery).toBe('welcome');
  });

  test('!is:otp explicitly clears an already-on OTP filter', () => {
    const out = applySearchShortcuts('!is:otp', { ...base, otpOnly: true });
    expect(out.otpOnly).toBe(false);
  });

  test('!has:attachment explicitly clears an already-on attachment filter', () => {
    const out = applySearchShortcuts('!has:attachment', { ...base, hasAttachment: true });
    expect(out.hasAttachment).toBe(false);
  });

  test('absent shortcut leaves the current filter state untouched', () => {
    const out = applySearchShortcuts('welcome', { ...base, otpOnly: true, hasAttachment: true });
    expect(out.otpOnly).toBe(true);
    expect(out.hasAttachment).toBe(true);
  });

  test('non-shortcut text leaves filters unchanged', () => {
    const out = applySearchShortcuts('plain query', base);
    expect(out.otpOnly).toBe(false);
    expect(out.hasAttachment).toBe(false);
    expect(out.searchQuery).toBe('plain query');
  });

  test('!from:domain sets the exclusion field and keeps the search text', () => {
    const out = applySearchShortcuts('!from:github.com invoices', base);
    expect(out.notSenderDomain).toBe('github.com');
    expect(out.senderDomain).toBe('');
    expect(out.searchQuery).toBe('invoices');
  });

  test('!from:email sets the email exclusion field', () => {
    const out = applySearchShortcuts('!from:support@github.com', base);
    expect(out.notSenderEmail).toBe('support@github.com');
    expect(out.notSenderDomain).toBe('');
  });

  test('!to: sets the recipient exclusion field', () => {
    const out = applySearchShortcuts('!to:user@domain.com', base);
    expect(out.notRecipient).toBe('user@domain.com');
  });

  test('!subject: sets the subject exclusion field', () => {
    const out = applySearchShortcuts('!subject:verify', base);
    expect(out.notSubject).toBe('verify');
  });

  test('absent value shortcut clears exclusions (pill removal round-trip)', () => {
    // Value shortcuts are query-owned (no chips): removing the token from the
    // query must clear the exclusion so pill removal round-trips cleanly.
    const withExclusions = {
      ...base,
      notSenderDomain: 'spam.com',
      notRecipient: 'old@x.com',
      notSubject: 'unsubscribe',
    };
    const out = applySearchShortcuts('welcome', withExclusions);
    expect(out.notSenderDomain).toBe('');
    expect(out.notRecipient).toBe('');
    expect(out.notSubject).toBe('');
  });

  test('non-shortcut text does not clobber active exclusions when pill token present', () => {
    // When the query still carries the pill token, the exclusion is reapplied
    // even though free text was added.
    const withExclusions = { ...base, notSenderDomain: 'github.com' };
    const out = applySearchShortcuts('!from:github.com invoices', withExclusions);
    expect(out.notSenderDomain).toBe('github.com');
    expect(out.searchQuery).toBe('invoices');
  });

  test('subject token sets the field and clears on removal', () => {
    const set = applySearchShortcuts('subject:verify', base);
    expect(set.subject).toBe('verify');
    const cleared = applySearchShortcuts('plain', set);
    expect(cleared.subject).toBe('');
  });

  test('negated subject token sets notSubject and clears the positive subject', () => {
    const out = applySearchShortcuts('!subject:spam', { ...base, subject: 'news' });
    expect(out.notSubject).toBe('spam');
    expect(out.subject).toBe('');
  });

  test('removing a positive from: pill clears the sender filters', () => {
    const withSender = { ...base, senderDomain: 'github.com', senderEmail: '' };
    const out = applySearchShortcuts('invoices', withSender);
    expect(out.senderDomain).toBe('');
  });
});
