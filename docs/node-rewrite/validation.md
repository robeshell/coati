# Validation record — 2026-09-25

> 最新本轮功能收尾与准确验证结果见[final-functional-acceptance.md](final-functional-acceptance.md)。下文是历史证据，各阶段TODO/剩余项不能覆盖当前roadmap。

This record describes the preview branch, not production acceptance. Stable Coati reference: `e41bb06529ac346bf289e6fb5aa132ca1ecc3851`. Foundation: castor-kit `afe076c7835c8f7e2c330c0d6574fb92d8229d92`.

## Evidence

| Check | Result |
| --- | --- |
| TypeScript | `pnpm typecheck` passed |
| API tests | 243 passed; 2 opt-in scheduler process tests skipped (`SCHEDULER_E2E=1` enables them) |
| Web tests | 42 passed, including login return-path safety |
| Gateway gate | 35 passed across gateway, migration-chain and bootstrap suites; scoped gateway ESLint passed |
| Gateway-specific tests | 27 passed: admin configuration → request → usage, 3 native SSE protocols, cookie/bearer isolation, key revocation/model allowlist, concurrent quota reservation, one-time device redemption, split UTF-8/events, truncated streams, real socket disconnect, idle timeout, 503 failover, private/mapped addresses, malformed requests and settlement failure |
| Builds | API + web builds passed; frontend retains a bundle-size warning for inherited administration/chart code |
| Migrations | Fresh database bootstrap exercised by tests; isolated `coati_node_dev` migrated through `0003_gateway_query_indexes`; gateway tables and both query indexes confirmed |
| Container | Node 22 Debian image built and started against a fresh PostgreSQL 17 container; both healthy |
| Container smoke | Real HTTP health, admin login/session, overview, SPA, bearer-only model access, JSON 404, and no bootstrap secrets in logs passed |
| Browser | Login, overview/navigation, upstream form and required validation, device authorization page, logout/login return to authorization page verified on localhost |
| Stable/private projects | Python `portal/`, original Coati main, private company checkout and castor-kit source not modified by this rewrite |

The full tests use a real isolated PostgreSQL database and a fake upstream. No real provider credentials or paid model calls were used. Browser checks did not submit a real provider key or authorize an external client. Real-provider, mobile, multi-replica and sustained slow-client acceptance remain outstanding.

## Initial Node performance baseline

Measured gateway source: `c8913aa` (before the query-index follow-up).

Command: `BENCH_DATABASE_URL=postgresql://localhost/postgres pnpm bench:gateway`. Raw results: [benchmark-node.json](benchmark-node.json).

Conditions: macOS arm64, Node v25.9.0, local PostgreSQL, one key, 10 warm-up requests, 200 measured requests per concurrency. Upstream emits six SSE deltas with a 10ms initial delay and 5ms between deltas. Load generator, fake upstream and gateway run in the same process. Authentication, quota reservations, SQL usage settlement and real HTTP are enabled. RSS includes all three components. This short local sample is not a capacity guarantee.

| Concurrent requests | Requests/s | First event p95 | Total p95 | Process RSS |
| --- | ---: | ---: | ---: | ---: |
| 1 | 17.98 | 21.07ms | 60.14ms | 262.4 MiB |
| 20 | 343.19 | 52.42ms | 86.35ms | 264.5 MiB |
| 100 | 295.36 | 291.55ms | 429.06ms | 282.6 MiB |

Increasing concurrency to 100 did not increase throughput in this run. Investigate database/pool contention and the shared load-generator process with longer, separately hosted trials before optimizing. These results do **not** establish that Node is faster than Python. A matched Python baseline has not yet been run; language, deployment workers, real provider latency, and protocol conversion must be compared separately.

## Release gates still open

Protocol bridge parity; model profiles and provider-specific header/tool behavior; shared user budgets; legacy token/client flows; old-data export/import and credential re-encryption; retention; multi-replica load/fault tests; real upstream integration; production rollout and rollback rehearsal. No migration or traffic cutover was performed.

## P0/P1 contract batch — 2026-09-25

Local changes on top of `fa1c840`; no production handler or database migration changed.

- Legacy inventory: 69 method/path entries classified; static inventory is not runtime parity evidence.
- Draft independent protocol types, event lifecycle guard, and 216 explicit matrix acceptance TODOs (9 pairs × 2 modes × 12 scenarios).
- TypeScript and API/web builds passed. Existing frontend bundle-size warning remains.
- API tests: 253 passed, 2 skipped, 216 TODO. Web tests: 44 passed.
- Gateway gate: 45 passed, 216 TODO; scoped lint passed. TODOs remain release blockers for their eventual supported scope, despite Vitest's successful exit status.
- Historical evaluation: 13 isolated pi-ai checks passed, but the user subsequently rejected this dependency. The experiment and its lockfile were removed; these results are not acceptance evidence for the self-written adapters. Full protocol bridges, socket policies and sustained streaming remain unverified.
- No pi-ai dependency added to the production workspace. No live credentials, production writes, schema changes or traffic cutover.

See [protocol contract](protocol-contract.md) and [legacy inventory](legacy-inventory.md) for evidence boundaries and remaining work.

## Active migration goal: first Python parity port — 2026-09-25

- `python3 scripts/export-protocol-fixtures.py --check`: 43 unchanged Python bridge tests passed; 70 deterministic JSON conversion fixtures reproduced, including supplementary cache/tool/image cases. The script loads only the bridge, with a fixed clock/UUID; no Flask startup or database access. Fixture source and test SHA-256 values are checked by the Node suite.
- `anthropic-chat.ts`: first request/JSON-response direction implemented. 12 fixture comparisons pass; the other 58 converter cases remain explicit TODOs. There is no runtime route integration yet and no stream parity claim.
- Full suite: API 266 passed, 2 skipped, 274 TODO (216 matrix obligations + 58 remaining golden comparisons); web 44 passed. Gateway gate 58 passed with the same 274 TODOs; scoped lint, typecheck and builds passed. Existing frontend size warning remains.
- No migrations, production calls or traffic changes. Subsequent work must implement the other converters, stream traces/adapters and runtime integration before closing P1.

## Full JSON converter port — 2026-09-25

- All six cross-protocol request/JSON-response directions and the nine-pair dispatcher implemented as pure modules. Native requests return a shallow copy; adapters do not mutate input fixtures. Production handlers remain unchanged until streaming and accounting integration are ready.
- Python fixture exporter runs 43 original tests plus supplementary nine-pair/cache/image/tool cases: 88 JSON/error fixtures and 14 public stream-method traces. `--check` reproduces both artifacts. Node parity suite: 89 passed (88 cases plus source/test hash guard), no pending JSON fixture cases.
- Full suite: API 342 passed, 2 skipped, 216 matrix TODO; web 44 passed. Gateway gate 134 passed with 216 TODO. TypeScript, scoped gateway lint and builds passed; existing frontend bundle warning remains.
- Stream traces are preparation evidence, not a passed Node streaming suite. No live provider requests, migrations or traffic changes.
- Python behavioral caveats retained and recorded: Chat-to-Anthropic and Responses-to-Chat JSON response helpers omit some cache details; Chat-to-Responses usage ignores Chat `prompt_tokens_details`. These must be addressed explicitly in the final usage contract/accounting integration, with separate regression cases, rather than treating fixture parity as complete cache telemetry. Unsigned reasoning remains visible text as in Python; this is not a lossless signature mapping.

## Runtime JSON/SSE matrix integration — 2026-09-25

- Four base stream adapters match all 14 exported Python method traces. `bridgeStream` composes them into six conversion directions and retains native passthrough on the diagonal.
- Service route selection no longer filters by inbound protocol. Request-capability filtering precedes the three-attempt cap; HTTP path, provider headers, request body and usage parser use the upstream protocol. Responses are encoded for the inbound protocol. The legacy `/api/agent/anthropic/v1/messages` alias shares the handler.
- Converted finish/usage is deferred until the actual upstream terminal, then withheld until successful settlement. EOF without the source terminal remains an error. Late Chat usage is included; partial Anthropic usage snapshots preserve prior cache counts. `response.incomplete` caused by output length is a terminal partial response, not a transport failure.
- Cross-protocol state is bounded by a 16 MiB cumulative input-event budget; existing 1 MiB event/terminal bounds remain. This is a resource guard, not sustained-load acceptance.
- `gateway-matrix.test.ts`: 94 route/integration cases cover nine pairs of text/tools in JSON/SSE, linked tool-result followup, length limits, upstream errors, six cross-protocol truncations, six real client disconnects, six settlement failures, unsupported parameters, compatible-route filtering, legacy alias and output-reservation bounds. Provider HTTP uses local fixtures; there were no real model calls. Configuration calls and most client requests use Fastify injection; cancellation cases use real client sockets.
- Matrix text/upstream-error TODOs are replaced by these concrete tests; 180 broader matrix obligations remain. Tool/usage/slow-client/SDK production coverage is not inferred from the basic cases.
- No schema migration in this batch. Cache subcounts are currently retained in request memory and included in aggregate accounting; persistent cache detail fields and full wire-detail mapping remain the next required work.

Verification for the final code in this batch: API 451 passed, 2 skipped, 180 TODO; web 44 passed (unchanged after the last backend-only allowance fix). Gateway gate 243 passed with 180 TODO; scoped lint, TypeScript and API/web builds passed. Frontend bundle-size warning remains. Python fixture regeneration check passed. No commit, push, production switch or final migration acceptance was performed.

## Persistent detailed usage — 2026-09-25

- Added nullable cache read/write, 5m/1h cache-write, reasoning, upstream protocol and raw usage columns on `gw_requests`. Missing counters remain null, reported zero remains zero; existing historical rows are not backfilled with invented measurements.
- Shared normalization counts Anthropic cache as part of total input, while Chat/Responses input already includes it. Reasoning is a subset of output. Partial cumulative snapshots merge recursively without adding repeated counts or clearing known fields on empty objects.
- Runtime JSON and terminal SSE conversion preserve known usage details across all nine pairs, independently of the unchanged Python golden converters. Native passthrough remains intact. Matrix integration now checks returned usage and persisted read/write/raw/protocol details for all nine pairs, JSON/SSE, text/tools.
- Six new unit cases cover TTLs, reasoning, unknown/zero/invalid counts and repeated partial snapshots. No real model requests were made.
- Actual isolated development DB upgrade: pre-head `0003_gateway_query_indexes` (4 migration records), post-head `0004_gateway_usage_details` (record 5, timestamp 1790346095812). All seven nullable columns verified through information_schema. Test DB and fresh bootstrap migration checks passed as part of full suite/gateway gate.
- Validation: API 457 passed, 2 skipped, 180 TODO; web 44 passed. Gateway gate 249 passed, 180 TODO. Typecheck, scoped lint and API/web builds passed; existing frontend chunk warnings remain. Only whitespace formatting followed validation.
- This completes a backend usage slice, not final migration acceptance. Usage detail presentation, richer upstream-specific usage fixtures and the remaining matrix obligations still require acceptance. No commit, push, production deployment or traffic switch.

## Console usage details — 2026-09-25

- Request detail now shows inbound/upstream protocol, translated usage source, normalized input/output, cache read/write and TTL breakdown, reasoning, and collapsed raw upstream usage. Missing details remain “not reported”; zero remains zero; estimated totals retain their label. Subcounts are explicitly identified as already included in totals.
- English/Japanese catalogs updated. Two component tests cover missing versus zero, estimate labeling, collapsed raw usage and safe text rendering. Web suite: 46 passed; web build passed with existing bundle warnings. Backend unchanged from the previous validated batch.
- Browser check on local Chrome at its current desktop viewport: opened a temporary, explicitly named mock request, verified all values in the detail sheet, expanded raw usage and inspected the screenshot. The fixture used a revoked nonfunctional key and no upstream requests. Both temporary database records were removed afterward. This is local mock UI evidence, not real provider acceptance; mobile geometry and translated-language rendering were not checked in this batch.

## HTTP failure switching parity — 2026-09-25

- Ported Python `classify_upstream_http` billing markers and status rules into an isolated classifier; 429 remains retryable but never classified as immediate fatal cooldown, even when its body reports insufficient quota/balance.
- Service now switches candidates for 401/402/403, explicit billing errors, 408/429 and 5xx before a successful response is emitted, subject to the existing three-attempt cap and request cancellation. Transport exceptions and final HTTP mapping are unchanged and listed as remaining parity work.
- Added 16 checks: classifier semantics; nine retry statuses with attempt history and single settlement; ordinary 400/404/422 not retried; billing attempts capped at three; truncated SSE never switches to another candidate. These use local fixture upstreams and the isolated test database.
- Full validation: API 473 passed, 2 skipped, 180 TODO; web 46 passed; gateway gate 265 passed, 180 TODO. Typecheck, scoped lint, API/web builds and fresh bootstrap checks passed. Existing frontend bundle warnings remain. No schema change, production requests, commit, push or release in this batch.
- P2 is not complete: see scheduling-parity.md for persistent health/cooldown, stale observations, selection, account leases, personal channels and provider probe gaps.

## Persistent upstream health — 2026-09-25

- Migration 0005 adds shared upstream health status, consecutive failure count, cooldown deadline, observation timestamp and sanitized error. HTTP failure classification now updates health; completed JSON/SSE success resets it. Candidate queries exclude active cooldown and allow expired cooldown.
- Immediate credential failures cool for 1800 seconds; ordinary hard failures cool for 60 seconds after three observations. Switching/429 observations are soft unless classified fatal. Updates are single atomic SQL statements, with attempt-start timestamps rejecting stale observations; equal timestamps conservatively favor failures.
- Three added integration checks verify concurrent failure accumulation, soft-limit behavior, stale success/failure exclusion, cooldown expiry, successful reset and persisted HTTP-fatal gating on the next request. Model calls use local fixtures only.
- Development DB migrated from 0004 (record 5) to 0005 (record 6, 1790346880098); all five columns verified through information_schema. Fresh database bootstrap and migration chain passed.
- Full suite: API 476 passed, 2 skipped, 180 TODO; web 46 passed. Initial gate found three timestamp-style lint failures; after replacing those calls with the project serializer, gateway gate passed 268 tests with 180 TODO, TypeScript and API build passed. Full web build passed before that backend-only correction. Existing frontend size warnings remain.
- No commit/push/release or production writes. P2 remains open: provider probes, account concurrency leases, in-flight candidate revalidation, all-cold diagnostics, health UI and full credential-pool domain migration are still pending.

## Candidate refresh before I/O — 2026-09-25

- Re-read the selected route/account after quota reservation and before constructing upstream headers/body. Disabled or cooling candidates are skipped; updated credentials/protocol are used. This closes a stale-snapshot window but is not an atomic lease and does not cancel already running requests.
- When enabled routes exist but all accounts are cooling, return 503 upstream_unavailable instead of 404 model_not_found. Cooldown retry-time diagnostics remain pending.
- Regression disables accounts inside reservation and verifies zero upstream calls and a settled error request. Fatal cooldown regression now verifies 503 on the next request. Retry fixtures use separate accounts for credential failures and billing exhaustion instead of duplicated routes to the same account.
- Focused gateway suite: 45 passed. After correcting the test spy's explicit TypeScript this annotation, typecheck, gateway lint/gate (269 passed, 180 TODO), migration/bootstrap checks and API/web builds passed. Existing frontend warnings remain. No schema change or production traffic in this batch; broader unchanged admin/web tests were not rerun.

## Account concurrency leases — 2026-09-25

- Migration 0006 adds configurable account concurrency (API schema default 10) and indexed database leases. Short transactions lock route/account, validate enabled/cooldown/capacity, remove expired account leases and insert a request-owned lease. No transaction spans provider I/O. Account updates after acquisition affect later acquisitions, not already leased traffic.
- Settlement releases leases before persistence, covering JSON/SSE success/error/cancellation paths; HTTP retry releases before the next candidate. Expiry uses original request hard timeout plus 60 seconds, and reclamation occurs on the next acquisition. Candidate skips no longer consume the three-send cap. No upstream send settles zero input/output instead of charging prompt estimates.
- Added database competition across two repository instances, expiry recovery, repeated release, normal/error release and saturated-first-three/fourth-route success checks. Existing stream cancellation and settlement-failure matrix tests also pass with the integrated lease path, but process-kill acceptance is still pending.
- Actual dev migration: 0005 record 6 -> 0006 record 7 (1790347216403). Verified lease table, account/expiry index and both cascading foreign keys. Fresh bootstrap passes.
- Full run before the final unsent-usage correction: API 479 passed, 2 skipped, 180 TODO; web 46 passed, builds passed. Final code: typecheck, scoped lint, gateway gate 272 passed with 180 TODO, and API build passed. The final gate includes the added saturated-route case and zero-usage assertion. Existing web size warnings remain.
- No production calls, commit, push or release. Account settings UI, account RPM/budgets, affinity and real process-crash recovery remain open.

## Account health/configuration UI — 2026-09-25

- Model-service table shows health, concurrency, active cooldown deadline and expandable sanitized last error. Expired cooldown is labeled awaiting recovery verification, not healthy. State is recomputed when rendered/refreshed; no polling/probe behavior is implied.
- Add/edit dialog configures concurrency 1–1000, default 10. Fixed service persistence omission: the already validated concurrency_limit is now passed to repository save. API regression verifies changing to 2 persists without returning the secret.
- Web suite 46 passed plus 2 new focused health-state tests passed; focused gateway suite 49 passed. Typecheck and API/web builds passed with existing frontend size warnings. Browser DOM/interaction check on local Chrome verified new columns, add form default 10 and cancel; nonempty health-row geometry/mobile/translated rendering were not checked in this batch.
- No schema change, production calls or release. Health data remains request-observed until provider probing is implemented.

## Weighted account ordering — 2026-09-25

- Added account weight, management form/table and save validation/persistence. Runtime weighted sampling stays within route priority and does not bypass authorization/cooldown/leases. Duplicate routes to the same account share their random sample.
- Four algorithm checks cover proportional sampling with a seeded 10k experiment, priority dominance, no duplication, stable removal/order, one Python-computed SHA256 rendezvous example and duplicate-route sample sharing. Rendezvous is a reusable function only; persistent session affinity is not yet wired.
- Actual development migration 0006 record 7 -> 0007 record 8 (1790347555377); weight column default 1 verified. Bootstrap gate passed. UI weight rendering has not had a browser check in this batch.
- Initial runtime test caught Node crypto randomInt's exclusive range bound; corrected. An overlapping test invocation then caused test-database fixture conflict; both runs ended before the clean serial validation. Clean run: API 484 passed, 2 skipped, 180 TODO; web 48 passed; gateway gate 276 passed, 180 TODO; builds and TypeScript passed. Final duplicate-route check was added afterward and all 4 selection tests plus TypeScript/diff checks passed. Existing frontend warnings remain.
- No production calls or release. Session binding/TTL/rebinding/load balancing remain required, along with account budget and the wider migration plan.

