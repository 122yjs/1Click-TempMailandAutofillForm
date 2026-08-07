<script lang="ts">
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';
import { copyToClipboardAndSchedulePurge } from '@/utils/clipboard.js';

let {
  text = '',
  purgeDelayMs = 60000,
  label = '',
  tooltip = '',
  size = 'md',
  variant = 'ghost',
  class: className = '',
  onCopied,
}: {
  text: string;
  purgeDelayMs?: number;
  label?: string;
  tooltip?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'surface' | 'primary';
  class?: string;
  onCopied?: () => void;
} = $props();

let copied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCopy(e: MouseEvent) {
  e.stopPropagation();
  if (!text) return;
  const ok = await copyToClipboardAndSchedulePurge(text, purgeDelayMs);
  if (ok) {
    copied = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied = false;
    }, 2000);
    onCopied?.();
  }
}
</script>

<button
  type="button"
  class="inline-flex items-center justify-center gap-1.5 transition-colors rounded-lg font-medium select-none
    {size === 'sm' ? 'px-1.5 py-1 text-xs' : size === 'lg' ? 'px-3 py-2 text-sm' : 'px-2 py-1.5 text-xs'}
    {variant === 'primary' ? 'bg-md-primary text-md-on-primary hover:bg-md-primary/90' : variant === 'surface' ? 'bg-md-surface-variant/60 text-md-on-surface hover:bg-md-surface-variant' : 'bg-transparent text-md-on-surface/70 hover:bg-md-surface-variant/50 hover:text-md-on-surface'}
    {copied ? 'text-md-success' : ''}
    {className}"
  title={tooltip || label || $t('common.copy')}
  aria-label={label || tooltip || $t('common.copy')}
  onclick={handleCopy}
>
  <Icon name={copied ? 'check' : 'copy'} class={size === 'sm' ? 'w-3.5 h-3.5' : size === 'lg' ? 'w-5 h-5' : 'w-4 h-4'} />
  {#if label}
    <span data-selectable-text="true">{copied ? $t('common.copied') : label}</span>
  {/if}
</button>
