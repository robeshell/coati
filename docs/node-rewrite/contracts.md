# Contract inventory against Python Coati

Reference: `robeshell/coati` main `e41bb06529ac346bf289e6fb5aa132ca1ecc3851`, specifically `portal/backend/app/agent/api/` and gateway/auth/usage services. This matrix is a migration checklist, not a parity claim.

| Capability | Python reference | Node preview |
| --- | --- | --- |
| Chat Completions | `/api/agent/v1/chat/completions` | Same alias + `/v1/chat/completions`, JSON/SSE with all three upstream protocols |
| Messages | `/api/agent/v1/messages`, `/api/agent/anthropic/v1/messages` | Both legacy aliases + `/v1/messages`; JSON/SSE matrix active |
| Responses | `/api/agent/v1/responses` | Same alias + `/v1/responses`, JSON/SSE matrix, `store:false` |
| Stored Responses lookup | Explicit unsupported response | Not implemented; 404 |
| Models | Chat-callable catalog + profile fields | Basic route catalog, no profile metadata yet |
| Messages count_tokens | Dedicated endpoint/estimation | Pending |
| Protocol conversion | Chat/Messages/Responses bridges incl. tools | Six cross-protocol JSON/SSE directions wired; Python golden parity + basic nine-pair route tests passed; extended capability coverage pending |
| PAT management | `/api/agent/auth/pat`, rotate/update/usage/revoke | New `/api/admin/gateway/keys` creation/list/revoke and personal-key edit; legacy shape/rotation pending |
| Device grant | start/poll/confirm, `/api/agent/me` | Start/poll + new admin confirm endpoint; one-time redemption; profile-scoped `/api/agent/me` user/quota response implemented |
| Quotas | User/account controls, detailed usage | Atomic per-key and shared-user daily/concurrency/RPM reservations; account/provider budgets pending |
| Scheduling | Account pool, failure classification, cooldown, affinity | Priority route order + pre-stream 429/503 failover only |
| Server tools | Web search/fetch/tool conversion | Pending |
| Model profiles/personal channels/cache testing | Dedicated management APIs | Personal ownership isolation, owner-scoped model catalog and runtime implemented; native personal CRUD implemented; personal discovery/manual checks/create-time probes implemented; legacy personal fields/paths, UI, model profiles and cache-testing APIs pending |
| Logs | Detailed usage and operational views | Requests, attempts, timing, redacted errors, source-labelled usage |
| Data/token migration | Existing production data | No importer; fresh isolated database only |

## Compatibility rules

- Gateway bearer authentication never accepts a management cookie as model authorization.
- Both path families in the implemented matrix share one handler; this does **not** imply compatibility with every Python management/client endpoint.
- Preserve native protocol unknown fields and tool blocks. Cross-protocol paths use the explicit Python-compatible converters; unsupported conversions are rejected before reservation, while known legacy transformations are documented in protocol-contract.md.
- Reject Responses state references (`previous_response_id`, non-null `conversation`), `background:true` and `store:true`, including native Responses routes. Pass complete conversation history; outbound Responses requests force `store:false`. Null references and explicit false defaults remain usable.
- Non-null Chat `logit_bias` and Messages `container` are preserved on native routes and rejected with `unsupported_feature` before upstream I/O on cross-protocol routes. Native forwarding does not establish that every upstream model supports these fields.
- HTTP failures before a stream use a structured `error` object and request ID. Mid-stream errors use a protocol-appropriate SSE error, without a fabricated completion.
- Usage is approximate when upstream usage is absent. The daily quota is reservation-based admission control; estimates cannot be advertised as exact provider billing limits.

## Demonstrate device login without publishing a CLI

1. A demo application POSTs `{}` to `/api/agent/auth/device/start` and receives `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`.
2. The user opens the returned relative verification path on the same Coati console origin, signs in, enters the displayed `user_code` and confirms the described access.
3. The demo application POSTs `{ "device_code": "..." }` to `/api/agent/auth/device/poll` no faster than the returned interval. `authorization_pending` means keep waiting; expiry/denial means stop.
4. A successful poll returns the access token once. Concurrent/subsequent redemptions fail. The device token lasts 30 days, permits routed models and has a 100,000-token per-key daily budget; it is listed and can be revoked under access keys.

This protocol example replaces the need to publish the private CLI. A complete SDK/client compatibility suite is still required before migration.


## Legacy PAT CRUD and list adapter

Console-session/CSRF-protected `/api/agent/auth/pat` now supports GET/POST, with PUT/DELETE `/:id` and POST `/:id/rotate`. Existing native gateway key permissions apply; legacy role-code import mapping is still pending. Bearer-only requests cannot manage keys. Creation defaults to personal, chat/profile scopes and no expiry, supports 1–3650 days, deduplicates scopes, and persists a 255-character note. Legacy keys have no additional per-key daily/RPM/concurrency cap (zero); shared user/account policies still apply. Native creation retains its separate preview defaults.

