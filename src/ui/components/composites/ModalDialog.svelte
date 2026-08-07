<script lang="ts">
import { onDestroy, type Snippet, tick } from 'svelte';
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';
import { setupFocusTrap } from '@/utils/focusTrap.js';
import { PORTAL_Z_CLASS, portalToBody, portalToTriggerContainer } from '@/utils/portal-layers.js';

interface Props {
  open: boolean;
  title?: string;
  subtitle?: string;
  showCloseButton?: boolean;
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'full';
  triggerElement?: HTMLElement | null;
  ariaLabel?: string;
  onClose: () => void;
  children?: Snippet;
  footer?: Snippet;
  dialogRef?: HTMLElement | null;
}

let {
  open,
  title,
  subtitle,
  showCloseButton = true,
  maxWidth = 'md',
  triggerElement,
  ariaLabel,
  onClose,
  children,
  footer,
  dialogRef = $bindable(null),
}: Props = $props();

let overlayEl = $state<HTMLElement | null>(null);
let innerRef = $state<HTMLElement | null>(null);
let cleanupFocusTrap: (() => void) | null = null;
let previousActiveElement = $state<HTMLElement | null>(null);

const maxWidthClasses: Record<NonNullable<Props['maxWidth']>, string> = {
  xs: 'max-w-xs',
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  full: 'max-w-full m-2',
};

// Portal handling
$effect(() => {
  if (!open || !overlayEl) return;
  if (triggerElement) {
    const { destroy } = portalToTriggerContainer(overlayEl, triggerElement);
    return destroy;
  } else {
    return portalToBody(overlayEl);
  }
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

// Focus trap + body scroll locking
$effect(() => {
  let prevOverflow: string | null = null;
  if (open) {
    previousActiveElement = document.activeElement as HTMLElement;
    prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void tick().then(() => {
      const targetEl = dialogRef || innerRef;
      if (targetEl) {
        cleanupFocusTrap = setupFocusTrap(targetEl);
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
    if (e.key === 'Escape' && open) {
      onClose();
    }
  }}
/>

{#if open}
  <!-- Portaled modal shell with z-[10000] layer -->
  <div
    bind:this={overlayEl}
    class="fixed inset-0 {PORTAL_Z_CLASS.dialog} flex items-center justify-center bg-md-scrim/40 backdrop-blur-sm p-4 overflow-y-auto"
    data-portal-layer="dialog"
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title || $t('common.confirm')}
  >
    <!-- Backdrop backdrop click -->
    <div
      class="fixed inset-0 -z-10 cursor-default"
      role="button"
      tabindex="-1"
      aria-label={$t('common.close')}
      onclick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onkeydown={(e) => {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClose();
        }
      }}
    ></div>

    <!-- Modal Card -->
    <div
      bind:this={innerRef}
      class="bg-md-surface-container rounded-2xl p-4 shadow-2xl w-full border border-md-outline-variant/20 relative my-auto z-10 space-y-3 {maxWidthClasses[maxWidth]}"
      tabindex="-1"
    >
      <!-- Header -->
      {#if title || showCloseButton}
        <div class="flex items-start justify-between gap-2 border-b border-md-outline-variant/15 pb-2.5">
          <div class="min-w-0 flex-1">
            {#if title}
              <h2 class="text-base font-bold text-md-on-surface truncate">{title}</h2>
            {/if}
            {#if subtitle}
              <p class="text-xs text-md-on-surface/60 truncate mt-0.5">{subtitle}</p>
            {/if}
          </div>
          {#if showCloseButton}
            <button
              type="button"
              class="w-8 h-8 flex items-center justify-center rounded-full text-md-on-surface/70 hover:bg-md-surface-variant/50 hover:text-md-on-surface transition-colors shrink-0 ms-2"
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
        <div class="min-w-0">
          {@render children()}
        </div>
      {/if}

      <!-- Footer -->
      {#if footer}
        <div class="pt-2 border-t border-md-outline-variant/15 flex items-center justify-end gap-2">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
