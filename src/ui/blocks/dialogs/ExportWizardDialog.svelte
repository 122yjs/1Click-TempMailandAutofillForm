<script lang="ts">
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import Btn from '@/ui/components/primitives/Btn.svelte';
import { logError } from '@/utils/logger.js';
import { toastStore } from '@/utils/toastStore.js';
import type { Account, Email } from '@/utils/types.js';

let {
  open = false,
  account = null as Account | null,
  messages = [] as Email[],
  onClose = () => {},
  onExecuteExport = async (_format: string) => {},
} = $props<{
  open?: boolean;
  account?: Account | null;
  messages?: Email[];
  onClose?: () => void;
  onExecuteExport?: (format: string) => Promise<void>;
}>();

let selectedFormat = $state<'json' | 'eml' | 'mbox' | 'bitwarden-csv' | 'identities-csv'>('json');
let isProcessing = $state(false);
let progressPercent = $state(0);
let isDone = $state(false);
let exportError = $state(false);
let activeTimer: ReturnType<typeof setInterval> | null = null;
let dialogRef = $state<HTMLElement | null>(null);

function resetState() {
  selectedFormat = 'json';
  isProcessing = false;
  progressPercent = 0;
  isDone = false;
  exportError = false;
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
}

$effect(() => {
  if (open) {
    resetState();
  }
});

function handleStartExport() {
  if (isProcessing) return;
  isProcessing = true;
  progressPercent = 10;

  activeTimer = setInterval(() => {
    if (progressPercent < 90) {
      progressPercent += 15;
    }
  }, 100);

  void onExecuteExport(selectedFormat)
    .then(() => {
      progressPercent = 100;
      setTimeout(() => {
        if (activeTimer) clearInterval(activeTimer);
        isProcessing = false;
        isDone = true;
      }, 200);
    })
    .catch((e: unknown) => {
      if (activeTimer) clearInterval(activeTimer);
      isProcessing = false;
      progressPercent = 0;
      exportError = true;
      logError('Export failed', undefined, e instanceof Error ? e : undefined);
      toastStore.error(get(t)('toasts.exportFailed') || 'Export failed');
    });
}
</script>

<ModalDialog
  {open}
  title={$t('backup.wizardTitle')}
  subtitle={account ? account.address : $t('backup.exportEmailsAndBackup')}
  maxWidth="sm"
  showCloseButton={!isProcessing}
  onClose={() => {
    if (!isProcessing) onClose();
  }}
  bind:dialogRef
