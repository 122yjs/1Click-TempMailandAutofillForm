<script lang="ts">
/**
 * Dropdown — reusable MD3 select field with a custom menu surface.
 *
 * Replaces native <select> where MD3 state layers and consistent styling are
 * wanted. The trigger is a labeled button field (role=combobox) with an MD3
 * surface + state layers; the menu is a body-portaled `position:fixed` surface
 * (escapes scroll/transform clipping) built on the global .menu-list /
 * .menu-list-item state-layer classes (hover 8% / pressed+focus 12%).
 *
 * Keyboard: Enter/Space/↑/↓ open · ↑/↓ navigate · Enter/Space select ·
 * Home/End jump · Esc closes · Tab closes and moves focus on.
 */
import { onDestroy } from 'svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { PORTAL_Z } from '@/utils/portal-layers.js';

export interface DropdownOption {
  value: string | number;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface Props {
  /** Selected value — bindable, or controlled via value + onchange. */
  value?: string | number;
  options?: DropdownOption[];
  /** Optional caption rendered above the field (MD3 label slot). */
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  size?: 'xs' | 'sm';
  variant?: 'filled' | 'outlined' | 'secondary';
  error?: string;
  id?: string;
  ariaLabel?: string;
  class?: string;
  maxHeight?: string;
  /** Menu surface z-index. Pass PORTAL_Z.dialogMenu when the trigger lives
   * inside a body-portaled dialog/overlay (z-10000) so the menu stacks above it. */
  zIndex?: number;
  onchange?: (value: string | number) => void;
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Date.now().toString(36)}`;
}

let {
  value = $bindable(''),
  options = [] as DropdownOption[],
  label = '',
  placeholder = '',
  disabled = false,
  size = 'sm',
  variant = 'filled',
  error = '',
  id,
  ariaLabel,
  class: className = '',
  maxHeight = 'min(15rem, 60vh)',
  zIndex = PORTAL_Z.navMenu,
  onchange,
}: Props = $props();

let open = $state(false);
let highlight = $state(-1);
let triggerEl = $state<HTMLButtonElement | null>(null);
let menuEl = $state<HTMLDivElement | null>(null);
const listId = uid('dd-list');

const selected = $derived(options.find((o) => o.value === value) || null);
const activeDesc = $derived(
  open && highlight >= 0 && highlight < options.length ? `${listId}-opt-${highlight}` : undefined
);

const fieldClass = $derived.by(() => {
  const sizeClass = size === 'xs' ? 'px-2 py-1.5 text-xs' : 'px-3 py-2 text-sm';
  const common =
    'w-full flex items-center gap-2 rounded-xl text-start text-md-on-surface outline-none transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-md-primary/40';
  let surface: string;
  if (variant === 'secondary') {
    surface = error
      ? 'bg-md-error/10 border border-md-error font-medium'
      : 'bg-md-secondary-container border border-transparent hover:brightness-105 font-medium';
  } else if (variant === 'outlined') {
    surface = error
      ? 'bg-md-surface-variant/40 border border-md-error'
      : 'bg-md-surface-variant/40 border border-md-outline-variant hover:border-md-on-surface/40';
  } else {
    // filled (MD3 filled field)
    surface = error
      ? 'bg-md-error-container/30 border border-md-error'
      : 'bg-md-surface-container-high border border-transparent hover:border-md-outline-variant';
  }
  const stateLayer = open ? ' ring-2 ring-md-primary/30 border-md-primary' : '';
  return `${common} ${surface} ${sizeClass}${stateLayer}`;
});

function openMenu() {
  if (disabled || options.length === 0) return;
  highlight = options.findIndex((o) => o.value === value);
  if (highlight < 0) highlight = 0;
  open = true;
}

function closeMenu(returnFocus = true) {
  open = false;
  highlight = -1;
  if (returnFocus) triggerEl?.focus();
}

function select(option: DropdownOption) {
  if (option.disabled) return;
  value = option.value;
  onchange?.(option.value);
  closeMenu(false);
}

function firstEnabled(): number {
  return options.findIndex((o) => !o.disabled);
}

function lastEnabled(): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i]?.disabled) return i;
  return -1;
}

function nextEnabled(start: number): number {
  let i = start;
  for (let n = 0; n < options.length; n++) {
    if (!options[i]?.disabled) return i;
    i = (i + 1) % options.length;
  }
  return start;
}

function prevEnabled(start: number): number {
  let i = start;
  for (let n = 0; n < options.length; n++) {
    if (!options[i]?.disabled) return i;
    i = (i - 1 + options.length) % options.length;
  }
  return start;
}

function handleTriggerKeydown(e: KeyboardEvent) {
  if (disabled) return;
  if (!open) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openMenu();
    }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    // Stop propagation so a wrapping dialog's window-level Escape handler
    // doesn't close the dialog while the menu is still open (matches native
    // <select> — Escape only dismisses the open listbox).
    e.stopPropagation();
    closeMenu();
    return;
  }
  if (e.key === 'Tab') {
    closeMenu();
    return; // let the browser move focus on
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    highlight = nextEnabled(highlight < 0 ? 0 : (highlight + 1) % options.length);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    highlight = prevEnabled(
      highlight < 0 ? options.length - 1 : (highlight - 1 + options.length) % options.length
    );
  } else if (e.key === 'Home') {
    e.preventDefault();
    highlight = firstEnabled();
  } else if (e.key === 'End') {
    e.preventDefault();
    highlight = lastEnabled();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const opt = options[highlight];
    if (opt) select(opt);
  }
}

function onDocPointerDown(e: PointerEvent) {
  if (!open) return;
  const target = e.target as Node | null;
  if (triggerEl?.contains(target) || menuEl?.contains(target)) return;
  closeMenu(false);
}

$effect(() => {
  if (!open) return;
  document.addEventListener('pointerdown', onDocPointerDown);
  return () => document.removeEventListener('pointerdown', onDocPointerDown);
});

// Keep the highlighted option visible inside the scrollable menu.
$effect(() => {
  if (!open || highlight < 0 || !menuEl) return;
  menuEl.querySelector(`#${listId}-opt-${highlight}`)?.scrollIntoView({ block: 'nearest' });
});

