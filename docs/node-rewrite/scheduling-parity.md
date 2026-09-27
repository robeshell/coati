# Scheduling migration ledger

> 当前收尾状态见[功能收尾验收](final-functional-acceptance.md)；下文按时间保存审计过程，旧pending不作为当前待办。候选路由已由用户冻结。

> 当前迁移行为状态以 [Python → Node 行为对照账本](behavior-parity.md) 为准。本文的已开发/历史阶段结论不等同于行为完全一致。

The Python reference is `portal/backend/app/agent/service/credential_service.py`, `gateway_service.py` and `crud/credential.py`. This ledger distinguishes implemented retry classification from the remaining account-pool work.

| Concern | Python behavior | Node status / required work |
| --- | --- | --- |
| HTTP failure switch | 401/402/403, explicit billing text, 408/429 and 5xx can switch candidates | Implemented before successful response content; bounded at three attempts |
| 429 billing text | Retryable, never immediate fatal cooldown | Classifier implemented and tested; persistence not yet implemented |
| Fatal account failures | Immediate threshold, at least 1800s cooldown | Implemented in shared upstream health columns; new candidate queries exclude active cooldown |
| Ordinary failures | Threshold defaults to 3, cooldown defaults to 60s; switching/429 observations can be soft | Atomic HTTP-failure observations implemented and tested; transport/stream failure classification remains pending |
| Cooldown expiry | Expired cooldown is selectable; UI must distinguish expired from active | Database selection implemented; health UI remains pending |
| Selection order | Higher numeric credential priority first; weighted ordering / rendezvous affinity within priority buckets | Node currently has ascending route priority and ID; preserve the semantic difference explicitly during data import, implement account selection separately |
| Affinity | Does not bypass enabled/model/protocol/cooldown/scope filters | Pending shared contract and deterministic tests |
| Account concurrency | Python tracks active credential requests with leases | Database account leases implemented with expiry and idempotent release; configuration UI and process-level crash acceptance remain pending |
| Recovery probe | Model discovery can reset health; unsupported discovery must not claim success | Manual recovery API and durable worker implemented; provider-specific checks and process acceptance pending (see recovery-probes.md) |
| Personal channels | Scope and ownership filters exclude private credentials from platform candidate selection | Pending account ownership model and authorization tests |
| Network failures | Python classifies transient connection errors separately | Node currently records and stops on transport exceptions; migrate with explicit cancellation/timeout boundaries |
| Final HTTP error | Python preserves upstream HTTP status; fatal-account response extracts a sanitized message | Node still wraps most final failures as 502; error contract migration pending |

Do not mark P2 complete based on a successful second HTTP attempt. Upcoming persistence must use database transactions for short state transitions only, never hold locks across provider I/O, and must guard against stale successes clearing newer fatal failures. No provider probes may run against real accounts during tests.


## Shared health slice (2026-09-25)

Migration 0005 adds health status, failure count, cooldown deadline, last observation timestamp and sanitized error to upstreams. HTTP failures and successful completed JSON/SSE requests update these fields. Observation ordering uses attempt start time; success requires strictly newer observation time, failure accepts equal time so simultaneous failures accumulate atomically. Equal timestamps conservatively favor failure. Cold accounts are excluded from subsequent candidate queries; expired cooldown is selectable even before a new success updates the descriptive status.

This does not yet implement half-open probe leases. Each selected route is re-read under a shared route lock, then its account is locked briefly for enabled/cooldown/capacity checks and lease insertion. Locks are released before provider I/O; later administrator changes apply to subsequent acquisitions and do not cancel already leased requests. Success of a subsequent request clears health, but model-discovery recovery is still pending. Upstream health currently belongs to one stored credential per upstream; the complete provider/account-pool UI and domain separation remain P2 work. All-cold routing now returns 503 upstream_unavailable instead of 404 model_not_found; retry timing diagnostics remain pending.


## Account lease slice (2026-09-25)

Migration 0006 adds account concurrency_limit (default 10) and gw_upstream_leases, keyed by request with cascading foreign keys and an account/expiry index. Acquisition serializes on the account row across connections, deletes expired leases for that account and checks capacity before insertion. Lease expiry is the request hard timeout plus 60 seconds; the provider request retains its original AbortSignal timeout. Normal/error/stream settlement releases the lease, retries release before switching, and expired rows are reclaimed on the next account acquisition. Idle expired rows may remain stored until the next acquisition; they do not count against capacity.

Unavailable candidates do not consume the three actual attempt allowance. No upstream attempt means settlement releases the quota reservation with zero usage. Account constraints remain separate from key constraints. Cross-process crash/kill recovery and high-load acceptance are not proved by the focused database concurrency test.

## Weighted ordering slice (2026-09-25)

