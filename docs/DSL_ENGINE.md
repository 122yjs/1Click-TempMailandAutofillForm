# Email Provider DSL Specification & Engine Guide

This document specifies the architecture, configuration format, and execution semantics of the Extension's Email Provider Domain-Specific Language (DSL). 

The extension uses a configuration-driven DSL (`src/config/providers.jsonc`) to define integration details for temporary email providers. This enables adding new disposable email providers without writing or modifying TypeScript backend code.

---

## 1. Directory Structure

```
src/
├── config/
│   ├── providers.jsonc         # Active provider configurations
│   ├── providers.schema.jsonc  # JSON Schema rules for validation and autocomplete
│   └── providers-standard-example.json # Template reference for new providers
└── utils/
    ├── email-service.ts        # Operations coordinator and API client
    └── dsl/
        └── email-fetcher.ts    # Core execution engine (Request construction & response parsing)
```

---

## 2. Config Contract & Lifecycle

The lifecycle of provider configurations:

1. **Compilation Phase:** The JSONC file is stripped of comments and trailing commas during compilation (`wxt.config.ts` Vite transform).
2. **Bootstrapping Phase:** The engine runs `validateAllProviderConfigs` on module load (defined in `src/utils/provider-validation.ts`) to ensure structural compliance with the schema.
3. **Execution Phase:** When operations are requested, the `EmailService` parses parameters, formats queries, triggers HTTP calls, validates status signals, and transforms JSON structures into internal models.

---

## 3. Template Resolution Engine

The DSL engine (`src/utils/dsl/email-fetcher.ts`) supports variable interpolation within parameter values or paths:

* `{auth.token}` - Replaced with the authentication/session token (e.g. `sid_token` / JWT key).
* `{inboxId}` - Replaced with the target mailbox unique identifier.
* `{emailUser}` - Replaced with the mailbox username segment (local-part before the `@`).
* `{email_id}` - Replaced with the single email identifier.
* `{email_addr}` - Replaced with the full email address (e.g. `name@guerrillamailblock.com`). Used in `forgetMe` operation.
* `{seq}` - Replaced with the local incremental counter parameter to avoid full-history checks.
* `{timestamp}` - Current Unix epoch millisecond value.
* `{random}` - Random 8-character cryptographic nonce to bypass CDN caches.
* `{instanceUrl}` - Dynamically replaces the base endpoint url (used by multi-instance providers).

> **Future auth variables** (not yet implemented - documented for forward compatibility):
> * `{auth.jwt}` - Full JWT token for providers using Bearer authentication.
> * `{auth.cookie}` - Named cookie value for cookie-based auth.
> * `{auth.apiKey}` - API key for query parameter-based authentication.
> * `{auth.refreshToken}` - Refresh token for OAuth-style flows.

---

## 4. Authentication Strategies

The `auth` block in each provider configuration defines how the engine authenticates API requests. Three strategies are currently supported:

| Mode | Config `type` | Mechanism |
|---|---|---|
| **Cookie** | `"cookie"` | Engine sets a named browser cookie before each request using `browser.cookies.set()`. Session state is maintained server-side. |
| **Header** | `"header"` | Engine injects a named HTTP header containing the token on every request. |
| **Query Parameter** | `"query_parameter"` | Engine appends the token as a URL query string parameter. |

### Current Provider Examples

```json
// Guerrilla Mail - Cookie auth
"auth": {
  "type": "cookie",
  "cookieName": "PHPSESSID",
  "description": "Session cookie mirrored in sid_token response field"
}

// Burner-compatible - Header auth
"auth": {
  "type": "header",
  "headerName": "X-Burner-Key",
  "description": "JWT token returned at inbox creation, sent on all subsequent requests"
}
```

> **Future:** `"type": "none"` for public/anonymous providers and `"type": "bearer"` for OAuth-style `Authorization: Bearer <token>` header injection.

---

## 5. Cookie Management

Some providers rely on HTTP cookies for session state that may change on every response. The engine handles this transparently for cookie-authenticated providers.

### Currently Implemented

When `auth.type` is `"cookie"`, the engine:
1. Calls `browser.cookies.set()` to inject the stored token value as the named cookie before each request.
2. Uses `credentials: "include"` in fetch options so the browser automatically sends all cookies to the API domain.

### Guerrilla Mail Cookie Contract

Guerrilla Mail uses two cookies:

| Cookie | Role | Handling |
|---|---|---|
| `PHPSESSID` | Session identifier - required on every request | Stored as `account.token` (mirrored from `sid_token` in responses). Re-injected before each call. |
| `SUBSCR` | Subscriber identifier - optional, returned only for paid accounts | Returned by the server as a `Set-Cookie` header. The engine currently relies on the browser's cookie jar to handle this automatically. |

