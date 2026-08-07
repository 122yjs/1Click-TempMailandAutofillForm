import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Entrypoint Parity (AGENTS.md Rule 1)', () => {
  const root = join(import.meta.dir, '..', '..', '..', 'src', 'entrypoints');
  const popupSrc = readFileSync(join(root, 'popup', 'Popup.svelte'), 'utf-8');
  const sidepanelSrc = readFileSync(join(root, 'sidepanel', 'Sidepanel.svelte'), 'utf-8');
  const appSrc = readFileSync(join(root, 'app', 'App.svelte'), 'utf-8');

  test('all entrypoint svelte files import AppLayout', () => {
    expect(popupSrc).toContain("import AppLayout from '@/ui/blocks/layout/AppLayout.svelte'");
    expect(sidepanelSrc).toContain("import AppLayout from '@/ui/blocks/layout/AppLayout.svelte'");
    expect(appSrc).toContain("import AppLayout from '@/ui/blocks/layout/AppLayout.svelte'");
  });

  test('all entrypoint svelte files check $isLoading for svelte-i18n loading state', () => {
    // Accept both a standalone isLoading import and a merged one (biome
    // organizeImports merges same-module imports); the invariant is that
    // isLoading comes from svelte-i18n and the render is gated on $isLoading.
    const isLoadingImport = "import { isLoading } from 'svelte-i18n'";
    expect(popupSrc).toContain(isLoadingImport);
    expect(popupSrc).toContain('{#if $isLoading}');
    expect(sidepanelSrc).toContain(isLoadingImport);
    expect(sidepanelSrc).toContain('{#if $isLoading}');
    expect(appSrc).toContain('isLoading');
    expect(appSrc).toContain("from 'svelte-i18n'");
    expect(appSrc).toContain('{#if $isLoading}');
  });

  test('all entrypoint svelte files pass their respective context to AppLayout', () => {
    expect(popupSrc).toContain('<AppLayout context="popup" />');
    expect(sidepanelSrc).toContain('<AppLayout context="sidepanel" />');
    expect(appSrc).toContain('<AppLayout context="app" />');
  });
});
