# Key lifecycle migration

## Personal key editing

`PUT /api/admin/gateway/keys/:id` uses the console session/CSRF stack and `gateway_keys_edit`, scoped to the signed-in owner. It accepts only `name` and optional `expires_days` (1–3650, null/omitted removes expiry). Names are trimmed and limited to 100 characters. This follows Python `normalize_pat_update_payload` and `AuthService.update_pat` for the valid personal-key edit path.

A transaction locks the owned key, checks current database time after the lock, and rejects revoked, expired or nonpersonal keys. Missing/other-owner keys return 404, invalid key states 409. The update preserves id, credential digest/prefix, model scopes, budgets and the existing request ledger. Responses never reveal the credential or digest. Gateway bearer credentials cannot use the console administration endpoint, and extra privilege fields are rejected.

Five real-database/API cases cover renaming, the maximum supported expiry, clearing expiry, unchanged bearer authentication/limits, revoked/expired/device rejection, owner scope and privilege-field/bearer rejection.

## Remaining migration

The existing create path still has the Node-preview expiry defaults/range; full Python create/PAT response compatibility remains pending. The console edit dialog and legacy PUT alias are not implemented by this API slice. Rotation must follow Python replacement-record plus atomic old-token revocation, preserve expiry/scopes, and ensure neither shared-user nor per-key admission accounting can reset through rotation. Do not substitute an in-place credential overwrite for the legacy replacement history. Rotation, usage history/lineage, legacy PAT endpoints and full UI remain open acceptance items.


## Replacement-record rotation

`POST /api/admin/gateway/keys/:id/rotate` requires the console session/CSRF and separate `gateway_keys_rotate` permission. It returns 201 with the replacement record and its raw token once. The locked old key must belong to the caller and be currently valid; revoked/expired keys return 409 and foreign/missing keys 404. The same transaction inserts the replacement and revokes the old record. Insert failure rolls back without invalidating the original token; simultaneous rotations have exactly one winner.

Migration 0011 adds `quota_group` (each existing/new independent key gets a random UUID) and the self-referencing `rotated_from_id`. Replacements inherit the original group and record their immediate predecessor. Name, kind, models, expiry and all quota settings are copied. Request logs remain attached to the historical key that admitted them. Per-key admission aggregates all records in the group, including revoked predecessors; outstanding reservations, daily settled usage and rolling RPM therefore survive arbitrary rotations. Separate independently created keys retain separate key budgets, with the existing shared-user policy applying across all keys. No raw token/digest is returned from list responses.

Seven database/API regressions cover replacement metadata/old authentication failure, competing rotations, ownership/expiry, three quota types with in-flight settlement, repeated rotations versus independent keys, and insertion rollback. The database foreign key and quota-group index are applied to the isolated development database; seed-rbac adds the independent rotation permission incrementally.

This supersedes the earlier statement that the native rotation API is pending. Console rotation/edit forms, legacy PAT route/response compatibility and creation defaults remain outstanding.


## Native console actions

The access-key list now exposes edit for valid personal keys with edit permission and rotation for valid keys with the separate rotation permission. Editing requires an explicit new expiry choice (unlimited or 1–3650 days from now) so changing a name cannot silently remove an existing expiry. Revoked/expired keys hide both actions; device keys do not expose personal-key editing. Expiry visibility is refreshed every minute, with authoritative validation still performed by the API.

Rotation shows a confirmation explaining immediate old-token invalidation and continued quota accounting. The returned token uses the existing one-time display/copy dialog; closing it clears the token from component state. The list refreshes on successful mutations. English/Japanese translations are included. Component tests cover explicit confirmation/token delivery, mandatory expiry selection and revoked/device actions. Authenticated browser geometry/interaction acceptance and legacy PAT endpoints remain pending.


## PAT scope prerequisite

