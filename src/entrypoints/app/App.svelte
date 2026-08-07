<script lang="ts">
import { onMount } from 'svelte';
import { isLoading, t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import AppLayout from '@/ui/blocks/layout/AppLayout.svelte';
import BottomSheet from '@/ui/components/composites/BottomSheet.svelte';
import Icon from '@/ui/components/icons/Icon.svelte';

let sidePanelOpen = $state(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Full-page app view.
 * Side panel must NOT open while this app.html tab is the active surface —
 * disable the panel for this tab only (other sites keep side panel).
 */
onMount(() => {
  void (async () => {
    try {
      const chromeApi = (
        globalThis as unknown as {
          chrome?: {
            sidePanel?: {
              setOptions?: (opts: {
                path?: string;
                enabled?: boolean;
                tabId?: number;
              }) => Promise<void>;
              setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void>;
            };
            action?: { setPopup?: (d: { popup: string }) => Promise<void> | void };
            tabs?: {
              getCurrent?: () => Promise<{ id?: number } | undefined>;
            };
          };
        }
      ).chrome;
      const anyBrowser = browser as typeof browser & {
        sidePanel?: {
          setOptions?: (opts: {
            path?: string;
            enabled?: boolean;
            tabId?: number;
          }) => Promise<void>;
          setPanelBehavior?: (opts: { openPanelOnActionClick: boolean }) => Promise<void>;
        };
        action?: { setPopup?: (details: { popup: string }) => Promise<void> };
        tabs?: {
          getCurrent?: () => Promise<{ id?: number } | undefined>;
        };
      };
      const sidePanel = chromeApi?.sidePanel ?? anyBrowser.sidePanel;
      const action = chromeApi?.action ?? anyBrowser.action;
      await sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
      await action?.setPopup?.({ popup: 'popup.html' });
      // Global path stays available for other tabs
      await sidePanel?.setOptions?.({ path: 'sidepanel.html', enabled: true });
      // This app tab: disable side panel so users cannot open it alongside app.html
      try {
        const tab = await (chromeApi?.tabs?.getCurrent ?? anyBrowser.tabs?.getCurrent)?.();
        if (tab?.id != null) {
          await sidePanel?.setOptions?.({ tabId: tab.id, enabled: false });
        }
      } catch {
        /* per-tab options may be unavailable */
      }
      await sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false });
    } catch {
      /* sidePanel API unavailable */
    }
  })();

  // Poll the background's sidePanelOpen flag: when the side panel is open
  // while this app tab is active, show the non-closable overlay so the user
  // knows to close the panel to "unlock" the full app page.
  const readSidePanelOpen = async () => {
    try {
      const { sidePanelOpen: open = false } = (await browser.storage.local.get([
        'sidePanelOpen',
      ])) as { sidePanelOpen?: boolean };
      sidePanelOpen = !!open;
    } catch {
      /* ignore */
    }
  };
  void readSidePanelOpen();
  pollTimer = setInterval(() => void readSidePanelOpen(), 500);
  const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'local' && changes.sidePanelOpen) {
      sidePanelOpen = !!changes.sidePanelOpen.newValue;
    }
  };
  browser.storage.onChanged.addListener(onStorage);
  return () => {
    if (pollTimer) clearInterval(pollTimer);
    browser.storage.onChanged.removeListener(onStorage);
  };
});
</script>

{#if $isLoading}
  <div class="flex items-center justify-center h-screen bg-md-surface text-md-on-surface"></div>
{:else}
  <AppLayout context="app" />

  {#if sidePanelOpen}
    <BottomSheet
      open={true}
      dismissible={false}
      showCloseButton={false}
      title={$t('app.sidePanelOverlayTitle')}
      ariaLabel={$t('app.sidePanelOverlayTitle')}
      onClose={() => {}}
    >
      <div class="flex flex-col items-center text-center gap-3 py-2">
        <div class="w-12 h-12 rounded-full bg-md-secondary-container/60 flex items-center justify-center text-md-primary">
          <Icon name="layout" class="w-6 h-6" />
        </div>
        <p class="text-sm text-md-on-surface/80 leading-relaxed">
          {$t('app.sidePanelOverlayBody')}
        </p>
        <p class="text-xs text-md-on-surface/50 leading-relaxed">
          {$t('app.sidePanelOverlayHint')}
        </p>
      </div>
    </BottomSheet>
  {/if}
{/if}

