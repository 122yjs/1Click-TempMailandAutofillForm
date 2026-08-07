import { describe, expect, test } from 'bun:test';
import { extractHtmlPartFromRawSource, mapMessageItem } from '@/utils/dsl/email-fetcher.js';

const attachmentMapping = {
  enabled: true,
  path: 'att_info',
  hasAttachmentFlagPath: 'att',
  fields: {
    filename: 'f',
    mimeType: 't',
    partNumber: 'p',
    downloadUrl: null as string | null,
  },
};

describe('mapMessageItem hasAttachment flag', () => {
  test('sets hasAttachment when the list flag is "1"', () => {
    const mapped = mapMessageItem(
      { att: '1', att_info: [{ f: 'scan.pdf', t: 'application/pdf', p: '2' }] },
      null,
      attachmentMapping
    );
    expect(mapped.hasAttachment).toBe(true);
    expect(Array.isArray(mapped.attachments)).toBe(true);
  });

  test('does not set hasAttachment when the flag is "0"', () => {
    const mapped = mapMessageItem({ att: '0' }, null, attachmentMapping);
    expect(mapped.hasAttachment).toBeUndefined();
  });

  test('ignores a missing or empty flag', () => {
    expect(mapMessageItem({}, null, attachmentMapping).hasAttachment).toBeUndefined();
    expect(mapMessageItem({ att: '' }, null, attachmentMapping).hasAttachment).toBeUndefined();
    expect(mapMessageItem({ att: null }, null, attachmentMapping).hasAttachment).toBeUndefined();
  });

  test('treats truthy non-numeric flags as attached', () => {
    expect(mapMessageItem({ att: true }, null, attachmentMapping).hasAttachment).toBe(true);
    expect(mapMessageItem({ att: 'yes' }, null, attachmentMapping).hasAttachment).toBe(true);
  });

  test('no flag path configured leaves hasAttachment unset', () => {
    const noFlag = { ...attachmentMapping, hasAttachmentFlagPath: undefined };
    expect(mapMessageItem({ att: '1' }, null, noFlag).hasAttachment).toBeUndefined();
  });
});

describe('extractHtmlPartFromRawSource', () => {
  const multipartRaw = `Delivered-To: aa@sharklasers.com
Content-Type: multipart/alternative; boundary="_av-EIxz-JyoJIfI7spUI7kcZA"

--_av-EIxz-JyoJIfI7spUI7kcZA
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Plain text part
--_av-EIxz-JyoJIfI7spUI7kcZA
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<table style=3D"background-color:#ffffff">\r\n  <tr><td>Hello</td></tr>\r\n</table>
--_av-EIxz-JyoJIfI7spUI7kcZA--
`;

  test('extracts and quoted-printable-decodes the HTML part of a multipart message', () => {
    const html = extractHtmlPartFromRawSource(multipartRaw);
    expect(html).not.toBeNull();
    expect(html).toContain('<table');
    expect(html).toContain('background-color:#ffffff');
    expect(html).toContain('<td>Hello</td>');
    expect(html).not.toContain('Plain text part');
  });

  test('decodes base64-encoded HTML parts', () => {
    const html = '<h1>Base64 Body</h1>';
    const b64 = btoa(html);
    const raw = `Content-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--b--\r\n`;
    expect(extractHtmlPartFromRawSource(raw)).toBe(html);
  });

  test('handles a single-part HTML message without multipart boundary', () => {
    const raw = 'Content-Type: text/html; charset=UTF-8\r\n\r\n<p>Single part</p>';
    expect(extractHtmlPartFromRawSource(raw)).toBe('<p>Single part</p>');
  });

  test('returns null for a raw source with no HTML part', () => {
    const raw = `Content-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOnly plain\r\n--b--\r\n`;
    expect(extractHtmlPartFromRawSource(raw)).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(extractHtmlPartFromRawSource('')).toBeNull();
    expect(extractHtmlPartFromRawSource(undefined as unknown as string)).toBeNull();
  });
});