Migration 0012 adds persisted `scopes` with the historical chat/profile defaults, preserving existing Node keys' model-call behavior. Native key creation accepts only a nonempty subset of these two values. Model execution and discovery require chat; rotation copies scopes; personal editing does not accept scope changes. Reservation re-reads current scopes and model grants under the key lock, preventing an earlier authentication snapshot from bypassing a change before admission. Already admitted requests keep their established behavior.

Three regressions cover profile-only rejection across three protocols/models without upstream calls or reservations, rotation/edit privilege preservation, and fresh admission checks. The profile endpoint and complete legacy PAT request/response adapter remain pending; merely adding scopes does not complete legacy compatibility.


The profile endpoint prerequisite is now implemented at /api/agent/me, including profile scope and legacy authentication error fields; default/override quota semantics are documented in user-limits.md. Legacy PAT CRUD/list/usage adapters remain pending.


## Legacy PAT CRUD and list adapter

Console-session/CSRF-protected `/api/agent/auth/pat` now supports GET/POST, with PUT/DELETE `/:id` and POST `/:id/rotate`. Existing native gateway key permissions apply; legacy role-code import mapping is still pending. Bearer-only requests cannot manage keys. Creation defaults to personal, chat/profile scopes and no expiry, supports 1–3650 days, deduplicates scopes, and persists a 255-character note. Legacy keys have no additional per-key daily/RPM/concurrency cap (zero); shared user/account policies still apply. Native creation retains its separate preview defaults.

Responses expose legacy PAT metadata; raw tokens appear only on creation/rotation. Lists are owner-scoped, searchable by name/prefix/note, filterable by status/type, paginated up to 100 rows and include settled seven-day request/token totals per historical key. Rotation copies note/scopes and records revocation time atomically. Successful authentication records last-use time best-effort. Migration 0014 adds nullable note/revoked_at/last_used_at; unknown pre-migration timestamps are not fabricated.

Still pending: `/:id/usage`, complete legacy error/normalization parity, legacy role/data import and authenticated visual acceptance. Native strict update validation currently also applies to the legacy PUT alias; this is not a claim of complete Python PAT compatibility.


## PAT usage endpoint and request context — 2026-09-26

GET /api/agent/auth/pat/:id/usage now requires the console session and gateway_keys permission, verifies key ownership and keeps rotation predecessors independently queryable. It supports days (1–365, default 7), exact model/status filters and page/per_page (capped at 100); reservations are excluded unless explicitly requested. Caller-supplied owner/key selectors cannot change scope. Personal rows use a field allowlist, omit internal account/route/key identifiers and raw provider usage, and replace internal fallback-account traces with Python's generic fallback notice. Cache details, totals, attempt count, last observed upstream HTTP status and request-purpose labels are returned.

Migration 0016 adds nullable request_context JSONB. Admission records context sizes/counts, explicit trace headers and bounded step/retry indices. Long session IDs and initial-message fingerprints use HMAC with SECRET_KEY; fingerprint-only correlation does not create account affinity. Prompt and tool-result bodies are not persisted in this context object. Unknown old-row dimensions remain null. Context tests cover UTF-8, nested images/tool results, bounded headers, stable first-message correlation and keyed fingerprints; API tests cover filtering, rotation history, reservation visibility, ownership, bearer rejection, internal-field omission and fallback-trace redaction.

Remaining fidelity work: Node usage IDs are UUIDs rather than Python numeric event IDs; historical import must preserve an explicit mapping. Parent request lineage awaits server-tool subrequests. The Node error ledger currently merges several source failure classes and the adapter maps generic error/cancelled to upstream_error/client_error; richer status and final downstream HTTP status need capture at the execution boundary. Legacy error wrappers, query-normalization edges, role-code import and authenticated UI acceptance remain pending. This endpoint is implemented but full Python usage parity is not claimed.


## Execution failure categories and final HTTP status — 2026-09-26

New settled execution records now distinguish upstream_error, protocol_error, routing_error, client_error and stream_error instead of generic error/cancelled. Existing historic aliases remain readable/billable under their prior meaning. Migration 0017 adds nullable http_status on the request ledger: this stores the final gateway response status, while gw_attempts.status retains each upstream status. A started SSE response stays 200 even if it ends in a stream/client error; a pre-response client disconnect has no confirmed response status. Old records remain null rather than guessing their gateway status from an upstream attempt. PAT usage now reads this ledger field directly.

