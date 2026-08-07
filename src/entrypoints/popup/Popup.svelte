<script lang="ts">
import { isLoading } from 'svelte-i18n';
import AppLayout from '@/ui/blocks/layout/AppLayout.svelte';
</script>

{#if $isLoading}
  <div class="w-[360px] h-[600px] flex items-center justify-center bg-md-surface text-md-on-surface overflow-hidden"></div>
{:else}
  <div class="w-[360px] max-w-[360px] h-[600px] max-h-[600px] overflow-hidden flex flex-col box-border">
    <AppLayout context="popup" />
  </div>
{/if}
