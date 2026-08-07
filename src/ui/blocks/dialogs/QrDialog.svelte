<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import ModalDialog from '@/ui/components/composites/ModalDialog.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Btn } from '@/ui/components/primitives';
import { rgbToHex } from '@/utils/color-utils.js';
import { logError } from '@/utils/logger.js';

interface Props {
  open: boolean;
  selectedEmail: string;
  qrDialogElement?: HTMLElement | null;
  qrCanvas?: HTMLCanvasElement | null;
  onClose: () => void;
  onDownload: () => void;
  onCopyImage: () => void;
}
let {
  open,
  selectedEmail,
  qrDialogElement = $bindable(null),
  qrCanvas = $bindable(null),
  onClose,
  onDownload,
  onCopyImage,
}: Props = $props();

let localCanvas: HTMLCanvasElement | null = null;

async function generateQR() {
  if (!localCanvas || !selectedEmail) {
    logError('QR error: Missing canvas or email', {
      canvas: !!localCanvas,
      email: !!selectedEmail,
    });
    return;
  }
  try {
    const primaryColor =
      getComputedStyle(document.documentElement).getPropertyValue('--md-primary').trim() ||
      '#000000';

    const darkColor = rgbToHex(primaryColor);
    const lightColor = rgbToHex(
      getComputedStyle(document.documentElement).getPropertyValue('--md-surface').trim() ||
        getComputedStyle(document.documentElement).getPropertyValue('--md-background').trim() ||
        '#ffffff'
    );

    const QRCode = await import('qrcode');
    await QRCode.toCanvas(localCanvas, selectedEmail, {
      width: 160,
      margin: 2,
      color: {
        dark: darkColor,
        light: lightColor,
      },
    });
  } catch (e) {
    logError('QR error: Failed to generate QR code', {
      error: e instanceof Error ? e.message : String(e),
      email: selectedEmail.substring(0, 50),
      canvas: !!localCanvas,
    });
  }
}

onMount(() => {
  if (qrCanvas) localCanvas = qrCanvas;
});

$effect(() => {
  if (qrCanvas && qrCanvas !== localCanvas) {
    localCanvas = qrCanvas;
  }
  if (open && localCanvas) {
    generateQR();
  }
});
</script>

<ModalDialog
  {open}
  maxWidth="xs"
  {onClose}
  bind:dialogRef={qrDialogElement}
>
  <div class="flex flex-col items-center gap-3">
    <div class="bg-md-surface-container-low rounded-xl p-3 w-full flex items-center justify-center">
      <canvas bind:this={qrCanvas} width="160" height="160" class="w-40 h-40 rounded-lg"></canvas>
    </div>

    <p class="text-xs font-medium text-md-on-surface text-center break-all px-1">{selectedEmail}</p>

    <div class="flex gap-1.5 w-full">
      <Btn
        variant="primary"
        size="md"
        class="flex-1"
        aria-label={$t('qr.downloadQr')}
        onclick={(e) => { e.stopPropagation(); onDownload(); }}
      >
        <Icon name="download" class="w-3.5 h-3.5" />
        {$t('qr.download')}
      </Btn>
      <Btn
        variant="tonal"
        size="md"
        class="flex-1"
        aria-label={$t('qr.copyImage')}
        onclick={(e) => { e.stopPropagation(); onCopyImage(); }}
      >
        <Icon name="copy" class="w-3.5 h-3.5" />
        {$t('qr.copyImage')}
      </Btn>
    </div>
  </div>
</ModalDialog>