This does not yet record failures occurring before reservation (no route, unsupported conversion, admission rejection), which need their own zero-charge ledger path. Recovery rows remain provisional and final interrupted-worker semantics are still pending. No parent-child server-tool lineage or migration ID mapping is implied.

## Device decisions

Both /api/admin/gateway/device/{confirm,deny} and /api/agent/auth/device/{confirm,deny} are session-authenticated, CSRF-protected and require gateway_keys_add. They accept user_code; confirmation and denial compete atomically for a pending device request. Invalid codes return 404, expired requests 410, and already-decided requests 409. Polling returns authorization_pending, expired_token, access_denied or already_consumed (409) as applicable. Start includes verification_uri_complete; page behavior and evidence are recorded below.

## Shared device-start admission

Device start now serializes admission in PostgreSQL with the legacy advisory-lock namespace. Across replicas sharing a database, AGENT_DEVICE_STARTS_PER_MINUTE defaults to 60, AGENT_DEVICE_MAX_ACTIVE to 5000, and AGENT_DEVICE_RETENTION_HOURS to 24. Configure identical values on every replica. Pending and approved requests consume active capacity; every recent creation counts toward the minute limit regardless of later status. Admission marks expired pending/approved requests and removes rows older than retention, even when the new start is refused. Created/expiry timestamps use database time; the current authorization TTL remains 600 seconds.

Rate refusal returns 429 rate_limited with Retry-After: 60; capacity refusal returns 503 capacity_exceeded. The additional per-IP start/poll layer is shared in PostgreSQL as described below.

## Device page status

The page now preloads user_code from the verification URL, shows the current account, supports explicit confirm/deny and disables both while pending. Failed requests keep the code for correction/retry; invalid, expired and already-handled states have actionable copy. Accounts without gateway_keys_add see a permission explanation. The login return path retains the full query. Component tests cover both decisions and login redirect; real browser verification covers invalid-code handling and denial at desktop/mobile widths. Fresh-login-to-success browser acceptance remains pending.

## Device-grant governance parity

New device grants have no additional key-level daily/concurrency/RPM cap (all three key fields are zero). They remain subject to the owner's shared daily budget, concurrency and RPM policy, matching Python's user-governed device PAT behavior. This replaces the preview's arbitrary 100000/5/60 device caps; existing keys keep their stored limits and are not silently modified. Device grants retain chat/profile scopes, 30-day expiry and one-time redemption. Poll success includes the sanitized user profile (id, username, created_at, roles and menu_codes); password hashes are excluded. Profile loading occurs in the redemption transaction before inserting the key/consuming the code, so a profile-query failure leaves the grant retryable.


## Shared device start/poll IP limits

Migration 0019 replaces the process-local address map with gw_device_rate_limits. POST start and poll share a fixed 60-second window of 60 requests per client IP across replicas; rejected, malformed and unknown-code requests count. A transaction advisory lock serializes counter creation/increment and identity-capacity checks. At most 10000 live identities are retained; expired windows are removed on admission. Refusal is 429 slow_down with Retry-After in seconds. Rejected requests do not indefinitely extend the window or increment counters. State uses database time and survives application restart. The table stores an address digest, not raw addresses; this is not a claim of irreversible IP anonymization.

Forwarded client IP/protocol is trusted only when the connecting peer belongs to TRUSTED_PROXIES (comma-separated IPs/CIDRs). Empty, the default, uses direct peer addresses and ignores forwarded headers. Configure only the reverse proxy's actual source addresses, protect direct API access, and have the proxy overwrite incoming forwarding headers. Do not use an all-address CIDR. A trusted proxy chain resolves to the nearest untrusted address. For TLS termination, set this trust boundary correctly and SESSION_COOKIE_SECURE=true when all public access is HTTPS. Vite development requests remain shared under the local proxy address unless explicitly trusted.

