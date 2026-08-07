# 1Click Temp Mail Autofill Form

Generate temporary email addresses and auto-fill OTPs and login forms with one click.

## Features

- **Temporary Email Generation**: Create disposable email addresses instantly
- **OTP Auto-Detection**: Automatically detects and extracts OTP codes from emails
- **Form Auto-Fill**: One-click OTP and email form filling
- **Multiple Browser Support**: Chrome (published), Firefox & Safari builds (export-ready; store listings coming soon)
- **Identity Management**: Manage multiple identities with custom names
- **Inbox Management**: View and manage emails across multiple inboxes
- **Tag System**: Organize inboxes with custom tags and colors
- **Demo signup pages**: Built-in showcase forms for practicing Autofill in demo mode

## Permissions

This extension declares `host_permissions: ["<all_urls>"]` in its manifest. That sounds broader than it behaves - here's what it actually enables and why each capability requires it.

### What the extension does on every page

1. **Form autofill content script** - `src/entrypoints/content/index.ts:13` registers a content script with `matches: ["<all_urls>"]`. It scans every page for signup/login forms and injects an "Autofill" button. The product is universal form autofill; there is no fixed list of "signup sites" to enumerate, so the match pattern is necessarily open-ended.
2. **Disposable email detector** - `src/entrypoints/content/disposable/disposable-detector.ts` highlights the active email field when the user starts typing a known disposable domain. Operates on every page.
3. **OTP autofill** - `src/entrypoints/content/otp/otp-handler.ts` watches for OTP code inputs on any site and offers one-click fill.

A content script's `matches` array implicitly requires matching `host_permissions`; declaring `<all_urls>` keeps the two in sync.

### What the background script does on every page

4. **Context menu - "Create Temp Email"** - `src/entrypoints/background/index.ts:107-119` registers a context menu item on every page (`contexts: ['page', 'link', 'editable']`). When clicked, it calls `chrome.scripting.executeScript` against the right-clicked tab to write the new address to the clipboard. The target tab can be any site, so the scripting permission must cover all URLs.
5. **Context menu - "Exclude from Autofill"** - `src/entrypoints/background/index.ts:80-135` reads `tab.url` to label the menu per-site. Reading `tab.url` for an arbitrary cross-origin tab in MV3 requires a matching host permission.
6. **Keyboard shortcut - `Alt+Shift+F` autofill** - `src/entrypoints/background/runtime/message-handler.ts:561` queries the active tab on shortcut press and sends an `autofillForm` message; works on any site.
7. **Per-domain autofill blocklist** - `src/utils/storage-keys.ts:201-219` lets the user exclude specific sites. The blocklist check needs to read `tab.url` for the active tab on every navigation.

### What network requests it makes

