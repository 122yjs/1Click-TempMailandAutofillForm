# Email Provider APIs

This document summarizes the two supported disposable email provider families:

- Guerrilla Mail JSON API
- Burner.kiwi-compatible API

The original provider-specific documents are preserved:

- `docs/www-guerrillamail-com-GuerrillaMailAPI-html.md`
- `docs/BURNER_API.md`

---

## Guerrilla Mail

Base URL:

```text
https://api.guerrillamail.com/ajax.php
```

Guerrilla Mail uses a function-style API. Every request includes an `f` query or form parameter naming the operation.

Common parameters:

```text
f=<function>
ip=<end-user IP address>
agent=<end-user user-agent string>
lang=en
```

> **Live finding:** `ip`, `agent`, and `lang` are documented as required but are **all optional** - the API works without them. Only `f` and function-specific parameters matter.

> **Rate limiting:** The API may be rate limited. Guerrilla Mail does not publish their rate limits. Use the API carefully and do not poll excessively.

### Cookie Model

The client must track and send two cookies on every request:

- **`PHPSESSID`** - Session ID. Set by the server in every response header. The client must always watch for this cookie, store the latest value, and send it in every subsequent request. **This value can change on every call.** When it changes, it indicates a new session was started and the client should refresh its state with new data.
- **`SUBSCR`** - Subscriber cookie. Set by the server if the email address has an active subscription. The client must save it when it changes but does not need to send it as a cookie - instead it is passed as a parameter named `SUBSCR` in the `get_email_address` call.

### Session And Mailbox Model

- `sid_token` in response bodies mirrors the current `PHPSESSID` value exactly.
- Messages are tied to the email address/username mailbox, not the session. Switching sessions to username `b` shows `b`'s messages; switching back to `a` shows `a`'s messages again (while not yet expired).
- Messages expire after approximately **1 hour** regardless of session lifetime.
- A session expires after approximately **18 minutes of inactivity**. On the next `get_email_address` call a new address is generated; the old address can be reclaimed with `set_email_user`.
- **Session cookie is optional for `set_email_user`** - a new session is auto-created and returned if `PHPSESSID` is not sent.

### Address Expiry Formula

The official formula for seconds remaining before the address expires:

```
seconds_remaining = 3600 - (current_unix_timestamp - email_timestamp)
```

`email_timestamp` is the Unix timestamp returned in `get_email_address`, `set_email_user`, and `check_email` (`ts` field).

### Recommended Client Flow

1. Call `get_email_address` - get session, email address, and `email_timestamp`.
2. Periodically call `check_email` in the background to poll for new messages.
3. When a message arrives and the user opens it, call `fetch_email` to get the full body.
4. To change address, call `set_email_user`. Old address and its emails remain available until they expire (1 hour).
5. To abandon the current address (without deleting it), call `forget_me`. Follow up with `get_email_address` or `set_email_user` to set a new address.
6. `extend` is documented to extend expiry by 1 hour (max 2 hours total) but is **permanently disabled live**.
7. Track expiry client-side using `email_timestamp`. Stop polling `check_email` once the address has expired.

### Error Handling

> **Critical:** Guerrilla Mail **always returns HTTP 200**, even on errors. HTTP status codes cannot be used to detect failures.

Missing required parameters result in **200 OK with an empty body** - no JSON, no error object. Callers must validate that the response body is non-empty and valid JSON before processing.

| Scenario | HTTP Status | Content-Type | Body |
|---|---|---|---|
| Success | 200 | `application/json` | JSON object |
| Missing required parameter | 200 | `text/html` | Empty (zero bytes) |
| Invalid email ID (`fetch_email`) | 200 | `application/json` | `false` (bare boolean) |
| Missing `email_addr` (`forget_me`) | 200 | `application/json` | `false` (bare boolean) |
| `extend` (disabled) | 200 | `text/html` | Plain text string |

### Endpoints

#### `get_email_address` - Create Or Read Current Address

