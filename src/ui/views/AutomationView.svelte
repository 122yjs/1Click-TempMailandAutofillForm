<script lang="ts">
import { onMount } from 'svelte';
import { t } from 'svelte-i18n';
import { browser } from 'wxt/browser';
import Icon from '@/ui/components/icons/Icon.svelte';
import { Checkbox, Dropdown } from '@/ui/components/primitives';
import { getAllProviderConfigs } from '@/utils/email-service.js';
import { logError } from '@/utils/logger.js';
import { toastStore } from '@/utils/toastStore.js';
import type { Identity } from '@/utils/types.js';

let { onBack = () => {} } = $props<{
  onBack?: () => void;
}>();

interface AutomationRules {
  autoArchiveOnCopyOtp: boolean;
  autoArchiveOnRead: boolean;
  autoDeletePromo24h: boolean;
}

const DEFAULT_RULES: AutomationRules = {
  autoArchiveOnCopyOtp: true,
  autoArchiveOnRead: false,
  autoDeletePromo24h: false,
};

let automationRules = $state<AutomationRules>({ ...DEFAULT_RULES });

/**
 * Future routing-rule model (identity / mailbox / sender condition → action).
 * Laid out now so the "Create rule" pill and the identity/mailbox mixing rules
 * have a home. Wired end-to-end once the rule engine lands.
 */
export interface AutomationRule {
  id: string;
  name: string;
  condition: {
    identityIds?: string[];
    mailboxAddresses?: string[];
    senderPattern?: string;
  };
  action: {
    archive?: boolean;
    deleteAfterDays?: number;
    tag?: string;
    autoExtend?: boolean;
  };
  enabled: boolean;
}

async function loadAutomationRules() {
  try {
    const res = (await browser.storage.local.get(['automationRules'])) as {
      automationRules?: Partial<AutomationRules>;
    };
    if (res.automationRules) {
      automationRules = { ...DEFAULT_RULES, ...res.automationRules };
    }
  } catch (error) {
    logError('Failed to load automation rules', error);
  }
}

async function saveAutomationRule(key: keyof AutomationRules, val: boolean) {
  automationRules = { ...automationRules, [key]: val };
  try {
    await browser.storage.local.set({ automationRules });
  } catch (error) {
    logError('Failed to save automation rule', error);
  }
}

// ── Site rules (moved from Settings → General) ───────────────────────────────
/** Site rules: domain → identity / provider / auto-archive */
type SiteRuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  domainPattern: string;
  identityId?: string | null;
  providerId?: string | null;
  autoArchiveDays?: number | null;
};
let siteRules = $state<SiteRuleRow[]>([]);
let newRuleDomain = $state('');
let newRuleIdentityId = $state('');
let newRuleProviderId = $state('');
let newRuleArchiveDays = $state(0);
let ruleIdentities = $state<Identity[]>([]);
let ruleProviders = $state<{ id: string; label: string }[]>([]);

async function loadSiteRulesData() {
  try {
    const { loadSiteRules } = await import('@/features/intelligence/site-rules.js');
    siteRules = await loadSiteRules();
    const idRes = (await browser.storage.local.get(['identities'])) as {
      identities?: Identity[];
    };
    ruleIdentities = idRes.identities || [];
    ruleProviders = getAllProviderConfigs().map((p) => ({
      id: p.id,
      label: p.displayName || p.name || p.id,
    }));
  } catch {
    /* ignore */
  }
}

async function addSiteRule() {
  const domain = newRuleDomain.trim();
  if (!domain) return;
  try {
    const { upsertSiteRule } = await import('@/features/intelligence/site-rules.js');
    await upsertSiteRule({
      domainPattern: domain,
      name: domain,
      enabled: true,
      identityId: newRuleIdentityId || null,
      providerId: newRuleProviderId || null,
      autoArchiveDays: newRuleArchiveDays > 0 ? newRuleArchiveDays : null,
    });
    newRuleDomain = '';
    newRuleIdentityId = '';
    newRuleProviderId = '';
    newRuleArchiveDays = 0;
    await loadSiteRulesData();
    toastStore.success($t('intelligence.ruleSaved'));
  } catch (e) {
    logError('Failed to save site rule', undefined, e instanceof Error ? e : new Error(String(e)));
    toastStore.error($t('intelligence.ruleSaveFailed'));
  }
}