8. **Mail provider APIs** - `src/utils/email-service.ts:190` and `src/utils/dsl/email-fetcher.ts:194-197` call provider endpoints with `credentials: 'include'`. Credentialed cross-origin fetches from a service worker require the target host in `host_permissions`. Bundled providers: Guerrilla Mail (`api.guerrillamail.com`) and Burner.kiwi instances (`alphac.qzz.io`, `raceco.dpdns.org`, `burner.kiwi`).
9. **User-added provider instances** - `src/features/settings/settings-actions.ts:379-431` and `src/utils/instance-manager.ts:94-108` let the user add custom instance URLs. After SSRF-safe validation (`src/utils/validation.ts:67-100` blocks private IPs), any public https URL may be added and then fetched with credentials. The set of target domains is therefore unbounded by design.
10. **Favicon fetcher** - `src/entrypoints/background/runtime/message-handler.ts:464-502` and `src/utils/favicon.ts:88-117` fetch favicons for arbitrary email-sender domains (e.g. `https://${sender}/favicon.ico` or via Google's favicon proxy).

### What the extension does NOT do

To be explicit about scope:

- **No browsing-history collection.** The content script only inspects `<form>` elements, `<input>` values typed by the user, and DOM structure. It does not log, store, or transmit page content.
- **Scoped cookie management.** The `cookies` permission is used solely to manage authorization cookies (such as `PHPSESSID`) for email providers like Guerrilla Mail, scoped strictly to the provider API origin.
- **No `chrome.webRequest` interception.** The extension does not observe, block, or modify network traffic.
- **No keystroke logging, no page text exfiltration, no remote-script injection.** The content script's CSP is locked down in `wxt.config.ts:79-81`.

### Minimum-viable alternative considered

`<all_urls>` could in principle be replaced with an enumerated list of bundled provider hosts + a smaller set of "common signup sites," but:

- The product's value proposition is "autofill on *any* site the user signs up on," which has no upper bound.
- User-added custom provider instances make the fetch target set genuinely unbounded.
- The context menu and keyboard shortcut must work on whatever tab the user invokes them on.

Narrowing the permission would require either removing the universal-autofill feature, removing custom provider instances, or introducing dynamic `permissions.request` flows (not currently implemented) - all of which are larger product tradeoffs.

### References

- Chrome: [Declare permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) and [host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#host-permissions)
- Firefox: [host_permissions in Manifest V3](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions)
- Source: `wxt.config.ts:82-91` (manifest declaration), `src/entrypoints/content/index.ts:12-14` (content script)

## Install from stores

| Browser | Status | Link |
|---------|--------|------|
| **Chrome** | Published | [Chrome Web Store](https://chromewebstore.google.com/detail/1click-temp-mail-with-aut/oilafkncmnboohnekbnokkifjbnjeecn) |
| **Firefox** | Coming soon | [Firefox Add-ons (ghost listing)](https://addons.mozilla.org/firefox/addon/1click-temp-mail/) |
| **Safari** | Coming soon | [App Store (ghost listing)](https://apps.apple.com/app/1click-temp-mail) |
| **Edge** | Coming soon | Ghost listing placeholder |

## Installation (developer / sideload)

### Chrome
1. Download the latest release from the [Releases](https://github.com/UnarchiveTech/1Click-TempMailandAutofillForm/releases) page
2. Extract the downloaded zip file
3. Open Chrome and navigate to `chrome://extensions/`
4. Enable "Developer mode" in the top right
5. Click "Load unpacked" and select the extracted folder

### Firefox
1. Download the latest Firefox release from the [Releases](https://github.com/UnarchiveTech/1Click-TempMailandAutofillForm/releases) page
2. Extract the downloaded zip file
3. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
4. Click "Load Temporary Add-on" and select the `manifest.json` file in the extracted folder

### Safari (export-ready)

The project builds a Safari-compatible MV3 package via WXT. Store submission is not live yet (ghost link above).

```bash
# Produce Safari build artifacts
bun run build:safari
# Optional zip
bun run zip:safari
```

1. Run `bun run build:safari` (or `zip:safari`).
2. Open the output under `.output/safari-mv3` (exact folder name may vary by WXT version).
3. On macOS, convert / load with **Xcode → File → New → Project → Safari Extension App**, or use Apple’s `safari-web-extension-converter` against the built folder.
4. Enable the extension in Safari → Settings → Extensions.

Firefox and Safari store links above are **ghost placeholders** until listings go live; Chrome uses the real Web Store URL.

## Development

### Prerequisites
- Node.js 18+ or Bun
- Git

### Setup

```bash
# Clone the repository
git clone https://github.com/UnarchiveTech/1Click-TempMailandAutofillForm.git
cd 1Click-TempMailandAutofillForm

# Install dependencies
bun install

# Run development server (Chrome)
bun run dev

# Run development server (Firefox)
bun run dev:firefox
```

### Build

```bash
# Build for Chrome
bun run build

# Build for Firefox
bun run build:firefox

# Build for Safari (MV3 export; convert with Xcode / safari-web-extension-converter)
bun run build:safari

# Create zip package
bun run zip
bun run zip:firefox
bun run zip:safari
```

### Linting and Type Checking

```bash
# Run Biome lint check
bun run lint

# Fix linting issues
bun run lint:fix

# Format code
bun run format

# Run TypeScript type check
bun run typecheck
```

## Project Structure

```
src/
├── components/          # Reusable UI components
├── entrypoints/         # Extension entry points (app, popup, sidepanel, background)
├── features/            # Feature-specific logic (inbox, identities, etc.)
├── utils/               # Utility functions and types
└── views/               # Page views (Inbox, Identities, Settings, etc.)
```

## Contributing

Contributions are welcome! Please read our [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Third-Party Attributions

### Material Color Utilities

This project includes a lightweight, vendored port of Google's [`@material/material-color-utilities`](https://github.com/material-components/material-color-utilities) (Apache 2.0 License). The original library is 102 KB; the vendored version in `src/utils/material-color-utils.ts` is ~6 KB and implements the Material 3 `SchemeTonalSpot` color algorithm used for dynamic theme generation (`src/utils/theme-generator.ts`).

- **Original library**: https://github.com/material-components/material-color-utilities
- **License**: Apache License, Version 2.0
- **Source file**: `src/utils/material-color-utils.ts`
- **Usage**: `import { Hct, SchemeTonalSpot, MaterialDynamicColors } from '@/utils/material-color-utils.js'` in `src/utils/theme-generator.ts`
- **Build-time tool**: `scripts/generate-theme.ts` still imports the full `@material/material-color-utilities` package (listed as a devDependency) for CLI theme generation, which is not shipped to the browser.

## Support

For issues, questions, or suggestions, please open an issue on GitHub.