```bash
curl.exe -i "https://api.guerrillamail.com/ajax.php?f=get_email_address&ip=127.0.0.1&agent=Client&lang=en"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `lang` | No | Language code. Supported: `en`, `fr`, `nl`, `ru`, `tr`, `uk`, `ar`, `ko`, `jp`, `zh`, `zh-hant` |
| `SUBSCR` | No | Subscriber cookie data from a previous session (passed as a query/form param, not a cookie) |

**Behavior:**
- If `PHPSESSID` cookie is present and session exists → returns the existing session's email address.
- If no session → checks `SUBSCR` to restore a subscribed address; otherwise creates a new random address.
- Always generates a new welcome email for the session on creation.
- May set or update both `PHPSESSID` and `SUBSCR` cookies in the response headers.

**Response:**

```json
{
  "email_addr": "name@guerrillamailblock.com",
  "email_timestamp": 1783098241,
  "alias": "session-alias-string",
  "sid_token": "PHPSESSID_VALUE"
}
```

**Field reference:**

| Field | Type | Description |
|---|---|---|
| `email_addr` | string | The assigned email address |
| `email_timestamp` | number | Unix timestamp of address creation - used to track expiry |
| `sid_token` | string | Mirrors current `PHPSESSID` value |
| `alias` | string | Internal session alias (undocumented, do not rely on) |
| `s_active` | string | `"Y"` or `"N"` - subscription active flag (only if SUBSCR present) |
| `s_date` | string | Full date of subscription (only if SUBSCR present) |
| `s_time` | number | Unix timestamp of subscription start (only if SUBSCR present) |
| `s_time_expires` | number | Unix timestamp of subscription expiry (only if SUBSCR present) |

Also sets `Set-Cookie: PHPSESSID=<session>` in response headers.

---

#### `set_email_user` - Set Username / Renew Address

```bash
curl.exe -i -X POST \
  -H "Cookie: PHPSESSID=<session>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "f=set_email_user&email_user=myname&lang=en&ip=127.0.0.1&agent=Client" \
  "https://api.guerrillamail.com/ajax.php"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `email_user` | **Yes** | The username part only (e.g. `"test"` for `test@guerrillamailblock.com`) |
| `lang` | No | Language code |

**Behavior:**
- If the username is a subscriber → returns subscription details.
- If the username is not a subscriber → the address is given 60 minutes again.
- If the username is not in the database → a new address is created and a welcome email is generated.
- When a user changes from address `a` to address `b`, address `a` and its emails are **not deleted** - switching back to `a` will still show those messages until they expire (1 hour).
- `email_user` is required - omitting it silently returns an empty 200 body.
- `PHPSESSID` cookie is not strictly required - a new session is auto-created if absent.

**Response:**

```json
{
  "alias_error": "",
  "alias": "session-alias",
  "email_addr": "myname@guerrillamailblock.com",
  "email_timestamp": 1783431487,
  "site_id": 1,
  "sid_token": "PHPSESSID_VALUE",
  "site": "emjd",
  "auth": { "success": true, "error_codes": [] }
}
```

Same `s_active`, `s_date`, `s_time`, `s_time_expires` fields as `get_email_address` when SUBSCR is present.

> **Renewal:** Since `extend` is disabled, use `set_email_user` with the **same current username** to renew. Use the returned `email_timestamp` to recompute the 60-minute expiry window.

---

#### `check_email` - Poll For New Messages

