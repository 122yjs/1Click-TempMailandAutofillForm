<script lang="ts">
/**
 * Checkbox — MD3 checkbox with hover/pressed state layers.
 *
 * Renders a real (visually-hidden) <input type="checkbox"> so label-activation,
 * form semantics and keyboard toggling behave exactly like a native checkbox,
 * plus the MD3 checkBox / checkBoxBlank glyph. Drop-in replacement for native
 * checkboxes: supports checked (bindable), onchange (native event), disabled,
 * size.
 *
 * Nested inside an existing <label>, clicking the row toggles via native label
 * activation; clicking the glyph itself toggles via a preventDefault + click
 * passthrough (no double-toggle).
 */
import Icon from '@/ui/components/icons/Icon.svelte';

interface Props {
  checked?: boolean;
  disabled?: boolean;
  /** 'md' = 16px glyph, 'sm' = 14px glyph */
  size?: 'sm' | 'md';
  id?: string;
  class?: string;
  ariaLabel?: string;
  onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
}

let {
  checked = $bindable(false),
  disabled = false,
  size = 'md',
  id,
  class: className = '',
  ariaLabel,
  onchange,
}: Props = $props();

let inputEl = $state<HTMLInputElement | null>(null);

const glyph = $derived(size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4');
</script>

<span
  class="inline-flex items-center justify-center rounded-md cursor-pointer select-none {disabled
    ? 'opacity-40 pointer-events-none'
    : 'hover:bg-md-on-surface/8 active:bg-md-on-surface/12'} transition-colors {className}"
>
  <input
    bind:this={inputEl}
    {id}
    type="checkbox"
    class="peer sr-only"
    bind:checked
    {disabled}
    aria-label={ariaLabel}
    {onchange}
  />
  <span
    class="flex items-center justify-center rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-md-primary/40 {glyph} {checked
      ? 'text-md-primary'
      : 'text-md-on-surface/30'}"
    aria-hidden="true"
    onclick={(e) => {
      if (disabled) return;
      // Stop the outer label from double-toggling; toggle once via the input.
      e.preventDefault();
      inputEl?.click();
    }}
  >
    <Icon name={checked ? 'checkBox' : 'checkBoxBlank'} class={glyph} />
  </span>
</span>