## Persistent explicit-session affinity — 2026-09-25

- Runtime now uses explicit Python-compatible header/body session identifiers to derive owner/model/session HMAC scope. No prompt-derived binding and no plaintext session ID persistence. Active bindings are preferred; initial selection uses weighted rendezvous.
- Binding creation and account lease acquisition share one short transaction with a scope advisory lock. First writer wins; scope TTL is one hour, renewed below half remaining. HTTP retryable failure invalidates the matching account binding before fallback; account enable/cooldown/capacity gates remain.
- Tests cover header precedence, legacy body aliases, owner/model isolation, no prompt-based affinity, repeated request binding, 401 fallback/rebind, concurrent repository first writers, expiry replacement, sliding renewal and stale account invalidation preserving the new binding. Local fixture upstreams only.
- Dev database migrated from 0007 record 8 to 0008 record 9 (1790347824957); table, expiry index and owner/account cascading foreign keys verified. Full suite API 489 passed, 2 skipped, 180 TODO; web 48 passed; gateway gate 281 passed, 180 TODO. TypeScript, scoped lint, fresh bootstrap and API/web builds passed; existing frontend warnings remain.
- No production traffic, commit, push or release. Load-aware initial assignment, configuration, global retention, network rebinding and the broader P2/P3 work remain open; this does not certify final migration parity.

## Transient connection fallback — 2026-09-25

- Added bounded cause-chain classification for Node transient socket/DNS/connect-timeout errors. Pre-response failures can invalidate matching session bindings, update health, release leases and use another candidate within the existing send cap. Cancellation/deadline and unclassified policy/certificate errors do not switch. No retry occurs after response handling has begun.
- Regression exposed cleanup aborting the controller before reading its state, which made ordinary transport errors become 504. The handler now captures the original abort state before cleanup. Ordinary failures return 502; cancellation/deadline returns 504.
- New tests cover cause cycles/abort/certificate exclusion, session rebind after a mocked reset followed by real local-fixture HTTP, policy-error no-retry, caller cancellation racing with reset, and lease cleanup. No real model requests.
- Final serial validation: API 493 passed, 2 skipped, 180 TODO; web 48 passed; gateway gate 285 passed, 180 TODO; typecheck, scoped lint and API/web builds passed. Existing frontend size warnings remain. No schema change, production write, commit, push or release.

## Initial session load balancing — 2026-09-25

- Added model-global active-binding counts and account-wide active lease counts to initial session selection. Python smooth weighted score and equal-score rotation are applied within Node route-priority buckets; duplicate routes are grouped by account. Existing eligible bindings remain first. Unbound requests use only active leases, retaining weighted random order when no work is active.
- Added score/priority/tie-order unit checks and local HTTP integration: four sequential new sessions split 2:2 across equal-weight accounts, then reuse of an existing session leaves binding counts unchanged. Snapshot load reads are not a globally serialized pool selector; cross-process burst distribution is still unverified. Hard capacity continues to use atomic leases.
- Validation: API 496 passed, 2 skipped, 180 TODO; web 48 passed; gateway gate 288 passed, 180 TODO. TypeScript, scoped lint, fresh bootstrap and API/web builds passed. Existing frontend size warnings remain. No schema migration, production requests, commit, push or release.

## Shared user budget reservation — 2026-09-25

- Migration 0009 adds optional owner-level daily token/concurrency/RPM limits. Reservation locks the owner policy after its key and aggregates all owner keys before inserting a request, preventing multi-key races. Defaults are zero additional user caps, preserving existing behavior; key limits remain enforced.
- GET/PUT user-limit admin endpoints require system_users/system_users_edit respectively under existing console authentication/CSRF. Gateway bearer access cannot alter policy. Actual settlement replaces reserved usage using the existing ledger.
- Four regression cases cover separate-key concurrent races for each limit, actual settlement allowing a later reservation, and rejected gateway-bearer mutation. These are isolated database/repository concurrency checks, not multi-process deployment acceptance.
- Development database migrated 0008 record 9 -> 0009 record 10 (1790348467498); columns, zero defaults, owner primary key and cascading FK verified. Full validation: API 500 passed, 2 skipped, 180 TODO; web 48 passed; gateway gate 292 passed, 180 TODO. TypeScript, scoped lint, fresh bootstrap and builds passed; existing frontend warnings remain.
- User-limit UI, remaining-quota presentation and rollover/recovery acceptance remain pending. No production requests, commit, push or release.


## User-limit administration form — 2026-09-25

User management now exposes an RBAC-gated gateway-limits dialog for daily tokens, concurrency and RPM across all keys owned by a user. The form documents UTC reset and zero semantics and keeps edits on save failure. English and Japanese translations are included. Three focused component tests verify numeric/zero submission, load-failure behavior and fractional validation with save-failure preservation; the web suite passes 51 tests and the production build passes (existing chunk warnings remain). This slice changes no database schema. Live browser inspection reached an expired login session, so authenticated visual acceptance is still pending. Changes remain local and unpublished; this is not final migration acceptance.


## UTC quota boundary correction — 2026-09-25

Fixed key-level rolling RPM dropping prior-day completed requests immediately after midnight. Key and shared-user daily totals exclude prior-day completed usage while retaining all outstanding reservations. Admission now samples the database clock after acquiring key/owner locks; both checks and the inserted created_at use that same instant rather than transaction-start time. A protected clock expression enables deterministic real-PostgreSQL boundary tests without changing host/database clocks.