Responses expose legacy PAT metadata; raw tokens appear only on creation/rotation. Lists are owner-scoped, searchable by name/prefix/note, filterable by status/type, paginated up to 100 rows and include settled seven-day request/token totals per historical key. Rotation copies note/scopes and records revocation time atomically. Successful authentication records last-use time best-effort. Migration 0014 adds nullable note/revoked_at/last_used_at; unknown pre-migration timestamps are not fabricated.

Still pending: `/:id/usage`, complete legacy error/normalization parity, legacy role/data import and authenticated visual acceptance. Native strict update validation currently also applies to the legacy PUT alias; this is not a claim of complete Python PAT compatibility.


Cache miss detail is now persisted as nullable `cache_miss_tokens` with `cache_miss_source` (`reported`/`derived`/null). It is a partition of input, never an extra billable amount. Derived values require a known protocol plus a reported cache dimension; inconsistent negative remainders remain unknown. Migration 0015 leaves old unknown values null. See validation.md for matrix and normalization evidence.


## PAT usage endpoint and request context — 2026-09-26

GET /api/agent/auth/pat/:id/usage now requires the console session and gateway_keys permission, verifies key ownership and keeps rotation predecessors independently queryable. It supports days (1–365, default 7), exact model/status filters and page/per_page (capped at 100); reservations are excluded unless explicitly requested. Caller-supplied owner/key selectors cannot change scope. Personal rows use a field allowlist, omit internal account/route/key identifiers and raw provider usage, and replace internal fallback-account traces with Python's generic fallback notice. Cache details, totals, attempt count, last observed upstream HTTP status and request-purpose labels are returned.

Migration 0016 adds nullable request_context JSONB. Admission records context sizes/counts, explicit trace headers and bounded step/retry indices. Long session IDs and initial-message fingerprints use HMAC with SECRET_KEY; fingerprint-only correlation does not create account affinity. Prompt and tool-result bodies are not persisted in this context object. Unknown old-row dimensions remain null. Context tests cover UTF-8, nested images/tool results, bounded headers, stable first-message correlation and keyed fingerprints; API tests cover filtering, rotation history, reservation visibility, ownership, bearer rejection, internal-field omission and fallback-trace redaction.

Remaining fidelity work: Node usage IDs are UUIDs rather than Python numeric event IDs; historical import must preserve an explicit mapping. Parent request lineage awaits server-tool subrequests. The Node error ledger currently merges several source failure classes and the adapter maps generic error/cancelled to upstream_error/client_error; richer status and final downstream HTTP status need capture at the execution boundary. Legacy error wrappers, query-normalization edges, role-code import and authenticated UI acceptance remain pending. This endpoint is implemented but full Python usage parity is not claimed.


## Billable status consistency — 2026-09-26

All token aggregates now share the same billable predicate: ok, stream_error and client_error, plus the existing Node cancelled alias. PAT seven-day totals, settled user quota summaries, both key-group and owner reservation checks, and overview token totals no longer charge generic/upstream/protocol/routing/quota failures merely because they carry token estimates. Request/error counts and rolling RPM still include those requests; active reservations still block admission but do not appear as settled usage. Historical raw token counters remain untouched for diagnosis.

The existing Node interrupted-worker recovery remains provisionally charged at its reserved amount, labelled estimated. This is an explicit recovery policy extension, not a claim of Python parity; final recovery/data-migration acceptance must resolve it. Detailed error classification and logging of admission failures remain separate outstanding work.


## Execution failure categories and final HTTP status — 2026-09-26

New settled execution records now distinguish upstream_error, protocol_error, routing_error, client_error and stream_error instead of generic error/cancelled. Existing historic aliases remain readable/billable under their prior meaning. Migration 0017 adds nullable http_status on the request ledger: this stores the final gateway response status, while gw_attempts.status retains each upstream status. A started SSE response stays 200 even if it ends in a stream/client error; a pre-response client disconnect has no confirmed response status. Old records remain null rather than guessing their gateway status from an upstream attempt. PAT usage now reads this ledger field directly.

This does not yet record failures occurring before reservation (no route, unsupported conversion, admission rejection), which need their own zero-charge ledger path. Recovery rows remain provisional and final interrupted-worker semantics are still pending. No parent-child server-tool lineage or migration ID mapping is implied.


## Pre-admission rejection ledger — 2026-09-26

Authenticated, model-authorized requests rejected for routing/cooldown, unsupported conversion/stateful Responses options, or admission limits now produce a settled zero-charge ledger record. It carries context metadata, reason, gateway HTTP status and a request ID shared with the error response. No upstream attempt, reserved token balance or active concurrency slot is created. These records remain visible to personal usage and operational request/error counts; rolling request-frequency accounting continues to include recorded requests. Existing authentication/scope/model-grant failures and invalid request-schema inputs remain outside this model-request ledger.

