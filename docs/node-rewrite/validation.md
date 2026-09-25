# Validation record — 2026-09-25

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