```bash
curl.exe -i -H "Cookie: PHPSESSID=<session>" \
  "https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&ip=127.0.0.1&agent=Client"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `seq` | **Yes** | The mail ID of the oldest message already seen (pass `0` on first call). Returns messages newer than this ID. |

**Behavior:**
- Returns up to **20** of the newest messages.
- Do not call while the address is expired - polling should pause after expiry.
- `seq=0` returns the most recent messages unconditionally.

**Response:**

```json
{
  "list": [
    {
      "mail_id": "266089861",
      "mail_from": "sender@example.com",
      "mail_subject": "Subject (HTML-entity encoded)",
      "mail_excerpt": "Preview text... (HTML-entity encoded)",
      "mail_timestamp": "1783430237",
      "mail_read": "0",
      "mail_date": "13:17:17",
      "att": "0",
      "mail_size": "45389"
    }
  ],
  "count": "10",
  "email": "myname@guerrillamailblock.com",
  "alias": "session-alias",
  "ts": 1783431487,
  "sid_token": "PHPSESSID_VALUE",
  "stats": {
    "sequence_mail": "87,430,146",
    "created_addresses": 38163242,
    "received_emails": "21,127,269,518",
    "total": "21,039,839,372",
    "total_per_hour": "62349"
  },
  "auth": { "success": true, "error_codes": [] }
}
```

**Field reference:**

| Field | Type | Description |
|---|---|---|
| `list` | array | Message summaries (max 20). `mail_subject` and `mail_excerpt` are HTML-entity encoded. |
| `count` | **string** | Total number of new emails in the database - **can greatly exceed 20**. To retrieve messages beyond the first 20, use `get_email_list` with an `offset`, or see `get_older_list` below. |
| `email` | string | The active mailbox address - watch this to detect address changes |
| `ts` | number | Unix timestamp of the email address creation - use to sync expiry |
| `sid_token` | string | Current session token |
| `mail_id` | **string** | Message ID (string, not number) |
| `mail_timestamp` | **string** | Unix timestamp as string |
| `mail_read` | **string** | `"0"` unread, `"1"` read |
| `att` | **string** | `"0"` = no attachment, `"1"` = has attachment(s) |
| `s_active/s_date/s_time/s_time_expires` | - | Subscription fields (only if SUBSCR active) |
| `stats` | object | Global server stats - undocumented, do not rely on |

> **Attachment indicator:** `att: "1"` in a list item means the message has attachments. Use this to show an attachment badge without calling `fetch_email`.

---

#### `get_email_list` - Get Paginated Message List

```bash
curl.exe -i -H "Cookie: PHPSESSID=<session>" \
  "https://api.guerrillamail.com/ajax.php?f=get_email_list&offset=0&ip=127.0.0.1&agent=Client"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `offset` | **Yes** | Number of messages to skip. `0` = first page, `10` = second page, etc. |
| `seq` | No | The sequence number (ID) of the first email - optional filter |

**Behavior:**
- Gets a maximum of **20** messages from the specified offset.
- `offset=0` → first 10 emails; `offset=10` → next 10, and so on.
- Use for initial inbox population. `check_email` is better for polling.
- `mail_subject` and `mail_excerpt` are HTML-entity encoded.
- `offset` is required - omitting it returns a 200 empty body silently.

Returns the **identical shape** as `check_email`.

---

#### `get_older_list` - Fetch Older Messages *(undocumented)*

The official `check_email` documentation references this function:

> *"If you want to get the emails after the first 20, then make another call with the `get_older_list` function"*

This function is **mentioned but never formally documented** in the official API spec. Use `get_email_list` with `offset` as the documented alternative for pagination beyond 20 messages.

---

#### `fetch_email` - Get Full Message Content