> **Future DSL capability** - explicit cookie capture configuration (not yet implemented):
> ```json
> "cookies": {
>   "capture": ["PHPSESSID", "SUBSCR"],
>   "send": true
> }
> ```
> This would instruct the engine to actively read response `Set-Cookie` headers, persist each listed cookie name, and re-send them on future requests regardless of browser cookie jar state.

---

## 6. Operation Configurations

An operation configuration defines the endpoint method, required inputs, output extraction paths, and error states.

### Operations Contract Example

```json
"createInbox": {
  "method": "GET",
  "function": "get_email_address",
  "requiredParams": {
    "lang": "en"
  },
  "optionalParams": {
    "_t": "{timestamp}"
  },
  "response": {
    "successPath": "!error", // success if 'error' field is absent
    "dataPath": null,
    "fields": {
      "address": "email_addr",
      "token": "sid_token",
      "timestamp": "email_timestamp"
    }
  },
  "errorHandling": {
    "errorPath": "error",
    "errorMessagePath": "error"
  }
}
```

### Success and Error Detection
* **HTTP Agnostic Systems:** Since some providers (like Guerrilla Mail) return an HTTP 200 Status Code on failure, the engine uses the `errorHandling` object to walk the response JSON. If a truthy value exists at `errorPath`, an exception is thrown with the text located at `errorMessagePath`.
* **Success Path Negation:** The `successPath` property supports a leading `!` character. For example, `"!error"` dictates that the response represents a success ONLY if the `error` property is absent or falsy.

---

## 7. HTTP Status Handling

Different providers use HTTP status codes very differently. The engine currently handles:

| Provider | Behavior | Notes |
|---|---|---|
| **Guerrilla Mail** | Returns HTTP 200 for everything - successes, errors, missing params, and disabled endpoints | JSON field inspection required for all error detection |
| **Burner-compatible** | Uses standard HTTP status codes: 401 (missing/bad auth), 403 (wrong inbox), 404 (unknown path), 405 (wrong method) | HTTP status can be relied upon for error detection |

### Current Implementation

The engine throws an `ApiError` when `response.ok` is false (`status >= 400`). This correctly handles Burner-style providers. For Guerrilla Mail, the `errorHandling.errorPath` field provides a secondary check for application-level errors inside a 200 response.

> **Future DSL capability** - explicit status handling config (not yet implemented):
> ```json
> "statusHandling": {
>   "mode": "ignoreStatus",   // or "require2xx" | "allowedStatus"
>   "allowedStatus": [200, 201]
> }
> ```

---

## 8. Response Types

The DSL engine currently assumes all responses are valid JSON objects. However, providers return a variety of content types:

| Response Type | Example Providers | Description |
|---|---|---|
| `json` | Burner, Guerrilla Mail (success) | Standard `application/json` object or array |
| `boolean` | Guerrilla Mail (`forget_me`, invalid `fetch_email`) | Bare `true` or `false` literal - not wrapped in an object |
| `text` | Guerrilla Mail (`extend` - disabled endpoint) | Plain text string, not parseable as JSON |
| `empty` | Guerrilla Mail (missing required params) | HTTP 200 with zero-byte body |

### Current Handling

The engine calls `response.json()` unconditionally. Bare booleans parse correctly as JSON. Empty bodies and plain text will cause a JSON parse exception - the engine catches these via `ApiError`.

> **Future DSL capability** - explicit response type configuration (not yet implemented):
> ```json
> "responseType": "json" // or "boolean" | "text" | "empty"
> ```

---

## 9. Body Field Transforms

The DSL engine maps response fields using dot-notation paths but does not yet support in-config field transformation. Several transformations are currently applied implicitly in code:

| Transform | Where Applied | Description |
|---|---|---|
| HTML entity decode | `mail_subject`, `mail_excerpt` in Guerrilla Mail | Fields arrive HTML-entity encoded - must be decoded before display |
| Date string parsing | `mail_date` in Guerrilla Mail | Parsed from `"YYYY-MM-DD HH:MM:SS"` or `"HH:MM:SS"` format to Unix timestamp |
| Integer coercion | `mail_id`, `mail_timestamp`, `mail_read`, `att`, `count`, `mail_size` | Guerrilla Mail returns all these as strings - arithmetic requires explicit `parseInt()` |
| URL decode | `res.php?q=` image URLs | URL-encoded original image source decoded via `decodeURIComponent` |

> **Future DSL capability** - per-field transform declarations (not yet implemented):
> ```json
> "fields": {
>   "subject": { "path": "mail_subject", "transform": ["htmlEntityDecode", "trim"] },
>   "received_at": { "path": "mail_timestamp", "transform": ["parseInt"] }
> }
> ```

---

## 10. Fetching Types & Execution Flow Architecture