Migration 0007 adds positive account weight (API/UI range 1–10000, default 1). Runtime uses weighted exponential-race ordering within ascending route-priority buckets; this is sampling without replacement with the same weighted probability as Python's repeated weighted choices. Duplicate routes to one account in a priority bucket share a sample, so duplication does not increase account selection probability. Account lease/cooldown/permission gates remain authoritative.

The reusable ordering function also implements Python's SHA256 weighted rendezvous score with a checked Python example. That optional affinity mode is not yet wired into runtime: full Python session binding includes TTL, first-writer binding, rebind after failures and load-aware first-session assignment. A hash alone is not a substitute. Python descending credential priority still requires explicit import mapping to Node ascending route priority.

## Persistent session binding slice (2026-09-25)

Migration 0008 stores HMAC session scope, owner, model, account and expiry. Runtime recognizes Python's explicit session header/body aliases; prompt fingerprints do not establish bindings. Scope includes owner and public model, and plaintext session IDs are not stored. The existing encryption secret is used as the HMAC key; rotating it changes scope identity, requiring binding cleanup as part of rotation tooling.

First acquisition uses weighted rendezvous; an active binding is preferred on later requests. A transaction-scoped advisory lock serializes each scope's first binding, with the binding created together with its account lease. A concurrent candidate cannot overwrite a valid first winner. Bindings expire after one hour and refresh when less than half remains. HTTP retryable failures invalidate only the matching account binding before switching; an old account failure cannot delete a newer account binding. Expired rows are cleaned for the accessed scope; global expired-row retention cleanup remains pending.

This advances persistent affinity but does not complete Python parity: global active-binding/load-aware initial assignment, configurable TTL/disable switch, network-failure rebinding, binding diagnostics and high-contention/process-crash tests remain. Account filters and capacity checks still apply; state changes after initial candidate enumeration may conservatively reject a request rather than retry all newly eligible accounts.

## Transient connection fallback (2026-09-25)

Before response headers are returned, recognized Node socket/DNS/connect-timeout codes (including bounded fetch cause chains) can switch candidates, invalidate the matching session binding and release the account lease. Ordinary switching failures are soft health observations; a final transient failure is a hard observation. No switch occurs after response processing begins, after caller/deadline cancellation, or for an unclassified/policy/certificate-validation error. Each actual send still consumes the same three-attempt cap.

Node-specific code allowlisting replaces Python's broad substring matching for TLS errors; it does not disable certificate or address validation. Failed POSTs may already have reached the provider before a connection is lost, as with Python's retry behavior; exact provider-side deduplication is not asserted. Cleanup now preserves the pre-cleanup abort state so a network failure is not accidentally reported as a timeout.

## Shared initial-load ordering (2026-09-25)

Initial explicit sessions now read model-wide active binding counts across users, plus current unexpired account leases. Within each route priority bucket, score is (bindings + active requests + 1) / weight, with deterministic rotation after the most recent binding among equal scores, matching Python's smooth-order rule. Existing eligible bindings retain precedence. Requests without an explicit session use active request load only when there is active work; otherwise weighted random ordering remains.

Latest-binding order uses expiry as the renewal timestamp proxy while TTL is fixed at one hour. A configurable TTL will require an explicit updated_at column to keep this ordering correct. Load reads are snapshots, not a global pool-wide selection lock: simultaneous new scopes can see the same initial load. Account leases still enforce hard capacity. Sequential distribution is tested; cross-process distribution quality and race acceptance remain separate required work.


The recovery-probe API slice is documented in [recovery-probes.md](recovery-probes.md). It uses bounded GET discovery, protocol-specific health verification and stale configuration guards. The standalone opt-in runner now uses durable expiring claims and quiet windows; see recovery-probes.md for operational limits.


## Current reconciliation — 2026-09-26

See behavior-parity.md S01–S11 for current status; earlier chronological pending entries are not a current checklist. Personal sessions now use Python's stateless `personal:owner:session:model` rendezvous key, without platform binding rows. A soft failure can use a backup for this request and choose the primary again on the next request; persistent failover stickiness was a Node deviation, not the Python personal policy. Without a session, weighted active-load ties now retain weighted-random ordering.

Platform affinity respects AGENT_SESSION_AFFINITY_ENABLED (default true), AGENT_SESSION_AFFINITY_TTL_SECONDS (default 3600, bounded 60–604800) and AGENT_GATEWAY_MAX_ATTEMPTS (default 3, bounded 1–10). The switch applies to platform affinity/smooth assignment, not personal stateless routing. Changing environment values requires restarting the API. No environment/configuration file was changed by this repair.

This does not resolve scope identity, health penalty/candidate window, configurable health cooldown, environment fallback credentials, downstream HTTP status or crash-accounting differences. Do not mark full scheduling parity complete.
