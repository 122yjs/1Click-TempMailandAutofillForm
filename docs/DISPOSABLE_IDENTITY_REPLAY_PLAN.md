# Plan: Disposable Identity Replay

> **Status:** Proposal / pre-implementation
> **Related files:** `src/entrypoints/content/autofill/form-filler.ts`, `src/entrypoints/content/autofill/autofill-buttons.ts`, `src/entrypoints/background/runtime/message-handler.ts`, `src/features/login-info/login-actions.ts`, `src/utils/crypto.ts`

## 1. Goal

Offer users the ability to re-fill a form on a site using the **same disposable
identity** (temp email + generated password + name/username/phone) they
previously used on that domain with the current active inbox - instead of
generating a fresh random identity each time.

This is scoped to **disposable identities** (tied to a temp inbox + domain),
not a password manager. See §2 for the explicit boundary.

## 2. What this is NOT (the password-manager boundary)

To keep the product coherent ("temp mail + autofill," not "vault"), this
feature deliberately does **not** include:

- ❌ A vault of real/permanent accounts
- ❌ Cross-device sync of credentials
- ❌ A master password / persistent key derivation
- ❌ Editing or importing saved credentials
- ❌ Auto-login (always user-initiated via the autofill button)
- ❌ Bypassing the autofill blocklist

The saved-logins view (`SavedLoginsView.svelte`) stays a **record**; replay
adds a single "re-use" action scoped to `(temp inbox ↔ domain)`.

## 3. Current State (the data already exists)

`loginInfo[]` (in `browser.storage.local`, capped at 50, newest first) already
stores per-fill, written by `form-filler.ts:222-244`:

```
{ email, username, name, phone, website, password (encrypted), domain, inboxId, identityId, timestamp }
```

The lookup key `(domain, inboxId)` is **already present** in every entry. So
this is a *lookup + offer* feature, not new storage. No schema change needed.

## 4. The Session-Key Constraint (honest limitation)

The encryption master key lives in `browser.storage.session`
(`crypto.ts:102`), which is cleared when the browser restarts. Consequences:

- **Within a browser session:** replay works - the key is available, `decrypt()`
  succeeds.
- **After a browser restart:** old encrypted passwords can't be decrypted →
  replay is not offered for pre-restart entries; the user generates a new
  identity (correct disposable behavior).

This is **acceptable for disposable identities** (they're meant to be ephemeral,
and the temp inbox itself usually expires within hours) and is arguably a
security feature (a previous session's credentials don't persistently leak).

A second constraint: **content scripts cannot read `browser.storage.session`**
(MV3 restricts it to extension contexts - background, popup, sidepanel). So the
decrypt + lookup must happen in the **background** via a runtime message, not in
the content script.

## 5. Architecture - background-mediated lookup

```
Content script ──sendMessage──▶ Background ──▶ reads loginInfo
                                              ──▶ decrypts passwords
                                              ──▶ finds most recent (domain, inboxId) match
               ◀──response──── Background
Content script fills the form with the returned credential
```

New message shape (added to the `BackgroundMessage` union in `types.ts`):

```ts
| { action: 'findReusableIdentity'; domain: string; inboxId: string }
```

Response shape:

```ts
{
  found: boolean;
  credential?: {
    email: string;
    password: string;
    username?: string | null;
    name?: string | null;
    phone?: string | null;
    website?: string | null;
  };
}
```

## 6. Data Flow

1. User navigates to domain `X`, with active temp inbox `Y` (`activeInboxId`).
2. The content script's `injectAutoFillButtons` (already `async`) sends
   `findReusableIdentity { domain: X, inboxId: Y.id }` to the background.
3. Background reads `loginInfo`, decrypts passwords, finds the **most recent**
   entry where `domain === X && inboxId === Y.id` and whose password decrypted
   successfully.
4. Returns `{ found: true, credential }` or `{ found: false }`.
5. If found: the "Fill All" pill button and the popup's "Autofill Entire Form"
   item become **"Re-use identity for {domain}"** (highlighted).
6. User clicks → `fillSignupForm(form, updateAndCopyCredentials, undefined,
   replayCredential)`.
