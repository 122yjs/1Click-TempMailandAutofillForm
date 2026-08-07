/**
 * Generic submit / continue button detection + click.
 * No site hardcoding — multi-language action labels.
 */

/** Words that indicate primary form action (signup / continue / login). */
const ACTION_RE =
  /\b(sign\s*up|signup|register|create(\s+(an?|your|my))?\s+account|join(\s+now)?|get\s+started|continue|next|submit|log\s*in|login|sign\s*in|signin|verify|confirm|send(\s+code)?|proceed|finish|done|s'inscrire|créer|inscrire|registrieren|konto\s+erstellen|registrarse|crear\s+cuenta|cadastrar|登録|サインアップ|创建账户|注册|สมัคร|ลงทะเบียน|إنشاء|تسجيل|متابعة|suivant|weiter|siguiente|次へ|下一步|ถัดไป)\b/i;

const NEGATIVE_RE =
  /\b(cancel|close|back|previous|forgot|reset\s*password|google|facebook|apple|github|twitter|microsoft|sso|oauth|skip|later|maybe)\b/i;

function visible(el: HTMLElement): boolean {
  try {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    return true;
  } catch {
    /* ignore */
    return false;
  }
}

function controlLabel(el: HTMLElement): string {
  const parts = [
    el.getAttribute('aria-label') || '',
    el.getAttribute('value') || '',
    el.getAttribute('title') || '',
    (el as HTMLInputElement).value || '',
    el.textContent || '',
  ];
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Find the best Continue / Sign up / Log in control near a form (or page).
 */
export function findPrimaryActionButton(
  form?: HTMLFormElement | HTMLElement | null
): HTMLElement | null {
  const roots: ParentNode[] = [];
  if (form) {
    roots.push(form);
    // Sibling footer actions (common in SPAs)
    if (form.parentElement) roots.push(form.parentElement);
  }
  if (typeof document !== 'undefined') roots.push(document);

  type Cand = { el: HTMLElement; score: number };
  const cands: Cand[] = [];

  const selector =
    'button, input[type="submit"], input[type="button"], [role="button"], a.button, a[class*="btn" i]';

  for (const root of roots) {
    let nodes: Element[];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch {
      /* ignore */
      continue;
    }
    for (const n of nodes) {
      if (!(n instanceof HTMLElement)) continue;
      if (!visible(n)) continue;
      if ((n as HTMLButtonElement).disabled) continue;
      const label = controlLabel(n);
      if (!label || label.length > 80) continue;
      if (NEGATIVE_RE.test(label)) continue;
      if (!ACTION_RE.test(label)) continue;

      let score = 10;
      if (/sign\s*up|register|create.*account|登録|注册|สมัคร|إنشاء/i.test(label)) score += 40;
      if (/continue|next|suivant|weiter|siguiente|次へ|下一步|ถัดไป|متابعة/i.test(label))
        score += 30;
      if (/log\s*in|sign\s*in|login|signin/i.test(label)) score += 20;
      if (n.tagName === 'BUTTON' || (n as HTMLInputElement).type === 'submit') score += 8;
      if (form?.contains(n)) score += 15;
      // Prefer primary-looking classes
      const cls = (n.className || '').toString().toLowerCase();
      if (/primary|submit|cta|btn-primary|contained/.test(cls)) score += 12;

      cands.push({ el: n, score });
    }
  }

  // Also native form submit without visible text
  if (form) {
    const native = form.querySelector<HTMLInputElement>(
      'input[type="submit"], button[type="submit"]'
    );
    if (native && visible(native) && !native.disabled) {
      cands.push({ el: native, score: 25 });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  return cands[0]?.el || null;
}

/** Click primary action after autofill (best-effort). Returns true if clicked. */
export function clickPrimaryAction(form?: HTMLFormElement | HTMLElement | null): boolean {
  const btn = findPrimaryActionButton(form);
  if (!btn) return false;
  try {
    btn.focus?.();
    btn.click();
    return true;
  } catch {
    /* ignore */
    try {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      /* ignore */
      return false;
    }
  }
}

/**
 * Arm success detection only after a real submit/continue click.
 * Call after autofill; marks credential when success follows a user/auto click.
 */
export function armSignupOutcomeAfterSubmit(
  domain: string,
  form: HTMLFormElement | HTMLElement | null,
  opts?: {
    autoClick?: boolean;
    timeoutMs?: number;
    onStatus?: (status: 'pending_submit' | 'submitted' | 'verified' | 'undetected') => void;
  }
): () => void {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  let stopped = false;
  let submitted = false;
  let cleanupWatch: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('click', onClick, true);
    if (form) form.removeEventListener('submit', onSubmit, true);
    cleanupWatch?.();
  };

  const markSubmitted = async () => {
    if (submitted) return;
    submitted = true;
    opts?.onStatus?.('submitted');
    try {
      const { markLatestCredentialStatus } = await import('./post-submit.js');
      await markLatestCredentialStatus(domain, 'submitted');
      const { watchPostSubmitSuccess } = await import('./post-submit.js');
      cleanupWatch = watchPostSubmitSuccess(domain, {
        timeoutMs: timeoutMs,
        requirePriorSubmit: true,
        onSuccess: () => opts?.onStatus?.('verified'),
        onTimeout: () => opts?.onStatus?.('undetected'),
      });
    } catch {
      /* ignore */
    }
  };

  const onClick = (e: Event) => {
    if (stopped || submitted) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest(
      'button, input[type="submit"], input[type="button"], [role="button"], a'
    ) as HTMLElement | null;
    if (!btn) return;
    const label = controlLabel(btn);
    if (NEGATIVE_RE.test(label)) return;
    if (ACTION_RE.test(label) || (btn as HTMLInputElement).type === 'submit') {
      void markSubmitted();
    }
  };

  const onSubmit = () => {
    void markSubmitted();
  };

  document.addEventListener('click', onClick, true);
  if (form instanceof HTMLFormElement) form.addEventListener('submit', onSubmit, true);

  opts?.onStatus?.('pending_submit');
  void import('./post-submit.js').then(({ markLatestCredentialStatus }) =>
    markLatestCredentialStatus(domain, 'pending_submit')
  );

  if (opts?.autoClick !== false) {
    // Slight delay so frameworks bind filled values
    setTimeout(async () => {
      if (stopped || submitted) return;

      try {
        const { loadSmartAutofillSettings } = await import('./smart-settings.js');
        const settings = await loadSmartAutofillSettings();
        if (!settings.autoClickSubmitButtons) return;
      } catch {
        // proceed if settings load fails
      }

      if (stopped || submitted) return;
      const formEl = form instanceof HTMLFormElement ? form : null;
      if (clickPrimaryAction(formEl || (form as HTMLElement))) {
        // markSubmitted will fire from click capture if successful;
        // also arm if click doesn't bubble the way we expect
        setTimeout(() => {
          if (!submitted) void markSubmitted();
        }, 100);
      }
    }, 280);
  }

  setTimeout(() => {
    if (!stopped && !submitted) {
      opts?.onStatus?.('undetected');
      void import('./post-submit.js').then(({ markLatestCredentialStatus }) =>
        markLatestCredentialStatus(domain, 'undetected')
      );
      stop();
    }
  }, timeoutMs);

  return stop;
}
