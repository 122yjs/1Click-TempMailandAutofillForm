<script lang="ts">
import { isLoading } from 'svelte-i18n';
import AppLayout from '@/ui/blocks/layout/AppLayout.svelte';
</script>

{#if $isLoading}
  <div class="flex items-center justify-center h-screen bg-md-surface text-md-on-surface"></div>
{:else}
  <AppLayout context="sidepanel" />
{/if}
