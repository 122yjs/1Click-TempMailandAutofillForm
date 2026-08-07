<script lang="ts">
/**
 * Radio — MD3 radio button with hover/pressed state layers.
 *
 * Renders a real (visually-hidden) <input type="radio"> for semantics and
 * label-activation plus the radioChecked / radioUnchecked glyph. Native radios
 * use bind:group; this component instead takes checked + onchange — the parent
 * owns the group value (e.g. checked={group === 'a'} onchange={() => group = 'a'}).
 */
import Icon from '@/ui/components/icons/Icon.svelte';

interface Props {
  checked?: boolean;
  disabled?: boolean;
  /** Radio group name (form semantics). */
  name?: string;
  value?: string;
  /** 'md' = 20px glyph, 'sm' = 16px glyph */
  size?: 'sm' | 'md';
  id?: string;
  class?: string;
  ariaLabel?: string;
  onchange?: (e: Event & { currentTarget: HTMLInputElement }) => void;
}

let {
  checked = $bindable(false),
  disabled = false,
  name,
  value,
  size = 'md',
  id,
  class: className = '',
  ariaLabel,
  onchange,
}: Props = $props();

let inputEl = $state<HTMLInputElement | null>(null);

const glyph = $derived(size === 'sm' ? 'w-4 h-4' : 'w-5 h-5');
</script>

<span
  class="inline-flex items-center justify-center rounded-full cursor-pointer select-none {disabled
    ? 'opacity-40 pointer-events-none'
    : 'hover:bg-md-on-surface/8 active:bg-md-on-surface/12'} transition-colors {className}"
>
  <input
    bind:this={inputEl}
    {id}
    {name}
    {value}
    type="radio"
    class="peer sr-only"
    checked={checked}
    {disabled}
    aria-label={ariaLabel}
    onchange={(e) => {
      checked = e.currentTarget.checked;
      onchange?.(e);
    }}
  />
  <span
    class="flex items-center justify-center rounded-full peer-focus-visible:ring-2 peer-focus-visible:ring-md-primary/40 {glyph} {checked
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
    <Icon name={checked ? 'radioChecked' : 'radioUnchecked'} class={glyph} />
  </span>
</span>
