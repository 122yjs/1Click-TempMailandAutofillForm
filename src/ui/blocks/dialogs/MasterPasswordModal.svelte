<script lang="ts">
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import Icon from '@/ui/components/icons/Icon.svelte';
import Btn from '@/ui/components/primitives/Btn.svelte';
import InputField from '@/ui/components/primitives/InputField.svelte';
import { setupFocusTrap } from '@/utils/focusTrap.js';
import { portalToBody } from '@/utils/portal-layers.js';

let {
  isOpen = false,
  onClose = () => {},
  onSave = (_password: string) => {},
} = $props<{
  isOpen?: boolean;
  onClose?: () => void;
  onSave?: (password: string) => void;
}>();

let password = $state('');
let confirmPassword = $state('');
let error = $state('');

let dialogRef = $state<HTMLElement | null>(null);
let overlayEl = $state<HTMLElement | null>(null);
let cleanupFocusTrap: (() => void) | null = null;

$effect(() => {
  if (isOpen && overlayEl) {
    return portalToBody(overlayEl);
  }
});
let previousActiveElement: HTMLElement | null = null;

// Handle Escape key globally when dialog is open
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && isOpen) {
    e.stopPropagation();
    onClose();
  }
}

$effect(() => {
  if (isOpen) {
    previousActiveElement = document.activeElement as HTMLElement;
    window.addEventListener('keydown', handleKeydown);

    void tick().then(() => {
      if (dialogRef) {
        cleanupFocusTrap = setupFocusTrap(dialogRef);
      }
    });
  }
  return () => {
    window.removeEventListener('keydown', handleKeydown);
    if (cleanupFocusTrap) {
      cleanupFocusTrap();
      cleanupFocusTrap = null;
    }
    if (previousActiveElement) {
      previousActiveElement.focus();
      previousActiveElement = null;
    }
  };
});

function handleSubmit() {
  error = '';
  if (!password || password.length < 6) {
    error = $t('settings.masterPasswordTooShort');
    return;
  }
  if (password !== confirmPassword) {
    error = $t('settings.masterPasswordMismatch');
    return;
  }
  onSave(password);
  password = '';
  confirmPassword = '';
  onClose();
}
</script>

{#if isOpen}
  <div
    bind:this={overlayEl}
    class="fixed inset-0 bg-md-scrim/30 backdrop-blur-sm z-[10000] flex items-center justify-center p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby="master-password-modal-title"
  >
    <div
      class="absolute inset-0"
      role="button"
      tabindex="-1"
      aria-label={$t('common.close')}
      onclick={(e) => { e.stopPropagation(); onClose(); }}
      onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onClose(); } }}
    ></div>
    <div
      class="bg-md-surface-container border border-md-outline-variant/60 rounded-2xl p-5 w-full max-w-sm shadow-2xl relative space-y-4"
      bind:this={dialogRef}
      tabindex="-1"
    >
      <!-- Icon-only close — stays raw, no text label -->
      <button
        class="absolute top-4 end-4 text-md-on-surface/50 hover:text-md-on-surface transition-colors"
        onclick={onClose}
        aria-label={$t('common.close')}
      >
        <Icon name="x" class="w-4 h-4" />
      </button>

      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-md-primary/10 flex items-center justify-center text-md-primary shrink-0">
          <Icon name="shield" class="w-5 h-5" />
        </div>
        <div>
          <h3 id="master-password-modal-title" class="text-sm font-bold text-md-on-surface">{$t('settings.setMasterPassword')}</h3>
          <p class="text-xs text-md-on-surface/60">{$t('settings.masterPasswordSubtitle')}</p>
        </div>
      </div>

      {#if error}
        <div class="p-2.5 rounded-lg bg-md-error-container/40 border border-md-error/30 text-xs text-md-error flex items-center gap-2">
          <Icon name="info" class="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      {/if}

      <div class="space-y-3">
        <div>
          <label for="input-master-password" class="block text-xs font-medium text-md-on-surface/80 mb-1">{$t('settings.masterPasswordPlaceholder')}</label>
          <InputField
            id="input-master-password"
            type="password"
            bind:value={password}
            placeholder={$t('settings.masterPasswordEnterPlaceholder')}
            showToggle
            size="sm"
          />
        </div>

        <div>
          <label for="input-confirm-master-password" class="block text-xs font-medium text-md-on-surface/80 mb-1">{$t('settings.confirmMasterPassword')}</label>
          <InputField
            id="input-confirm-master-password"
            type="password"
            bind:value={confirmPassword}
            placeholder={$t('settings.masterPasswordConfirmPlaceholder')}
            size="sm"
          />
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 pt-2">
        <Btn variant="ghost" size="md" onclick={onClose}>
          {$t('common.cancel')}
        </Btn>
        <Btn variant="primary" size="md" onclick={handleSubmit}>
          {$t('settings.masterPasswordSave')}
        </Btn>
      </div>
    </div>
  </div>
{/if}
