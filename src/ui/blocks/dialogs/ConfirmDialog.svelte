<script lang="ts">
import { t } from 'svelte-i18n';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import Btn from '@/ui/components/primitives/Btn.svelte';

interface Props {
  confirmDialog: {
    message: string;
    onConfirm: () => void;
    title?: string;
    confirmLabel?: string;
    secondaryLabel?: string;
    onSecondary?: () => void;
    note?: string;
  } | null;
  confirmDialogRef?: HTMLElement | null;
  onClose: () => void;
}
let { confirmDialog, confirmDialogRef = $bindable(null), onClose }: Props = $props();
</script>

{#if confirmDialog}
  <ModalDialog
    open={!!confirmDialog}
    title={confirmDialog.title ?? $t('common.confirmAction')}
    maxWidth="xs"
    showCloseButton={false}
    {onClose}
    bind:dialogRef={confirmDialogRef}
  >
    <p class="text-sm text-md-on-surface/80 mb-3">{confirmDialog.message}</p>
    {#if confirmDialog.note}
      <p class="text-xs text-md-on-surface/50 bg-md-surface-variant/40 rounded-lg px-3 py-2 mb-4">{confirmDialog.note}</p>
    {/if}
    {#if confirmDialog.onSecondary && confirmDialog.secondaryLabel}
      <Btn
        variant="outline"
        size="md"
        class="w-full mb-2 text-md-primary border-md-primary/30 hover:bg-md-primary/10 justify-start"
        aria-label={confirmDialog.secondaryLabel}
        onclick={() => confirmDialog.onSecondary?.()}
      >
        <Icon name="trashBox" class="w-4 h-4 shrink-0" />
        {confirmDialog.secondaryLabel}
      </Btn>
    {/if}

    {#snippet footer()}
      <Btn
        variant="ghost"
        size="sm"
        aria-label={$t('common.cancel')}
        onclick={onClose}
      >
        {$t('common.cancel')}
      </Btn>
      <Btn
        variant="danger"
        size="sm"
        aria-label={$t('common.confirm')}
        onclick={() => {
          const fn = confirmDialog.onConfirm;
          fn();
          onClose();
        }}
      >
        {confirmDialog.confirmLabel ?? $t('common.confirm')}
      </Btn>
    {/snippet}
  </ModalDialog>
{/if}