async function toggleSiteRule(id: string, enabled: boolean) {
  const row = siteRules.find((r) => r.id === id);
  if (!row) return;
  try {
    const { upsertSiteRule } = await import('@/features/intelligence/site-rules.js');
    await upsertSiteRule({ ...row, enabled, domainPattern: row.domainPattern });
    await loadSiteRulesData();
  } catch {
    /* ignore */
  }
}

async function removeSiteRule(id: string) {
  try {
    const { deleteSiteRule } = await import('@/features/intelligence/site-rules.js');
    await deleteSiteRule(id);
    await loadSiteRulesData();
  } catch {
    /* ignore */
  }
}

onMount(() => {
  void loadAutomationRules();
  void loadSiteRulesData();
});

const ruleRows: Array<{
  key: keyof AutomationRules;
  title: string;
  hint: string;
}> = [
  {
    key: 'autoArchiveOnCopyOtp',
    title: $t('automation.autoArchiveOnCopyOtp'),
    hint: $t('automation.autoArchiveOnCopyOtpHint'),
  },
  {
    key: 'autoArchiveOnRead',
    title: $t('automation.autoArchiveOnRead'),
    hint: $t('automation.autoArchiveOnReadHint'),
  },
  {
    key: 'autoDeletePromo24h',
    title: $t('automation.autoDeletePromo24h'),
    hint: $t('automation.autoDeletePromo24hHint'),
  },
];
</script>