Four new regression cases cover both scopes at 00:00:10 UTC, the 60-second RPM boundary, outstanding prior-day reservations, settlement and current-day reservations. pnpm typecheck, pnpm test (API 504 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway (296 passed, 180 TODO, migration/bootstrap checks) all pass. Existing build chunk warnings remain. No schema change or production write. Actual lock-wait midnight/recovery and full legacy parity remain unverified; changes are local and unpublished.


## Recovery-probe API slice — 2026-09-25

Added administrator-triggered saved-account recovery discovery with bounded GET transport, no redirect following, existing network restrictions and protocol-specific verification. OpenAI/Responses nonempty model lists may clear cooldown; Anthropic discovery only returns models and never verifies Messages health. Failed recovery probes are soft observations. Observation ordering plus credential/base/protocol/enabled guards prevent stale probe writes after account edits or newer traffic observations. See recovery-probes.md for endpoint semantics and the distinction from legacy manual hard-failure checks.

Added 11 tests using mock HTTP and isolated PostgreSQL. pnpm typecheck, pnpm test (API 515 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway (307 passed, 180 TODO plus migration/bootstrap) pass. No schema or production change, no real model calls, no publish. Periodic probing, durable claims/quiet windows, last-checked metadata, UI and provider-specific/legacy checks remain pending; P2 is not complete.


## Durable recovery worker — 2026-09-25

Manual/periodic probes now share database claims, 60-second lease expiry and fenced completion; stored last-start/outcome/latency supports diagnosis. The opt-in standalone worker scans five nonhealthy enabled accounts per minute with a ten-minute per-account quiet window. It prevents local overlapping batches and drains only its current probe on shutdown. Candidate claims recheck eligibility. API responses omit internal claim tokens. See recovery-probes.md for enablement and restart behavior.

Applied migration 0010_gateway_probe_claims to isolated coati_node_dev: prior ledger id 10 / 1790348467498, new head id 11 / 1790349444695. Verified all five new columns with psql. Database tests cover competing repository/service instances, lease expiry, old-token fencing, quiet-window expiry, newer traffic observations and configuration changes; runner tests cover no overlap, shutdown and retry after candidate-query failure. pnpm typecheck, pnpm test (API 520 passed, 2 skipped, 180 TODO; web 51 passed), pnpm build and pnpm verify:gateway pass, including fresh bootstrap. No production/provider traffic or publication. Actual OS process-kill acceptance, compose worker wiring, UI and provider-specific/legacy parity remain outstanding.


## Recovery console and Compose wiring — 2026-09-25

Added the RBAC-gated recovery action to model-service rows with separate discovery/recovery result wording and success/failure refresh. Added optional Compose recovery profile: worker shares API configuration, waits for healthy initialized API, exposes no port and replaces the HTTP entrypoint/healthcheck. Documentation describes enablement and explicit stopping. Fixture-only docker compose config JSON confirms the wiring; no containers were started and no provider was called. Web suite 54 tests and build pass; authenticated browser and actual container acceptance remain pending. This slice has no backend/schema changes and remains unpublished.

Scoped lint passes for the new probe component/test. Including ResourcePage surfaces its existing react-hooks/set-state-in-effect violation at the initial load effect; this check is not reported as fully green. The probe test was rerun with explicit i18n initialization and passes without the missing-instance warning.


## Isolated Docker deployment and worker crash check — 2026-09-25

Built the current checkout using the repository Dockerfile as coati-node:recovery-validation. Started project coati-recovery-validation with its own PostgreSQL/app volumes, random disposable credentials and loopback port 18084. The default entrypoint initialized an empty production-configured database to all 11 migrations (head timestamp 1790349444695). API /health reported database connected; the recovery worker started only after API health passed. No existing deployment or developer database was used.

Added a temporary internal mock HTTP service, explicitly allowed private upstreams only in this disposable environment, and verified admin login/session/CSRF, creation of an encrypted saved credential, model discovery, health restoration and claim release through the built API. The model endpoint was a local fixture, not a real supplier.

For actual process recovery, changed the fixture to a ten-second model response, started a fresh probe, observed its persisted running claim, sent SIGKILL to the worker container and confirmed the claim survived. Advanced only the disposable probe_expires_at and last_probe_at timestamps to simulate lease/quiet-window expiry, restarted the worker, and verified the account became healthy with last_probe_status=verified and probe_token=NULL. This proves built-worker restart/reclaim behavior with a real killed process; it does not prove ten minutes of wall-clock waiting or high-load/cross-host failover.

Removed this test project's containers, network, volumes and temporary credential/configuration files after validation. The locally tagged build image remains available for repeat checks; nothing was published. Remaining acceptance includes authenticated visual QA, provider-specific and legacy check parity, real SDK/provider authorization, full data migration and upgrade/rollback.


## Personal key edit API — 2026-09-25

Added owner-scoped console PUT /api/admin/gateway/keys/:id with existing gateway_keys_edit permission and CSRF. It mirrors Python's valid-personal-key rules, supports 1–3650-day expiry or null/omitted for no expiry, locks before state/time validation, rejects revoked/expired/nonpersonal keys and keeps credential/scopes/limits/ledger unchanged. Unknown privilege fields are rejected. See key-lifecycle.md for scope and remaining creation/rotation/PAT/UI work.

Five added database/API tests pass. Full checks: typecheck; API 525 passed, 2 skipped, 180 TODO; web 54 passed; build; gateway gate 317 passed, 180 TODO including migration/bootstrap. No new schema or production writes. Changes remain local/unpublished; full key lifecycle parity is not claimed.


## Replacement-key rotation and quota continuity — 2026-09-25

Added owner-scoped POST /api/admin/gateway/keys/:id/rotate with console/CSRF and independent gateway_keys_rotate permission (incremental seed applied, English/Japanese menu catalogs updated). Rotation locks the original, inserts a replacement with copied policy/expiry, and revokes the old record in one transaction. Raw replacement tokens appear only in that response. A quota_group UUID and rotated_from_id history preserve per-key daily/RPM/concurrency across rotations while leaving independent keys separate; shared-user limits continue aggregating all keys.

Applied migration 0011_gateway_key_rotation to isolated coati_node_dev: prior head ledger 11 / 1790349444695, new head 12 / 1790350386740. Verified both columns, UUID default, lineage FK and group index using psql. Seven new regressions prove competing rotations, immediate old-token rejection, owner/expiry guards, all three quota types, in-flight settlement, repeated lineage, independent-key isolation and insertion rollback. Full checks pass: typecheck; API 532 passed, 2 skipped, 180 TODO; web 54 passed; build; gateway gate 324 passed, 180 TODO with fresh bootstrap. No production traffic or publication. Native console forms and legacy PAT/create compatibility remain outstanding; this is not full migration acceptance.


## Native key lifecycle console — 2026-09-25

Added permission-gated edit and rotation actions to the access-key list. Edit requires explicit new expiry; rotation confirms old-token invalidation and delivers the replacement to the existing one-time token dialog. Inactive keys cannot invoke actions and device keys cannot use the personal edit form. Fixed the new selector's uncontrolled transition and kept expiry-clock updates outside rendering. Web suite 57 tests, production build and new-component/test lint pass. ResourcePage's previously recorded load-effect lint issue is unchanged; authenticated visual acceptance is pending. No backend/schema change in this slice; changes remain local/unpublished.


## Legacy PAT scope prerequisite — 2026-09-25

Python PAT inspection found independent chat/profile scopes missing from Node keys. Added persisted scopes, restricted creation validation, model-call/discovery enforcement, rotation preservation and locked reservation-time scope/model rechecks. Profile-only keys cannot cause upstream calls or quota reservations. This is the authorization prerequisite for legacy PAT adaptation; the legacy endpoints/profile API and metadata remain open.

Applied migration 0012_gateway_key_scopes to coati_node_dev: prior ledger 12 / 1790350386740, head 13 / 1790350828064. Verified NOT NULL JSONB scopes with chat/profile default. Three added regression cases pass. Full checks pass: typecheck; API 535 passed, 2 skipped, 180 TODO; web 57 passed; build; gateway gate 327 passed, 180 TODO with fresh bootstrap. No production/provider traffic or publication. Existing creation defaults and full legacy shape still need migration.


## Python business-day timezone correction — 2026-09-25

Inspection for /api/agent/me found Python local_day_start_utc uses AGENT_TIMEZONE with Asia/Shanghai default, while Node admission/overview incorrectly fixed UTC. Corrected both owner/key quota day boundaries and overview aggregation to configured PostgreSQL business midnight; invalid timezone names fall back to Asia/Shanghai. Existing UTC cases now explicitly select UTC. Overview returns effective timezone, console copy no longer claims UTC, env examples and Compose pass the setting to API/worker. This supersedes earlier fixed-UTC default descriptions; preserve the source deployment timezone during migration.

Five new cases cover fallback/explicit UTC plus both key and user budgets at Shanghai midnight and New York's spring DST transition. Full checks pass: typecheck; API 540 passed, 2 skipped, 180 TODO; web 57 passed; build; gateway gate 332 passed, 180 TODO. Compose JSON confirms explicit UTC propagation. No schema/production change or publication. Profile response and default-quota policy remain pending; implementing a superficially matching /me response before fixing its accounting semantics was deferred.


## Default user policy and legacy profile — 2026-09-25

Added AGENT_DAILY_TOKEN_QUOTA with fail-closed integer validation; nullable daily_limit means inherit, explicit zero remains unlimited. Admission and quota summary share this policy. Existing preview numeric rows are preserved (including earlier automatic zero rows whose intent is unknowable); an administrator must explicitly clear them to adopt a nonzero default. The user-limit form accepts that clear operation. Added /api/agent/me with safe role/menu user serialization, profile-scope enforcement, settled daily quota fields, Bearer/X-Api-Key/Api-Key extraction and legacy missing/invalid/scope error shapes. PAT CRUD adapters remain pending.

Applied migration 0013_gateway_default_quota to coati_node_dev: prior ledger 13 / 1790350828064, head 14 / 1790351294575. Verified daily_limit is nullable with no default. Added default/zero/null admission tests, profile/auth contract tests, config validation and a UI inheritance test. Checks pass: typecheck; API 544 passed, 2 skipped, 180 TODO; web 58 passed; build; gateway gate 336 passed, 180 TODO including bootstrap. No production/provider traffic or publication. The first full run caught missing error translations; the corrected full rerun passed.


## Legacy PAT CRUD/list and metadata — 2026-09-26

Added console-session/CSRF legacy PAT creation/list/update/rotation/revocation routes, legacy metadata serialization, scoped search/filter/pagination and settled seven-day statistics. Creation defaults to unlimited expiry and no additional per-key caps; user/account limits continue applying. Notes survive rotation, revocation timestamps are stable across repeated deletion, and successful bearer authentication tracks last use best-effort. Existing unknown metadata remains null. See key-lifecycle.md for incomplete normalization/error/permission-import parity and the still-missing PAT usage endpoint.

Applied 0014_gateway_pat_metadata to isolated coati_node_dev: prior ledger 14 / 1790351294575, head 15 / 1790351644509. Verified nullable note, revoked_at and last_used_at columns using psql. Three new API/database regressions cover metadata/defaults/rotation/history, seven-day reservation exclusion and owner isolation, plus bearer-only/invalid-scope rejection. Typecheck, API 547 passed (2 skipped, 180 TODO), web 58 passed, production build and gateway gate 339 passed (180 TODO, migration/bootstrap included) all pass. git diff --check is clean. Changes remain local/uncommitted/unpublished; no real provider or production writes. Full migration is still in progress.


## Cache miss accounting prerequisite — 2026-09-26

PAT usage comparison exposed a missing Python ledger dimension: cache_miss_tokens. Migration 0015 adds nullable cache_miss_tokens and cache_miss_source. Explicit reported counters (including zero) win; with a reported cache dimension, OpenAI/Responses derive uncached input as total minus cache reads/writes, while Anthropic uses its disjoint input count. Absent dimensions and contradictory negative remainders remain unknown. Derived counters do not add to billed totals. Conversions preserve miss count/source, repeated SSE usage snapshots recompute derived values without summing counters, and the console labels derived values. Historical rows remain null; no fabricated backfill. Provider-specific aliases beyond the supported spellings still require the full adapter parity audit.

Applied to isolated coati_node_dev: prior ledger 15 / 1790351644509, head 16 / 1790352107074. Verified both nullable columns through psql. Added 11 normalization/conversion/snapshot tests and one UI test; extended all existing three-protocol JSON/SSE accounting matrix cases to assert persisted miss count/source. Typecheck, API 558 passed (2 skipped, 180 TODO), web 59 passed, production build, scoped usage/UI lint and gateway gate 350 passed (180 TODO, fresh migration/bootstrap included) all pass. This is a prerequisite fix; the PAT usage endpoint itself remains pending along with request-context metadata capture and legacy personal-response redaction. No production calls or publication.


## PAT usage and safe context recording — 2026-09-26

Implemented owner-scoped GET /api/agent/auth/pat/:id/usage with pagination, time/model/status filters, explicit reservation visibility, historical rotation records and personal field projection. Added context shape/trace capture without storing prompt/tool-result bodies, HMAC log correlation independent of session affinity, and legacy fallback-trace redaction. See key-lifecycle.md for implemented contract and explicit remaining UUID/event-ID, parent lineage, detailed error classification, final HTTP status and normalization/import differences.

Applied 0016_gateway_request_context to isolated coati_node_dev: prior ledger 16 / 1790352107074, head 17 / 1790352322878; verified nullable JSONB request_context via psql. Three context unit cases and two database/API cases added. First full test run exposed Drizzle stripping correlation qualifiers in raw SELECT subqueries; explicitly qualified static SQL fixed the request-id/attempt-id comparison and focused rerun passed. Corrected full suite: API 563 passed, 2 skipped, 180 TODO; web 59 passed. Typecheck, production build, scoped new-module lint and gateway gate (355 passed, 180 TODO, fresh migration/bootstrap included) pass. Changes remain local/unpublished, with no provider or production calls.

Follow-up audit item: legacy PAT seven-day token statistics currently sum every nonreserved Node row; Python sums only billable ok/stream_error/client_error rows. Align this alongside richer execution status capture rather than treating all settled failures as billable.


## Consistent billable-status aggregation — 2026-09-26

Corrected the preceding PAT statistics audit item across all consumers, not only that endpoint. A shared billable predicate now drives PAT seven-day token totals, settled user quota summaries, owner/key-group admission accounting and overview totals. Nonbillable failures retain logs and RPM impact but no longer consume daily token budgets; partial stream/client output remains billable. Active reservations still consume admission capacity without appearing in settled totals. Existing provisional interrupted-worker charging is unchanged and remains an explicitly documented recovery-parity acceptance item.

Two real-database regressions exercise both user and key quota paths across ten statuses, deliberately large nonbillable estimates, per-PAT/overview/profile consistency, exact remaining-budget admission and outstanding reservation exclusion from settled totals. Checks pass: typecheck; API 565 passed, 2 skipped, 180 TODO; web 59 passed; build; gateway gate 357 passed, 180 TODO including migration/bootstrap; git diff --check. No schema change, production traffic or publication. Next: execution failure categories/final HTTP status and admission-failure ledger capture, then remaining source behavior gaps.


## Execution status and downstream HTTP evidence — 2026-09-26

Replaced new generic error/cancelled execution records with explicit upstream_error/protocol_error/routing_error/client_error categories while retaining stream_error. Added nullable request-level http_status, separate from each attempt's upstream status. PAT usage uses this final gateway status and no longer guesses old-row values from attempts. Started streams record HTTP 200 even when later failing; pre-response client cancellation remains unknown. Updated console labels/detail and English/Japanese translations. Legacy aliases remain supported without rewriting historical rows.

Applied 0017_gateway_http_status to isolated coati_node_dev: prior ledger 17 / 1790352322878, head 18 / 1790352901277; verified nullable integer http_status using psql. Four new API/database cases distinguish upstream 401/429/503 from final gateway responses and cover stream failure/unknown historical values. Existing routing, cancellation and matrix assertions now verify canonical categories. Typecheck, API 569 passed (2 skipped, 180 TODO), web 59 passed, build and gateway gate 361 passed (180 TODO, migration/bootstrap included) pass. No production/provider traffic or publication. Pre-reservation failure ledger capture, recovery parity and server-tool lineage remain pending.


## Correlated pre-admission rejection records — 2026-09-26

Added zero-charge, nonreserved ledger rows for known routing/cooldown, protocol/stateful-option and admission-limit refusals. Responses share their request ID with the persisted record; execution errors now do likewise. Rejected records have no upstream attempts, no active concurrency ownership and no recoverable reservation. Recording failure is reported without changing refusal or invoking an upstream. Authentication/scope/model-grant/schema failures remain outside this model-request ledger.

Five added API/database tests cover no-route/cooldown/quota/stateful rejection and unavailable logging persistence; the conversion matrix's unsupported-parameter test now verifies a zero-charge protocol-error row instead of expecting no audit evidence. Checks pass: typecheck; API 574 passed (2 skipped, 180 TODO); web 59 passed; build; gateway gate 366 passed (180 TODO, migration/bootstrap included); git diff --check. No schema change or production/provider calls; changes remain local/unpublished. Next work returns to remaining protocol-matrix acceptance obligations; these checks do not establish final migration readiness.


## Cache usage wire acceptance and unknown-counter correction — 2026-09-26

Added 54 full-matrix JSON/SSE cases covering complete cache/reasoning/TTL details, explicitly reported zero and absent usage. They assert both persisted counters and client-visible totals/details. Replaced the 18 usage-cache TODO obligations with these tests, leaving 162 other obligations. Tests exposed synthetic cache zeros in three conversion paths and synthetic Anthropic start totals; runtime wire output now uses actual normalized upstream snapshots rather than merging in legacy-fabricated values. Pure Python parity fixtures remain unchanged; the explicit runtime behavior correction is documented in protocol-contract.md.

The initial zero-profile failure was a mock's hardcoded Anthropic final output count, corrected to use the selected profile. Actual unknown-cache failures then reproduced and were fixed. Final full checks: API 628 passed, 2 skipped, 162 TODO; web 59 passed; typecheck, build, scoped service/stream lint and gateway gate (420 passed, 162 TODO, migration/bootstrap included) pass. No schema change, real provider traffic or publication. Cache-control input capability policy and other protocol scenarios remain incomplete; this is not final migration acceptance.


## Actual client-tool roundtrip matrix — 2026-09-26

Added 18 two-request roundtrips across all nine protocol pairs and JSON/SSE modes. Each case parses the first actual wire tool call (stream argument fragments where applicable), constructs the follow-up from that ID/name/arguments and verifies the mock upstream receives correctly linked call/result history. Both turns must have independently settled usage. Replaced the 18 tool-roundtrip TODOs, leaving 144; parallel tools and other tool capabilities remain explicitly unaccepted.

Focused matrix: 166 tests pass. Full typecheck, API 646 passed (2 skipped, 144 TODO), web 59 passed, build and gateway gate (438 passed, 144 TODO, migration/bootstrap included) pass. No runtime/schema change in this slice, no real provider calls or publication. The new evidence establishes single client-tool roundtrips, not server-tool execution or final migration readiness.


## Parallel tools with interleaved parameters — 2026-09-26

Added 18 full-pair/mode roundtrips using two same-name functions with distinct IDs and arguments. Parameter fragments alternate at individual-character granularity including Unicode/JSON escapes; results return in reverse order. Assertions reconstruct actual wire calls, compare both complete upstream histories and per-ID results, and require two independently settled request rows. All 184 focused matrix tests pass. The 18 parallel-tools TODOs are replaced by these cases, leaving 126.

Full typecheck, API 664 passed (2 skipped, 126 TODO), web 59 passed, build and gateway gate (456 passed, 126 TODO, migration/bootstrap included) pass. No runtime/schema change, live provider calls or publication. This establishes valid parallel client-tool conversion, not malformed-call handling, strict tool capability policy, server tools or final migration readiness.


## Settlement confirmation and no error-path rewrite — 2026-09-26

Full-matrix settlement testing found that a first-write exception could be followed by a successful error-handler update, converting generated usage into an unbilled upstream_error. Added a per-request failed-settlement guard, safe settlement_failed errors, and an exactly-one-updated-row check. JSON success and SSE successful terminals remain withheld when persistence cannot be confirmed; subsequent error/finally paths cannot rewrite the ledger. Upstream leases are released independently, while the simulated pre-write failures retain reservations for recovery. Ambiguous commits preserve whatever state actually persisted rather than forcing a rollback assertion.

Added 36 real-handler fault cases (nine pairs x JSON/SSE x exception/zero-row update), with only the first database call faulted to expose unintended retries. Tests check one attempted update, no fabricated success, correlated request IDs, no private error leakage, retained reservations and lease release. Replaced 18 settlement-failure TODOs, leaving 108. Typecheck, API 700 passed (2 skipped, 108 TODO), web 59 passed, build, scoped service/stream lint and gateway gate (492 passed, 108 TODO, migration/bootstrap included) pass. No schema change, production/provider calls or publication. Recovery reconciliation and remaining compatibility scope are still open.


## Truncated response audit and matrix acceptance — 2026-09-26

Added 18 all-pair JSON/SSE truncation tests with a configured backup: invalid partial JSON and missing SSE source terminals cannot produce success, do not trigger another account call, retain correlated request errors, record exactly one upstream attempt and release the lease. Initial focused tests exposed missing JSON attempt records in all nine JSON directions. Bounded read/parse/object validation/usage observation failures now record safe attempt diagnostics before propagating; no parser body excerpts are stored.

The 18 truncated-stream obligations are replaced by these real tests, leaving 90 matrix TODOs. The first full run passed functional cases but caught a missing translation for the new diagnostic; English/Japanese entries were added before rerunning validation. Corrected full run: API 718 passed (2 skipped, 90 TODO), web 59 passed; typecheck, build, scoped service lint and gateway gate (510 passed, 90 TODO, migration/bootstrap included) pass. No schema change, real provider calls or publication. Cancellation, slow-client behavior and other protocol/capability work remain open.


## Live HTTP cancellation across all pairs — 2026-09-26

Added 18 real-client JSON/SSE cancellation cases across nine protocol pairs. The JSON fixture leaves a body incomplete; SSE remains open after initial content. Tests cancel at those distinct stages and await upstream closure plus client_error settlement, checking one upstream request, no active reservation/account lease, and null-versus-200 HTTP evidence. The focused cases all pass; replaced 18 cancel TODOs, leaving 72. No runtime/schema change was needed.

Full typecheck, API 736 passed (2 skipped, 72 TODO), web 59 passed, build and gateway gate (528 passed, 72 TODO, migration/bootstrap included) pass. No production/provider calls or publication. Remaining matrix categories are image, reasoning, unsupported-field and slow-client, in addition to broader migration/acceptance work.


## Ordinary image transport baseline — 2026-09-26

Added 18 nine-pair JSON/SSE cases with URL and base64 PNG input. Tests verify exact image representation/order at the mock upstream, no gateway fetch of a local image URL, one model request, correct image_count and no raw URL/base64 persisted in context. Source comparison identified the missing coati-auto vision_model target selection; documented its Python detection rules and 503 behavior in protocol-contract.md. Ordinary Python routes do not enforce mandatory vision declarations, so the earlier draft must not invent that as migration behavior.

Focused 18 cases and full API 754 passed (2 skipped, 72 TODO), web 59 passed, typecheck, build and gateway gate (546 passed, 72 TODO, migration/bootstrap included) pass. Image TODOs remain open for automatic routing and type/size policy acceptance. No runtime/schema change, live provider calls or publication. Next: migrate vision_model and automatic model selection with console configuration and route revalidation.


## Automatic image target routing — 2026-09-26

Migrated Python coati-auto detection and nullable per-route vision_model. Text requests select upstream_model; image requests select vision_model; normal model names ignore this override. Missing auto routes or configured image targets return 503 before upstream traffic. The management route form exposes the optional field and allows clearing it. The repository rechecks image eligibility under the route lock before creating an account lease or session binding, preventing a concurrently removed target from silently invoking a text model.

Added 12 source-derived detection cases and six API/database cases covering target selection, public alias preservation, missing configuration, route editing/clearing and removal between candidate selection and acquisition. Development database applied 0018_gateway_vision_model, verified nullable text column and 19 migration entries (latest 1790355012819). Typecheck, build and scoped backend lint pass; full API 772 passed (2 skipped, 72 TODO), web 59 passed. Gateway gate passes with 564 tests and 72 TODOs, including clean-database migration/bootstrap; git diff --check passes. Image matrix TODOs remain open for type/size policy acceptance; no provider vision support is inferred. No live supplier calls or publication.


## Image boundary and automatic matrix acceptance — 2026-09-26

Compared Python protocol_bridge image helpers, provider adapters and MAX_CONTENT_LENGTH: the legacy gateway passes through nonempty MIME/base64 strings without decoding or image-specific validation, and bounds the encoded body at the global request limit. Expanded real-handler fixtures from 18 to 54 image cases, covering all pairs/modes with PNG, automatic vision routing, and opaque MIME/data preservation. Added six exact body-byte boundary cases (configured 2048 accepted, 2049 rejected with 413 before supplier traffic/new ledger/leases). Focused 60 cases pass. Removed 18 image TODO placeholders, leaving 54 (reasoning, unsupported-field, slow-client); malformed/empty field behavior belongs to the remaining field compatibility review.

Typecheck, full API 814 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 606 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No runtime/schema change in this stage and no live supplier calls or publication. This verifies gateway image transport and selection, not real model vision quality. Next: reasoning content/signature round trips against Python, including unsigned Chat-to-Messages text representation and Responses encrypted-content handling; broad migration acceptance remains open.


## Reasoning JSON replay baseline — 2026-09-26

Added nine real-handler two-request tests: follow-up history is taken from the actual first JSON response and sent back through each protocol pair. Assertions cover thought and answer content, public model alias, supported signature/encrypted_content mapping, unsigned Chat-to-Messages text representation and two successful ledger rows. All nine focused tests pass. The audit also records two unresolved signature limitations: Python/Node Anthropic request encoding into Responses omits signatures, and the streaming Chat intermediate has no opaque signature transport. These are explicitly documented in protocol-contract.md; all 18 reasoning obligations remain open, and total matrix TODOs remain 54.

Full API 823 passed (2 skipped, 54 TODO), web 59 passed; typecheck passes. Build and gateway gate pass (615 passed, 54 TODO; clean migration/bootstrap included); git diff --check passes. No runtime/schema change, supplier traffic or publication. Next work must validate streaming reasoning and resolve the signature capability boundary before marking reasoning accepted.


## Reasoning SSE replay baseline — 2026-09-26

Added nine actual SSE handler/replay cases using one-byte transport fragmentation, including multibyte thought, answer and opaque signature text. Tests reconstruct client history from emitted deltas/terminal response items, replay it, and verify exact text, one terminal and two successful ledger rows. Native Messages/Responses preserve signature data. The tests now prove runtime cross-protocol signature loss as well as text preservation, matching the existing Python-style pipeline; this limitation is not accepted as the final capability contract. All 18 reasoning TODOs remain open (54 total).

Focused nine tests, typecheck, full API 832 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 624 passed (54 TODO, clean migration/bootstrap included) pass. git diff --check passes. No runtime/schema change, real supplier traffic or publication. Next: resolve opaque-signature handling consistently across request, JSON response and streaming conversion, with explicit capability boundaries; full migration remains incomplete.


## Messages-to-Responses stream signature fix — 2026-09-26

Implemented a direct signed-thinking path in the runtime stream bridge. Messages signature_delta fragments and initial thinking/signature fields now reach Responses encrypted_content on the corresponding completed item and final output. Sequential blocks receive separate IDs and independent text/signature buffers, including signature-only blocks. Unclosed thinking blocks cause truncated_stream even if a later message terminal arrives. This matches existing JSON mapping without inventing a Chat signature field or asserting supplier interoperability.

Updated the actual SSE matrix replay test to require signature preservation in this direction; added block/empty-summary/initial-value/missing-stop tests. Focused nine matrix tests and 17 signed-block/legacy-stream tests pass. Full typecheck, API 834 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 626 passed (54 TODO, clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. Reverse Responses-to-Messages streaming and Messages-to-Responses request signature behavior still need work; the 18 reasoning TODOs remain open and the overall migration is incomplete.


## Messages-to-Responses request signature fix — 2026-09-26

Request conversion now retains thinking.signature as reasoning.encrypted_content for each item, including empty-text signed blocks. Updated JSON wire replay assertions and added a direct multiple-block round trip, unsigned fallback and input-immutability test. This intentionally corrects Python's request omission and aligns request encoding with existing JSON response and corrected SSE mapping; no supplier signature portability is assumed. The original 88 golden cases and hash guard remain unchanged and pass because the old request samples lacked signatures.

Focused matrix/signed/golden suite: 426 passed. The first typecheck found unknown-field accesses in the new test; these were replaced with typed object/array helpers and typecheck then passed. Full API 835 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 627 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No schema change, live supplier traffic or publication. Reverse Responses-to-Messages streaming remains unresolved; reasoning TODOs and broader migration acceptance remain open.


## Responses-to-Messages stream signature fix — 2026-09-26

Runtime stream conversion now emits completed Responses reasoning items directly as signed Messages thinking blocks or unsigned text blocks, bypassing the lossy Chat intermediate. Item completion retains encrypted_content; final output supplies items not completed earlier and does not duplicate completed identities. Pending reasoning absent from final output raises truncated_stream. Startup still uses the ordinary usage-normalizing path so missing initial usage is not changed into zero.

Updated all-pair SSE replay to require signature preservation across both Messages/Responses directions. Added multiple-item, signature-only, unsigned, duplicate-completion, terminal-only completion and missing-item tests. Focused nine matrix tests and 21 signed/legacy stream tests pass. Typecheck, API 838 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 630 passed (54 TODO, clean migration/bootstrap included) pass; git diff --check passes. No schema change, supplier traffic or publication. Mixed-content ordering with delayed reasoning completion, conflicting completion data and block/index edge cases remain to audit before closing reasoning obligations; overall migration remains incomplete.


## Reasoning completion conflict protection — 2026-09-26

Responses-to-Messages streaming now compares repeated completions against the emitted text/signature and verifies item identity for each output index. Conflicting text, removed/changed opaque data or a reassigned identity raises an internal invalid_response with a safe diagnostic. The external handler keeps its stream_error envelope, withholds message_stop, records stream_error, makes one supplier call and releases the account lease. Index-only reasoning events resolve through the announced item alias.

Added four focused content/signature/identity/index tests and one actual API error/ledger/lease case. Initial test issues were corrected: the fixture's shared item/final object needed independent cloning, and the API assertion needed the established stream_error code rather than the internal code. Retest: 345 passed. Typecheck, full API 843 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 635 passed (54 TODO; clean migration/bootstrap included) pass. git diff --check passes. No schema change, real supplier calls or publication. Mixed-content order and interleaved block boundaries remain open; all reasoning obligations and full migration goal remain active.


## Delayed reasoning/content ordering fix — 2026-09-26

Added a bounded ordering layer for Responses-to-Messages streams. Later text/tool frames wait behind an announced reasoning item until item completion or final output supplies its signature-bearing content. Completed reasoning is emitted before queued later content, preserving source order without manufacturing signatures. Original bytes are counted before buffering against the 16 MiB cap; synthesized completions do not consume the supplier-byte allowance a second time. Missing completions still fail and consumed queued frames are released.

Added delayed-item and terminal-only completion order tests, two actual handler/ledger cases, a thought/text/tool case preserving tool ID/arguments, and a bounded unresolved-item test. Focused matrix/signed suite: 351 passed. Typecheck, full API 849 passed (2 skipped, 54 TODO), web 59 passed, build and gateway gate 641 passed (54 TODO; clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. Interleaved Messages reasoning blocks and final unsupported-capability behavior remain open; full migration goal is not complete.


## Interleaved Messages thinking fix — 2026-09-26

Added a bounded Messages thinking-order layer for the Responses target. Active-block deltas stream immediately; other blocks wait and then drain by source thinking index, keeping each block's text/signature separate when later blocks stop first. Unknown or late signature fragments, duplicate thinking starts and invalid thinking indexes fail explicitly. Native same-protocol paths are unaffected. Byte counting occurs before buffering and preserves the 16 MiB limit.

Added interleaved-two-block/text and malformed lifecycle tests, plus actual gateway success/failure ledger and lease checks. Initial focused suite: 355 passed. Full validation exposed a new fixture mode not wired into the upstream handler; fixed that test setup, and the gateway gate then passed 647 tests (54 TODO, clean migration/bootstrap included). Typecheck and build pass. Corrected full rerun: API 855 passed (2 skipped, 54 TODO), web 59 passed; git diff --check passes. No schema change, real supplier traffic or publication. Final opaque-content/unsupported-capability rules remain open; all reasoning TODOs and the broad migration goal remain active.


## Redacted thinking explicit boundary — 2026-09-26

The runtime bridge rejects Messages redacted_thinking on cross-protocol requests/responses/SSE, while native Messages retains the block unchanged. Requests with no compatible candidate return 400 unsupported_feature, zero-charge protocol_error and no supplier call; JSON response conversion returns 502 protocol_error; SSE returns stream_error without a success terminal and releases the lease. Checks target protocol content blocks, including initial stream message content, without inspecting tool inputs/schemas or leaking opaque data.

Added 12 handler cases across native/cross-protocol JSON/SSE request/response paths plus a tool-payload false-positive test. Initial assertions needed explicit numeric SQL casts; the first fix also touched two existing tool-test queries, which was corrected to affect only the new test. The corrected gateway gate passes 660 tests (54 TODO; clean migration/bootstrap included), with typecheck/build passing. Corrected full rerun passes: API 868 passed (2 skipped, 54 TODO), web 59 passed; git diff --check passes. No schema change, supplier traffic or publication. Chat signature capability and other unsupported-field behavior remain open; full migration is incomplete.


## Explicit reasoning policy and matrix acceptance — 2026-09-26

Added X-Coati-Reasoning-Policy (preserve by default, text-only by explicit selection). Runtime conversion refuses signed history/output when targeting Chat unless text-only is chosen; redacted_thinking remains forbidden across protocols in either mode. The policy is recorded in request_context and never forwarded upstream. Both candidate preflight and fresh route conversion, JSON and SSE use the same option. Native protocol data is preserved. Added strict/explicit request and response cases, policy tracing/non-forwarding, invalid policy rejection and the redacted exception.

New tests exposed standalone Responses reasoning disappearing before the next user message. Fixed it by flushing a separate assistant reasoning message while retaining normal assistant/tool grouping; original Python goldens still pass. Documented the intentional correction, protocol limitations and header usage in the Node README. Focused suite: 477 passed, followed by an additional standalone-history regression. The accumulated nine-pair JSON/SSE/replay, signature, ordering, conflict, lifecycle, policy and redacted evidence replaces the 18 reasoning TODOs. Remaining matrix categories: unsupported-field and slow-client, 36 TODOs.

Typecheck, full API 887 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 679 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. No schema change, real supplier traffic or publication. This is simulated-upstream gateway acceptance, not SDK/provider interoperability or completion of the full migration objective.


## Stop and structured-output field preservation — 2026-09-26

Audit found Chat/Messages stop sequences dropped when converting to Responses and Responses text.format dropped when converting to Chat/Messages. Added explicit Responses-route refusal for supplied non-null stop settings, retaining native and Chat/Messages stop mappings. Responses-to-Chat now maps json_object/text/json_schema formats and preserves schema/name/description/explicit strict:false. Current Messages conversion refuses structured-format requirements it cannot map, consistent with the existing Chat-to-Messages behavior. Native routes remain passthrough.

Added 12 stop and 24 structured-format handler cases covering JSON/SSE, preserved upstream fields, refusals and no upstream traffic on preflight failures. Focused matrix plus Python golden suite: 493 passed. Typecheck, full API 923 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 715 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Public Node README and protocol contract describe these boundaries without claiming supplier output compliance. No schema change, real supplier calls or publication. Remaining unsupported-field cases and slow-client acceptance stay open; overall migration remains incomplete.


## Parallel tool-control preservation — 2026-09-26

Verified official Claude/OpenAI field semantics and added runtime cross-protocol mapping between parallel_tool_calls and the inverse Messages tool_choice.disable_parallel_tool_use. Named selection is retained, missing Messages choice defaults to auto only when needed for the explicit control, and none remains none without an unsupported parallel subfield. Tool-less requests do not gain a tool_choice; non-boolean explicit values are rejected. Existing native paths are unchanged.

Added 72 real-handler cases across nine pairs, JSON/SSE, both boolean settings and default/named choices, plus three boundary tests. Focused 72 cases pass. Typecheck, full API 998 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 790 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Official references and mapping boundaries are recorded in protocol-contract.md. No schema change, real supplier traffic or publication. Other tool/unsupported fields and slow-client acceptance remain open, as does the complete migration goal.


## Tool strict transport — 2026-09-26

Explicit tool strict true/false now survives six cross-protocol request conversions, including legacy additional_tools. Added 36 handler matrix cases plus eight boundary tests. Native passthrough and original Python goldens remain intact. Missing controls are not defaulted; invalid and ambiguous declarations are refused; schema properties named strict are preserved as data. Mock-upstream evidence establishes request transport only, not supplier schema enforcement.

Typecheck, full API 1042 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 834 passed (36 TODO; clean migration/bootstrap included) pass; git diff --check passes. Logs: /tmp/coati-tool-strict-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, commit or publication.

## Slow clients over real loopback HTTP — 2026-09-26

Twenty new cases cover nine paused/cancelled SSE protocol pairs, nine paused/resumed SSE pairs, and two oversized Responses-terminal errors. Paused clients stop upstream production under 16 MiB while a 256 MiB producer remains unfinished; cancellation closes upstream and clears leases. Resume tests check 128 KiB of exact content and terminal/accounting success. These are local TCP pull/buffer observations, not RSS/load acceptance.

A 512 KiB success experiment failed for Chat/Messages -> Responses because repeated full-text ending events exceed the current aggregate 1 MiB terminal buffer. It is now explicitly tested as a bounded error with no false completion. Long-stream fidelity and terminal-buffer policy remain open. Slow-client TODO placeholders are retained, including JSON, long pause and timeout requirements.

Validation: typecheck, API 1062 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 854 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-slow-client-{focused,typecheck,tests,build,gate}.log. Changes remain local and uncommitted; full migration acceptance is incomplete.


## Repeated Responses endings corrected — 2026-09-26

The previous 512 KiB Chat/Messages-to-Responses failure is resolved: allowlisted content endings are released in order, while response-level completion remains gated on settlement. Per-frame and aggregate pending-completion limits are still 1 MiB. The previous two failure regressions now assert success. Real HTTP resumed Responses clients now verify 512 KiB; four additional long-response tests prove oversized single events and settlement failures never emit completion and release leases. Three unit tests cover bounds, ordering and unchanged Chat/Messages gating. This does not remove the remaining long-stream/JSON/timeout/load acceptance work.

Typecheck, API 1069 passed (2 skipped, 36 TODO), web 59 passed, build, and gateway gate 861 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-terminal-buffer-{focused,boundaries,typecheck,tests,build,gate}.log. No database schema changes, supplier traffic, production writes, commit or publication.


## Paused iterator timeout cleanup — 2026-09-26

Before-fix idle reproduction left reserved ledger state until another consumer pull. Stream abort now settles independently of iteration, with one shared settlement promise and abort guards before subsequent reads/completion. Four focused service cases and 27 nine-pair idle/deadline/client cases verify release and upstream closure without another pull, exactly one settlement and no resumed successful terminal. This is not evidence of forced downstream TCP closure or sustained load acceptance.

Typecheck, full API 1099 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 891 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-paused-timeout-{before,focused,matrix,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.


## Downstream response deadline — 2026-09-26

Added a model-route response timer for the service timeout plus 1s error-flush grace. Three helper tests cover stalled SSE/JSON clients and cleanup. Nine real route tests pause HTTP consumers and verify the server response is closed, upstream closes, stream_error accounting remains, leases clear and no retry occurs. First matrix run failed because the test tried to add a Fastify hook after ready; observing server response close directly fixed test setup. These results establish bounded downstream writes for the exercised cases, not sustained-load/RSS or complete JSON gateway matrix acceptance.

Typecheck, full API 1111 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 903 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-response-deadline-{focused,matrix,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.


## Messages count_tokens — 2026-09-26

Migrated local estimation and three paths, requiring a valid chat-scoped key with request-ID headers. Nineteen fixtures execute the unmodified Python estimator/normalizer plus a source hash guard. Three real-handler cases verify alias behavior, auth/scope, no supplier traffic and no accounting row. Standard tools, Unicode and successful/failed server search/fetch history are covered; server-side execution itself remains pending.

Typecheck, full API 1134 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 926 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-count-tokens-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.


## Device authorization decisions — 2026-09-26

Added session/CSRF-protected legacy confirm alias and confirm/deny transitions with row locks, post-lock database expiry checks and stable status distinctions. Four new cases plus existing concurrent redemption pass for both route families. First CSRF assertion used an incorrectly formed cookie header; after using the named test cookie it verifies 403. UI completion, grant-policy compatibility and distributed abuse control remain open.

Typecheck, full API 1138 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 930 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-device-decisions-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.


## Shared device-start limits — 2026-09-26

PostgreSQL admission serializes starts across connections, marks expired grants, checks recent/global-active counts and removes retained history. Three focused tests plus configuration coverage verify a 12-way race through two pools admits exactly three, approved-capacity/expiry/retention behavior and rate-limit HTTP headers across client IPs. Creation/expiry uses DB time; defaults and Compose settings match the Python start policy. Distributed polling and deployed multi-replica/load evidence remain open.

Typecheck, full API 1142 passed (2 skipped, 36 TODO), web 59 passed, build and gateway gate 934 passed (36 TODO; clean migration/bootstrap included). Compose config --quiet with disposable fixture values and git diff --check pass. Logs: /tmp/coati-device-admission-{focused,typecheck,tests,build,gate}.log. No schema change, real supplier traffic, production writes, commit or publication.


## Device authorization page — 2026-09-26

Query-code prefill, explicit denial, current identity, permission state, inline errors/retry and pending-state controls are implemented. Five component tests cover both decisions, login-return query preservation and error states. Browser: existing local admin session, 1280x720 invalid-code display and 390x844 form/deny interaction; a disposable request was denied and API polling confirmed access_denied without issuing a token. The local temporary secret was removed. Fresh login and successful approval remain component/API evidence, not this browser check.

Typecheck, API 1142 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 934 passed (36 TODO; clean migration/bootstrap included). Scoped frontend lint first found the callback/ref analysis issue; moved handleSubmit construction into event callbacks, then scoped lint, all 64 web tests and web build passed again. Browser checks preceded that event-wrapper-only correction; final component tests cover the corrected callbacks. git diff --check passes. Logs: /tmp/coati-device-ui-{focused,typecheck,tests,build,gate,lint,web-final,build-final}.log. No schema change, supplier traffic, production writes, commit or publication.


## Device-grant policy and profile parity — 2026-09-26

New device keys inherit owner governance without the preview-only 100000/5/60 extra caps. A database test verifies a 120000-token reservation plus owner quota, concurrency and RPM refusals. Poll success returns safely serialized user data; a profile-read fault test proves authorization remains approved and no orphan key is issued before a successful retry. Existing issued keys are unchanged. UI copy reflects shared policy; this copy change has build/component evidence, not a new browser run. Distributed polling and complete client acceptance remain open.

Typecheck, full API 1144 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 936 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-device-grant-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Shared device start/poll limits and proxy trust — 2026-09-26

Migration 0019 adds bounded database IP windows shared by device start/poll across app instances. Four tests verify 80-way/two-pool admission accepts exactly 60, expiry reset, 10000-address capacity/reclamation, shared HTTP limits, forged forwarding headers and trusted proxy chains. The first HTTP test failed because the inherited unconditional one-hop trust allowed address spoofing; explicit TRUSTED_PROXIES (empty default) fixes that boundary. Existing HTTPS cookie testing now declares its loopback proxy. DB/HTTP-injection evidence does not certify deployed replicas or sustained throughput. Deployment instructions require trusted proxy IP/CIDR configuration; upgrade the DB before API rollout. A previous API version can leave the additive table in place.

Typecheck, full API 1148 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 940 passed (36 TODO; clean migration/bootstrap included). Development/test databases are at 0019 (20 migration rows, 1790355012820); development table columns and both primary/window indexes were inspected after the real upgrade. Compose config with disposable fixture values and git diff --check pass. Extra app/config lint finds the pre-existing unused resolveAiSqlUrl in config.ts (also present at HEAD); gateway-scoped lint passes via the gate. Logs: /tmp/coati-device-shared-{focused,migrate,typecheck,tests,build,gate,config-lint}.log. No supplier traffic, production writes, commit or publication.


## Personal usage compatibility query — 2026-09-26

Implemented the session-only /api/agent/me/usage endpoint with owner-scoped aggregation across retained/rotated keys and optional PAT, model, status and time filters. Reused PAT serialization/redaction. Two new DB/HTTP cases and existing PAT regressions verify current-user isolation (including a normal account without management roles), foreign PAT exclusion, bearer-only rejection, invalid filters, pagination, null/zero cache values, reservation visibility, historical window and internal fallback-trace masking. Initial typecheck caught a nonexistent request owner column; corrected ownership to the request's key owner before tests. No admin analytics, export or historical import acceptance is claimed by this stage.

Typecheck, full API 1150 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 942 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-mine-usage-{focused,typecheck,tests,build,gate}.log. No schema change, live supplier traffic, production writes, commit or publication.


## Personal usage export — 2026-09-26

Ported CSV/XLSX/XLS export, Python field labels/order, filtered/selected behavior, nullable cache values and safe personal serialization. Added the dedicated export permission; enforced session, CSRF and current-user scope. Six focused cases cover decoded cells in all formats (plus BIFF8 OLE header), formula-looking text, defaults/selection/filter errors, normal-user permission refusal and foreign-ID omission. Selected export has an explicit 5000-ID resource bound; historical numeric IDs still require migration mapping. Full checks found missing locale names and invalid seed parent/child ordering; both were fixed before the final passing run. Existing development seed success alone did not prove empty-database bootstrap. This stage does not include the console export control or manual spreadsheet-app acceptance.

Typecheck, final full API 1154 passed (2 skipped, 36 TODO), web 64 passed, build and gateway gate 946 passed (36 TODO; clean migration/bootstrap included). The final rerun follows fixes for missing menu translations and parent-before-child RBAC ordering. Development incremental seed was applied and the 10041/gateway_my_usage_export/button/1004 row was inspected. git diff --check passes. Logs: /tmp/coati-usage-export-{focused,seed,typecheck,tests-fixed,build,gate}.log; earlier failed full runs are tests.log and tests-final.log. No table schema change, live supplier traffic, production writes, commit or publication.


## Personal usage console — 2026-09-26

Added a session-authenticated personal page and user-menu entry with query filters, pagination, safe details and permission-gated field/format/selected export. Four new component tests cover query and export parameters, draft/applied distinction, permissions/retry and stale-response suppression. Fixed a relative import caught by whole-suite integrity and moved loading resets from the effect into user actions to satisfy scoped lint.

Browser: existing local admin, desktop 1280x720 and mobile 390x844; disposable revoked key + synthetic usage row. List, selection, modal field/format controls and narrow layout were inspected; numeric filter-label alignment was corrected. CSV submission closed the modal without error, but no download event was observed within the browser-tool timeout, so saved-file acceptance remains unverified. Component Blob handoff and API-decoded format content are separate evidence. Fixture removed (key count verified zero), viewport reset, temporary tab closed. Ordinary-account browser access and failed-export browser retry are not claimed.

Typecheck, final API 1154 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 946 passed (36 TODO; clean migration/bootstrap included). Scoped frontend lint and git diff --check pass. Logs: /tmp/coati-mine-ui-{focused,lint,typecheck,tests-final,build,gate}.log; initial whole-suite failure is tests.log (relative import). No schema change, supplier traffic, production writes, commit or publication.


## Personal usage analytics — 2026-09-26

Added owner-scoped summary/trends/model distribution/filter options/quota. Two new database cases plus an extended ordinary-user case verify billing/error separation, explicit reservations, p95/average latency, top-eight/full denominator, model drilldown, unknown/zero cache data and owner isolation. Six timezone bucket cases cover standard, overlap, gap and fractional offsets; three transition expectations were separately confirmed with Python ZoneInfo. Initial Drizzle transaction-option typing and PostgreSQL parameterized GROUP BY failures were corrected before the passing full run. Cache totals include coverage counts; daily quota is read separately from the repeatable-read analytics snapshot. No analytics-page, administrator analytics or production/load acceptance is claimed.

Typecheck, full API 1162 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 954 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-analytics-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Administrator usage analytics — 2026-09-26

Added the session/gateway_requests-protected legacy administrator analytics endpoint using explicit repository scope. Extended multi-user tests prove global totals and user ranking, user/PAT narrowing, globally available authorized filter options and personal-data isolation. One new handler test covers invalid/unknown users and anonymous/bearer-only refusal; ordinary logged-in user is also denied. Personal analytics regressions remain green. Statistics use the shared billable/error/timezone/model denominator rules; administrator list and analytics UI are not included in this stage. A temporary SQL template syntax error was caught and fixed before typecheck and focused checks passed.

Typecheck, full API 1163 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 955 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-admin-analytics-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Administrator usage record query — 2026-09-26

Added session/RBAC-protected administrator list with explicit admin/personal repository scope, user/PAT/model/status/time filters and pagination. Shared personal serialization remains allowlisted; administrator responses add owner/PAT identifiers, username, latest recorded account and stored diagnostics. Extended owner-isolation fixtures plus a new handler case verify global and filtered lists, normal-user/bearer refusal, diagnostic redaction boundaries, cache null/zero and invalid filters. No keys, secrets or raw payloads are exposed.

Field parity remains incomplete: route, provider and actual upstream-model execution snapshots are not stored, so these fields return null rather than inferring historical values from current mutable configuration. Latest recorded attempt metadata is not a successful-execution provenance guarantee. Historical mapping and administration presentation remain open.

Typecheck, full API 1164 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 956 passed (36 TODO; clean migration/bootstrap included). git diff --check passes. Logs: /tmp/coati-admin-usage-{focused,typecheck,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Execution target snapshots — 2026-09-26

Migration 0020 adds nullable JSONB execution snapshots to requests and attempts. After acquiring fresh route/account configuration and preparing the actual payload, the service persists route ID, account ID/name, wire model and protocol before transport I/O. Each recorded attempt retains its own target; the request retains the last selected target. Persistence failure aborts before supplier traffic and settlement releases the reservation/lease. No secrets, URL or raw payload are included. This is target provenance, not a success assertion.

Tests cover preserved account/model values after configuration rename, null historical snapshots, retry-specific route IDs/final target, actual vision/text model selection, native SSE snapshots and persistence fault cleanup. Initial fault injection targeted an unused service instance and returned 200; corrected the spy to the repository prototype used by HTTP handlers before the focused run passed. Existing personal serializers remain allowlisted. route_name/provider are still unmodeled and null; legacy import/parent-child lineage remain separate work.

Development database was recorded at 0019 (20 ledger rows, max 1790355012820), then actually upgraded to 0020 (21 rows, max 1790364888852); both JSONB columns were queried in information_schema. Apply the additive migration before API rollout; older API rollback may retain the columns. This does not constitute deployed backup/restore or rollback acceptance. Full validation follows.

Typecheck, full API 1165 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 957 passed (36 TODO; migration-chain and empty bootstrap included). Development/test are at 0020, 21 ledger rows/max 1790364888852. git diff --check passes. Logs: /tmp/coati-execution-{focused,typecheck,migrate,tests,build,gate}.log. No live supplier traffic, production writes, commit or publication.


## Provider classification and route display provenance — 2026-09-26

Python source verification (model/__init__.py, crud/usage.py related_context) establishes provider as classification independent of upstream_protocol and route_name as the route model_name. Corrected the earlier assumption that a separate route-name configuration was required. Node now snapshots route.model as route_name and account provider; old execution JSON remains valid and absent fields return null without consulting current configuration.

Migration 0021 adds gw_upstreams.provider with the neutral openai-compatible default. API validates trimmed nonempty length <=64; omission on update preserves classification and omission on create uses the default. Request serialization/authentication still depends only on protocol. The existing model-service form/list adds classification plus explanatory copy and en/ja translations, using the existing components and layout (ui-craft local change).

A new DB/HTTP test checks default, custom trim, omission preservation, invalid input and transport independence; the admin-history case now verifies provider/alias remain stable after renaming and null legacy snapshots. Browser on localhost:5175 with existing admin session at 1280x720 verified empty-list column, create-form default/help text and scroll reachability of lower fields/fixed footer. No form submitted; no browser persistence or mobile acceptance claimed; temporary tab closed.

Development database before upgrade: 0020, 21 ledger rows/max 1790364888852. Ran db:migrate to 0021, 22 rows/max 1790365215151, then inspected provider text/not-null/default in information_schema. Additive migration must precede API rollout; previous API can leave column in place. Deployed rollback/backup testing remains open. Full validation follows.

Typecheck, full API 1166 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 958 passed (36 TODO; migration-chain and empty bootstrap included). Development/test are at 0021, 22 ledger rows/max 1790365215151. git diff --check passes. Logs: /tmp/coati-provider-{focused,typecheck,migrate,tests,build,gate}.log. No live supplier traffic, production writes, commit or publication.


## Legacy administrator quota query and editing — 2026-09-26

Implemented the two quota endpoints, searchable/paginated user list, settled business-day usage, default/override fields, dedicated write permission/CSRF and non-destructive restoration to inheritance. Daily-only updates preserve RPM and concurrency fields. Migration 0022 adds nullable quota update timestamps; unknown existing times are not backfilled. Existing full-limit updates also record the timestamp. Responses normalize recorded timestamps to UTC ISO.

Two focused cases (new quota flow plus extended normal-user isolation) pass: exhausted quota immediately rejects, zero admits, null/empty inherits, custom default summary, search/pagination/clamp, malformed payload/user, missing CSRF, bearer refusal and normal-user read/write refusal. The later UTC timestamp assertion is included in full validation. This is API/DB evidence; dedicated quota presentation, permission-code import mapping and historical data acceptance remain open.

Development DB upgraded from 0021 (22 rows/max 1790365215151) to 0022 (23/max 1790365482451); timestamp column inspected. Initial seed invocation omitted --incremental and entered full-rebuild mode; foreign-key rejection caused the encompassing transaction to roll back (transaction code inspected; existing user_roles=1 and role_menus=48 remained). Corrected to incremental synchronization; verified 10042/gateway_requests_quota_edit/1004. The failed chain did not start tests; full validation was then started after incremental sync. Logs preserve both seed attempts. No production database involved.

Typecheck, full API 1167 passed (2 skipped, 36 TODO), web 68 passed, build and gateway gate 959 passed (36 TODO; migration-chain and clean bootstrap included). Development/test are at 0022 (23 ledger rows/max 1790365482451). git diff --check passes. Logs: /tmp/coati-quotas-{focused,typecheck,migrate,seed,seed-incremental,tests,build,gate}.log. No supplier traffic, production writes, commit or publication.


## Administrator quota console — 2026-09-26

Added User quotas alongside Requests using the existing table/dialog components. Search, paging, effective/default/source/billed/remaining values and exhausted state connect to the legacy list. Edit action requires the dedicated quota permission, offers inheritance/unlimited/positive cap and writes only daily_token_quota. Save failures preserve input; busy guard prevents duplicate writes; current-query refresh and stale-fetch cleanup protect the displayed list. Existing ui-craft local layout conventions are retained.

Five component cases pass (read permission/search, validation/failure retry, two distinct zero/null modes, error refresh/stale response). Scoped new-component lint and typecheck pass. Browser: localhost:5175 with existing admin, 1280x720 and 390x844; tab navigation, current inherited default, dialog modes/positive input and narrow layout inspected. Responsive shell remounted the page on viewport switch, so reopened quota tab before mobile inspection. No production or local quota was changed through the browser. Restored viewport and closed temporary tab. Ordinary-account browser, successful-save browser and failed-save browser remain component/API evidence only.

Initial whole-suite frontend locale scan found missing Remaining quota/Available translations; added both en/ja entries before rerunning. The failed pnpm test stopped the first chain before build/gate; no Vitest processes remained before the final sequential run. Full validation follows.

Typecheck, final full API 1167 passed (2 skipped, 36 TODO), web 73 passed, build and gateway gate 959 passed (36 TODO; migration-chain/clean bootstrap included). New Quotas component scoped lint and git diff --check pass. Logs: /tmp/coati-quota-ui-{focused,lint,typecheck,tests,tests-final,build,gate}.log; tests.log contains the corrected locale failure. No schema change, supplier traffic, user-quota mutation, production writes, commit or publication.


## Administrator request-log console migration — 2026-09-26

Requests now uses the legacy administrator list with submitted days/model/user/PAT/status filters and paging. Default explicitly labels finished requests; reserved requests are available through the in-progress filter. Node interrupted status is accepted by the shared filter schema. List includes user/PAT/account; query refresh invalidates pending detail opens and stale query responses cannot replace newer data.

Added session/gateway_requests-protected GET /api/admin/gateway/requests/:id (UUID, 404 absent) to load the complete existing Node ledger only on inspection. Detail loading fetches that row plus attempts together, retaining full cache TTL/reasoning/raw-usage fields without adding raw payloads to the compatibility list. Details show immutable route/account/provider/wire model, and prefer snapshot upstream protocol. Attempt rows display their own targets. The existing administrator-only native list already exposes the same ledger shape; this does not widen personal access.

Three component tests cover submitted filters and full detail, failed detail retry, obsolete-response suppression; two focused API cases cover detailed counters/provenance, missing/malformed IDs, bearer-only rejection and ordinary-user forbidden access. Scoped Requests lint passes. Browser: existing admin at localhost:5175, 1280x720 with a disposable revoked key and synthetic completed request, no supplier call. List/filters and side-sheet provenance/cache zero-versus-null inspected. Snapshot protocol precedence was corrected after initial inspection and verified after reload; an added component assertion checks it too. Fixture request/key removed transactionally and zero remaining marker keys verified. Tab closed. Narrow layout, interactive filter submission and failure states are component evidence only in this stage.

Typecheck, full API 1168 passed (2 skipped, 36 TODO), web 76 passed, build and gateway gate 960 passed (36 TODO; migration-chain/bootstrap included). After protocol precedence correction, three focused web cases passed; after adding interrupted-filter evidence, one focused API case passed. Scoped Requests lint and git diff --check pass. Logs: /tmp/coati-admin-log-{typecheck,api-focused,api-final,web-focused,web-final,lint,tests,build,gate}.log. No schema change, supplier traffic, production writes, commit or publication.


## Personal and administrator analytics console — 2026-09-26

Added a shared analytics view to personal usage and administrator Requests tabs, with separate endpoints/scopes. Submitted day/model/status plus personal PAT or administrator user/PAT filters drive requests. Personal requests strip user_id and never render user ranking. Model/PAT/user options come from authorized API responses; selected values remain visible if later absent from options. Loading hides old aggregates, failed loads show retryable errors, and stale responses are ignored.

Display includes request/token/success/latency/active-model summaries, daily personal quota, ECharts token/request trend with explicit axes and gateway-offset bucket labels, an expandable trend data table, nullable cache totals and reported-request counts, top-eight model shares with denominator/filter caveat, and administrator user ranking. Missing time buckets are not invented as zeros. Raw tooltips use richText; React escapes names. The chart supports the existing dark theme context and transparent background; dark-mode rendering was not browser-checked. Browser inspection moved the legend to the top to avoid the zoom slider and clarified the default status as finished requests.

Four component tests cover personal/admin scope/filter distinction, null/zero cache values, trend series, errors/empty data and stale response rejection. Initial JSX closure and unused-variable errors were fixed before focused tests/lint passed. The first full run found a missing personal Usage records translation; en/ja were added before the final passing run.

Browser: existing admin session, localhost:5175, administrator 1280x720 and personal 390x844. Used a disposable revoked key and three synthetic prior-day records; verified totals (3 requests, 72 tokens), local +08:00 buckets/tooltip, completed trend rendering, model distribution, cache zero with 3 reports versus unknown with 0 reports, and personal current-day quota. No supplier traffic. Restored viewport/closed tab; deleted all three fixture requests and key in a transaction, then verified zero marker keys. User-ranking section and scope-specific controls visible; normal-user browser access, dark mode, zoom manipulation and saved user preferences are not acceptance claims.

Typecheck, final API 1168 passed (2 skipped, 36 TODO), web 80 passed, build and gateway gate 960 passed (36 TODO; migration/bootstrap included). Scoped analytics lint and git diff --check pass. Logs: /tmp/coati-analytics-ui-{focused,lint,typecheck,tests,tests-final,build,gate}.log; tests.log records the corrected locale failure. No schema change, production writes, commit or publication.


## Same-origin route path overrides — 2026-09-26

Added nullable route description (255 characters) and upstream_base, with existing shared-form controls and English/Japanese labels. Omitted update fields retain stored values; empty/null clears. Both configuration save and pre-transport execution validate HTTP(S), reject URL credentials/query/fragment, and require the current account origin (scheme, hostname, effective port). The fresh leased account/route supplies execution values; a changed account origin cannot send its credential to the old override. Clearing the override restores account base behavior. Existing outbound DNS/private-address and no-redirect policies remain in effect.

Three API/loopback tests prove actual alternate-path routing and clearing, omitted-field retention, cross-origin and malformed URL rejection, normalized default HTTPS port equivalence, and runtime origin-change refusal before transport with request settlement and lease release. No real supplier calls. UI controls have build/locale coverage in this stage, not browser interaction acceptance.

Applied development migration from 0022 (23 ledger rows, max 1790365482451) to 0023_gateway_route_overrides (24 rows, max 1790367258338), verified both real nullable text columns. Test DB also at 0023. Typecheck, API 1171 passed (2 skipped, 36 TODO), web 80 passed and build pass. Existing frontend bundle-size warnings remain. Logs: /tmp/coati-route-{format,migrate,focused,typecheck,tests,build,gate}.log. No production writes, commit or publication. Python routes_admin API and public-route/account-pool fallback semantics remain open, explicitly recorded in roadmap and inventory.

Gateway gate also passed: 963 tests, 36 TODO; scoped gateway/schema lint, migration chain and isolated bootstrap included. git diff --check passes.


## Account model declarations — 2026-09-26

Added supported_models JSONB and default_model text to upstream accounts, native admin read/write APIs and existing account form. Fields omitted on update retain stored values; null/empty clears. Model declarations trim and remove empty/duplicate strings before the Python limit of 50 models, 128 characters each; the default model is included in the effective API list when absent. The native typed API rejects non-string list entries; legacy credential input coercion belongs to the pending compatibility adapter. Probe/discovery results do not mutate administrator declarations. This is configuration foundation, not automatic pool selection/default-request-model acceptance: the current explicit candidate route path does not yet filter by declarations.

0024_gateway_account_models backfills existing actual and vision model values from all configured Node routes, including disabled ones, deduplicating/trimming and preserving accounts without routes as empty lists. It does not invent a default. Applied dev 0023 (24 ledger rows, max 1790367258338) → 0024 (25 rows, max 1790367762576); verified real non-null JSONB/text columns. Three API/DB tests cover model/default/omitted/clear normalization and validation, discovery non-mutation, and actual migration SQL against transaction-local temporary tables containing duplicate, vision, disabled, empty and unbound-account examples. These temporary tables are dropped at commit. No source Python DB writes.

The first focused run exposed a fixture encryption-key mismatch between API-created accounts and the standalone service; the fixture now explicitly re-encrypts its test credential for that service. Discovery order expectation was corrected to the existing sorted output. Three focused cases then pass; after matching Python empty/dedup/count behavior, all three pass again. Full API before that normalization refinement: 1174 passed, 2 skipped, 36 TODO; web 80 passed. Logs: /tmp/coati-account-models-{generate,format,migrate,focused,focused-final,normalization,typecheck,typecheck-final,tests,build,build-final,gate}.log. UI fields have build/locale evidence only this stage, no browser interaction claim. No real supplier calls, production writes, commit or publication.

After final normalization changes: typecheck/build and gateway gate pass (966 tests, 36 TODO), including scoped lint, migration chain and isolated bootstrap. Test DB verified at 0024 (25 ledger rows, max 1790367762576). git diff --check passes.


## Enforce account declarations in explicit routing — 2026-09-26

Route save now rejects undeclared actual/vision targets and enabled routes bound to disabled accounts, matching the Python route_service constraint. The default model participates in support checks; empty declarations are not wildcards. Request candidate filtering selects the actual wire target (vision only for coati-auto with images). A second check after fresh route/account reads under lease-transaction locks prevents a declaration removed after quota reservation from reaching transport. Initial declaration mismatch is 422 unsupported_upstream_model; all candidates lost after reservation result in 503 with ordinary routing-error settlement. No attempt is recorded for an unsent request.

Updated protocol/fixture account declarations explicitly rather than weakening enforcement. Initial gateway plus matrix run: 731 passed. Four focused additions prove route actual/vision validation and disabled binding, empty/default-only declarations, removal after reservation with zero traffic/attempts/leases and settled zero usage, and selection of another still-declared candidate. Supported model matching is exact. No new migration this stage; 0024 already backfills existing route declarations. This does not implement automatic pools or prove affinity re-selection during concurrent account changes; those remain part of pool migration acceptance.

Full API 1178 passed (2 skipped, 36 TODO), web 80 passed; typecheck/build passed. Final gateway gate 970 passed (36 TODO), including scoped lint, migration chain and isolated bootstrap. Logs: /tmp/coati-model-enforcement-{format,focused,races,typecheck,tests,build,gate}.log. git diff --check passes. No supplier traffic, production writes, commit or publication.


## Revalidate session bindings against live account eligibility — 2026-09-26

acquireUpstream now checks the bound account's current enabled/non-cooling routes for the requested public model, and matches the actual text/vision target against current account declarations. Static eligible IDs alone no longer pin a request to a disabled or unsupported account. The scope advisory lock still serializes competing binding writers; invalidation matches scope and the observed upstream ID. Actual candidate acquisition still performs fresh locked route/account checks before leasing.

Five HTTP/real isolated DB cases establish a binding, mutate configuration after quota reservation, then prove one successful send/attempt to a valid fallback, replacement binding and no remaining lease: models removed, account disabled, cooldown entered, route disabled, vision target removed. Together with the existing competing-repository first-writer/expiry case, six focused tests pass. These are in-process repositories and loopback supplier fixtures, not real multi-replica deployment acceptance. No schema/UI change or live supplier traffic.

Typecheck, full API 1183 passed (2 skipped, 36 TODO), web 80 passed, build, and gateway gate 975 passed (36 TODO; scoped lint/migration chain/isolated bootstrap included). Logs: /tmp/coati-binding-recheck-{format,focused,typecheck,tests,build,gate}.log. git diff --check passes. No production writes, commit or publication.


## Public route and automatic account pool runtime — 2026-09-26

Added a separate public-model route table with a unique model name, optional bound account, actual/vision model, same-origin override, description, enable and explicit fallback flag (default false). Existing explicit candidate rows are preserved; no silent conversion. Cross-table alias conflicts use the same model advisory lock in both write paths; the public table also has a unique constraint. New native admin CRUD uses existing gateway_routes permissions and global cookie/CSRF hooks; public delete requires disable first. Updates merge omitted fields and validate object payload, bindings, models, coati-auto target and override origin. Compatibility route listing/summary and console integration remain pending.

Account priority is now persisted (1–1000, default 100), with descending priority for public pool candidates; existing explicit route priorities keep their earlier behavior. Bound account has absolute precedence and does not use session affinity. The effective wire model filters candidates independently of public alias/protocol; unbound pools use existing session/weighted/load logic. Secondary accounts never inherit the bound account's base override. Locked lease acquisition reloads public configuration and selected account, including fallback eligibility, before transport. Public route execution snapshots add route_kind; explicit snapshots also label their kind. Public aliases participate in discovery.

Applied dev 0024 (25 rows, max 1790367762576) → 0025_gateway_public_routes (26 rows, max 1790368793841); inspected actual unique constraint, FK and column defaults with psql. Twenty-five initial focused cases cover automatic priority selection, primary-first/flag/no-primary handling, override isolation, fallback switch change during reservation, alias collisions/delete rules, and 18 JSON/SSE three-protocol combinations preserving token/cache accounting. The initial disabled-fallback error assertion expected 503 but existing upstream HTTP translation is 502; corrected without changing runtime error mapping. A further public-pool affinity race and personal-scope/RBAC set (7 cases) passes. Ordinary user cannot list public routes. No supplier traffic or production writes.

Final typecheck, full API 1209 passed (2 skipped, 36 TODO), web 80 passed, build and gateway gate 1001 passed (36 TODO; scoped lint, migration chain and isolated bootstrap included). Test DB verified at 0025, 26 rows/max 1790368793841. Logs: /tmp/coati-public-routes-{generate,migrate,focused,focused-final,affinity,typecheck-final,tests,build,gate}.log. git diff --check passes. No browser/console acceptance for this stage, commit or publication.


## Public routing console and account priority — 2026-09-26

Applied ui-craft to the existing project components/theme. The main task is defining each public model's account selection and fallback policy. The public-route table is primary, with search and CRUD in consistent controls, a single-column scrollable form, and existing candidate configuration in a separate tab. Account priority is exposed in the upstream list/form. Public creation uses auto pool by default; bound accounts expose fallback/base override and declared models. Switching to automatic submits null override and false fallback, including after editing a bound route. Disabled accounts cannot be newly selected. A missing account list does not hide route records or automatic configuration.

Six component tests cover read-only permission/search, auto route and coati-auto validation, bound→auto hidden-field clearing and failed-save retry, bound payload and disabled-only confirmed deletion, account-load failure/stale-list suppression, route-load retry and required/length errors. Shared cookie/CSRF/RBAC and native CRUD already have API evidence from previous stages. Initial full run failed the import-integrity rule because the new tab page used a relative JS import; changed to the required @/ alias. Eight focused component/import cases pass after correction.

Browser: localhost:5175, existing admin, 1280×720 and 390×844. Inspected empty table/create form, a disabled temporary route bound to an account with no real credential, selected account/support list/fallback/override, automatic-mode switch, long-form scroll and fixed footer. Mobile table initially compressed account labels into narrow columns; assigned local minimum widths and 820px table width, then verified readable rows and horizontal scroll to edit/delete actions. Inspected account-priority default 100 and help text in model-service form. Did not save or delete through browser UI; successful/failed writes, deletion and ordinary-user UI states are component/API evidence only. No dark-mode check this stage.

Temporary dev fixture model/description public-ui-disposable and account secret marker public-ui-fixture-unusable were removed in one transaction; verified 0 route and 0 account markers remain. Restored viewport and closed tabs 11/12. No real supplier calls, production writes, schema migration, commit or publication. Logs: /tmp/coati-public-ui-{focused,focused-final,lint,lint-final,typecheck,tests,tests-final,build,build-final}.log; tests.log records the fixed alias failure.

Final typecheck, full API 1209 passed (2 skipped, 36 TODO), web 86 passed, build, scoped new-page lint and gateway gate 1001 passed (36 TODO; migration/bootstrap included). Final gate log: /tmp/coati-public-ui-gate.log. git diff --check passes. The final required/length-message and alias-import edits were checked by component/import/full tests; browser rendering preceded those non-layout corrections.


## Legacy candidate migration preflight — 2026-09-26

Added read-only admin GET /api/admin/gateway/route-migration/preflight under gateway_routes permission. Repository uses a repeatable-read/read-only PostgreSQL transaction and an explicit account projection that excludes credentials. Per-model output separates single-bound proposals with fallback disabled from multi-candidate manual review, and blocks invalid configuration or existing public aliases. Reports possible changes in target, per-candidate overrides and automatic pool membership. Configuration fingerprints exclude secret rotation and transient cooldown; an eventual apply operation must re-read and compare transactionally. No apply or archive implementation is claimed.

Eight new API/database cases cover empty/read-only proposal and no upstream calls, deterministic/config-sensitive fingerprints unaffected by secret/health changes, multi-candidate differences and additional pool members, and five blocking cases (unsupported target, disabled binding, unsafe override, oversized alias, existing alias). Existing ordinary-user isolation test also denies preflight; anonymous and PAT-only callers are rejected. Fixtures use the isolated test database and are cleared by existing hooks. Invalid credential-bearing override is not exposed in the report.

The first intended focused invocation passed through an extra -- and actually ran the full API suite: 1217 passed, 2 skipped, 36 TODO. This is recorded as full-suite evidence, not as a focused run. Typecheck and build passed; no schema migration or UI/browser change in this stage. Logs: /tmp/coati-preflight-{format,format-tests,focused,typecheck-final,build,lint,tests,gate}.log. Final gate outcome follows.

Final required checks passed: pnpm typecheck; pnpm test (API 1217 passed, 2 skipped, 36 TODO; web 86 passed); pnpm build; pnpm verify:gateway (1009 passed, 36 TODO, scoped lint/migration chain/isolated bootstrap). Focused preflight module lint and git diff --check also pass. No provider traffic, production writes, schema change, commit or publication. Migration apply, archival/ID mapping, rollback and console preflight remain pending.


## Single-candidate migration apply, archive and rollback — 2026-09-26

Added native route-migration history/apply/rollback service/repository endpoints. Read uses gateway_routes; writes use gateway_routes_edit and the shared cookie/CSRF hooks. Apply holds short configuration table locks, recalculates preflight and compares the supplied fingerprint before archiving source rows and creating the public row. Source rows leave the active table only in the same transaction as the journal/public insertion. The journal preserves original row IDs, the public ID/configuration, actor and rollback metadata; no upstream credentials. Concurrent duplicate apply/rollback is idempotent. Edited/deleted destination or occupied original ID/name rejects rollback instead of overwriting later changes. Lock timeout/deadlock maps to retryable 409. No upstream I/O is performed under migration locks.

0026_gateway_route_migrations applied on isolated coati_node_dev and coati_node_test. Recorded prior dev ledger 26/max1790368793841; current both 27/max1790370687611. psql inspected the real journal table columns and primary key. Dev journal count remains zero: no dev route conversion was performed. New-database bootstrap is included in the required gateway gate.

Eight added API/database cases cover round trip with real mock model calls and unchanged accounting, original IDs and execution route_kind history, stale fingerprint/manual-candidate rejection, three rollback conflicts, concurrent duplicate submission and rollback, bounded lock contention/no partial write, payload/CSRF/PAT rejection. Existing ordinary-user test additionally denies history/apply/rollback. Seventeen focused migration/personal-scope cases pass. Initial focused failure used the wrong assertion field execution_snapshot; corrected to the existing execution field. This was a test assertion error, not a runtime schema change.

Typecheck, full API 1225 passed (2 skipped, 36 TODO), web 86 passed and build passed. Logs: /tmp/coati-route-apply-{generate,format,format-tests,migrate,focused,focused-final,typecheck-final,tests,build,gate}.log. Final gateway outcome follows. No UI/browser changes, real supplier calls, production writes, commit or publication. Multi-candidate decisions, console migration controls, full Python data import, current-head container recovery and real multi-process contention remain pending.

Final pnpm verify:gateway passed: 1017 tests passed, 36 TODO, scoped gateway lint, migration chain and isolated new-database bootstrap. All four required gates and git diff --check pass. These tests do not certify complete migration or production readiness.


## Route migration console — 2026-09-26

Applied ui-craft within existing theme/components. Added Models and routes → Route migration with searchable preflight rows as the primary content, expandable proposed result, candidate differences and a secondary migration history. Shared request API wrapper sends model/version for apply and journal UUID for rollback. ConfirmAction names the model and explains configuration consequences before either POST. Only ready_for_review has apply; manual/blocked items remain visible with reasons. gateway_routes_edit controls write actions. Both reads settle independently; stale/unmounted responses are ignored. Busy protection prevents duplicate operations, refresh follows success and failed confirmation stays open with error toast.

Six component tests cover review/cancel/apply payload and refresh, failed apply plus cancel/recheck/confirmed rollback, read-only/search, preflight failure preserving history, history failure preserving preflight and empty states, and an unmounted response. Component/import focused run: 8 passed. Initial full run caught two missing i18n strings (操作成功/未知); added English/Japanese entries and reran required checks. Scoped new-page lint passed.

Browser: localhost5175 existing admin, 1280×720 and 390×844. Verified empty preflight/history, disabled single-candidate proposal, multi-candidate difference, expanded result, named confirmation and cancel; mobile text wraps with accessible actions and normal vertical scrolling. Did not confirm apply/rollback through browser; successful writes, conflicts and rollback remain component/API evidence. No populated-history/rollback-dialog browser check or dark-mode check this stage.

Temporary fixtures: three gw_routes marked description=migration-ui-disposable (one single and two multi) and one disabled upstream with an unusable secret marker. Removed all fixtures transactionally and verified both marker counts zero. No real supplier calls, permanent config transition, schema change, production writes, commit or publication. Reset viewport and closed temporary tab13. Logs /tmp/coati-migration-ui-{format,format-tests,focused,lint,typecheck,tests,tests-final,build,gate}.log; tests.log preserves the fixed i18n failure. Final gate outcome follows.

The first corrected full run passed web92 but API matrix setup hit a fixture FK: the earlier aborted run left gw_keys referencing the fixture admin before ensureSuperAdmin recreated it. Moved matrix fixture clearing before that helper as well as beforeEach; the cleanup remains confined to coati_node_test. Recorded failure in tests-final.log and corrected rerun in tests-clean.log. No product schema/account behavior was changed by this test-harness correction.

Final checks passed: typecheck; full API1225 passed (2 skipped,36 TODO) and web92 passed; build; gateway gate1017 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). Final clean full run: tests-clean.log; gate.log includes the bootstrap evidence. git diff --check passes. UI is implemented and partially browser-verified as above; no claim of full Python parity or production acceptance.


## Python route administration list contract — 2026-09-26

Read Python routes_admin.py, route_service.py, crud/route.py, pagination.py and AgentRouteConfig.to_dict. Added GET /api/admin/agent/routes backed by public configs, current gateway_routes permission and admin session. Repository selects only account fields needed for serialization; no secrets/probe tokens. A repeatable-read read-only transaction returns filtered page/count, optional unfiltered summary source and model-based seven-day usage. Model/actual-model ILIKE, provider, credential ID and enabled filters follow reference valid-input behavior; page defaults/clamps and maximum100 mirror the two-stage Python paginator/service clamp. Malformed credential ID returns400 instead of reproducing an uncaught Python exception.

Serialization includes legacy credential and route field names, protocol labels, effective target/base, automatic/bound mode and exact warning strings. Automatic without an account remains ready as in Python; readiness is not a successful probe. Seven-day counts exclude reserved; token aggregation uses the existing billable Node terminal states (including mapped cancellation/interruption semantics), not arbitrary failure token values. UTC timestamps preserve fractional precision for UTC driver values.

0027_gateway_route_updated_at adds a nullable column before setting default, preserving unknown existing history as NULL. Native public-route updates set database clock time; new inserts get a default timestamp. Applied to isolated dev/test: prior dev27/max1790370687611, current28/max1790371770471; psql inspected real column/default. Added real-PostgreSQL temporary-table migration test for old-null/new-default behavior.

Four endpoint cases plus extended ordinary-user isolation cover filtered page versus global summary, protocol/secret field allowlist, automatic mode, pagination/input validation, disabled/cooldown/unsupported text and vision warnings without probing, seven-day failure/reservation/old-row usage, timestamps and cookie/PAT/RBAC boundaries. Five focused cases passed before adding the real migration test. Final full outcome follows. Logs /tmp/coati-route-list-{generate,format,format-tests,migrate,focused,typecheck-final,tests,build,gate}.log. No UI changes, supplier requests or production writes. Legacy write endpoints and full credential/personal-channel/data-import parity remain pending.

Final required checks passed: typecheck; API1230 passed (2 skipped,36 TODO), web92 passed; build; gateway gate1022 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). The migration old-null/new-default case passed against actual PostgreSQL. git diff --check passed. No commit/publication or claim of complete legacy API parity.


## Python route create/update/delete compatibility — 2026-09-26

Read normalize_route_payload/common validators and delete_policy alongside the prior service reference. Added legacy write adapter mapping model_name/credential_id and returning only the old route record shape. Uses the existing public table/repository, alias advisory lock, updated_at tracking and disabled-delete transaction. Native public routes and compatibility routes operate on the same rows; explicit candidate aliases still conflict. Admin writes retain cookie/CSRF and dedicated add/edit/delete permissions.

Preserves scalar normalization/defaults, nullable/empty clearing, partial omission and ignored fields; caller IDs/timestamps cannot overwrite server fields. Errors cover duplicate names, missing/disabled account, unsupported explicit actual/vision target, missing coati-auto target, unbound/cross-origin override and enabled deletion. The Python distinction between omitted actual target (save with readiness warning) and explicitly unsupported target (reject) is retained instead of delegating to the stricter native service. Credential-bearing URLs and current network policy remain rejected. Object/array text values are explicitly400 rather than reproducing Python container repr; full credential/personal-channel/provider-availability parity is still pending.

Ten new endpoint cases: defaults/response allowlist/partial update/rename/delete; bound route serving a local mock and clearing overrides; implicit versus explicit model checks and disabled bindings; duplicate/coati-auto/URL boundaries; five field-validation message cases; PAT/CSRF plus concurrent duplicate creation. Extended ordinary-user test denies POST/PUT/DELETE. Fourteen focused legacy-route and personal-scope cases passed. No schema or UI change, real supplier calls, production writes, commit or publication. Logs /tmp/coati-route-write-{format,format-tests,typecheck-final,focused,tests,build,gate}.log. Final outcome follows.

Final required checks passed: typecheck; full API1240 passed (2 skipped,36 TODO), web92 passed; build; gateway gate1032 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). git diff --check passes. This closes this compatibility-write increment, not the remaining personal-channel/provider/data-import or release acceptance obligations.


## Nonportable controls and stateless Responses — 2026-09-26

Inspected existing request schema, service state guard and outbound Responses payload. n was already limited to 1; previous_response_id/background/store:true were already rejected even on native routes. Added non-null conversation rejection to that policy. Cross-protocol bridge now rejects non-null Chat logit_bias and Messages container before upstream I/O, while native forwarding preserves them. No provider capability or state persistence was introduced. Errors identify field names without echoing control values.

Added 36 JSON/SSE matrix cases for native preservation or rejection, plus 18 default/null control cases. Rejections assert zero upstream calls, attempts, reserved/input/output tokens and no remaining lease. Native mocks assert observed wire controls and ordinary usage settlement. Initial focused run exposed incorrect test assumptions about native Responses state support; corrected those assumptions rather than weakening existing policy. Final focused result54 passed.

All required gates passed: typecheck; full API1294 passed (2 skipped,36 TODO), web92 passed; build; gateway1086 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). Logs: /tmp/coati-state-controls-{focused-final,typecheck,tests,build,gate}.log. Build retains the existing large-chunk warning. No schema changes, real supplier requests, production writes, commit or publication. The 36 matrix TODOs remain because this slice does not close the full unsupported-field catalog or sustained slow-client acceptance.

Read the Python personal-channel endpoints, owner scoping, prefix/model matching and runtime selection; recorded the implementation dependencies and acceptance obligations in personal-channel-migration.md. This is source-derived migration preparation, not evidence that personal channels are implemented.


## Personal-channel ownership and platform isolation foundation — 2026-09-26

Read Python my_channels.py, credential_service.py ownership/limit/prefix methods, credential CRUD scope filters, model prefix/display mapping and gateway personal selection/model catalog. Implemented the ownership prerequisite, not the full personal-channel feature. 0028_gateway_personal_scope adds scope (existing rows default platform), nullable owner FK, model_prefix, owner/scope index and a CHECK linking platform/null-owner/empty-prefix versus personal/non-null-owner/nonblank-prefix. No secret conversion or model mutation.

Platform account list/save/disable, migration snapshot account projection, joined legacy route account details, public automatic pools, explicit candidates/models, recovery probe selection/claims and lease acquisition exclude personal accounts. Public and explicit binding saves share-lock the referenced account and verify platform ownership inside the transaction. Native platform saves cannot set scope/owner/prefix through their values. Request acquisition rechecks scope under the account row lock. No personal write API is exposed yet; owner-aware CRUD, model visibility, runtime selection, probes and UI remain pending.

Five PostgreSQL/API cases passed: guessed personal ID cannot update/disable/probe via platform endpoints; platform list and preflight omit personal details; repository/API binding rejects personal targets; automatic pool and malformed historical explicit reference cannot select personal accounts; post-selection scope change cannot acquire a lease; malformed ownership CHECK combinations reject while existing platform defaults remain valid. Probe candidate assertion compares IDs explicitly. No real supplier calls or production writes.

Applied migration to isolated dev and test: both prior28/max1790371770471, now29/max1790373122879 (0028_gateway_personal_scope). psql inspected real columns/defaults, index, CHECK and owner FK. Required gate results recorded below. Logs /tmp/coati-personal-scope-{generate,migrate,format,format-tests,focused,typecheck-final,tests,build,gate}.log.

Final required checks passed: typecheck; API1299 passed (2 skipped,36 TODO), web92 passed; build; gateway1091 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). git diff --check passes. Existing large-chunk build warning remains. No commit/publication or complete personal-channel acceptance claim.


## Owner-scoped personal model catalog and execution — 2026-09-26

Added personal-route.ts with Python-compatible prefix normalization and declared/default model mapping. Repository model discovery/candidate selection accepts the authenticated owner; enabled personal matches take precedence and cooling is evaluated by PostgreSQL. A matched but cooled pool returns no candidates rather than entering the platform pool. Service still filters key model grants and uses existing reservation, protocol conversion, controlled transport, usage, terminal settlement and lease lifecycle. Lease acquisition separately rechecks personal ownership/prefix/model/enabled/health under current account locking; affinity binding eligibility uses the same owner-aware resolver. Execution snapshots distinguish personal with null route_id and real upstream_id. This is a JSON type extension, not a schema migration.

Health success/failure writes from execution now include the observed account snapshot; repository guards scope/owner as well as secret/base/protocol. Owner changes after a completed admission do not retroactively rewrite execution provenance. Platform background probe APIs remain isolated; personal probe management is still pending.

26 focused cases passed:18 real handler/local mock combinations (nine protocol pairs, JSON/SSE), each doing a two-request tool exchange with public/wire name, auth header, cache-read counters, settled usage, health and lease assertions;3 slash/hyphen prefix cases; no platform fallback for a cooled personal match; model grants and budget denial before I/O; wrong owner/changed prefix lease checks; two real users sharing a model alias/session with distinct target and binding rows; and retry within the owned pool with later session affinity to the surviving account. No real supplier calls or production writes. Personal CRUD/discovery/probe API, UI, additional cancellation/failure stress and full data migration remain pending. Logs /tmp/coati-personal-runtime-{format,format-tests,format-final,focused,focused-final,typecheck-final,tests,build,gate}.log. Full gate results follow.

All required checks passed: typecheck; API1325 passed (2 skipped,36 TODO), web92 passed; build; gateway1117 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). git diff --check passed. Existing bundle-size warning remains. Database schema head remains0028. No commit/publication or claim of complete personal-channel/release acceptance.


## Native personal-channel management and deletion history — 2026-09-26

Read Python credential normalization/serialization/delete behavior in addition to the prior ownership contract. Added personal-channel service and native GET/POST /api/admin/gateway/my-channels plus PUT/DELETE /:id. Uses session owner, dedicated permissions and existing CSRF guard. Strict payload validation rejects owner/scope and unimplemented fields; partial edits merge the currently locked row inside the repository transaction. Owner advisory lock serializes five-row counting/create/delete; disabled rows count. Secret material remains encrypted, unchanged when omitted and excluded by response allowlist. List filters/pagination operate over at most five owned rows.

Deletion requires disabled, no platform route reference and no request lease. 0029_gateway_channel_history changes attempts upstream FK to nullable ON DELETE SET NULL: historical request/attempt records and execution snapshots survive physical channel deletion. Existing account values are unchanged. Applied isolated dev/test from29/max1790373122879 to30/max1790374056078; psql inspected actual nullable column and delete rule. Incremental dev seed added gateway_my_channels and three action permissions with hidden navigation until the page exists; checked IDs were unoccupied. English/Japanese menu labels added.

12 focused cases passed: CRUD through actual handler followed by local mock call and deletion with history preserved; concurrent disjoint partial edits; seven concurrent disabled creations admit exactly five, delete frees a slot; seven invalid/unimplemented input cases; PAT/CSRF denial; ordinary user permission denial and two administrators still unable to modify each other's channels or platform accounts; active lease prevents deletion. Migration also tested by the real history-delete operation. No real supplier calls, production writes, commit or publication.

Initial full test failed frontend menu-translation completeness for the four new permissions; added both locale names, confirmed no live test process remained, and reran. Logs /tmp/coati-personal-crud-{generate,migrate,seed,format,format-tests,focused,typecheck-final,tests,tests-final,build,gate}.log. Python management aliases, full legacy credential fields and summary, proxy/headers/timeout/note, automatic create probe, discovery/probe/catalog endpoints and UI remain pending. This is the native CRUD stage, not a replacement for full Python parity. Final gate outcome follows.

The next full run exposed a seed-test assumption that every menu-type permission must be visible. Updated that test to keep buttons hidden, require visible entries to be menu-type, and require hidden menu groups to have null path/component. This preserves the deliberate API-only group without shipping a broken navigation target. Restarted the full required suite after the prior process exited; final test log is /tmp/coati-personal-crud-tests-complete.log.

Final required gates passed: typecheck; API1337 passed (2 skipped,36 TODO), web92 passed; build; gateway1129 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). git diff --check passes. Existing bundle-size warning remains. Both isolated dev/test databases are at0029_gateway_channel_history; no commit or publication. Personal-channel full parity and overall release acceptance remain incomplete.