>
  {#if isDone}
    <!-- Done State -->
    <div class="py-6 flex flex-col items-center justify-center gap-2 text-center">
      <div class="w-12 h-12 rounded-full bg-md-primary/15 text-md-primary flex items-center justify-center animate-bounce">
        <Icon name="checkCircle" class="w-7 h-7" />
      </div>
      <h3 class="text-sm font-bold text-md-on-surface">{$t('backup.exportComplete')}</h3>
      <p class="text-xs text-md-on-surface/60">{$t('backup.exportCompleteHint')}</p>
    </div>

    {#snippet footer()}
      <Btn
        variant="primary"
        size="md"
        class="w-full"
        onclick={onClose}
      >
        {$t('common.done')}
      </Btn>
    {/snippet}
  {:else if isProcessing}
    <!-- Progress State -->
    <div class="py-6 flex flex-col gap-3">
      <div class="flex items-center justify-between text-xs font-semibold">
        <span class="text-md-on-surface/80">{$t('backup.generatingFile')} ({selectedFormat.toUpperCase()})...</span>
        <span class="text-md-primary font-mono">{progressPercent}%</span>
      </div>
      <div class="w-full h-2 rounded-full bg-md-surface-variant/40 overflow-hidden">
        <div
          class="h-full bg-md-primary transition-all duration-150 rounded-full"
          style="width: {progressPercent}%;"
        ></div>
      </div>
    </div>
  {:else if exportError}
    <!-- Error State -->
    <div class="py-8 flex flex-col items-center justify-center gap-3 text-center">
      <div class="w-12 h-12 rounded-full bg-md-error/10 text-md-error flex items-center justify-center">
        <Icon name="alertTriangle" class="w-7 h-7" />
      </div>
      <h3 class="text-sm font-bold text-md-on-surface">{$t('toasts.exportFailed')}</h3>
      <p class="text-xs text-md-on-surface/60">{$t('backup.exportFailedHint')}</p>
    </div>
  {:else}
    <!-- Choice State -->
    <div class="space-y-3">
      <div class="text-sm font-medium text-md-on-surface">
        {$t('backup.selectExportFormat')}
      </div>

      <div class="grid gap-2">
        <button
          type="button"
          class="flex items-center justify-between p-3 rounded-xl border transition-all text-start {selectedFormat === 'json' ? 'border-md-primary bg-md-primary/10 shadow-sm' : 'border-md-outline-variant/20 bg-md-surface-container-low/50 hover:bg-md-surface-variant/30'}"
          onclick={() => (selectedFormat = 'json')}
        >
          <div class="flex items-center gap-2.5">
            <span class="text-xs font-mono font-bold px-2 py-1 rounded bg-md-primary-container text-md-on-primary-container">JSON</span>
            <div>
              <div class="text-xs font-bold text-md-on-surface">{$t('backup.structuredJsonBackup')}</div>
              <div class="text-xs text-md-on-surface/50">{$t('backup.includesMetadataAndFullRaw')}</div>
            </div>
          </div>
          {#if selectedFormat === 'json'}
            <Icon name="check" class="w-4 h-4 text-md-primary" />
          {/if}
        </button>

        <button
          type="button"
          class="flex items-center justify-between p-3 rounded-xl border transition-all text-start {selectedFormat === 'eml' ? 'border-md-primary bg-md-primary/10 shadow-sm' : 'border-md-outline-variant/20 bg-md-surface-container-low/50 hover:bg-md-surface-variant/30'}"
          onclick={() => (selectedFormat = 'eml')}
        >
          <div class="flex items-center gap-2.5">
            <span class="text-xs font-mono font-bold px-2 py-1 rounded bg-md-secondary-container text-md-on-secondary-container">EML</span>
            <div>
              <div class="text-xs font-bold text-md-on-surface">{$t('backup.emlRawEmailFiles')}</div>
              <div class="text-xs text-md-on-surface/50">{$t('backup.individualEmlFiles')}</div>
            </div>
          </div>
          {#if selectedFormat === 'eml'}
            <Icon name="check" class="w-4 h-4 text-md-primary" />
          {/if}
        </button>

        <button
          type="button"
          class="flex items-center justify-between p-3 rounded-xl border transition-all text-start {selectedFormat === 'mbox' ? 'border-md-primary bg-md-primary/10 shadow-sm' : 'border-md-outline-variant/20 bg-md-surface-container-low/50 hover:bg-md-surface-variant/30'}"
          onclick={() => (selectedFormat = 'mbox')}
        >
          <div class="flex items-center gap-2.5">
            <span class="text-xs font-mono font-bold px-2 py-1 rounded bg-md-tertiary-container text-md-on-tertiary-container">MBOX</span>
            <div>
              <div class="text-xs font-bold text-md-on-surface">{$t('backup.mailboxArchive')}</div>
              <div class="text-xs text-md-on-surface/50">{$t('backup.singleFileAppleMail')}</div>
            </div>
          </div>
          {#if selectedFormat === 'mbox'}
            <Icon name="check" class="w-4 h-4 text-md-primary" />
          {/if}
        </button>
      </div>
    </div>

    {#snippet footer()}
      <Btn
        variant="ghost"
        size="md"
        onclick={onClose}
      >
        {$t('common.cancel')}
      </Btn>
      <Btn
        variant="primary"
        size="md"
        class="flex items-center gap-1.5"
        onclick={handleStartExport}
      >
        <Icon name="download" class="w-3.5 h-3.5" />
        <span>{$t('preferences.exportFile') || 'Export File'}</span>
      </Btn>
    {/snippet}
  {/if}
</ModalDialog>