Tests cover 80 competing admissions through two database pools (exactly 60 accepted), expiry reset, 10000-identity capacity/reclamation, two app instances sharing limits, forged forwarding headers on direct connections and trusted proxy chains. These are isolated DB/HTTP-injection checks, not deployed replica/load acceptance. A global database lock favors correctness during migration; throughput and database outage behavior need the planned reliability validation. Apply 0019 before deploying the new API; rolling back API code may leave this additive table intact.


## Personal usage compatibility

GET /api/agent/me/usage uses the admin session, without requiring a management-menu permission (matching Python). Bearer-only requests are not accepted. It aggregates only the logged-in user's keys, including revoked keys retained after rotation; user_id cannot change scope. Optional pat_id further narrows within that owner, with unknown/foreign IDs returning an empty list. days defaults to 7 (1–365), model/status filtering and page/per_page match the PAT usage query. Reservations are hidden unless status=reserved; historic cancelled/error statuses map to client_error/upstream_error.

PAT-specific usage retains its explicit ownership check/404 and ignores a query pat_id in favor of the path. Both endpoints now share the repository query and safe serializer: key names/types, correlation/context metrics, cache null-versus-zero and fallback metadata are retained, while raw usage, key/user IDs, credential/routing details and internal fallback traces are not exposed. Admin analytics, personal analytics/export, legacy history import and parent-request lineage remain separate migration tasks.


## Personal usage export

POST /api/agent/me/usage/export requires a session, CSRF token and gateway_my_usage_export permission (the legacy agent_my_usage_export permission still needs mapping during data import). All records remain constrained to that session's owner. fields retains valid requested fields/order; no valid fields selects the Python default field set. filters accepts the personal query filters; absent filters uses top-level fields. Default/unknown file_type yields XLSX; CSV and actual BIFF8 XLS are also supported. Headers, Chinese status/purpose labels, blank unknown cache counts, real zero cache counts and fallback redaction follow Python; formula-looking text is escaped before writing.

Filtered export includes up to 5000 matching records. selected mode requires nonempty request IDs, ignores filter window/model/status while retaining owner scope, and deduplicates naturally through SQL IN; unknown/foreign IDs are omitted. Node requests use string IDs; Python numeric historical ID mapping remains pending. Selected requests explicitly reject more than 5000 IDs as a resource bound, rather than silently truncating. Output fields do not expose credentials/raw usage/internal routing data. RBAC seed adds the export button; no role is automatically granted new non-super-admin access.