## Personal discovery, manual checks and post-create observation — 2026-09-26

Read Python _probe_upstream/_assert_saved_probe_unchanged/check/_probe_after_create. Added owner-authenticated native POST my-channels/discover-models and /:id/check using a new gateway_my_channels_test permission. Stored credentials require matching saved base/protocol unless the caller explicitly supplies a draft key; even draft requests with a saved ID must own that record. Discovery uses controlled bounded transport with at most30s timeout and does not update configured models/health.

Manual probes now use owner-qualified database claims and snapshot scope/owner guards during completion. Default platform callers/background candidate queries remain platform-only. Deletion rejects active probe claims in addition to request leases. Messages discovery remains unverified for conversation health. Creation commits before probing; observations, including failures, return in health_probe with201 instead of pretending the saved record failed. Disabled channels retain the Node disabled-probe rejection. Personal list exposes safe probe metadata and redacted last_error, never secret/ciphertext/claim tokens. Extended probe error redaction to encrypted credential and claim values as well as the plaintext key.

Eight new tests plus extension of the prior foreign-owner test: create observation normal/HTTP error/unsupported/HTML; Messages unverified; saved-target/protocol override denial with no I/O; draft header use and read-only discovery; concurrent real HTTP checks with blocked transport and409 second claim; disable during probe causes stale result and deletion is blocked until claim release; returned/persisted errors strip plaintext/cipher/claim values. The first added redaction test incorrectly expected an undefined property instead of absence; corrected it to not.toHaveProperty, without changing the response. Final focused20 passed (new8 plus prior12 CRUD).