The DSL engine supports two distinct execution patterns for email retrieval based on the `emailFetching.type` configuration:

```
[Fetch Triggered]
       │
       ├─► (single_step) ──► HTTP Get/Post request ──► Map JSON Array to Email Model ─┐
       │                                                                               │
       └─► (multi_step)  ──► 1. HTTP Get (List)                                        │
                                  │                                                    │
                             2. Filter IDs against Local DB to isolate new messages    │
                                  │                                                    │
                             3. Promise.all (HTTP Details query per new message ID)    │
                                  │                                                    │
                             4. Parse dates, fallback timestamps ──────────────────────┼─► [Sanitization Stage]
                                                                                       │         │
                                                                                       │         ├─► DOMPurify sanitization
                                                                                       │         └─► Guerrilla Mail res.php proxy URL decoding
                                                                                       │                 │
                                                                                       │           [Storage Write]
                                                                                       │                 │
                                                                                       └─────────────────┴─► Update `lastSequence` in DB
```

### A. Single-Step Fetching (`single_step`)
An API request that directly yields a complete array containing target message payloads (headers + body content).
1. **API Call:** The engine issues a single HTTP request using the configured `operation` name.
2. **Parsing:** The engine maps properties from the returned JSON using the `emailFetching.responseMapping` configuration. If the data is nested, it extracts it first from `emailFetching.dataPath`.
3. **Common Processing:** The mapped emails are forwarded to the **Sanitization Stage** (see Section 11) and OTP extraction before being returned.

### B. Multi-Step Fetching (`multi_step`)
Used for systems that separate summaries from email content (such as Guerrilla Mail).
1. **Initial List Retrieval:** The engine calls `listOperation` (e.g., `checkEmail`), passing the current increment tracker `{seq}`.
2. **Incremental Extraction:** The engine extracts message summaries from `listPath` (e.g., `list`). It checks these summaries against local storage using `getStoredEmailsMap()` to isolate only newly arrived message IDs.
3. **Concurrently Query Details:** For every new message ID, the engine fires concurrent detail requests (`Promise.all`) using the `detailOperation` config.
4. **Field Mapping & Time Reconstruction:** Detail responses are mapped using `detailResponseMapping`. Timestamps are resolved sequentially:
   * Try `date_field` parsed into a Date object.
   * Fallback to `timestamp_field` or `fallback_timestamp_field`.
   * Ultimate fallback: use the listing response's base timestamp `ts`.
5. **Sanitization:** Newly resolved bodies are passed directly to the **Sanitization Stage**.

---

## 11. HTML Sanitization Stage

All email HTML content parsed by the DSL engine is passed through a global sanitization pipeline before database insertion or rendering:

1. **XSS Protection:** The engine feeds `body_html` (falling back to a wrapped `<pre>` block of `body_plain`) into `DOMPurify.sanitize()` using strict tags and attributes lists:
   * Allowed Tags: `a`, `b`, `br`, `div`, `em`, `h1` to `h6`, `hr`, `img`, `li`, `ol`, `p`, `span`, `strong`, `table`, `tbody`, `td`, `th`, `thead`, `tr`, `ul`, `pre`, `code`, `blockquote`.
   * Allowed Attributes: `href`, `src`, `alt`, `title`, `width`, `height`, `style`, `class`, `target`, `rel`.
2. **Guerrilla Mail Image Unblocking:** Since Guerrilla Mail proxies and rewrites all image sources to a relative `/res.php?r=1&n=img&q=<encoded_original_url>` path, the DSL engine intercepts these sources during sanitization. It matches:
   * URL-encoded sequences nested within `q=`.
   * Decodes them back into fully qualified URLs using `decodeURIComponent` (e.g., matching both standard `&` and HTML-encoded `&amp;` delimiters).
   * Replaces the proxied relative `/res.php` path with the decoded original source URL so images load correctly inside the extension.

---

## 12. Polling & Sequence Tracking

To avoid fetching the entire mailbox history on every background poll, the DSL supports incremental sequence tracking:

```json
"sequenceTracking": {
  "enabled": true,
  "sequenceField": "lastSequence",
  "listSequenceField": "mail_id",
  "sequenceOperation": "max"
}
```

### Persistence Lifecycle
1. **Initial State:** `lastSequence` is `0` on inbox creation.
2. **Request Interpolation:** `lastSequence` is injected as `{seq}` on each poll.
3. **Incremental Update:** After each check:
   * `"max"` → highest `mail_id` across the returned array.
   * `"last"` → last item's ID.
   * Persisted as `lastSequence` on the local `Account` record.
4. **Next Request:** Only messages newer than the stored sequence are returned.