```bash
curl.exe -i -H "Cookie: PHPSESSID=<session>" \
  "https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=266094691&ip=127.0.0.1&agent=Client"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `email_id` | **Yes** | The ID of the email to fetch. Only emails owned by the current session can be fetched. |

**Behavior:**
- Only emails belonging to the current session's mailbox can be fetched.
- Missing `email_id` → 200 empty body.
- Non-existent or inaccessible `email_id` → bare `false` (not a JSON error object).

**Response:**

```json
{
  "mail_id": "266094691",
  "mail_from": "sender@example.com",
  "mail_recipient": "are",
  "mail_subject": "Subject",
  "mail_excerpt": "&lt;div&gt;body text&lt;/div&gt;",
  "mail_body": "<div>body text</div>",
  "mail_timestamp": "1783432349",
  "mail_date": "2026-07-07 13:52:29",
  "mail_read": "1",
  "content_type": "text/html",
  "source_id": "0",
  "source_mail_id": "0",
  "reply_to": "sender@example.com",
  "mail_size": "357261",
  "att": "1",
  "att_info": [
    { "t": "application/pdf", "f": "big-o-cheatsheet.pdf", "p": "1.2" }
  ],
  "ver": "4.5",
  "ref_mid": "266094691:773f05fdffde69971e5802d56eb0537308140eaa",
  "sid_token": "PHPSESSID_VALUE",
  "auth": { "success": true, "error_codes": [] }
}
```

**Field reference:**

| Field | Type | Description |
|---|---|---|
| `mail_body` | string | Filtered HTML body - JS, applets, iframes removed |
| `mail_excerpt` | string | HTML-entity-encoded version of the body snippet |
| `mail_date` | string | Full datetime `"YYYY-MM-DD HH:MM:SS"` (vs. time-only `"HH:MM:SS"` in list endpoints) |
| `mail_recipient` | string | Username part of the recipient address only (e.g. `"are"`) |
| `content_type` | string | MIME type of the body (e.g. `"text/html"`, `"text"`) |
| `reply_to` | string | Reply-To address |
| `att` | string | `"0"` or `"1"` - attachment present flag |
| `att_info` | array | Attachment metadata (only present when `att: "1"`) |
| `att_info[].t` | string | MIME type of attachment (e.g. `"application/pdf"`) |
| `att_info[].f` | string | Filename of attachment (e.g. `"big-o-cheatsheet.pdf"`) |
| `att_info[].p` | string | MIME part number (e.g. `"1.2"`) |
| `ver` | string | API version string - undocumented |
| `ref_mid` | string | Internal message reference ID - undocumented |
| `source_id`, `source_mail_id` | string | Threading references - undocumented |

**Attachment notes (live-confirmed with PDF):**
- `att_info` is only present in `fetch_email` responses, not in list endpoints.
- The API provides attachment **metadata only** - there is no download URL. Attachment file content is not retrievable via the JSON API.

**Image proxy in `mail_body`:**

All images in the HTML body are rewritten to route through `http://www.guerrillamail.com/res.php`:

```
/res.php?r=1&n=img&q=<url-encoded-original-url>
```

Parameters:
- `r` - always `1`
- `n` - element type (e.g. `img`)
- `q` - URL-encoded original image URL

By default the client should display the blocked/proxied images. To implement a "Display Images" button, replace `res.php` links with the decoded `q` parameter value:

```javascript
// Replace res.php links with original URLs
html = html.replace(/"\/res\.php\?r=1&amp;n=[a-z]+&amp;q=([^"^&]+)"/g,
  (str, p1) => '"' + unescape(p1) + '"');
// Handle &quot; enclosed variants
html = html.replace(/&quot;\/res\.php\?r=1&amp;n=[a-z]+&amp;q=([^"]+)&quot;/g,
  (str, p1) => '&quot;' + unescape(p1) + '&quot;');
```

---

#### `del_email` - Delete Messages

```bash
curl.exe -i -X POST \
  -H "Cookie: PHPSESSID=<session>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "f=del_email&email_ids%5B%5D=266089861&ip=127.0.0.1&agent=Client" \
  "https://api.guerrillamail.com/ajax.php"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `email_ids[]` | **Yes** | Array of IDs to delete. Can also pass a single integer. URL-encoded form: `email_ids%5B%5D=425&email_ids%5B%5D=426` |

Multiple IDs in one call:

```bash
--data "f=del_email&email_ids%5B%5D=111&email_ids%5B%5D=222"
```

**Response:**

```json
{
  "deleted_ids": ["266089861"],
  "auth": { "success": true, "error_codes": [] }
}
```

**Notes:**
- `deleted_ids` is an array of **strings**, not numbers.
- GET method also works despite docs recommending POST - method is not enforced.
- Omitting `email_ids` returns a 200 empty body silently.

---

#### `forget_me` - Forget Current Address

```bash
curl.exe -i -X POST \
  -H "Cookie: PHPSESSID=<session>" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "f=forget_me&email_addr=name%40guerrillamailblock.com&ip=127.0.0.1&agent=Client" \
  "https://api.guerrillamail.com/ajax.php"