Incrementally seeded hidden gateway_my_channels_test permission after checking ID10054 was free, with both locale names. No schema change; database head remains0029. No real supplier requests, production writes, commit or publication. Personal background recovery, legacy path/field/provider catalog parity, proxy/headers/timeout and console remain pending. Logs /tmp/coati-personal-probe-{format,format-tests,format-final,seed,focused,focused-final,focused-complete,typecheck-final,tests,build,gate}.log. Full gate result follows.

Full test result: API1344 passed with one i18n coverage failure (2 skipped,36 TODO), web92 passed. The failure was the two new observation messages missing locale entries. Added English/Japanese entries for both plus personal-channel validation errors; reran the complete five-test i18n file rather than repeating unrelated DB tests. It passed. Typecheck/build/gateway gate rerun after that catalog change; final result follows. Logs /tmp/coati-personal-probe-{i18n,typecheck-complete}.log supplement the preceding run.

Final closure:20 focused personal probe/CRUD cases passed; the full run had API1344 passed plus the one subsequently repaired i18n case, and web92 passed. All five i18n tests passed on targeted revalidation. Final typecheck and build passed; gateway1137 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). git diff --check passed. Existing bundle-size warning remains. This records combined verification evidence, not a new fully green pnpm test run after the locale-only fix.


