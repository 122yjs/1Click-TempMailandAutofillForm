<script lang="ts">
import { onDestroy, type Snippet, tick } from 'svelte';
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';
import { setupFocusTrap } from '@/utils/focusTrap.js';
import { PORTAL_Z_CLASS, portalToBody } from '@/utils/portal-layers.js';

interface Props {
  open: boolean;
  title?: string;
  subtitle?: string;
  showCloseButton?: boolean;
  /** Dismiss on backdrop click / Escape. Defaults true; set false for
   * non-closable overlays (must be closed programmatically). */
  dismissible?: boolean;
  /** Bottom sheet max width — constrains the sheet on wide screens. */
  maxWidth?: 'sm' | 'md' | 'lg' | 'full';
  ariaLabel?: string;
  onClose: () => void;
  children?: Snippet;
  footer?: Snippet;
}

let {
  open,
  title,
  subtitle,
  showCloseButton = true,
  dismissible = true,
  maxWidth = 'md',
  ariaLabel,
  onClose,
  children,
  footer,
}: Props = $props();

let overlayEl = $state<HTMLElement | null>(null);
let sheetRef = $state<HTMLElement | null>(null);
let cleanupFocusTrap: (() => void) | null = null;
let previousActiveElement = $state<HTMLElement | null>(null);

const maxWidthClasses: Record<NonNullable<Props['maxWidth']>, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  full: 'max-w-full m-2',
};

// Portal the sheet to document.body so it clears any transformed ancestor.
$effect(() => {
  if (!open || !overlayEl) return;
  return portalToBody(overlayEl);
});

onDestroy(() => {
  try {
    if (overlayEl?.parentElement) {
      overlayEl.remove();
    }
  } catch {
    /* ignore */
  }
});

// Focus trap + body scroll locking (same contract as ModalDialog).
$effect(() => {
  let prevOverflow: string | null = null;
  if (open) {
    previousActiveElement = document.activeElement as HTMLElement;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void tick().then(() => {
      if (sheetRef) {
        cleanupFocusTrap = setupFocusTrap(sheetRef);
      }
    });
  }
  return () => {
    if (cleanupFocusTrap) {
      cleanupFocusTrap();
      cleanupFocusTrap = null;
    }
    if (prevOverflow !== null) {
      document.body.style.overflow = prevOverflow;
    }
    if (previousActiveElement && document.contains(previousActiveElement)) {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  };
});
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && open && dismissible) {
      onClose();
    }
  }}
/>

{#if open}
  <!-- Portaled bottom-sheet shell (dialog z-index layer) -->
  <div
    bind:this={overlayEl}
    class="fixed inset-0 {PORTAL_Z_CLASS.dialog} flex items-end justify-center bg-md-scrim/40 backdrop-blur-sm"
    data-portal-layer="dialog"
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title || $t('common.confirm')}
  >
    <!-- Backdrop (only dismisses when dismissible) -->
    <div
      class="fixed inset-0 -z-10 cursor-default"
      role="button"
      tabindex="-1"
      aria-label={$t('common.close')}
      onclick={(e) => {
        e.stopPropagation();
        if (dismissible) onClose();
      }}
      onkeydown={(e) => {
        if (dismissible && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClose();
        }
      }}
    ></div>

    <!-- Sheet -->
    <div
      bind:this={sheetRef}
      class="w-full {maxWidthClasses[maxWidth]} rounded-t-2xl bg-md-surface-container shadow-2xl border-t border-x border-md-outline-variant/20 relative z-10 flex flex-col max-h-[85vh]"
      tabindex="-1"
    >
      <!-- Drag handle affordance -->
      <div class="shrink-0 flex justify-center pt-2.5 pb-1">
        <div class="w-10 h-1 rounded-full bg-md-outline-variant/50" aria-hidden="true"></div>
      </div>

      <!-- Header -->
      {#if title || showCloseButton}
        <div class="flex items-start justify-between gap-2 px-4 pb-2.5 border-b border-md-outline-variant/15">
          <div class="min-w-0 flex-1">
            {#if title}
              <h2 class="text-base font-bold text-md-on-surface truncate">{title}</h2>
            {/if}
            {#if subtitle}
              <p class="text-xs text-md-on-surface/60 mt-0.5">{subtitle}</p>
            {/if}
          </div>
          {#if showCloseButton && dismissible}
            <button
              type="button"
              class="w-7 h-7 flex items-center justify-center rounded-full text-md-on-surface/70 hover:bg-md-surface-variant/50 hover:text-md-on-surface transition-colors shrink-0 ms-2"
              onclick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              aria-label={$t('common.close')}
            >
              <Icon name="x" class="w-4 h-4" />
            </button>
          {/if}
        </div>
      {/if}

      <!-- Body Content -->
      {#if children}
        <div class="px-4 py-3 min-w-0 overflow-y-auto">
          {@render children()}
        </div>
      {/if}

      <!-- Footer -->
      {#if footer}
        <div class="shrink-0 px-4 py-3 border-t border-md-outline-variant/15 flex items-center justify-end gap-2">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