<div class="flex flex-col h-full min-h-0 bg-md-surface text-md-on-surface">
  <!-- Header -->
  <div class="shrink-0 flex items-center gap-2 px-3 pt-2 pb-2 border-b border-md-outline-variant/20">
    <button
      type="button"
      class="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-md-surface-variant"
      aria-label={$t('common.back')}
      onclick={onBack}
    >
      <Icon name="back" class="w-4 h-4" />
    </button>
    <div class="min-w-0">
      <h1 class="text-base font-bold text-md-on-surface truncate">{$t('automation.title')}</h1>
      <p class="text-xs text-md-on-surface/55 truncate">{$t('automation.subtitle')}</p>
    </div>
  </div>

  <div class="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-4">
    <!-- Behaviour automations -->
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <Icon name="flame" class="w-4 h-4 text-md-primary" />
        <h2 class="text-sm font-bold text-md-on-surface">{$t('automation.behaviourTitle')}</h2>
      </div>
      <div class="space-y-2">
        {#each ruleRows as row (row.key)}
          <label
            class="flex items-center justify-between gap-3 p-3 rounded-xl bg-md-surface-container-low border border-md-outline-variant/20 cursor-pointer hover:bg-md-surface-container transition-colors"
          >
            <div class="min-w-0 space-y-0.5">
              <div class="text-xs font-semibold text-md-on-surface">{row.title}</div>
              <div class="text-xs text-md-on-surface/50">{row.hint}</div>
            </div>
            <Checkbox
              class="shrink-0"
              checked={automationRules[row.key]}
              onchange={(e) => void saveAutomationRule(row.key, e.currentTarget.checked)}
            />
          </label>
        {/each}
      </div>
    </section>

    <!-- Future routing rules (identity / mailbox) -->
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <Icon name="threads" class="w-4 h-4 text-md-primary" />
        <h2 class="text-sm font-bold text-md-on-surface">{$t('automation.rulesTitle')}</h2>
      </div>
      <div class="rounded-xl border border-dashed border-md-outline-variant/40 p-4 text-center">
        <p class="text-xs text-md-on-surface/60">{$t('automation.rulesEmpty')}</p>
        <button
          type="button"
          class="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-md-primary text-md-on-primary hover:bg-md-primary/90 transition-colors"
          onclick={() => toastStore.info($t('automation.rulesComingSoon'))}
        >
          <Icon name="plus" class="w-3.5 h-3.5" />
          {$t('automation.createRule')}
        </button>
      </div>
    </section>

    <!-- Site rules (moved from Settings → General) -->
    <section class="space-y-2">
      <div class="flex items-center gap-2">
        <Icon name="filter" class="w-4 h-4 text-md-primary" />
        <h2 class="text-sm font-bold text-md-on-surface">{$t('intelligence.rulesTitle')}</h2>
      </div>
      <div class="rounded-xl border border-md-outline-variant/20 bg-md-surface-container-low px-3 py-2.5 space-y-2">
        <p class="text-xs text-md-on-surface/50">{$t('intelligence.rulesHint')}</p>

        <div class="space-y-1.5">
          <input
            type="text"
            class="w-full px-2 py-1.5 text-xs rounded-lg bg-md-surface border border-md-outline-variant/40"
            placeholder={$t('intelligence.ruleDomainPlaceholder')}
            bind:value={newRuleDomain}
          />
          <div class="flex flex-wrap gap-1.5">
            <Dropdown
              class="flex-1 min-w-[100px]"
              size="xs"
              variant="outlined"
              ariaLabel={$t('intelligence.ruleAnyIdentity')}
              bind:value={newRuleIdentityId}
              options={[
                { value: '', label: $t('intelligence.ruleAnyIdentity') },
                ...ruleIdentities.map((id) => ({ value: id.id, label: id.name })),
              ]}
            />
            <Dropdown
              class="flex-1 min-w-[100px]"
              size="xs"
              variant="outlined"
              ariaLabel={$t('intelligence.ruleAnyProvider')}
              bind:value={newRuleProviderId}
              options={[
                { value: '', label: $t('intelligence.ruleAnyProvider') },
                ...ruleProviders.map((p) => ({ value: p.id, label: p.label })),
              ]}
            />
            <input
              type="number"
              min="0"
              max="365"
              class="w-20 px-2 py-1.5 text-xs rounded-lg bg-md-surface border border-md-outline-variant/40"
              title={$t('intelligence.ruleArchiveDays')}
              placeholder="0"
              bind:value={newRuleArchiveDays}
            />
          </div>
          <button
            type="button"
            class="w-full py-1.5 text-xs font-semibold rounded-lg bg-md-primary text-md-on-primary"
            onclick={() => void addSiteRule()}
          >
            {$t('intelligence.ruleAdd')}
          </button>
        </div>

        {#if siteRules.length === 0}
          <p class="text-label-sm text-md-on-surface/40">{$t('intelligence.rulesEmpty')}</p>
        {:else}
          <ul class="space-y-1.5 max-h-48 overflow-y-auto">
            {#each siteRules as rule (rule.id)}
              <li
                class="flex items-start gap-2 rounded-lg bg-md-surface/70 px-2 py-1.5 border border-md-outline-variant/20"
              >
                <label class="flex items-center pt-0.5 cursor-pointer shrink-0">
                  <Checkbox
                    checked={rule.enabled}
                    onchange={(e) => void toggleSiteRule(rule.id, e.currentTarget.checked)}
                  />
                </label>
                <div class="min-w-0 flex-1">
                  <div class="text-xs font-semibold text-md-on-surface truncate">{rule.domainPattern}</div>
                  <div class="text-xs text-md-on-surface/50 truncate">
                    {#if rule.identityId}
                      {$t('intelligence.ruleIdentityLabel')}:
                      {ruleIdentities.find((i) => i.id === rule.identityId)?.name || rule.identityId}
                    {/if}
                    {#if rule.providerId}
                      · {$t('intelligence.ruleProviderLabel')}:
                      {ruleProviders.find((p) => p.id === rule.providerId)?.label || rule.providerId}
                    {/if}
                    {#if rule.autoArchiveDays}
                      · {$t('intelligence.ruleArchiveLabel', {
                        values: { n: rule.autoArchiveDays },
                      })}
                    {/if}
                  </div>
                </div>
                <button
                  type="button"
                  class="text-xs font-semibold text-md-error shrink-0 px-1"
                  onclick={() => void removeSiteRule(rule.id)}
                >
                  {$t('common.delete')}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </div>
</div>