## Owner-aware personal background recovery — 2026-09-26

Inspected current worker call sites: only the internal worker calls runProbeBatch; administrative probe endpoints call the scoped service directly. Added an explicit includePersonal option to repository recovery selection (defaultfalse). Worker opts in to the shared oldest-first five-row queue and passes each selected owner_user_id into probeUpstream. Scope/owner are rechecked before credential access and at atomic claim/completion; default platform queries retain isolation. No schema, permission or UI change.

Four focused PostgreSQL/local HTTP cases passed: two GatewayService instances compete for a cooled personal account and send only one probe, resetting cooldown/failures on verification; shared batch max5 and disabled/recently-checked exclusion; Messages keeps cooldown unverified and honors the10-minute quiet interval; owner-to-platform scope change after candidate selection yields no network I/O through the stale owner. The focused -t filter skipped the separate two worker lifecycle unit cases; the required full suite/gateway gate below runs them. This is same-process multi-instance evidence, not actual replica process-failure acceptance.

No real supplier calls, production writes, schema migration, commit or publication. Current schema remains0029. Logs /tmp/coati-personal-recovery-{format,focused,typecheck,tests,build,gate}.log. Full gate outcome follows.

Final required checks passed: typecheck; fresh full API1349 passed (2 skipped,36 TODO), web92 passed; build; gateway1141 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). The full run includes the previously repaired i18n coverage and both worker lifecycle tests. git diff --check passed. Existing bundle-size warning remains; no production readiness or whole-goal completion claim.


