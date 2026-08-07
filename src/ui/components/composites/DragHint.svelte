<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';

let {
  hintKey,
  text,
  visible = false,
  onDismiss = () => {},
}: {
  hintKey: string;
  text: string;
  visible?: boolean;
  onDismiss?: () => void;
} = $props();

let shown = $state(false);
let dismissed = $state(false);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

onMount(() => {
  void (async () => {
    try {
      const result = (await browser.storage.local.get(hintKey)) as Record<string, boolean>;
      if (!result[hintKey]) {
        shown = true;
        hideTimer = setTimeout(() => {
          shown = false;
        }, 4000);
      }
    } catch {
      /* ignore */
      shown = true;
      hideTimer = setTimeout(() => {
        shown = false;
      }, 4000);
    }
  })();
});

$effect(() => {
  if (!visible) {
    shown = false;
  }
});

async function persistDismiss(): Promise<void> {
  dismissed = true;
  shown = false;
  try {
    await browser.storage.local.set({ [hintKey]: true });
  } catch {
    // ignore
  }
  onDismiss();
}

$effect(() => {
  return () => {
    if (hideTimer) clearTimeout(hideTimer);
  };
});
</script>

{#if shown && !dismissed}
  <div
    class="absolute -top-7 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 bg-md-inverse-surface text-md-inverse-on-surface text-xs font-medium px-2 py-1 rounded-full shadow-md whitespace-nowrap pointer-events-auto"
    role="tooltip"
  >
    <Icon name="grip" class="w-3 h-3" />
    {text}
    <button
      class="ms-1 text-md-inverse-on-surface/70 hover:text-md-inverse-on-surface"
      onclick={(e) => {
        e.stopPropagation();
        void persistDismiss();
      }}
      aria-label={$t('common.dismissHint')}
    >
      <Icon name="x" class="w-3 h-3" />
    </button>
    <div
      class="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-md-primary rotate-45"
    ></div>
  </div>
{/if}