```

**Arguments:**

| Parameter | Required | Description |
|---|---|---|
| `email_addr` | **Yes** | The full email address to forget |

**Behavior:**
- Does **not** delete the address or its messages from the server - they remain accessible by re-setting the same username.
- The existing `PHPSESSID` session continues; only the address association is cleared.
- After calling, use `get_email_address` to get a new random address or `set_email_user` to set a specific one.
- `SUBSCR` cookie is deleted from response headers on success; `PHPSESSID` persists.

**Response** (bare boolean, not a JSON object):

```text
true
```

Returns bare `false` if `email_addr` is missing or the call fails.

---

#### `extend` - Extend Address Lifetime *(Disabled)*

```bash
curl.exe -i -H "Cookie: PHPSESSID=<session>" \
  "https://api.guerrillamail.com/ajax.php?f=extend&ip=127.0.0.1&agent=Client"
```

**Arguments:** None.

**Documented behavior (not live):** Extends the email address time by 1 hour. Maximum of 2 hours can be extended.

**Documented response (not live):**

```json
{
  "expired": false,
  "email_timestamp": 1783098241,
  "affected": 1
}
```

| Field | Description |
|---|---|
| `expired` | `true` or `false` - whether the email has already expired |
| `email_timestamp` | Unix timestamp of address creation - can be in the future after extension |
| `affected` | `1` if extended successfully, `0` if not |

**Live tested response** (plain text, **not JSON**):

```text
this call has been disabled - call get_email_address instead
```

> **Do not call `extend`.** It is permanently disabled. The response is plain text with `Content-Type: text/html` - any `JSON.parse()` attempt will throw. Use `set_email_user` with the current username as the renewal path instead.

---

## Burner.kiwi-Compatible API

Burner-compatible providers use an inbox ID plus an `X-Burner-Key` JWT token. Unlike Guerrilla Mail, the API is resource-oriented with proper HTTP status codes.

### Predefined Instances

The extension ships with these built-in Burner instances:

| ID | Internal Name | Display Name | API Base URL |
|---|---|---|---|
| `burnerkiwi` | `burner.kiwi` | Burner.Kiwi | `https://burner.kiwi/api/v2` |
| `alphac` | `alphac` | Alphac Mail | `https://alphac.qzz.io/api/v2` |
| `raceco` | `raceco` | Raceco Mail | `https://raceco.dpdns.org/api/v2` |

> **Note:** `alphac.qzz.io` is a reverse proxy for `raceco.dpdns.org` - all email addresses are issued under `@raceco.dpdns.org` and JWT tokens carry issuer `burner.kiwi`.

### Custom Instances

The extension supports adding custom Burner.kiwi-compatible servers. Each instance uses this configuration shape:

```typescript
interface BurnerInstance {
  id: string;           // Unique identifier (auto-generated for custom)
  name: string;         // Internal name (e.g. 'my-custom-instance')
  displayName: string;  // User-facing label (e.g. 'My Custom Mail')
  apiUrl: string;       // Base URL (e.g. 'https://api.example.com/api/v2')
  isCustom?: boolean;   // true for user-added instances
}
```

**Via Extension Settings:**
1. Open extension settings → Burner.kiwi instance section
2. Click "Add Custom Instance"
3. Enter a display name and API base URL
4. Save

**Via Storage API (programmatic):**

```javascript
await browser.storage.local.set({
  customBurnerInstances: [
    {
      id: 'custom_1234567890',
      name: 'my-instance',
      displayName: 'My Custom Mail',
      apiUrl: 'https://api.example.com/api/v2',
      isCustom: true
    }
  ]
});
```

### API Compatibility Requirements

To build a compatible custom Burner server, your API must:

1. **Implement all three endpoints** - `GET /inbox`, `GET /inbox/{id}`, `GET /inbox/{id}/messages` - with the exact response shapes documented here
2. **Accept `X-Burner-Key` header** for authentication on inbox and messages endpoints
3. **Return `received_at` and `ttl` as Unix epoch seconds** (not milliseconds)
4. **Include both `body_html` and `body_plain`** in message responses
5. **Treat inbox IDs as opaque strings** - do not assume UUID format
6. **Configure CORS** if the API is on a different domain from the extension

**Troubleshooting custom instances:**

| Symptom | Check |
|---|---|
| "Failed to fetch messages" | API URL correct and reachable; `X-Burner-Key` header accepted; response format matches spec |
| Messages not appearing | `received_at` in seconds not milliseconds; `success: true` in response; CORS configured |
| Auth failures | Token generated and stored correctly; token not expired; validation logic matches extension expectations |

