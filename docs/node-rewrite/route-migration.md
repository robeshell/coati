# Existing Node candidate routes → public routes

This operation converts existing Node `gw_routes` records. It does not import a Python database or certify Python API parity. Python remains an unchanged reference. The console exposes preflight, single-candidate apply and history rollback under Models and routes → Route migration. Multi-candidate decision workflow is still pending.

## API flow

Use an authenticated admin cookie and the normal CSRF header for POST operations. Model PATs do not authorize these endpoints.

1. `GET /api/admin/gateway/route-migration/preflight` requires `gateway_routes`. Review each model's candidates, reasons and proposal. Keep the returned `model` and `version` together.
2. Only `ready_for_review` can be applied. `POST /api/admin/gateway/route-migration/apply` requires `gateway_routes_edit` and a body containing exactly `{ "model": "reviewed-model", "version": "returned-sha256" }`. A single candidate becomes a bound public route with automatic fallback disabled. `manual_review` and `blocked` cannot be applied through this operation.
3. `GET /api/admin/gateway/route-migration/history` requires `gateway_routes`. The returned journal includes the migration UUID, actor, original route rows and IDs, resulting public row and ID, and timestamps. It does not archive upstream credentials.
4. `POST /api/admin/gateway/route-migration/:id/rollback` requires `gateway_routes_edit` and CSRF. It restores the original route rows and IDs, removes the migration-created public row, and records rollback time/actor. Repeating the same rollback is idempotent.

## Transaction and conflict behavior

Apply acquires short-lived configuration table locks and recomputes preflight from the locked data before writing. Changed account or route configuration invalidates the supplied fingerprint with 409. Secret rotation and temporary health/cooldown changes are not fingerprint inputs. The immutable original rows, created public route and legacy→public ID mapping are retained in `gw_route_migrations`; original rows leave the active candidate table only in the same successful transaction. No upstream HTTP request happens under these locks.

Concurrent identical apply requests return the same successful journal if the resulting public row is unchanged. A timed-out lock or detected deadlock yields 409 and no partial migration. Lock wait is bounded to two seconds; retry after the competing operation finishes. These administrative locks can briefly delay new lease acquisition or account updates, so this is not an online zero-latency migration claim.

Rollback refuses to overwrite an edited/deleted public route or an occupied legacy name/ID. It also requires the original account to still exist. It restores route configuration, not account credentials, account declarations, health or earlier usage totals. Existing request/attempt execution snapshots and accounting are retained; their `route_kind` distinguishes public and explicit route ID namespaces. In-flight requests are not replayed by rollback.

Do not delete journal rows or rewrite their JSON to bypass a conflict. Inspect the current configuration and resolve the business decision explicitly. Multi-candidate routes retain their existing behavior until a reviewed strategy for model mapping, ordering and fallback membership is implemented.

## Evidence boundary

Isolated PostgreSQL/API tests cover preflight, migration→request→rollback→request, ID and snapshot retention, duplicate submissions, stale config, edited/deleted destination and occupied-ID conflicts, lock timeout, RBAC, CSRF and payload validation. The upstream is a local mock. Current container recovery, real multi-process contention, large configuration sets and console migration interaction are not covered by these tests.

The console has six component tests for reviewed apply, cancellation, retry/rollback, permission/search, independent load failures and stale responses. Browser checks cover empty and candidate views at 1280×720 and 390×844, proposal expansion and confirmation cancellation; browser submission and populated-history rendering are not yet verified.
