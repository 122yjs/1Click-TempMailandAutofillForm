/**
 * Intelligence layer public API.
 */

export { classifyFieldA11y, getAccessibleName } from './a11y-fields.js';
export { getActiveInboxMeta } from './active-inbox-meta.js';
export type { AddressUsageMap, AddressUsageSite } from './address-usage.js';
export { getAddressUsageDomains, getAddressUsageMap } from './address-usage.js';
export { buildAutofillPlan } from './autofill-plan.js';
export {
  acceptBlockSuggestion,
  dismissBlockSuggestion,
  getBlockSuggestions,
  recordAutofillFailure,
  recordAutofillSuccess,
} from './blocklist-learn.js';
export {
  createFreshInboxAddress,
  pageShowsEmailConflict,
  pageShowsOtpFailure,
  pageShowsUsernameConflict,
  watchEmailConflict,
  watchOtpFailure,
  watchUsernameConflict,
} from './conflict-watch.js';
export { collectFormsDeep, collectInputsDeep, queryAllDeep } from './dom-pierce.js';
export type { DryRunRow } from './dry-run.js';
export { showDryRunPreview } from './dry-run.js';
export type { FieldMapEntry, SiteFieldMap } from './field-maps.js';
export {
  buildSelectorHint,
  getFieldMap,
  recordFieldMapHit,
  resolveMappedField,
} from './field-maps.js';
export { maybeHumanDelay, randomBetween, sleep } from './fill-timing.js';
export { scoreForm, uniqueFieldKinds } from './form-score.js';
export type { FreshnessCandidate } from './freshness.js';
export { pickFreshestIdentity, rankIdentitiesForSignup } from './freshness.js';
export { rememberIdentityForDomain, routeIdentityForDomain } from './identity-router.js';
export {
  getLifecycleForInbox,
  recomputeLifecycleFromStorage,
  recordInboxAutofill,
  recordInboxMailSignals,
  suggestLifecycleActions,
} from './inbox-lifecycle.js';
export {
  detectPageLocale,
  localeAwareAddressExtras,
  localeAwarePhone,
  localeToCountryHint,
} from './locale-fill.js';
export {
  filterEmailsForNotification,
  getNotificationIntelligenceSettings,
  isInQuietHours,
  isOtpOrMagic,
} from './notification-policy.js';
export type { SignupOutcomeStatus } from './post-submit.js';
export {
  looksLikeSignupSuccess,
  markLatestCredentialStatus,
  markLatestCredentialVerified,
  watchPostSubmitSuccess,
} from './post-submit.js';
export {
  getBestHealthyProvider,
  getProviderFailoverOrder,
  getProviderHealth,
  providerHealthScore,
  rankProvidersByHealth,
  recordProviderCreate,
  recordProviderFetch,
  resolveCreateProvider,
} from './provider-health.js';
export { recordAutofillOutcome, shouldPreferReplay } from './site-memory.js';
export type { SiteRule, SiteRuleMatch } from './site-rules.js';
export {
  clearArchiveSchedule,
  deleteSiteRule,
  getDueArchiveInboxIds,
  loadSiteRules,
  matchSiteRule,
  resolveRuleIdentityId,
  resolveRuleProviderId,
  saveSiteRules,
  scheduleArchiveFromRule,
  upsertSiteRule,
} from './site-rules.js';
export type { SmartAutofillSettings } from './smart-settings.js';
export {
  DEFAULT_SMART_AUTOFILL,
  loadSmartAutofillSettings,
  saveSmartAutofillSettings,
} from './smart-settings.js';
export {
  getSiteProfile,
  loadIdentityStickyMap,
  loadInboxLifecycleMap,
  loadNotificationIntelligence,
  loadProviderHealthMap,
  loadSiteProfiles,
  normalizeDomain,
  saveNotificationIntelligence,
} from './storage.js';
export {
  armSignupOutcomeAfterSubmit,
  clickPrimaryAction,
  findPrimaryActionButton,
} from './submit-action.js';
export * from './types.js';
export type { UndoFrame } from './undo-stack.js';
export { FormUndoStack, getFormUndoStack } from './undo-stack.js';
export type { WizardSession, WizardStep } from './wizard-session.js';
export {
  advanceWizardStep,
  clearWizardSession,
  detectWizardStepFromPage,
  getWizardSession,
  upsertWizardSession,
} from './wizard-session.js';
