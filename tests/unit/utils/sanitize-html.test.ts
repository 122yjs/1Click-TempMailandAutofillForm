import { describe, expect, test } from 'bun:test';
import {
  escapeHtmlText,
  initSanitize,
  sanitizeHtml,
  sanitizeStyleBlockCss,
} from '@/utils/sanitize-html.js';

describe('escapeHtmlText', () => {
  test('escapes plain text before it is wrapped in HTML containers', () => {
    expect(escapeHtmlText('<img src=x onerror=alert(1)> & "quote"')).toBe(
      '&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quote&quot;'
    );
  });
});

describe('sanitizeHtml', () => {
  test('strips HTML tags when DOMPurify is not yet loaded', () => {
    const raw = '<p>Hello <strong>World</strong> <script>alert(1)</script></p>';
    // Since DOMPurify is not loaded, it falls back to tag stripping regex
    const sanitized = sanitizeHtml(raw);
    expect(sanitized).toContain('Hello World');
    // Script/style bodies are removed entirely — they must never leak as text
    expect(sanitized).not.toContain('alert(1)');
    expect(sanitized).not.toContain('<p>');
  });

  describe('with DOMPurify loaded', () => {
    test('preloads DOMPurify successfully', async () => {
      await initSanitize();
    });

    test('decodes and unblocks Guerrilla Mail proxy image resources', () => {
      const raw =
        '<img src="https://www.guerrillamail.com/res.php?r=1&amp;n=img&amp;q=https%3A%2F%2Fexample.com%2Flogo.png" />';
      const sanitized = sanitizeHtml(raw, { allowImages: true });
      expect(sanitized).toContain('src="https://example.com/logo.png"');

      const rawRawAmp = '<img src="/res.php?r=1&n=img&q=https%3A%2F%2Fexample.org%2Flogo2.png" />';
      const sanitizedRawAmp = sanitizeHtml(rawRawAmp, { allowImages: true });
      expect(sanitizedRawAmp).toContain('src="https://example.org/logo2.png"');
    });

    test('strips remote images by default (privacy)', () => {
      const raw = '<p>Hi</p><img src="https://example.com/track.png" alt="x" />';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).not.toContain('<img');
      expect(sanitized).toContain('Hi');
    });

    test('sanitizes HTML properly after DOMPurify is loaded', () => {
      const raw = '<p>Hello <strong>World</strong><script>alert(1)</script></p>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).toContain('<p>Hello <strong>World</strong></p>');
      expect(sanitized).not.toContain('<script>');
    });

    test('keeps inline style attributes but strips style blocks', () => {
      const raw =
        '<div style="color: red; padding: 10px;">Content</div><style>.btn { background: blue; }</style>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).toContain('style="color: red; padding: 10px;"');
      // <style> would inject GLOBAL css into the extension UI — must be removed
      expect(sanitized).not.toContain('<style');
      expect(sanitized).not.toContain('.btn');
    });

    test('keeps sanitized style blocks only when allowStyleBlocks is set (shadow DOM path)', () => {
      const raw =
        '<div>Hello</div><style>@media only screen and (max-width: 480px) { .info-item { display: block !important; } }</style>';
      // Default: stripped
      const stripped = sanitizeHtml(raw);
      expect(stripped).not.toContain('<style');
      expect(stripped).not.toContain('@media');
      // Shadow-DOM path: sanitized block kept
      const kept = sanitizeHtml(raw, { allowStyleBlocks: true });
      expect(kept).toContain('<style>');
      expect(kept).toContain('@media only screen and (max-width: 480px)');
      expect(kept).toContain('.info-item { display: block !important; }');
      expect(kept).toContain('Hello');
    });

    test('strips dangerous CSS from allowed style blocks (url, overlay props, imports)', () => {
      const raw =
        '<style>' +
        '@import url("https://evil.example/x.css");' +
        '@font-face { font-family: x; src: url(https://evil.example/f.woff); }' +
        '.overlay { position: fixed; inset: 0; z-index: 99999; transform: scale(1); opacity: 0; }' +
        '.tracker { background-image: url(https://evil.example/pixel.png); }' +
        '.clean { color: #333; padding: 8px; }' +
        '</style>';
      const sanitized = sanitizeHtml(raw, { allowStyleBlocks: true });
      expect(sanitized).not.toContain('@import');
      expect(sanitized).not.toContain('@font-face');
      expect(sanitized).not.toContain('position');
      expect(sanitized).not.toContain('z-index');
      expect(sanitized).not.toContain('transform');
      expect(sanitized).not.toContain('opacity');
      expect(sanitized).not.toContain('url(');
      expect(sanitized).toContain('.clean { color: #333; padding: 8px; }');
      expect(sanitized).not.toContain('.overlay');
      expect(sanitized).not.toContain('.tracker');
    });

    test('strips :host / :root selectors and custom properties from style blocks', () => {
      const raw =
        '<style>:host { display: none; } :root { --x: 1; } .ok { --local: red; color: var(--local); }</style>';
      const sanitized = sanitizeHtml(raw, { allowStyleBlocks: true });
      expect(sanitized).not.toContain(':host');
      expect(sanitized).not.toContain(':root');
      // The --local: red declaration is dropped (custom props could smuggle
      // values); a var() reference in a value is harmless because no --* can
      // ever be defined, so it just resolves to initial.
      expect(sanitized).not.toContain('--local: red');
      expect(sanitized).toContain('.ok { color: var(--local); }');
    });

    test('strips document-level tags that could restyle the app', () => {
      const raw =
        '<html><head><style>body { display: none; }</style><link rel="stylesheet" href="https://evil.example/x.css"></head><body><p>Hi</p></body></html>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).not.toContain('<style');
      expect(sanitized).not.toContain('<link');
      expect(sanitized).not.toContain('<html');
      expect(sanitized).not.toContain('<head');
      expect(sanitized).not.toContain('<body');
      expect(sanitized).toContain('Hi');
    });

    test('strips overlay/phishing CSS from inline styles', () => {
      const raw =
        '<div style="color: red; position: fixed; inset: 0; z-index: 99999; width: 100vw; height: 100vh;">Content</div>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).not.toContain('position');
      expect(sanitized).not.toContain('z-index');
      expect(sanitized).not.toContain('inset');
      expect(sanitized).toContain('color: red');
      expect(sanitized).toContain('Content');
    });

    test('strips class/id attributes from email content', () => {
      const raw = '<p id="app" class="flex hidden">Content</p>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).not.toContain('id=');
      expect(sanitized).not.toContain('class=');
      expect(sanitized).toContain('<p>Content</p>');
    });

    test('forces rel="noopener noreferrer" and target="_blank" on links', () => {
      const raw = '<a href="https://example.com">Link</a>';
      const sanitized = sanitizeHtml(raw);
      expect(sanitized).toContain('rel="noopener noreferrer"');
      expect(sanitized).toContain('target="_blank"');
    });

    describe('dark-mode neutralization', () => {
      test('rewrites light backgrounds to transparent, keeping layout', () => {
        const raw = '<div style="background-color: #ffffff; padding: 12px;">Content</div>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).toContain('background-color: transparent');
        expect(sanitized).toContain('padding: 12px');
      });

      test('rewrites dark text colors to inherit, keeping other props', () => {
        const raw = '<p style="color: #111111; font-size: 14px;">Content</p>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).toContain('color: inherit');
        expect(sanitized).toContain('font-size: 14px');
      });

      test('handles rgb() and named colors', () => {
        const raw = '<div style="background: rgb(255, 255, 255); color: black;">Content</div>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).toContain('background: transparent');
        expect(sanitized).toContain('color: inherit');
      });

      test('keeps mid-tone backgrounds and light text', () => {
        const raw = '<div style="background-color: #2b2b2b; color: #e0e0e0;">Content</div>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).toContain('#2b2b2b');
        expect(sanitized).toContain('#e0e0e0');
      });

      test('neutralizes bgcolor attribute and dark font color attribute', () => {
        const raw =
          '<table bgcolor="#ffffff"><tr><td bgcolor="#f7f7f7">Hi</td></tr></table><font color="#000000">Text</font>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).not.toContain('bgcolor');
        expect(sanitized).not.toContain('color="#000000"');
        expect(sanitized).toContain('Hi');
        expect(sanitized).toContain('Text');
      });

      test('rewrites a light leading token in a background shorthand', () => {
        const raw = '<div style="background: #ffffff center no-repeat; width: 100%;">Content</div>';
        const sanitized = sanitizeHtml(raw, { darkMode: true });
        expect(sanitized).toContain('transparent center no-repeat');
        expect(sanitized).toContain('width: 100%');
      });

      test('is disabled by default so light-mode emails keep their colors', () => {
        const raw = '<div style="background-color: #ffffff; color: #111111;">Content</div>';
        const sanitized = sanitizeHtml(raw);
        expect(sanitized).toContain('#ffffff');
        expect(sanitized).toContain('#111111');
      });
    });
  });
});