Rejection recording is best-effort with the existing error reporter: a database write failure does not replace the original refusal, authorize the request or cause an upstream call. Successful execution failures also attach their ledger ID to error responses. This completes the known routing/protocol/admission rejection paths, not general infrastructure-failure auditing or the remaining server-tool/data-import work. No schema change.


## Personal model execution boundary

Personal channels are selected by the bearer key owner and declared prefixed model. Prefixes retain a trailing slash or hyphen, otherwise append a slash. Only enabled accounts owned by that user are visible; key model grants still apply. An existing matched personal pool that is cooling does not fall back to a platform route with the same alias. Requests use the existing protocol, quota, lease and usage pipeline; the account owner, prefix, model declaration and health are rechecked at lease admission. Execution snapshots use `route_kind: personal` and `route_id: null`, with the actual account ID in `upstream_id`. Scope does not imply personal management/probe/UI completeness or real-provider acceptance.


Native personal channel administration is `/api/admin/gateway/my-channels` (GET/POST) and `/:id` (PUT/DELETE), with independent session/RBAC/CSRF protection. The five-row owner limit includes disabled rows and is serialized in PostgreSQL. PUT preserves omitted values; unsupported fields are rejected. DELETE requires disabled/no route reference/no request lease, preserves request and attempt history, and nulls the live account FK while retaining execution snapshots. Python management aliases and remaining credential controls are not yet covered by this endpoint.


Personal `discover-models` is read-only and only reuses an owned credential with unchanged target/protocol unless a new draft key is supplied. `/:id/check` uses an owner-fenced database claim; concurrent checks return409. Creation commits configuration before probing and returns observation failure inside health_probe with201. Messages model lists remain unverified for conversation health. Probe results never implicitly replace declared models. The recovery worker now includes personal accounts in its bounded queue and passes the database owner through claim and completion checks. Default platform candidate queries and administrative probe endpoints remain platform-only.


Native platform/personal account configuration now accepts note and extra_headers. Header values may be scalar strings/numbers/booleans/null; nested values are explicitly rejected. Protected auth/connection headers and CR/LF are rejected. Declared headers are used in actual model calls and discovery/probes, with request-specific draft discovery overrides that do not persist. Account-header changes invalidate older health observations; error diagnostics redact header values. This does not complete legacy field aliases, proxy configuration, per-account timeout or personal UI parity.

### Account request inactivity timeout

Native platform and personal account configuration accepts `request_timeout_seconds` as an integer from 5 to 300, default 120. Omitted edits retain the saved value. Transport applies the selected account limit separately to waiting for response headers and inactivity between body chunks, using per-dispatch Undici options on the shared pool. It is not a total-duration timer for an actively progressing response. Parent cancellation remains effective after headers. Header-stage transient timeout may fail over within existing attempt limits; a response-body timeout never restarts the request on another account.

Existing global safety bounds still apply: connection establishment is capped at 10 seconds, overall gateway request lifetime at 180 seconds by default, and model discovery at 30 seconds. These can end a request sooner than a larger account timeout. The production SSE idle ceiling is 300 seconds, bounded by the selected account timeout; explicitly configured smaller idle ceilings remain effective. Timeout configuration changes invalidate stale health/probe writes. This does not yet provide legacy credential field aliases or console editing.

### Account outbound proxy

Native platform and personal accounts accept optional `proxy_url` (HTTP/HTTPS, at most512 characters, optional URL-encoded Basic authentication). Missing edits preserve the saved value; null/empty clears it. The full URL is encrypted in `proxy_secret`; responses expose `proxy_hint` and presence only. Operation payloads mask proxy URLs, ciphertext and proxy authorization. Account error diagnostics redact URL, encoded/decoded credentials and Basic payload. Custom upstream headers cannot override `Proxy-Authorization`.

Actual model calls, stored/draft model discovery and manual/background observations use the selected proxy. Draft overrides do not persist. A new draft API key does not inherit the stored proxy implicitly. Health/probe writes compare encrypted proxy configuration to reject stale observations after edits.

Proxy use retains target network policy. Both target and proxy DNS answers are validated; the chosen proxy IP is pinned to its socket and the chosen target IP is pinned into the absolute HTTP request URI or HTTPS CONNECT destination while preserving original target Host/TLS identity. Redirects remain manual and failed proxies never silently fall back to direct connections. HTTP targets use absolute-URI forwarding; HTTPS targets use CONNECT. HTTP and HTTPS proxy endpoints are supported. Proxy dispatchers are isolated per request and close after body consumption/cancellation; connection-pool optimization is deferred. TLS certificate verification remains enabled. HTTP proxy transport is allowed explicitly as in the Python configuration; private endpoints still require the private-upstream deployment setting.