### Authentication

All authenticated endpoints require:

```text
X-Burner-Key: <jwt-token>
```

Auth errors are signalled via proper HTTP status codes - unlike Guerrilla Mail.

### Error Format

```json
{
  "success": false,
  "errors": { "code": 500, "msg": "Unauthorized: given auth key invalid" },
  "result": null
}
```

> **Note:** `errors.code` is always `500` regardless of the actual HTTP status (401, 403, etc.). Use the HTTP status code for branching logic, not `errors.code`.

### Endpoint Matrix

| Operation | Method | Path | Auth | HTTP Status (success) |
|---|---|---|---|---|
| Create inbox | GET | `/inbox` | None | 200 |
| Inbox details | GET | `/inbox/{inboxId}` | `X-Burner-Key` | 200 |
| Fetch messages | GET | `/inbox/{inboxId}/messages` | `X-Burner-Key` | 200 |

All endpoints return **405 Method Not Allowed** for wrong HTTP methods. Unknown paths return **404** with plain text `"404 page not found"` (not JSON).

### Create Inbox

```bash
curl.exe -i "https://alphac.qzz.io/api/v2/inbox"
```

Returns (HTTP 200, not 201 as official spec states):

```json
{
  "success": true,
  "errors": null,
  "result": {
    "email": {
      "address": "i3l9zeiv@raceco.dpdns.org",
      "id": "0294c4ba-0018-4b28-b5d1-82d026167c89",
      "created_at": 1783431605,
      "ttl": 1783518005
    },
    "token": "eyJhbGciOiJIUzI1NiJ9..."
  }
}
```

**Notes:**
- `created_at` and `ttl` are Unix epoch **numbers** (not strings).
- `ttl` is an absolute expiry timestamp - expiry duration = `ttl - now`.
- **Save the token** - it is not retrievable again.
- HTTP status is **200** on alphac/raceco (the official burner.kiwi spec says 201).

**`meta` field (official spec only - not returned by live servers):**

The official burner.kiwi API spec documents a `meta` object in every response:

```json
"meta": {
  "version": "dev",
  "by": "Hayden Woodhead"
}
```

Live testing of alphac/raceco confirmed this field is **not present** in any response. Do not depend on it.

### Get Inbox Details

```bash
curl.exe -i \
  -H "X-Burner-Key: <token>" \
  "https://alphac.qzz.io/api/v2/inbox/<inboxId>"
```

Returns:

```json
{
  "success": true,
  "errors": null,
  "result": {
    "address": "i3l9zeiv@raceco.dpdns.org",
    "id": "0294c4ba-0018-4b28-b5d1-82d026167c89",
    "created_at": 1783431605,
    "ttl": 1783518005
  }
}
```

**Auth error cases (live-tested):**

| Scenario | HTTP Status | `errors.msg` |
|---|---|---|
| No `X-Burner-Key` header | 401 | `"Unauthorized: missing auth key"` |
| Invalid/wrong token | 401 | `"Unauthorized: given auth key invalid"` |
| Valid token, wrong inbox ID | 403 | `"Forbidden: you do not have permission to access this resource"` |

### Fetch Messages

```bash
curl.exe -i \
  -H "X-Burner-Key: <token>" \
  "https://alphac.qzz.io/api/v2/inbox/<inboxId>/messages"
```

When messages exist, `result` is an array:

```json
{
  "success": true,
  "errors": null,
  "result": [
    {
      "id": "ab031ac3-fd0b-45ec-a9f0-4127f2dbb37d",
      "received_at": 1783431723,
      "sender": "sender@example.com",
      "from_name": "Sender Display Name",
      "from_address": "sender@example.com",
      "subject": "Subject line",
      "body_html": "<html>...</html>",
      "body_plain": "Plain text body",
      "ttl": 1783518005
    }
  ]
}
```

**`from` field behavior - alphac vs. official burner.kiwi:**

| Server | Field(s) returned |
|---|---|
| `alphac.qzz.io` / `raceco.dpdns.org` | `from_name` (display name) + `from_address` (email) separately - live-confirmed |
| Official `burner.kiwi` | Single combined `from` field: `"Name <email@example.com>"` |