7. `fillSignupForm` uses the `replayCredential` values instead of generating
   new ones; still dispatches `input`/`change` events; still calls
   `updateAndCopyCredentials`; does **not** append a new `loginInfo` entry
   (it's a replay, not a new fill - avoids duplicates; the original entry is
   the record).

## 7. Implementation Phases

### Phase 1 - Background lookup + decrypt handler

**Files:**
- `src/utils/types.ts` - add `| { action: 'findReusableIdentity'; domain: string; inboxId: string }` to the `BackgroundMessage` union (lines ~436-460).
- `src/entrypoints/background/runtime/message-handler.ts` - add `findReusableIdentity` to the `handlers` map and the local `RuntimeMessage` interface (lines 46-70). Implement: read `loginInfo` from storage, decrypt each entry's password, find the most recent match on `(domain, inboxId)`, return the credential.
- **Shared decrypt helper:** `decryptLoginsForDisplay()` currently lives in `src/features/login-info/login-actions.ts` (a UI-layer module). Importing a UI feature into the background is a layering smell. **Recommendation:** extract a `decryptCredentials(logins)` helper to `src/utils/crypto.ts` (or a new `src/features/login-info/login-crypto.ts`), and have both `login-actions.ts` and the new background handler import it.

### Phase 2 - Content-script lookup + UX wiring

**Files:**
- `src/entrypoints/content/autofill/autofill-buttons.ts`:
  - `injectAutoFillButtons` (line ~376, already `async`): before creating the "Fill All" pill (line ~617), send `findReusableIdentity`. If found, label the pill **"Re-use identity"** and wire its click to `fillSignupForm(form, updateAndCopyCredentials, undefined, replayCredential)`.
  - `showAutofillPopup` (line ~97): accept the `replayCredential` (or a flag). The "Autofill Entire Form" item (line ~351) becomes **"Re-use identity for {domain}"** (highlighted) when a replay credential is available; keep a "Generate new" option below it so the user can still re-roll.
- `src/entrypoints/content/autofill/form-filler.ts`:
  - Add an optional 4th param `replayCredential?: ReusableCredential` to `fillSignupForm` (line 69).
  - If present: **skip** `getPasswordToFill()` (line 147), `getNamesToFill()` (line 110), `generateUsername()` (150), `generatePhoneNumber()` (151), `generateWebsiteUrl()` (159) - use the provided values instead.
  - Still fill all fields + dispatch `input`/`change` events (lines 162-202).
  - Still call `updateAndCopyCredentials(credentials)` (line 213) so the session credential + clipboard stay consistent.
  - **Skip** the `loginInfo` append (lines 215-236) - it's a replay, not a new fill.
- `src/entrypoints/content/index.ts`: the `autofillForm` message handler (line ~262) and the existing identity-load path (lines ~180-234) already show the pattern of passing a credential bundle into `fillSignupForm` - reuse that pattern for replay.

### Phase 3 - i18n + polish

- Add new UI strings to `src/locales/en.json` (source of truth) and mirror
  to all 6 locales (`ar`, `de`, `es`, `fr`, `ja`, `zh`) per AGENTS.md rule #3:
  - `autofill.reuseIdentity` - "Re-use identity"
  - `autofill.reuseIdentityFor` - "Re-use identity for {domain}"
  - `autofill.identityReused` - "Identity re-used" (toast)
  - (Optional) `autofill.lastUsed` - "Last used {time}" (timestamp hint)
- Run `bun run check-translations` to verify completeness.
- The autofill blocklist is already respected - `scanForFormsAndInjectButtons`
  (`content/index.ts:41-47`) returns early on blocked domains, so no buttons
  (and thus no replay offer) appear. No new blocklist logic needed.

## 8. UX Design

- **"Fill All" pill** (positioned above the form, `autofill-buttons.ts:~617`):
  - Default label: "Fill All"
  - When a reusable identity exists for `(currentDomain, activeInboxId)`:
    label becomes **"Re-use identity"** with the active inbox address shown in
    small text beneath. Clicking fills the whole form with the saved identity.