### Account provider and upstream-protocol catalogs

GET `/api/admin/gateway/providers` and `/api/admin/gateway/upstream-protocols` require `gateway_upstreams`; equivalent `/api/admin/agent/...` paths preserve Python catalog shapes. Personal variants under `/api/admin/{gateway,agent}/my-channels/{providers,upstream-protocols}` require `gateway_my_channels`, independent of platform access. All eight routes require an authenticated administrative session.

Catalogs retain Python ordering and metadata, including Gemini's reserved status, no guessed model names, all three accepted inbound protocols and Messages discovery not verifying conversation health. Native protocol catalogs add `gateway_protocol` mapping legacy identifiers to `openai`, `anthropic`, `responses`; legacy catalogs remain unchanged. Provider descriptions are the pinned migration reference, not live claims about a supplier's current offerings. Catalog access performs no upstream requests and exposes no stored accounts or credentials.

Upstream endpoint resolution follows the Python adapters: Chat/Responses accept their full endpoint or append the respective suffix. Messages accepts a full `/messages` endpoint, appends `/messages` to `/v1`, and appends `/v1/messages` to other roots. Trailing slashes are removed before resolution. This makes the catalog's Anthropic root address usable without requiring callers to add `/v1` manually.

### Account metadata and scope summaries

New/replaced API keys record the Python-compatible SHA-256 fingerprint and masked hint (four Unicode codepoints at each end for keys longer than eight; otherwise `****`). Omitted-key edits preserve both. Native responses expose `api_key_masked`, fingerprint, update/use/check/success/error timestamps, latest observed latency and effective cooldown. No plaintext/ciphertext key is exposed.

Execution snapshots and last_used_at are recorded atomically immediately before dispatch; this denotes an attempted use, not proof of supplier receipt. Health observation timestamps are recorded only when existing freshness/configuration guards accept the observation. Successful observations clear the current error timestamp. Manual/background checks update checked time; Messages discovery can remain unverified with no success timestamp. Stale observations cannot replace newer latency/success values. Personal creation rereads its owned record after probing so returned timestamps reflect the committed observation.

List summaries count the full accessible account scope, independent of text/filter/pagination results. Disabled accounts are excluded from health buckets; active cooldown contributes to unhealthy/cooling, while expired or absent cooldown deadlines on cooldown-status accounts contribute to recovering. Used counts accounts with a recorded use. Historical metadata unknown before0033 stays null; absent masked hints display `****`. Fingerprint backfill for untouched historical encrypted credentials remains part of controlled data migration.

### Legacy account lists — 2026-09-26

GET `/api/admin/agent/credentials` and `/api/admin/agent/my-channels` now use the existing upstream and personal-channel menu permissions respectively. Platform scope cannot include personal accounts; personal scope always uses the session owner, including for superadmins. Query-supplied owner/scope cannot override this. Lists preserve the Python field allowlist, legacy protocol names, default-model insertion, safe key/proxy hints, nullable historical metadata and UTC microseconds. Credential/proxy ciphertext and probe claims are excluded.

Search uses PostgreSQL ILIKE over name, legacy protocol and default model; provider/protocol/health/enabled filters combine with it. ID descending, page/per_page defaults1/20, per_page1–100; invalid integers fall back and page is bounded to a safe numeric offset. Summary is the complete authorized scope independent of filters. Rows/count/summary use one repeatable-read snapshot. Legacy write/copy/check/discovery APIs, historical data backfill and personal console are still separate obligations.

### Account management writes and probes — 2026-09-26

Legacy credentials and my-channels now support POST, PUT/:id, DELETE/:id, POST/discover-models and POST/:id/check. Credentials additionally supports POST/:id/copy and POST/health-probe. Writes use the current add/edit/delete permissions; personal probes require gateway_my_channels_test and platform probes use gateway_upstreams_edit, matching the native console. Platform batch probing intentionally excludes personal accounts; background recovery still handles owned personal candidates separately. Disabled accounts retain the Node probe guard and return409 for manual checks. These explicit boundaries are not claims of byte-for-byte Python behavior.

Legacy input maps protocol names, Python boolean/scalar normalization, defaults (weight100), header JSON aliases and partial edits. Provider labels are inferred from the base hostname; caller provider/scope/owner values cannot override classification or ownership. Empty edit keys retain encrypted credentials. Platform writes lock the current row before merging, personal writes retain the owner lock and five-channel limit. Create commits before automatic observation and returns health_probe even on failure. Copy retains encrypted configuration while resetting health/use/probe state. Delete requires disabled status, no route references and no probe/in-flight leases; request history remains governed by the existing FK/snapshot policy. Container-valued text/header values remain rejected rather than Python-stringified. No new UI is included in this API module delivery.