describe('sanitizeStyleBlockCss', () => {
  test('keeps responsive @media rules with layout declarations', () => {
    const css =
      '@media only screen and (max-width: 480px) { .info-item { display: block !important; } .info-item { border-left: none !important; } }';
    const out = sanitizeStyleBlockCss(css);
    expect(out).toContain('@media only screen and (max-width: 480px)');
    expect(out).toContain('display: block !important');
    expect(out).toContain('border-left: none !important');
  });

  test('keeps plain rules and normalizes vendor-prefixed forbidden props', () => {
    const css = '.a { color: red; -webkit-transform: scale(2); -moz-position: fixed; }';
    const out = sanitizeStyleBlockCss(css);
    expect(out).toContain('color: red');
    expect(out).not.toContain('transform');
    expect(out).not.toContain('position');
  });

  test('drops at-rules that load external resources or animate', () => {
    const css =
      '@import url(x.css); @font-face { src: url(f.woff); } @keyframes spin { to { transform: rotate(1turn); } } .ok { color: blue; }';
    const out = sanitizeStyleBlockCss(css);
    expect(out).not.toContain('@import');
    expect(out).not.toContain('@font-face');
    expect(out).not.toContain('@keyframes');
    expect(out).not.toContain('url(');
    expect(out).toContain('color: blue');
  });

  test('keeps @supports feature queries', () => {
    const css = '@supports (display: grid) { .g { display: grid; } }';
    const out = sanitizeStyleBlockCss(css);
    expect(out).toContain('@supports (display: grid)');
    expect(out).toContain('display: grid');
  });

  test('strips comments and empty results return empty string', () => {
    expect(sanitizeStyleBlockCss('/* hidden */ .x { /* inner */ color: red; }')).toContain(
      'color: red'
    );
    expect(sanitizeStyleBlockCss('.x { position: fixed; }')).toBe('');
    expect(sanitizeStyleBlockCss('')).toBe('');
    expect(sanitizeStyleBlockCss('   ')).toBe('');
  });

  test('strips expression() and behavior: scripting vectors', () => {
    const css = '.x { width: expression(alert(1)); behavior: url(evil.htc); } .y { width: 10px; }';
    const out = sanitizeStyleBlockCss(css);
    expect(out).not.toContain('expression');
    expect(out).not.toContain('behavior');
    expect(out).not.toContain('url(');
    expect(out).toContain('.y { width: 10px; }');
  });

  test('neutralizes light backgrounds and dark text when darkMode is set', () => {
    const css = '.box { background-color: #ffffff; color: #111111; padding: 8px; }';
    const light = sanitizeStyleBlockCss(css);
    expect(light).toContain('#ffffff');
    expect(light).toContain('#111111');
    const dark = sanitizeStyleBlockCss(css, { darkMode: true });
    expect(dark).toContain('background-color: transparent');
    expect(dark).toContain('color: inherit');
    expect(dark).toContain('padding: 8px');
  });

  test('darkMode neutralization also applies inside kept @media blocks', () => {
    const css = '@media (max-width: 480px) { .box { background-color: #ffffff; } }';
    const dark = sanitizeStyleBlockCss(css, { darkMode: true });
    expect(dark).toContain('@media (max-width: 480px)');
    expect(dark).toContain('background-color: transparent');
    expect(dark).not.toContain('#ffffff');
  });
});

