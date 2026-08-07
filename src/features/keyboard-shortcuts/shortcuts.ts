import type { Account, Email, Keybinding, Keybindings } from '@/utils/types.js';

export interface ShortcutsState {
  currentView: string;
  mgmtTab: string;
  selectedAddresses: Set<string>;
  mgmtSearch: string;
  qrDialogOpen: boolean;
  confirmDialog: { message: string; onConfirm: () => void } | null;
  selectedMessage: Email[] | null;
  currentEmailDetail: Account | null;
  /** True when ANY blocking modal/dialog is open (create inbox, tag, import,
   * export, master password, etc.). Global nav/letter shortcuts are suppressed. */
  modalOpen: boolean;
}

export interface ShortcutsCallbacks {
  refreshInbox: () => void;
  createInbox: () => void;
  copyEmail: () => void;
  copyOtp: () => void;
  closeConfirm: () => void;
  closeQrDialog: () => void;
  setCurrentView: (view: string) => void;
  setSelectedAddresses: (addresses: Set<string>) => void;
  setMgmtSearch: (search: string) => void;
  setSelectedMessage: (message: Email[] | null) => void;
  setCurrentEmailDetail: (detail: Account | null) => void;
  toggleAccountSelector?: () => void;
  focusSearch?: () => void;
  /** j/k message list navigation (optional) */
  navigateMessageList?: (direction: 'next' | 'prev') => void;
}

function matchesKeybinding(event: KeyboardEvent, binding: Keybinding): boolean {
  const keyMatch = event.key.toLowerCase() === binding.key.toLowerCase();
  const requiresPrimaryMod = Boolean(binding.ctrlKey || binding.metaKey);
  const hasPrimaryMod = Boolean(event.ctrlKey || event.metaKey);
  const primaryMatch = requiresPrimaryMod ? hasPrimaryMod : !hasPrimaryMod;
  const shiftMatch = binding.shiftKey ? event.shiftKey : !event.shiftKey;
  const altMatch = binding.altKey ? event.altKey : !event.altKey;

  return keyMatch && primaryMatch && shiftMatch && altMatch;
}

export function handleKeydown(
  event: KeyboardEvent,
  state: ShortcutsState,
  callbacks: ShortcutsCallbacks,
  keybindings: Keybindings
) {
  const target = event.target as HTMLElement | null;
  const typingInField =
    !!target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable);

  // Refresh inbox
  if (matchesKeybinding(event, keybindings.refreshInbox) && !typingInField && !state.modalOpen) {
    event.preventDefault();
    callbacks.refreshInbox();
    return;
  }
  // Create new inbox
  if (matchesKeybinding(event, keybindings.createInbox) && !typingInField && !state.modalOpen) {
    event.preventDefault();
    callbacks.createInbox();
    return;
  }
  // Copy email (if not in input)
  if (matchesKeybinding(event, keybindings.copyEmail) && !typingInField) {
    event.preventDefault();
    callbacks.copyEmail();
    return;
  }
  // Copy OTP
  if (matchesKeybinding(event, keybindings.copyOtp) && !typingInField) {
    event.preventDefault();
    callbacks.copyOtp();
    return;
  }

  // Navigation shortcuts (Alt+Shift — avoid browser/site conflicts)
  if (
    !typingInField &&
    !state.modalOpen &&
    keybindings.openAddresses &&
    matchesKeybinding(event, keybindings.openAddresses)
  ) {
    event.preventDefault();
    callbacks.setCurrentView('addresses');
    return;
  }
  if (
    !typingInField &&
    !state.modalOpen &&
    keybindings.openIdentities &&
    matchesKeybinding(event, keybindings.openIdentities)
  ) {
    event.preventDefault();
    callbacks.setCurrentView('identities');
    return;
  }
  if (
    !typingInField &&
    !state.modalOpen &&
    keybindings.openSavedLogins &&
    matchesKeybinding(event, keybindings.openSavedLogins)
  ) {
    event.preventDefault();
    callbacks.setCurrentView('loginInfo');
    return;
  }
  if (
    !typingInField &&
    !state.modalOpen &&
    keybindings.toggleAccountSelector &&
    matchesKeybinding(event, keybindings.toggleAccountSelector)
  ) {
    event.preventDefault();
    callbacks.toggleAccountSelector?.();
    return;
  }
  if (
    !typingInField &&
    !state.modalOpen &&
    keybindings.focusSearch &&
    matchesKeybinding(event, keybindings.focusSearch)
  ) {
    event.preventDefault();
    callbacks.focusSearch?.();
    return;
  }

  // "/" always focuses search (Gmail-style), any page — not while typing / modal
  if (
    !typingInField &&
    !state.modalOpen &&
    event.key === '/' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  ) {
    event.preventDefault();
    callbacks.focusSearch?.();
    return;
  }

  // j / k navigate message list (mailbox or split detail)
  if (
    !typingInField &&
    !state.modalOpen &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K')
  ) {
    const dir = event.key.toLowerCase() === 'j' ? 'next' : 'prev';
    if (callbacks.navigateMessageList) {
      event.preventDefault();
      callbacks.navigateMessageList(dir);
      return;
    }
  }

  // Escape: Close dialogs
  if (matchesKeybinding(event, keybindings.closeDialogs)) {
    if (state.modalOpen) {
      // Only allow dialog-close actions while a modal is open; suppress the
      // view-navigation Escape (the modal's own handler closes itself).
      if (state.qrDialogOpen) {
        callbacks.closeQrDialog();
      } else if (state.confirmDialog) {
        callbacks.closeConfirm();
      }
    } else if (state.currentView === 'addresses') {
      callbacks.setCurrentView('mailbox');
      callbacks.setSelectedAddresses(new Set());
      callbacks.setMgmtSearch('');
    } else if (
      state.currentView === 'settings' ||
      state.currentView === 'analytics' ||
      state.currentView === 'loginInfo' ||
      state.currentView === 'about' ||
      state.currentView === 'identities' ||
      state.currentView === 'automation' ||
      state.currentView === 'organize'
    ) {
      callbacks.setCurrentView('mailbox');
    } else if (state.currentView === 'addressView') {
      callbacks.setCurrentView('addresses');
      callbacks.setCurrentEmailDetail(null);
    } else if (state.currentView === 'mailView') {
      callbacks.setCurrentView('mailbox');
      callbacks.setSelectedMessage(null);
    } else if (state.qrDialogOpen) {
      callbacks.closeQrDialog();
    } else if (state.confirmDialog) {
      callbacks.closeConfirm();
    }
  }
}
