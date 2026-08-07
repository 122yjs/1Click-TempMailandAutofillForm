/**
 * User-facing labels for activity page/dialog visit keys (view ids).
 * Never show raw storage keys like "storagePerformance" to end users.
 */
const VIEW_LABEL_KEYS: Record<string, string> = {
  mailbox: 'nav.mailbox',
  addresses: 'nav.addresses',
  addressView: 'nav.addresses',
  mailView: 'inbox.title',
  autofill: 'nav.autofill',
  identities: 'nav.profiles',
  loginInfo: 'nav.credentials',
  organize: 'nav.organize',
  automation: 'nav.automation',
  tagManagement: 'nav.tagManagement',
  labelManagement: 'nav.labelManagement',
  filtersManagement: 'nav.savedSearches',
  analytics: 'nav.activity',
  settings: 'nav.settings',
  about: 'nav.about',
  keybindings: 'nav.keyboardShortcuts',
  mailProvider: 'preferences.mailProviderSettings',
  storagePerformance: 'preferences.storageAndPerformance',
  constantsSettings: 'preferences.constants',
  diagnostics: 'preferences.diagnostics',
  playground: 'nav.playground',
  // Dialogs
  'dialog:createInbox': 'activity.dialogCreateInbox',
  'dialog:tag': 'activity.dialogTag',
  'dialog:confirm': 'activity.dialogConfirm',
  'dialog:export': 'activity.dialogExport',
  'dialog:import': 'activity.dialogImport',
  'dialog:qr': 'activity.dialogQr',
  'dialog:commandPalette': 'activity.dialogCommandPalette',
  'dialog:masterPassword': 'activity.dialogMasterPassword',
  'dialog:identityCreate': 'activity.dialogIdentityCreate',
  'dialog:identityEdit': 'activity.dialogIdentityEdit',
  'dialog:label': 'activity.dialogLabel',
  'dialog:filter': 'activity.dialogFilter',
};

/** Fallback: Title Case from camelCase / kebab id */
export function humanizeViewId(viewId: string): string {
  const cleaned = viewId.replace(/^dialog:/, '').replace(/[_-]+/g, ' ');
  return cleaned
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function viewDisplayLabelKey(viewId: string): string | null {
  return VIEW_LABEL_KEYS[viewId] ?? null;
}
