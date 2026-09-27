# Shared user limits

User limits apply in addition to per-key limits. Zero means no additional user-level cap; it never disables a key's own cap. New policies inherit AGENT_DAILY_TOKEN_QUOTA (default 0); a null daily_limit means inherit and an explicit 0 means unlimited. Existing preview rows retain their previous numeric setting. The daily unit is total normalized input plus output tokens, with cache/reasoning already included; no monetary pricing is inferred.

- GET `/api/admin/gateway/user-limits/:id` requires `system_users` and returns defaults when the user has no saved policy.
- PUT on the same path requires `system_users_edit`, console authentication and the existing CSRF protection. Body requires `daily_limit`, `concurrency_limit`, `rpm_limit`; values are nonnegative integers, with null additionally allowed for daily_limit inheritance. No gateway bearer credential can raise its own budget.
- Day boundary follows AGENT_TIMEZONE (default Asia/Shanghai, matching Python); all current reservations count, including those started before midnight. Completed usage belongs to the business day of admission (request created_at), including requests completed after midnight. User RPM uses a sliding minute, including the previous day near midnight.
- Reservation locks key then user policy, computes aggregate usage across all of that user's keys and inserts the reservation atomically. No lock is held across provider I/O. User-policy edits serialize with reservations through the same policy row. Changing a policy governs subsequent reservations and does not abort already running requests.
- Settlement uses the existing request ledger; releasing or finishing one reservation changes the next shared-budget decision. Revocation does not remove historical usage because aggregation does not filter out revoked keys.

The API/database slice and admin form are implemented. The user-management row exposes a separate gateway-limits dialog to users with system_users_edit. It loads the saved policy before opening, validates nonnegative integers, preserves edits on save failure, and documents the business timezone and zero semantics. User-visible remaining quota, lock-wait rollover and failure-recovery tests and multi-process recovery acceptance remain pending. Account/provider budgets are a separate concern and are not implemented by this table.

## UTC boundary regression coverage

Both key and owner checks now include the prior day when scanning the rolling minute, without charging that prior-day completed usage to the new daily budget. Outstanding reservations still count across midnight until settled. Four database tests pin 00:00:10 UTC and cover both scopes, the exact 60-second expiry boundary, prior-day settlement and new-day reservation totals. Admission samples the database clock after key/owner locks and uses that same instant for both quota queries and the inserted request timestamp, avoiding transaction-start timestamps after long lock waits. Actual lock-wait rollover and process recovery remain separate acceptance items.


The previous fixed-UTC default is superseded: configure AGENT_TIMEZONE to select the business-day timezone; invalid values fall back to Asia/Shanghai as in Python. PostgreSQL computes timezone-aware midnight, including DST, while timestamps remain UTC instants. Existing UTC regression tests explicitly request UTC. Additional key/user tests cover Shanghai midnight and the New York spring DST transition. The overview summary exposes its effective timezone to the console. Changing this setting changes which already recorded requests belong to today; operators must preserve the old installation setting during migration. Default-user-quota policy remains a separate pending compatibility item.


## Default policy and profile endpoint

AGENT_DAILY_TOKEN_QUOTA is read when the API/worker starts; invalid or negative values fail startup rather than silently disabling a cap. Migration 0013 removes the daily_limit NOT NULL/default constraints. Automatic admission-barrier rows now use null; existing preview rows with 0 stay explicitly unlimited because prior automatic rows cannot be reliably distinguished from intentional administrator settings. Operators may explicitly save null for those users when they want inheritance. Legacy Python import must preserve absence versus explicit zero.

GET /api/agent/me accepts Bearer, X-Api-Key or Api-Key, requires profile scope and returns user plus quota with the Python field names: daily_quota, quota_override, quota_source, used_today, remaining, usage_percent and exhausted. User serialization includes roles/menu_codes but never password hashes. Quota summary uses settled/charged input+output totals across all owned keys for the business day; admission additionally accounts for in-flight reservations, so displayed remaining is not a promise that an arbitrarily large request will be admitted. Unlimited quantities serialize as null. Legacy missing/invalid token and insufficient-scope error bodies are preserved.


## Billable status consistency — 2026-09-26

All token aggregates now share the same billable predicate: ok, stream_error and client_error, plus the existing Node cancelled alias. PAT seven-day totals, settled user quota summaries, both key-group and owner reservation checks, and overview token totals no longer charge generic/upstream/protocol/routing/quota failures merely because they carry token estimates. Request/error counts and rolling RPM still include those requests; active reservations still block admission but do not appear as settled usage. Historical raw token counters remain untouched for diagnosis.

The existing Node interrupted-worker recovery remains provisionally charged at its reserved amount, labelled estimated. This is an explicit recovery policy extension, not a claim of Python parity; final recovery/data-migration acceptance must resolve it. Detailed error classification and logging of admission failures remain separate outstanding work.


## Legacy administrator quota endpoints

GET /api/admin/agent/quotas uses session/gateway_requests permission and page/per_page/search; users sort by username then ID. The response preserves Python quota item fields, default_daily_quota, inherited null versus explicit zero and business-day billed usage across keys. Count and list share a repeatable-read snapshot. Remaining/percent exclude active reservations, like the profile summary; admission still includes them.

PUT /api/admin/agent/quotas/:id requires session, CSRF and gateway_requests_quota_edit (seed button 10042 under 1004). daily_token_quota is required, null/empty restores default, zero is unlimited and integers/numeric strings from 0 through 1000000000 are accepted. Missing users return 404; invalid values return 400. It patches only daily_limit, preserving concurrent RPM/concurrency edits; it does not delete the shared policy row when restoring defaults. The response is quota_summary. Existing admitted requests retain their admission semantics.

Migration 0022 adds nullable quota_updated_at: new quota/full-limit updates record database time; inherited entries and unrecorded legacy update times serialize null. Apply migration then run seed:rbac -- --incremental before API rollout. Full historical RBAC/ID/timestamp mapping and the dedicated quota console remain pending.


## Quota console

The Requests page now has a User quotas tab, using the legacy quota API. It shows system default, per-user inherited/explicit effective cap, billed usage, remaining and exhaustion, with submitted username search and pagination. Editing requires gateway_requests_quota_edit. The dialog explicitly selects inheritance, unlimited or a positive integer quota (max 1000000000), avoiding null/zero ambiguity. Only daily quota is written. Failed saves retain the dialog; successful saves reload the current query. Late list responses cannot replace newer queries. Loading/error states do not present stale default amounts as current.

Five component cases verify read-only controls/search, numeric validation/error retry, unlimited versus inherited payloads, and list error/stale-response handling. Browser at localhost:5175: existing admin, 1280x720 list/default mode; 390x844 contained horizontal table scrolling, edit dialog and positive-quota field. No browser write was submitted; persistence is covered by API and mocked component handoff separately.