## Account headers and notes across configuration and wire paths — 2026-09-26

Read Python credential header normalization and notes. Added shared header validator/merger, extra_headers JSONB default{} and nullable note in0030_gateway_account_headers. Native platform and personal saves preserve omitted values and allow explicit clearing; JSON strings and scalar header values normalize, unsafe auth/connection headers, illegal names, CR/LF, >20 fields and oversized values reject before creation/I/O. Native nested header values remain explicitly unsupported; full Python loose-input/extra_headers_json alias adaptation remains pending.

Headers now flow through actual model transport, model discovery, manual probes and background recovery. Saved discovery inherits account headers; explicit draft override does not persist. Canonical lower-case merging preserves gateway-owned authentication and allows supported protocol metadata overrides. Health success/failure/probe completion compare the observed JSONB headers so edited configuration is not overwritten by old observations. Error redaction includes custom header values in addition to API credentials; normal response content is not modified.

Applied dev/test from30/max1790374056078 to31/max1790375553042; psql inspected actual JSONB default/non-null and nullable note.31 initial focused cases passed:18 protocol pairs×mode wire/auth checks,11 unsafe-header configurations, personal CRUD/invoke/check/draft/clear and stale-health/error-redaction cases. Added one platform management preservation/runtime/probe case before full gates. No real supplier calls, production writes, commit or publication. Logs /tmp/coati-account-headers-{generate,migrate,format,format-tests,format-final,focused,typecheck-final,tests,build,gate}.log. Final gate result follows.

Final required checks passed: typecheck; full API1381 passed (2 skipped,36 TODO), web92 passed; build; gateway1173 passed (36 TODO, scoped lint/migration chain/isolated bootstrap). This includes all32 new header/note cases and existing personal/platform regressions. git diff --check passed. Existing bundle-size warning remains. Both isolated databases are at0030_gateway_account_headers; full legacy credential/UI and release acceptance remain pending.

## Account inactivity timeout — 2026-09-26

Read Python request_timeout_seconds use in urllib and installed Undici dispatch implementation. Added0031 integer default120/check5..300 and native account configuration, per-dispatch header/body limits, pre-header cancellation timer, bounded timeout cause classification and selected-account SSE watchdog. Discovery remains capped at30s. The shared origin pool is retained; a composed dispatcher only overrides this request. Parent cancellation, the10s connect cap and180s overall request bound remain in force. Health/probe updates additionally compare observed timeout configuration.

14 focused transport/schema tests passed using actual local HTTP: separate accounts on one origin, delayed headers/socket closure, body stall, progressing body longer than the idle limit, discovery stall, cancellation after headers and invalid/valid settings. Three full gateway tests passed with actual5s configured limits: headers/body produce504, stream emits error without DONE, requests leave reserved state, sockets/leases release and the next request succeeds. The first test assertion incorrectly expected historical reserved_tokens to be erased; corrected it to inspect active reservation status, which is the actual accounting rule. Added real header-timeout account failover coverage before full regression.

Recorded dev/test starting31/max1790375553042; applied0031 to both isolated databases, now32/max1790376138462. Inspected the real default120/non-null column and range constraint. No Python database or real supplier accessed. Logs /tmp/coati-account-timeout-{focused,integration,migrate,typecheck-final,tests,build,gate}.log. Full gate results follow.

Full pnpm test: API1398 passed with one newly added timeout-failover fixture failure,2 skipped/36 TODO; web92 passed. The backup fixture was encrypted by a separately configured service instead of the application handling the request, producing a decryption failure after the first timeout. Changed backup creation to the same administrative API used by the primary account; the real5s failover test then passed. No production code change was needed for that failure. Typecheck/build passed. Final gateway gate after the fixture repair follows; combined evidence must not be described as a new fully green pnpm test run.

Final closure: repaired failover case passed; final gateway gate1191 passed with36 TODO, including all18 new timeout cases, scoped lint, migration chain and isolated bootstrap. Final typecheck/build and git diff --check passed. Frontend92 passed; the broader API run plus targeted repair is recorded above without claiming another complete run. Dev/test are at0031_gateway_account_timeout. Existing bundle-size warning and2 broad-suite skips remain. No commit/push or release performed; overall migration goal stays active.

## Account outbound proxy — 2026-09-26

Read Python normalize_proxy_url, encrypted storage/hints and runtime/discovery selection, plus installed Undici ProxyAgent implementation. Added0032 nullable proxy_secret/proxy_hint; native platform/personal CRUD encrypts full proxy URLs and returns only hint/presence. Omitted updates preserve credentials, explicit null/empty clears. Runtime, model discovery and probes pass the selected proxy; transient discovery overrides do not persist. Health writes compare observed encrypted proxy configuration. Added recursive audit masking and error redaction, including encoded/decoded credentials and Basic payload. Upstream custom headers reject Proxy-Authorization.

Transport uses HTTP(S) CONNECT with separate target/proxy DNS validation and address pinning while retaining target Host/TLS identity. Each proxy dispatcher is request-scoped and closes after consumption/cancellation; failure never falls back to direct transport. Private endpoints require the existing allow-private setting. Proxy servers must support CONNECT. This round tested local HTTP proxy transport; real HTTPS proxy/TLS deployment acceptance remains pending and is not implied by the matrix fixtures.

Initial14 transport/schema cases exposed trailing-CRLF normalization before validation; validation now checks original input before trimming. Integration35 passed plus one stale test that still rejected proxy_url as unimplemented; changed that case to the genuinely unsupported socks5 scheme. Full pnpm test then passed API1433 (2 skipped,36 TODO) and web92. Added two checks afterward: recursive audit payload masking and a nonresponding CONNECT handshake. The latter initially left the test server's half-open socket unread; explicitly consuming FIN and closing the server side made all16 transport/schema/audit tests pass. No production transport change was required for this fixture correction.

The18 matrix cases exercise all9 pairs in JSON/SSE through the proxy with isolated auth and successful settlement. Two personal API cases cover encrypted storage/preservation/clear, draft overrides, stale-health guards and returned/persisted error masking. Development and test databases migrated from32/max1790376138462 to33/max1790376915676 (0032_gateway_account_proxy); inspected real nullable text columns. Typecheck/build passed; existing bundle-size warning remains. Logs /tmp/coati-account-proxy-{generate,focused,integration,migrate,typecheck-final,tests,build,focused-final,gate}.log. Final gate result follows. No Codex configuration, Python database, live supplier, commit or publication changed.

Remaining proxy parity obligation: Python can forward plain HTTP through a proxy without CONNECT. The current implementation requires CONNECT even for HTTP targets; forward-only proxy support is not yet migrated. This is an explicit remaining requirement rather than a permanent narrowing of supported deployments.

Final proxy-stage gate:1227 passed/36 TODO, with scoped lint, migration chain and isolated bootstrap. This includes the two additional audit/CONNECT-close tests after the full1433 API/92 web run. Final typecheck and diff whitespace checks passed. Proxy native integration is verified to this scope; HTTP forward-only parity, HTTPS proxy deployment, console and legacy API compatibility remain open, along with the overall roadmap.

## Forward-only HTTP proxy compatibility and local TLS — 2026-09-26

Changed plain HTTP destinations to absolute-URI proxy forwarding while HTTPS keeps CONNECT. Pinned target addresses are placed in the forwarded URI; original Host is restored at dispatch time because fetch owns Host. Initial interception through a composed Pool did not affect Undici's internal symbol dispatch; a real-wire assertion caught the unpinned hostname. Replaced it with explicit pinned request URI and dispatch-time Host, preserving path/query and avoiding proxy-side DNS resolution. Test proxy forwarding disables its own idle connection pool so cleanup assertions inspect active sockets rather than unrelated retained test sockets.

All21 initial transport/TLS cases passed, including existing16 plus three TLS path combinations and two hostname-mismatch rejections. Added two untrusted-certificate rejection cases before full regression. TLS tests use a clearly labeled public localhost fixture certificate/key, temporarily trusted only within their isolated worker and restored afterward. No system/Codex TLS settings or real suppliers are used. Existing18 protocol-matrix proxy tests now use HTTP forwarding through the updated fixture. Default HTTPS validation, manual redirects, request-scoped credentials, body timeout, cancellation and CONNECT timeout remain covered.

No database change; head remains0032. Logs /tmp/coati-proxy-forward-{format-final,typecheck-final,transport-tls,tests,build,gate}.log. Full checks follow. Real deployment acceptance and remaining console/legacy API obligations are not closed by these fixtures.

Final checks passed: fresh full API1442 (2 skipped,36 TODO), web92; typecheck/build; gateway1234 (36 TODO, scoped lint/migration chain/isolated bootstrap); git diff --check. This includes all7 new TLS cases and the prior proxy matrix now using HTTP forwarding. The former forward-only compatibility gap is closed to local HTTP/TLS fixture scope; real deployment/provider acceptance remains open. Database remains0032; no commit/push or system/Codex configuration changes.

## Account provider/protocol catalog endpoints — 2026-09-26