describe('style-block HTML breakout protection', () => {
  test('escapes </style> inside CSS strings so the tag cannot close early', () => {
    // `</style foo>` (whitespace after the name) closes a <style> element in
    // the HTML parser but is NOT matched by the block-extraction regex — so
    // without escaping it would land as raw HTML in the shadow root.
    const raw = '<style>.x { content: "</style foo><img src=x onerror=alert(1)>bar"; }</style>';
    const sanitized = sanitizeHtml(raw, { allowStyleBlocks: true });
    // CSS is kept (content is a safe declaration) but `</style` becomes
    // `<\/style` (\/ is a CSS escape for /), so the parser never sees a close.
    expect(sanitized).toContain('<\\/style foo>');
    expect(sanitized).not.toContain('</style foo>');
    // Exactly one real closing tag survives — the one we emit.
    expect((sanitized.match(/<\/style>/gi) || []).length).toBe(1);
  });

  test('escapes case-insensitive </STYLE> variants', () => {
    const raw = '<style>.x { content: "</STYLE foo><b>hi</b>bar"; }</style>';
    const sanitized = sanitizeHtml(raw, { allowStyleBlocks: true });
    // The escape is case-insensitive; the emitted `\/style` marker is lowercase.
    expect(sanitized).toContain('<\\/style foo>');
    expect(sanitized).not.toContain('</STYLE foo>');
    // The markup stays inert CSS string text (inside the style element's raw
    // text) — the real closing tag is emitted exactly once.
    expect(sanitized).toContain('<b>hi</b>');
    expect((sanitized.match(/<\/style>/gi) || []).length).toBe(1);
  });

  test('renders the escaped style block with layout intact', () => {
    const raw = '<style>.hero { padding: 12px; color: #333; }</style>';
    const sanitized = sanitizeHtml(raw, { allowStyleBlocks: true });
    expect(sanitized).toContain('<style>');
    expect(sanitized).toContain('.hero { padding: 12px; color: #333; }');
    expect((sanitized.match(/<\/style>/gi) || []).length).toBe(1);
  });
});