Code must handle both: use `from_name`/`from_address` directly when present; fall back to parsing the `from` field via `^(.+?)\s*<[^>]+>$` regex when only the combined field is present.

**Empty inbox (live-confirmed on alphac):**

```json
{ "success": true, "errors": null, "result": [] }
```

> **Important:** alphac returns `result: []` (empty array) - **not** `result: null`. Handle both `null` and `[]` as empty.

**XSS Warning:**

> ⚠️ `body_html` is **not sanitized** for XSS or any other vulnerability. It is the caller's responsibility to ensure the message body is displayed safely. The only processing applied is adding `target="_blank"` to `<a>` tags.

**Attachment support:**
- The messages endpoint returns **no attachment data** (no `att`, no `att_info`, no download URL).
- Live test confirmed: email with PDF attachment sent to `i3l9zeiv@raceco.dpdns.org` was **not delivered** - silently dropped.
- **Burner-compatible providers do not support email attachments.**

**Auth errors:** Same 401/403 pattern as Get Inbox Details above.

---

## Live Curl Findings

Test date: 2026-07-07.

### Burner-Compatible (alphac.qzz.io → raceco.dpdns.org)

- `alphac.qzz.io` is a reverse proxy for `raceco.dpdns.org`; all issued addresses are `@raceco.dpdns.org`
- Received plain-text and HTML emails successfully
- **Attachments not supported** - email with PDF sent to `i3l9zeiv@raceco.dpdns.org` was silently dropped and never delivered
- Empty inbox returns `result: []`, not `result: null`
- `from_name` and `from_address` returned as separate fields (not a combined `from` string)
- HTTP status codes are meaningful: 401 (missing/bad auth), 403 (wrong inbox), 404 (unknown path), 405 (wrong method)
- `errors.code` is always `500` regardless of actual error - use HTTP status code instead
- No `meta` field in any response (despite official spec showing it)
- HTTP 200 on inbox creation (official spec says 201)

### Guerrilla Mail

- All documented functions worked: `get_email_address`, `set_email_user`, `check_email`, `get_email_list`, `fetch_email`, `del_email`, `forget_me`
- `extend` permanently disabled - returns plain text, not JSON
- `set_email_user` is the renewal path; use the returned `email_timestamp` to recompute expiry
- Mailbox contents follow the active username/address regardless of session token
- **Attachments supported** - email with PDF (`big-o-cheatsheet.pdf`) delivered to `are@guerrillamailblock.com`; reflected in `att: "1"` and `att_info` in `fetch_email`
- Attachment metadata available but no download URL provided
- All missing-parameter failures return HTTP 200 with empty body - no error signalling

---

## Provider Implementation Notes

### Identity

- Guerrilla Mail: mailbox = email username; `PHPSESSID` selects which mailbox is active in the session.
- Burner-compatible: mailbox = inbox ID + JWT token.

### Renewal

- **Guerrilla Mail:** Call `set_email_user` with the same current username. Use returned `email_timestamp` for expiry: `expiry = email_timestamp + 3600`.
- **Burner-compatible:** No renewal endpoint. Use `ttl` from inbox creation as the absolute expiry timestamp.

### Deletion

- **Guerrilla Mail:** `del_email` endpoint - works with GET or POST, accepts single ID or array.
- **Burner-compatible:** No deletion endpoint - messages expire naturally by `ttl`.

### Empty Messages

- Guerrilla Mail returns `list: []`.
- Burner-compatible providers return `result: []` or `result: null` - treat both as empty.

### Attachments

| Provider | Receives attachments? | Metadata in API? | Download via API? |
|---|---|---|---|
| Guerrilla Mail | ✅ Yes | ✅ `att_info` in `fetch_email` | ❌ No URL |
| Burner-compatible (alphac/raceco) | ❌ No - silently dropped | ❌ No | ❌ No |

### Type Gotchas (Guerrilla Mail)

All of the following are returned as **strings**, not numbers - coerce before arithmetic:

- `mail_id`, `mail_timestamp`, `mail_read`, `att`, `count`, `mail_size`