Read Python constants, provider adapter catalog construction and both platform/personal API permission contracts. Added eight read-only endpoints across native and legacy paths. Static catalog functions clone their outputs; native protocols add gateway_protocol while legacy shapes match Python. Gemini stays reserved, model defaults stay empty, Messages discovery remains separate from verified health. No provider-network assumptions were inferred from the catalog.

Added a reproducible AST-based exporter and source-hashed fixture for the actual local Python reference. Eleven focused cases passed: source hashes, complete catalog shape and mutation isolation, eight endpoint/session/permission checks, and a real PostgreSQL role grant proving personal catalog access cannot grant platform access. No schema or seed change and no external supplier calls. Logs /tmp/coati-account-catalog-{focused,typecheck,tests,build,gate}.log. Required checks follow; remaining CRUD field/path and UI obligations remain open.

Catalog review exposed a runtime mismatch: Node always appended /messages, whereas the Python adapter supports bare Anthropic roots and full endpoint URLs for all protocols. Added upstreamEndpoint with the Python suffix rules and connected actual transport selection;16 live local HTTP tests passed across root/version/full/trailing-slash inputs and JSON/SSE, with one request and successful settlement each. This is required for the preserved catalog defaults to be usable.

The first broad catalog run had API1452 passed and one proxy-body-timeout fixture failure, web92 passed. Under load its100ms timeout expired before headers, so it did not reach the intended body-stall assertion. Increased only that test's allowance to1000ms; production timeout configuration is unchanged. Re-running full required checks after endpoint correction and this fixture stabilization. Supplemental logs /tmp/coati-account-catalog-{endpoint,typecheck-final,tests-final,build-final,gate-final}.log.

Final catalog/endpoint checks passed: fresh full API1469 (2 skipped,36 TODO), web92; typecheck/build; gateway1261 (36 TODO, scoped lint/migration chain/isolated bootstrap); git diff --check. All27 new catalog/endpoint cases are included. Existing bundle-size warning remains. No schema change (head0032), real supplier calls, Codex configuration edits, commit or push. Legacy account metadata/list/CRUD compatibility and personal console remain pending.

## Account metadata and ownership-scoped summaries — 2026-09-26

Read Python credential model/serialization, crypto hints/fingerprints and CRUD touch/health/summary rules. Added0033 nullable hints/fingerprint and updated/use/check/success/error/latency fields. Migration deliberately adds updated_at without filling historical rows, then sets the default for new rows. Node repository updates maintain updated_at, execution snapshots atomically record use before dispatch, accepted health writes maintain observation metadata, and success clears error time. Probe completion preserves newer health latency when a late probe is superseded. Personal create rereads its owned row after post-create observation.

Seven focused real-DB/HTTP and boundary cases passed: platform metadata retention/rotation with no plaintext response, runtime failure→success and stale failure rejection, personal checked/unverified/rotation behavior, unknown history and stale probe latency, Unicode hint boundary, exact health/cooldown summary buckets, and personal/platform scope with unfiltered summary. Summary follows Python's distinction between active cooldown and recovery pending. This does not yet expose the full legacy credential CRUD/list contract.

Dev/test started33/max1790376915676; migrated to0033 (34/max1790384235574), inspected all eight nullable columns and updated_at default. No synthetic fingerprint/history backfill; untouched old credentials remain a controlled data-migration obligation. Logs /tmp/coati-account-metadata-{generate,migrate,focused-final,typecheck-final,tests,build,gate}.log. No live supplier calls, Python DB, Codex configuration edits or publication. Full checks follow.

Final required checks passed: full API1476 (2 skipped,36 TODO), web92; typecheck/build; gateway1268 (36 TODO, scoped lint/migration chain/isolated bootstrap); git diff --check. Dev/test are at0033_gateway_account_metadata,34/max1790384235574. Existing bundle-size warning remains. Legacy credential aliases/CRUD/list serialization, historical credential metadata backfill and personal console are still pending; this stage does not complete the full migration goal.

## Legacy account list compatibility — 2026-09-26

Implemented platform credentials and owner-scoped my-channels GET aliases. Compared Python service/CRUD/model/pagination contracts; repository applies SQL ILIKE using legacy protocol names, scope/filter conditions, descending pagination and a repeatable-read list/count/unfiltered-summary snapshot. Service emits an explicit Python field allowlist without credential/proxy ciphertext or probe claims. No schema change.

Six real-DB/API cases cover session/menu rejection, exact serialized shape and secret exclusion, scope/pagination/summary, protocol and SQL wildcard filters/boolean semantics, pagination boundaries, and personal-only role grants with forged owner/scope and superadmin isolation. First run exposed timestamp microsecond loss for non-UTC PostgreSQL text; serializer now converts the whole-second timezone separately and preserves the fractional microseconds. Focused rerun6/6 and typecheck passed. Logs /tmp/coati-account-list-{focused,focused-final,typecheck-final,tests,build,gate}.log. Full required checks in progress. No supplier calls, configuration changes or publication. Legacy account writes and complete migration acceptance remain open.

Final required checks passed: full API1482 (2 skipped,36 TODO), web92; typecheck/build; gateway1274 (36 TODO, scoped lint/migration chain/isolated bootstrap). Existing bundle-size warning remains. Database schema unchanged at0033; no commit/push or Codex/system configuration edits. These results close the two legacy GET list contracts to local database/API test scope, not legacy CRUD, UI or final deployment acceptance.

## Account management API module — 2026-09-26

Following the user's change to module-sized delivery and focused validation, completed legacy platform/personal create/update/delete/discovery/check plus platform copy and batch probe. No schema migration. Added three workflow tests covering encrypted-key preservation, defaults/provider inference, copy reset, reference/enable deletion guards, post-create failure persistence, discovery destination protection, check/batch results, and ownership/menu rejection. Combined with the six existing list cases, focused9/9 passed in2.63s; typecheck and changed gateway files ESLint passed. Logs /tmp/coati-account-write-{typecheck-final,lint,focused-final,delete-regression}.log. Existing personal deletion tests are rerun for the shared repository change. No full suite/build/gateway gate rerun this turn, no real supplier calls or configuration/publication changes. Personal UI and remaining model-profile/cache-tool/data-migration work remain separate.

Shared personal deletion regression2/2 passed (other gateway cases deliberately excluded by name filter); git diff --check passed. No commit/push. Next module is personal channel console and account configuration controls.

## Account console module — 2026-09-26

Shared AccountsPage replaces the upstream screen and adds /gateway/my-channels. Form groups connection, models and advanced scheduling; exposes prefix, timeout, proxy keep/replace/clear, JSON headers and note. Explicit writable payloads prevent personal strict-schema failures or accidental credential/proxy clearing. Discovery is explicit-add and discards results after dialog/config changes. Lists expose scoped check/edit/delete, platform copy, disabled-delete guards, five-channel cap and stale-load protection. Existing gateway_my_channels menu is now visible with its dynamic route; incrementally seeded coati_node_dev and confirmed its path/component/visibility. No schema change.

Scoped ESLint and frontend build passed (existing bundle warning); two workflow component cases passed for writable payload/credential-proxy preservation and cap/permission restrictions. Browser checked actual dev admin session: platform/personal empty lists, personal form/advanced expansion at1280x720, form and required-field errors at390x844 with visible fixed footer. Viewport restored. No real credentials saved, supplier calls or browser write/delete acceptance claimed. Dev API5004/web5175 restarted for preview. Full regression deliberately omitted per current user preference; no commit/push. Logs /tmp/coati-accounts-ui-{tests-final,lint-final,build-final,seed}.log.

## Model capability profiles — 2026-09-26

Added0034_gateway_model_profiles, CRUD/candidates/catalog-import with native and legacy paths, seeded model-capability menu/buttons, and console. Overrides survive catalog refresh; explicit null restores catalog/defaults; disabled profiles do not affect model metadata. Source catalog imports are operator supplied: no LiteLLM or implicit external sync. Personal model targets take precedence, and explicit multi-target aliases use conservative limits. Metadata does not enforce output truncation or configure client compaction.

Three focused real-DB/API/service workflows passed: override/import/clear/disabled-delete; permission/atomic invalid import/no-external-sync; alias/personal capability resolution, disabled fallback, direct override and key model filtering. Typecheck, scoped page ESLint, frontend build and diff whitespace check passed; existing bundle warning remains. Dev/test and a newly created isolated coati_profiles_install_20260926 database reached35 migrations/max1790386861462 (0034), with unique/token-limit constraints inspected. Fresh database removed after verification.

Actual browser checked admin list, create/save64000, clear with keyboard and save to128000 default, desktop1280x720 and390x844 dialog layout. Browser number-input fill('') did not dispatch a clearing edit; keyboard selection/backspace verified actual behavior. Temporary ui-profile-check-20260926 record removed from dev afterward; no supplier calls. Logs /tmp/coati-profiles-{test,typecheck-final,lint,build,fresh-migrate}.log. Full regression omitted per user instruction; no commit/push or Codex/system configuration changes. Cache-test execution/history, Python catalog import and bootstrap compaction metadata remain pending.

## Cache verification module — 2026-09-26

Added0035_gateway_cache_tests, owner-scoped repository/admin routes, existing-key selection and shared gateway execution, round/summary statistics and console. Selected expired/revoked keys return409 so they do not log out the valid admin session. Each round rechecks key, reservation retains model/scope/quota enforcement, and usage/account identity is read from settled gateway requests. Unknown cache values remain null; reported0 stays0; complete denominator includes cache writes. Stops at first failure, preserves partial results, and warns on account/model changes. Prompt persists only in owned detail and is masked in operation audit. No generated internal credential or bypass quota path.

Three focused workflows passed using isolated real PostgreSQL and a local HTTP mock (Fastify inject for incoming admin requests). Verified3 identical upstream bodies, one session,303Token accounting,0/75/75 cache reads, unknown counters, partial failure, actual account switch warning, permission/owner isolation, revoked key,quota and pre-aborted cancellation with zero upstream calls. In-flight cancellation uses the existing gateway signal path; no new live-provider or full cancellation soak claim. Typecheck/scoped ESLint/frontend build passed; existing bundle warning remains. Dev/test and new coati_cache_install_20260926 reached36 migrations/max1790387760297 (0035); inspected table and owner/time index, removed fresh database. Logs /tmp/coati-cache-{tests,typecheck,lint,api-lint,build,migrate,fresh-migrate}.log.

Browser checked actual dev empty list and new-run form at desktop and390x844, quota/prompt-storage copy and no-available-token state. No run submitted against dev upstreams. Details/record persistence verified through API, not browser end-to-end live-provider run. Viewport restored; no commit/push or system/Codex config changes. Explicit key_id and summary/results are Node contracts; old Python field-level compatibility/history import remain tracked. Process crash recovery of pending verification runs is not implemented. Real supplier caching remains separate acceptance.

## Fake-IP/platform egress compatibility — 2026-09-26

Separated platform and personal connection pools. Only platform hostname DNS answers in198.18/15 and2001:2::/48 gain a Fake-IP exception; literals and other private ranges remain rejected by default. Scope is derived from stored account ownership or protected platform discovery routes. Platform proxy requests use hostname CONNECT/forwarding with proxy-side DNS; optional deployment GATEWAY_TRUSTED_PROXY_URL applies only to platform accounts without their own proxy. Personal proxy/IP pinning remains unchanged. Added missing IPv6 benchmark-range classification. TLS validation and manual redirects retained. Transport validates origin while preserving legitimate endpoint query strings, and shutdown tolerates proxies already destroyed during response errors.

Focused policy/proxy-TLS checks and typecheck/scoped lint used; no full suite. Initial focused run caught overbroad query-string validation and proxy shutdown race, both repaired. No-key DeepSeek /models comparison: platform401, personalblocked at Fake-IP resolution. This proves connectivity, not validity of user credentials or model-call acceptance. No machine/proxy/Codex/actual.env changes and no commit/push. See egress-policy.md for trust boundary. Logs /tmp/coati-egress-{tests,typecheck,lint}.log.

## Independent search/fetch adapter — 2026-09-26

Implemented Python Tavily request/response adapter in search-provider.ts. Real local HTTP fixture checks3 workflows: search contract/source dedup/domain boundaries; delegated extraction, truncation and restricted input/result URLs; sanitized provider errors and pre-cancel zero calls. Initial restricted-URL check exposed localhost-with-trailing-dot normalization, corrected before passing. Domain/path legacy semantics, settings resolution, direct gateway route, delegated-model fallback, quota/audit and JSON/SSE server-tool loop are explicitly still pending. No public route added or real supplier/model called. Typecheck and scoped ESLint passed. Logs /tmp/coati-search-provider-{tests,typecheck,lint}.log. No schema change, commit/push or machine configuration changes.


## Search settings management — 2026-09-26

Added encrypted singleton settings with field-level environment fallback, explicit clear and reset; protected native/legacy management endpoints and saved-config connection check; console menu and form. Two focused real-test-DB/local-HTTP workflows passed, covering encrypted persistence, non-echo, preserve/clear/reset, zero outbound calls on save/read, mock provider check and permission denial. Typecheck, scoped API/web ESLint and web build passed. No full-suite rerun or real provider/model calls. Browser verified loaded disabled state, unavailable check button and 390px layout, then restored viewport; live settings were not changed. Migration0036 applied to dev/test and fresh coati_search_install_20260926 (subsequently dropped), 37 journal entries; RBAC incrementally seeded in dev. Logs /tmp/coati-search-settings-{tests,typecheck,lint,api-lint,build,migrate,fresh}.log. Public search/tool execution remains pending. No commit/push or machine/Codex/actual.env modifications.

## Direct search API governance - 2026-09-26

Four focused real-test-DB/local-HTTP workflows passed: native/legacy response IDs and bounded estimates with no query-body logging; auth/scope/model/daily quota and simultaneous concurrency rejection; supplier failure and pre-cancel settlement; missing provider with zero calls. Initial concurrency fixture used the wrong field name, corrected before passing. Typecheck and scoped service ESLint passed. No full regression, schema changes, real supplier/model calls, actual environment modifications, commit or push. Logs /tmp/coati-web-search-{tests,typecheck,lint}.log. Local estimates are not supplier billing. Model fallback and multi-round tool audit remain pending.

## Rotation and cache interruption recovery - 2026-09-26

One PostgreSQL rotation workflow passed (dry-run, invalid source rollback, all encrypted fields, historical read key and reverse rotation). Four cache workflows passed including durable checkpoints and stale-run recovery with late-write protection. Typecheck, scoped API/web ESLint and API build passed. The rotation CLI is included in the production build. Compose now forwards optional search/provider/proxy and historical read-key settings to API/worker. No real credentials were rotated; no actual environment files, system or Codex settings were modified. No full-suite rerun, commit, push or release. Logs /tmp/coati-rotation-tests.log, /tmp/coati-cache-recovery-tests.log and /tmp/coati-finish-*.log.

## Completion batch — 2026-09-26

This batch adds delegated native search/fetch, bounded multi-round server tools, domain/path/result filtering, native refusal fallback, cache-run durability and imported-history presentation, offline master-key rotation, encrypted read-only Python export and transactional fresh-database import. Migration0037 is applied to the isolated development/test databases; fresh installation contains38 migrations. No source/production database or real model was used.

One broad integration run produced API1513 passes,1 i18n failure,2 skips and36 existing TODOs; web91 passes and3 translation/import failures. Those failures were repaired and the affected suites rerun successfully. New changes after that run were validated with focused checks rather than repeating the entire suite. Latest focused workflows include7 server-tool cases,6 direct/delegated search/fetch cases,4 provider cases,2 archive cases,1 import workflow,5 backend i18n checks and7 web i18n/import checks. Official OpenAI7.23.0 / Anthropic0.128.0 SDKs additionally passed one six-request JSON/SSE gateway workflow over real local sockets, backed only by a local mock provider. These counts are not advertised as a new whole-suite result.

Typecheck, production build, gateway static lint and diff whitespace checks pass. The image smoke passed fresh installation,38 migrations, administrator bootstrap, console HTML, database health,pg_dump/pg_restore and idempotent restart. Its randomly named containers/network were removed; the local image remains. CI uses the same smoke and runs the test suite once instead of duplicating gateway tests through the static gate. Remote CI has not been run.

New-runtime source/example/deployment paths were scanned for known company identifiers with no matches. Python reference remains unchanged. This is not a full secret-history audit or a publication approval. No commit,push,release,real-paid request,existing environment secret,Codex configuration or production deployment was changed. See roadmap.md for current boundaries and outstanding external acceptance.

## Real DeepSeek acceptance — 2026-09-26

Used the existing enabled DeepSeek account ID 3 in the application's **localhost TCP** `coati_node_dev` database. Model discovery returned `deepseek-flash` and `deepseek-v4-pro`. There were no configured public/explicit routes; created one unique temporary route pinned to this account and a one-day token limited to that alias, 4,096 daily tokens and concurrency 1. The upstream credential was read in memory and never printed.

Six HTTP calls to the running gateway on port 5004 passed: Chat Completions, Responses and Messages, each JSON and SSE, all translated to DeepSeek's Chat upstream. Every call used the same short prompt and a maximum output of 32 tokens. All HTTP statuses were 200; SSE terminal events arrived without error events. All six request IDs matched durable `ok` rows with upstream ID 3 and usage_source=upstream. Input totaled 204 tokens; output totaled 101, total 305. Cache reads were reported as zero, misses 34 per request, and cache writes remained null. Unauthenticated model listing returned 401.

Temporary route removed; token ID 5 revoked, retaining the six request records for review. No permanent public route was created. These calls establish this provider/model's text and stream conversion plus durable reported usage. They do not establish cache hits, tool invocation, signatures, billing-currency reconciliation, or the other six outbound protocol matrix combinations. Evidence: `/tmp/coati-deepseek-live-acceptance.json` contains only statuses, IDs and usage, no token/credential or prompt response content.

## Interrupted DeepSeek cache soak — 2026-09-26

Public deepseek-flash route pinned to account 3 retained. Run stopped on user pause; temporary key revoked. 30 calls over 450 seconds, 30 successful including wire/database token equality, three inbound protocols JSON/SSE, up to 64 output tokens per call. Input 430350, cache-read 412032, weighted input cache hit 95.74%. This is a 7.5-minute sequential baseline, not completed 15-minute or multi-account/load acceptance. Evidence: /tmp/coati-deepseek-soak.json.