- **Popup "Autofill Entire Form" item** (`autofill-buttons.ts:~351`):
  - When a replay credential exists: becomes **"Re-use identity for {domain}"**
    (highlighted, same styling as the active-email item). A "Generate new"
    option remains below it so the user can still re-roll a fresh identity.
  - When no replay credential exists: unchanged ("Autofill Entire Form" →
    generate new).
- **Per-field items** (email/password/name/etc.): unchanged in v1. Replay is
  whole-identity, not field-by-field. Per-field replay is a possible v2.
- **No auto-fill** - always a user click. This respects the "1Click"
  philosophy (user initiates) and the autofill blocklist.

## 9. Edge Cases & Decisions

| Case | Behavior |
|------|----------|
| No active inbox (`activeInboxId` unset) | No lookup; no replay offered; fall back to "generate new" |
| Active inbox expired, credential saved | Replay still offered (the password still works on the site - the site doesn't know the inbox expired). Optionally note "inbox expired" in the UI. |
| Multiple entries for `(domain, inboxId)` | Use the **most recent** (loginInfo is newest-first) |
| Decryption fails (post-restart, key gone) | Skip that entry; if none decrypt, no replay offered → "generate new" |
| 50-entry cap evicted the entry | No replay; generate new (correct disposable behavior - the identity is gone) |
| User re-rolls password manually after replay | That's a new fill → saved as a new `loginInfo` entry → becomes the most-recent match next time |
| Domain has no saved credential yet | Normal "generate new" flow (current behavior) |

## 10. Testing

- **Background handler unit test:** mock `loginInfo` with (a) an encrypted
  entry matching `(domain, inboxId)`, (b) a non-matching entry, (c) an entry
  whose decrypt fails. Assert `findReusableIdentity` returns the decrypted
  match for (a), skips (c), and returns `found: false` when none match.
- **`fillSignupForm` replay-path unit test:** call with a `replayCredential`;
  assert it fills the provided values and does **not** invoke
  `generatePassword` / `generateRandomName` / `generateUsername`. Assert it
  does not append to `loginInfo`.
- **Blocklist respect:** covered by the existing
  `scanForFormsAndInjectButtons` guard (`content/index.ts:45`) - no new test
  needed, but worth a manual smoke test on a blocked domain.

## 11. File Impact Analysis

| File | Change |
|------|--------|
| `src/utils/types.ts` | add `findReusableIdentity` to `BackgroundMessage` union |
| `src/entrypoints/background/runtime/message-handler.ts` | add handler + `RuntimeMessage` fields |
| `src/features/login-info/login-actions.ts` | extract `decryptLoginsForDisplay` → shared helper |
| `src/utils/crypto.ts` (or new `login-crypto.ts`) | shared `decryptCredentials(logins)` helper |
| `src/entrypoints/content/autofill/autofill-buttons.ts` | lookup before rendering; relabel + wire "Re-use identity" |
| `src/entrypoints/content/autofill/form-filler.ts` | `replayCredential` param; skip generation; skip loginInfo append |
| `src/locales/*.json` (en + 6) | new strings |
| `package.json` | no change (no new deps) |

## 12. Open Questions

1. **Cross-session replay?** Default: **no** (session-scoped, per the
   `storage.session` key). Option: move the master key to `storage.local` for
   persistence across restarts - weaker crypto (key on disk) but enables
   next-day replay. **Recommend:** ship session-scoped first; revisit only if
   users explicitly ask for cross-session.
2. **Append `loginInfo` on replay?** **Recommend: no** - avoids duplicates;
   the original entry is the record. (If we later want "replay history," we
   could append with a `replay: true` flag, but that's scope creep for v1.)
3. **Per-field replay in v2?** Defer - whole-identity replay is the coherent
   unit; per-field replay invites the "password manager" mental model.
4. **Separate settings toggle?** **Recommend: no** - the feature is
   user-initiated (a click) and respects the blocklist, so a separate toggle
   adds UI noise. Revisit if users want it off by default.
5. **Show "last used" timestamp?** Nice-to-have for discoverability; defer to
   polish phase.

---

*This is a planning document, not an implementation spec. Concrete code
changes should be tracked in separate tasks once the open questions in §12 are
resolved.*