> **Future pagination support** (not yet implemented): Different providers use different pagination paradigms. Future DSL should support:
> ```json
> "pagination": {
>   "type": "offset",      // or "cursor" | "seq" | "page" | "next_token"
>   "paramName": "offset",
>   "pageSize": 20
> }
> ```

---

## 13. Retry Strategy

The current `retry` configuration performs exponential backoff:

```json
"retry": {
  "maxAttempts": 3,
  "delayMs": 1000,
  "backoffMultiplier": 2
}
```

### Engine Behavior
- HTTP 4xx errors (except 429) are **not retried** - treated as permanent client errors.
- HTTP 5xx errors are retried up to `min(3, maxAttempts)` times.
- Each retry delay = `delayMs × backoffMultiplier^(attempt-1)` ± 15% random jitter to prevent thundering herd.

> **Future capability** - explicit `retryOn` conditions (not yet implemented):
> ```json
> "retry": {
>   "maxAttempts": 3,
>   "delayMs": 1000,
>   "backoffMultiplier": 2,
>   "retryOn": [429, 500, 502, 503, 504]
> }
> ```

---

## 14. Rate Limiting

Currently, no explicit rate limiting or `429 Retry-After` handling exists in the engine. The retry strategy avoids some thundering herd issues via jitter, but there is no awareness of provider-specific rate limits.

> **Future DSL capability** (not yet implemented):
> ```json
> "rateLimit": {
>   "respectRetryAfter": true,
>   "defaultBackoffMs": 5000,
>   "maxBackoffMs": 60000
> }
> ```
> When `respectRetryAfter` is true, the engine would read the `Retry-After` header on a 429 response and delay the next attempt accordingly.

---

## 15. Attachment Model

Attachments are partially supported through metadata exposure in `fetch_email` responses from Guerrilla Mail. The DSL does not currently define a field mapping for attachments.

### Current State

| Provider | Receives? | Metadata in API? | Download URL? |
|---|---|---|---|
| Guerrilla Mail | ✅ Yes | ✅ `att_info[]` in `fetch_email` | ❌ No |
| Burner-compatible | ❌ Silently dropped | ❌ No | ❌ No |

### Future Attachment Schema

```json
"attachmentMapping": {
  "enabled": true,
  "path": "att_info",
  "fields": {
    "filename": "f",
    "mimeType": "t",
    "partNumber": "p",
    "downloadUrl": null
  }
}
```

---

## 16. Provider Capabilities

Instead of hardcoding assumptions in the engine, each provider configuration should advertise its capabilities explicitly. The current `ui` block partially captures this.

### Current `ui` Flags

```json
"ui": {
  "canUnarchive": true,           // or "ifNotExpired"
  "supportsCustomEmail": true,
  "multiInstance": false,
  "supportsCustomInstance": false
}
```

### Future Capabilities Block

Standardizing capabilities into a dedicated block would enable the UI to adapt dynamically:

```json
"capabilities": {
  "attachments": true,
  "htmlBody": true,
  "deleteMessages": true,
  "pagination": false,
  "renewAddress": true,
  "customUsername": true,
  "multiDomain": true,
  "subscription": true
}
```

---

## 17. Operation Lifecycle

Every provider implementation should map operations to these standard lifecycle stages. Not all stages are required for every provider.

```
createInbox         - Provision a new inbox and obtain address + auth token
    │
    ▼
[selectMailbox]     - (Optional) Switch active mailbox to a specific username (Guerrilla only)
    │
    ▼
poll (checkEmail)   - Background periodic check for new messages using {seq}
    │
    ▼
list (getEmailList) - Retrieve paginated message summaries
    │
    ▼
detail (fetchEmail) - Fetch full HTML/plain body of a specific message
    │
    ▼
[deleteEmail]       - (Optional) Remove one or more messages from the server
    │
    ▼
[renew]             - (Optional) Extend the inbox expiry window
    │
    ▼
[forget]            - (Optional) Disassociate the address from the current session without deletion
    │
    ▼
expire              - Client-side expiry detection via email_timestamp; polling stops
```

### Lifecycle Operation Mapping

| Lifecycle Stage | Guerrilla Mail | Burner-compatible |
|---|---|---|
| `createInbox` | `get_email_address` | `GET /inbox` |
| `selectMailbox` | `set_email_user` | - |
| `poll` | `check_email` | `GET /inbox/{id}/messages` |
| `list` | `get_email_list` ⚠️ _Configured but not wired - dead code_ | `GET /inbox/{id}/messages` |
| `detail` | `fetch_email` | _(included in list)_ |
| `delete` | `del_email` | - _(not supported)_ |
| `renew` | `set_email_user` (same username) | - _(not supported)_ |
| `forget` | `forget_me` | - _(not supported)_ |
| `expire` | Client-side: `email_timestamp + 3600` | Client-side: `ttl` timestamp |