// Portal to document.body + position under the trigger while open. Fixed
// positioning escapes the scroll container (overflow clipping) and any
// CSS-transform ancestor; reposition on every scroll (capture phase catches
// container scrolls too) and on resize, and clamp to the viewport.
$effect(() => {
  if (!open || !menuEl || !triggerEl) return;
  if (menuEl.parentElement !== document.body) document.body.appendChild(menuEl);
  const el = menuEl;
  const pos = () => {
    const t = triggerEl;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const mw = el.offsetWidth || 160;
    const mh = el.offsetHeight || 200;
    let top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8));
    el.style.minWidth = `${r.width}px`;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.opacity = '1';
  };
  pos();
  const raf = requestAnimationFrame(pos); // re-measure after minWidth applies
  window.addEventListener('scroll', pos, { capture: true, passive: true });
  window.addEventListener('resize', pos);
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('scroll', pos, { capture: true });
    window.removeEventListener('resize', pos);
  };
});

onDestroy(() => {
  try {
    if (menuEl && menuEl.parentElement === document.body) menuEl.remove();
  } catch {
    /* ignore */
  }
});
</script>

<div class="relative {className}">
  {#if label}
    <span class="block text-label-sm text-md-on-surface/60 mb-1 px-1">{label}</span>
  {/if}
  <button
    bind:this={triggerEl}
    {id}
    type="button"
    role="combobox"
    aria-expanded={open}
    aria-haspopup="listbox"
    aria-controls={listId}
    aria-activedescendant={activeDesc}
    aria-label={ariaLabel}
    aria-invalid={!!error}
    disabled={disabled}
    class={fieldClass}
    onclick={(e) => {
      e.stopPropagation();
      if (open) closeMenu();
      else openMenu();
    }}
    onkeydown={handleTriggerKeydown}
  >
    <span class="flex-1 truncate {selected ? '' : 'text-md-on-surface/50'}">
      {selected?.label ?? placeholder}
    </span>
    <Icon
      name="chevronDown"
      class="w-4 h-4 shrink-0 text-md-on-surface/45 transition-transform duration-150 {open
        ? 'rotate-180'
        : ''}"
    />
  </button>
</div>

{#if open}
  <div
    bind:this={menuEl}
    id={listId}
    role="listbox"
    aria-label={ariaLabel}
    tabindex="-1"
    class="menu-list rounded-xl border border-md-outline-variant/50 bg-md-surface-container-low shadow-xl overflow-y-auto py-1 w-max max-w-[min(20rem,calc(100vw-16px))]"
    style="position:fixed; z-index:{zIndex}; max-height:{maxHeight}; opacity:0; transition:opacity 100ms ease;"
  >
    {#each options as option, i (option.value)}
      <button
        type="button"
        id={`${listId}-opt-${i}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined}
        disabled={option.disabled}
        class="menu-list-item w-full flex items-center gap-3 px-3 min-h-10 text-sm text-start {option
          .value === value
          ? 'is-active'
          : ''} {option.disabled ? 'is-disabled' : ''}"
        onmousemove={() => {
          highlight = i;
        }}
        onclick={(e) => {
          e.stopPropagation();
          select(option);
        }}
      >
        <span class="flex-1 min-w-0">
          <span class="block truncate font-medium">{option.label}</span>
          {#if option.hint}
            <span class="block text-xs text-md-on-surface/50 truncate">{option.hint}</span>
          {/if}
        </span>
        {#if option.value === value}
          <Icon name="check" class="w-4 h-4 shrink-0 text-md-primary" />
        {/if}
      </button>
    {/each}
  </div>
{/if}
