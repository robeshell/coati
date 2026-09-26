# Recovery probes

## Current recovery API

`POST /api/admin/gateway/upstreams/:id/probe` requires the console session, CSRF protection and `gateway_upstreams_test`. Gateway bearer tokens cannot invoke it. Missing or disabled accounts are rejected. The endpoint takes its target and credential from the saved account; callers cannot override the destination while reusing stored secrets.

The probe uses the existing DNS/IP restrictions and connection pool, manual redirects, a 30-second maximum deadline (or the shorter configured request deadline), and a 1 MiB response limit. It issues GET requests only, first to `<base>/models`, then `<base>/v1/models` if the base does not already end in `/v1`. Unsupported paths (404/405/501), invalid JSON and empty model lists can try that second path. Authentication/other HTTP failures stop discovery. Upstream error bodies are not exposed. Both Bearer and Anthropic authentication headers match the Python discovery adapter, and stay on the configured host because redirects are never followed.

Successful results include `models`, `model_discovery_supported`, `verified`, `health_updated` and `latency_ms`. A nonempty list can recover an OpenAI Chat/Responses account. Anthropic model discovery never verifies Messages health, matching Python protocol metadata. Empty or unsupported lists do not clear health. Recovery failures use soft observations without extending cooldown or increasing failure counters, matching Python's recovery-probe policy. This endpoint is a recovery probe, not yet the legacy manual credential-check API (which applies hard failure classification).

Health writes use probe-start observation ordering and compare the saved base URL, protocol, encrypted credential and enabled state. A newer traffic failure, edited account or disabled account prevents stale recovery. `health_updated: false` distinguishes a valid discovery response from a recovery that was actually applied.

## Historical evidence

Mock HTTP plus isolated PostgreSQL tests cover all three protocol policies, unsupported/HTML/auth-failure results, cooldown preservation, bearer rejection and changed-credential snapshots. Transport tests cover URL fallback, model normalization, redirects, response bounds, timeout and private-address rejection. No actual provider requests were sent.

This paragraph originally tracked pending manual-check, transport and process-kill work. It is superseded by the final acceptance below; it is not the current task list.

## Durable worker coordination

Migration `0010_gateway_probe_claims` adds a probe token/expiry, last-started time, outcome and latency on the saved account. A single conditional UPDATE claims an enabled account for 60 seconds; no database locks span HTTP I/O. Manual and periodic probes share these claims. Completion requires the current unexpired token, so an expired process cannot overwrite a replacement process's result. Completion records `verified`, `unverified`, `failed` or `stale` (configuration changed), and releases the claim atomically with any health transition. Internal claim tokens are excluded from admin account responses.

Run the standalone worker with `GATEWAY_ENABLE_PROBES=true pnpm --filter @coati/api worker` (built deployment: `GATEWAY_ENABLE_PROBES=true node apps/api/dist/worker.js`). The worker needs the same database, encryption key and network policy as the API. This switch is independent of ENABLE_TASK_SCHEDULER; it defaults off, including in development/tests. By default every 300 seconds it selects up to five enabled nonhealthy accounts whose last probe and last health check were at least ten minutes ago. AGENT_CREDENTIAL_PROBE_INTERVAL_SECONDS (minimum 30), AGENT_CREDENTIAL_PROBE_BATCH_LIMIT (minimum 1), and AGENT_CREDENTIAL_PROBE_QUIET_SECONDS (minimum 30) configure these values. AGENT_CREDENTIAL_PROBE_ENABLED is accepted when the Node switch is absent; the explicit Node switch takes precedence. Claims recheck eligibility, and a competing worker's claim is skipped. A local tick never overlaps its active batch. Shutdown stops new selections, drains the current bounded probe, skips the remainder of the batch and closes transport before the database.

A killed worker leaves `running` metadata until a later probe. Its lease expires after 60 seconds, while the scheduled quiet window still applies (up to ten minutes from last start, plus scheduling delay). A manual probe may reclaim after lease expiry. Database tests verify expired-token fencing and two service instances competing; this is not an OS process-kill test. A worker can be enabled without enabling the generic task scheduler.

## Compose and console

From the Node checkout root, `docker compose --profile recovery up -d --build` enables the optional `probe-worker` service alongside the API/database. Its environment inherits the API database/encryption/network settings, it waits for the API healthcheck (after initialization/migrations), has no published ports, overrides the API image entrypoint with `node dist/worker.js`, and disables the inherited HTTP healthcheck. The profile explicitly enables probing; normal `docker compose up` does not start this service. Stop automatic probes with `docker compose --profile recovery stop probe-worker`; manual console probes remain available. Omission of a profile does not stop an already running worker.

The current AccountsPage exposes “检查” using the manual account-check contract. The legacy ProbeAccount control exposes “恢复探测” with gateway_upstreams_test permission and disables it for disabled accounts. Background recovery is performed by the worker; it is not silently started by opening a console page. Results show discovered models and distinguish applied recovery from unverified discovery or a stale health observation. The list refreshes after success or failure. Three component regressions verify unverified-result wording, failure refresh and disabled accounts. Compose JSON configuration was validated with disposable fixture environment values; this is not a running-container deployment acceptance. Login-session visual verification remains pending.



The isolated built-container and actual SIGKILL/restart acceptance now passed; see validation.md, “Isolated Docker deployment and worker crash check”. Its expiry timestamps were advanced in a disposable DB, so the full real-time quiet period remains unmeasured. Earlier static-only evidence above is superseded for container startup and restart behavior, not for remaining provider/UI parity.

Compose forwards the documented affinity, candidate-window, health, quota, device-flow and legacy environment-fallback settings to both API and worker. The recovery profile remains an explicit opt-in; changing these configuration defaults does not start a worker in an existing deployment.

## Final functional acceptance (2026-09-26)

Recovery is implemented and verified within the finite contract in [final-functional-acceptance.md](final-functional-acceptance.md). Existing checks cover custom headers/proxies, protocol-specific model discovery, manual check compatibility, shared claims, expired-owner fencing, recent-check quiet periods, stale credential/ownership observations, failure retry and bounded shutdown. Startup logs now state whether gateway probes are enabled and show interval/batch/quiet settings separately from the generic scheduler.

The current real-child-process check also validates concurrent admission from a second process, SIGKILL, expiry recovery, zero invented billing and a successful API call after recovery. The prior isolated container worker SIGKILL/restart evidence remains applicable. Test expiry timestamps are advanced in the disposable database; no claim of waiting the production TTL or measuring production capacity is made. The opt-in deployment command above remains the operator contract, not an unfinished automatic-start feature. User accounts were not probed in this run.