XLS writing uses SheetJS CE 0.20.3, pinned to the official tarball with lockfile integrity; installed package declares Apache-2.0. Existing CSV/XLSX generation retains the shared table helper. References: [official Node installation](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) and [buffer output](https://docs.sheetjs.com/docs/solutions/output/). Release artifact/license audit remains part of P8.


## Personal usage page

Open the avatar menu → 我的用量 (/agent/my-usage). Every signed-in user can access their personal query; export controls appear only with gateway_my_usage_export. Apply days/model/PAT/status filters with 查询; drafts do not affect exports until applied. Filtered export is limited to 5000 records; selected export uses the current page only. Refresh/page/filter changes clear selection. Export dialog offers all 27 safe fields and CSV/XLSX/XLS. Error retry preserves filter input; stale earlier responses are ignored. Details reuse the personal response only and never request administrator attempt records. Aggregate analytics remains a separate open migration item.


## Personal usage analytics

GET /api/agent/me/usage/analytics uses the same session-only owner boundary and filter validation as personal records. Summary includes requests/success/error counts, billable input/output/total, latency average/p95 and active users/models. Nonbillable failures count as errors but do not contribute billed tokens. Reservations appear only when explicitly requested and contribute no billable tokens. Trend buckets use configured business timezone; days=1 is hourly, otherwise daily. Percentile interpolation matches PostgreSQL Python behavior; averages/percentiles truncate to integer milliseconds.

Model breakdown ignores only the model filter, retains owner/PAT/status/time scope, returns top eight and uses the total across all matching models as the share denominator. Personal response has users=[] and daily_quota_per_user=null; quota uses the existing current-user daily policy. Model and PAT filter options use the owner's time window independently of the narrower selected filters, including retained/revoked keys. No other owners' names/models/keys are exposed.

Cache summary fields are an additive Node extension: unknown totals remain null, reported zero stays zero, and *_reported_requests counts indicate coverage among billable requests. A partial sum is not evidence that every request reported cache use. Aggregate/option queries share a repeatable-read, read-only transaction; the current daily quota is read separately afterward. Analytics UI and administrator analytics remain open migration tasks.


## Administrator usage analytics

GET /api/admin/agent/usage/analytics requires a cookie session and gateway_requests. The legacy agent_usage permission needs mapping during data migration; bearer-only access is not accepted. The shared aggregation repository takes an explicit personal/admin scope. Administrator queries accept positive user_id plus the existing PAT/model/status/days filters, return up to eight users ranked by billable tokens (ID breaks ties), and retain the same summary/trend/model/cache coverage semantics as personal analytics.

Administrator filter options contain users/models from the full selected time window, independent of current user/model/status/PAT filters, matching Python's ability to switch drilldown targets. Model breakdown ignores only model itself and keeps the selected user/PAT/status/time. daily_quota_per_user reports the configured default or null for unlimited; no single-user quota object or personal PAT-option list is returned. Unknown users yield empty aggregates, while global filter options remain available to authorized administrators. The personal endpoint still forces the session owner and returns no user list.


## Administrator usage records

GET /api/admin/agent/usage requires gateway_requests with a cookie session. It accepts user_id plus the existing page/per_page/PAT/model/status/days filters. Administrator and personal queries use explicit repository scopes and a shared safe field serializer; the admin layer adds user/PAT identifiers, username and execution-snapshot account ID/name (old rows can retain a last-attempt account ID), and exposes the already-stored error diagnostic instead of personal fallback redaction. It never serializes key hashes, upstream secrets or raw request payloads. Personal responses remain allowlisted and do not gain these internal fields.

Migration 0020 adds nullable execution snapshots to requests and attempts. Before sending upstream I/O, the request stores the acquired route ID, account ID/name, actual wire model (including vision selection) and protocol; retries replace the request target and each attempt retains its own snapshot. Snapshot persistence failure prevents sending. These fields describe the last attempted target, not proof of success. Account renaming or route editing does not rewrite them. Old rows remain unknown; names are never inferred from live configuration. From migration 0021, account provider classification defaults to openai-compatible, accepts a nonempty trimmed value up to 64 characters and is retained when omitted on update. It never selects transport format. New snapshots store provider and route_name (the public model alias, matching Python related_context), while older snapshots omit those fields and serialize null. Historical import/mapping still requires migration work. Apply 0020 before the new API; rollback to the previous API can retain the additive columns.


The administrator Requests console now queries the compatible list using days/model/user/PAT/status filters, defaulting to finished rows. An explicit in-progress filter includes reservations; Node interrupted recovery records are also filterable. On inspection the session/RBAC-protected native request detail endpoint returns full ledger usage and execution snapshots, paired with attempt rows. This preserves cache TTL/reasoning/raw usage details without exposing them in personal serialization. Snapshot fields are historical; user/PAT names still come from current metadata. User/PAT filters currently take numeric IDs; historical ID mapping and analytics visualization remain pending.


Analytics console is now available in personal Usage and administrator Requests tabs. It uses the corresponding session API, never sends a personal user_id override and shows user ranking only for administrators. Summary, timezone buckets, model shares and cache nullable totals/report counts retain server semantics. The trend is accompanied by a data table; cache coverage is shown as counts, not an inferred full-coverage hit rate. Daily quota is a separate current-day read, independent of the selected historical window. Normal-user browser and historical import/reconciliation remain separate acceptance work.
