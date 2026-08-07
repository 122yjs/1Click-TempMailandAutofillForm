export type View =
  | 'mailbox'
  | 'addresses'
  | 'settings'
  | 'analytics'
  | 'loginInfo'
  | 'addressView'
  | 'mailView'
  | 'about'
  | 'identities'
  /** Autofill manager: Profiles + Credentials tabs */
  | 'autofill'
  | 'keybindings'
  | 'tagManagement'
  | 'filtersManagement'
  | 'mailProvider'
  | 'storagePerformance'
  | 'labelManagement'
  | 'constantsSettings'
  | 'diagnostics'
  /** Unified Tags / Labels / Filters hub */
  | 'organize'
  /** Automation rules hub */
  | 'automation'
  /** QA autofill playground */
  | 'playground';

export type AutofillTab = 'profiles' | 'credentials';
export type OrganizeTab = 'tags' | 'labels' | 'filters';
