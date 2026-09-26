# Coati Node rewrite — development preview

> 当前迁移行为状态以 [Python → Node 行为对照账本](behavior-parity.md) 为准。本文的已开发/历史阶段结论不等同于行为完全一致。

Coati is a self-hosted enterprise model gateway. This branch rebuilds its console and gateway using **castor-kit → TypeScript / Fastify / Drizzle / PostgreSQL + React / shadcn/ui**.

**This is a parallel development preview, not a drop-in replacement for the Python release.** Keep Python traffic and its database on the stable release until real-data migration and release/cutover acceptance have passed. Functional closure and explicit compatibility boundaries are recorded in [final-functional-acceptance.md](final-functional-acceptance.md); candidate-route redesign is deferred by the user. `portal/` is retained unchanged for that comparison.

The foundation was imported from `robeshell/castor-kit` at `afe076c7835c8f7e2c330c0d6574fb92d8229d92`. Its MIT license is retained in `THIRD_PARTY_LICENSES/castor-kit.txt`; Coati remains Apache-2.0. No desktop, CLI, agent plugin, or runtime installer is included.

## Run locally

Use Node 22.19+ and pnpm 11. PostgreSQL needs separate development and test databases.

```sh
createdb coati_node_dev
createdb coati_node_test
pnpm install --frozen-lockfile
cp .env.example .env.development
# Set DEV_DATABASE_URL / TEST_DATABASE_URL for your local PostgreSQL user.
# Set independent SECRET_KEY and GATEWAY_ENCRYPTION_KEY (openssl rand -hex 32).
pnpm setup-once
pnpm dev
```

Open http://localhost:5175. API: http://localhost:5004. The development bootstrap account is `admin` / `admin123`; production requires `ADMIN_PASSWORD`. The Vite proxy forwards `/api` and `/v1` to the Node API. Credentials configured in the new console belong to this isolated database.

In the console: **模型服务 → 模型与路由 → 访问与授权**. An upstream base URL includes its API prefix (e.g. `https://api.openai.com/v1`); select the native protocol and explicitly declare its supported wire models (an optional default is also supported). Route text/vision targets must be declared; an empty list is not a wildcard. Existing route targets are backfilled by migration 0024. Give clients a stable public model name. API keys are displayed once, then stored as SHA-256 digests. Provider keys are encrypted using AES-256-GCM; back up `GATEWAY_ENCRYPTION_KEY` separately from the database. Offline re-encryption and a bounded historical read-key ring are available; see [master-key rotation](credential-rotation.md).

```sh
curl http://localhost:5004/v1/chat/completions \
  -H "Authorization: Bearer $COATI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

For a private upstream, explicitly set `GATEWAY_ALLOW_PRIVATE_UPSTREAMS=true` in your own deployment. The default permits public HTTPS and validates DNS results at connection time. Redirects are not followed.

## Container deployment

From this branch's root, `bash setup.sh` generates `.env.production` with independent secrets and starts the Node stack. It creates separate Node volumes; it does not import or reuse Python volumes. Port binding defaults to loopback. Set `BIND_HOST` deliberately when placing the service behind an HTTPS reverse proxy. Disable proxy buffering for SSE and configure a sufficient read timeout. Set `TRUSTED_PROXIES` to the actual reverse-proxy IPs/CIDRs (comma separated); the default is empty and ignores forwarded IP/protocol headers. Ensure the proxy overwrites client-supplied forwarding headers, restrict direct API access, and use `SESSION_COOKIE_SECURE=true` for HTTPS-only public deployments.

Manual deployment: fill the required production variables in `.env.production`, then:

```sh
docker compose --env-file .env.production up -d --build
```

Initialization runs migrations and incremental RBAC seeding under a PostgreSQL advisory lock. The root `pnpm seed:rbac` command also defaults to incremental synchronization. Do not put Node's `DATABASE_URL` on an existing Python database. `GATEWAY_ENCRYPTION_KEY`, `SECRET_KEY`, `ADMIN_PASSWORD`, and `POSTGRES_PASSWORD` are all required by Compose. The image runs as a non-root user.

## Verification

```sh
pnpm verify:gateway
pnpm typecheck
pnpm test
pnpm build
# Optional isolated full-HTTP baseline; requires CREATEDB on a disposable local cluster:
BENCH_DATABASE_URL=postgresql://localhost/postgres pnpm bench:gateway
```

The benchmark creates and drops only its own `coati_bench_<timestamp>` database; it uses a local fake upstream and never calls a model provider. See [validation](validation.md), [contracts](contracts.md), and [architecture](architecture.md).

## Migration priority

Complete feature and behavioral parity with the Python open-source gateway before Node-specific optimization. Desktop, CLI, agent plugins and runtime installers remain excluded. Reliability and baseline measurement remain release gates; performance tuning follows final migration acceptance.

## Remaining delivery stages

The authoritative remaining plan is [roadmap.md](roadmap.md): a bidirectional 3×3 protocol matrix, no LiteLLM or pi-ai, and Coati-owned protocol adapters validated against the Python reference. The list below is a high-level summary.

- Complete the remaining protocol capability cases, cache-detail persistence and SDK acceptance around the implemented JSON/SSE matrix.
- Add account scheduling/cooldown, credential session affinity, provider model profiles, personal channels, server-side search/fetch, and existing client token-management compatibility.
- Add per-user/shared budgets, not just per-key limits; verify revocation/permission changes across active sessions and replicas.
- Build a read-only legacy export and idempotent import with dry-run counts, source IDs, credential re-encryption and rollback verification. Old tokens cannot currently be reused.
- Benchmark the Python and Node versions under identical workloads/process limits; verify slow-client memory bounds, multi-replica behavior and real upstream integration before cutover.

Do not merge this preview over the stable release on the strength of unit tests alone.

## Protocol contract batch

- [Legacy endpoint inventory](legacy-inventory.md)
- [Protocol contract and capability policy](protocol-contract.md)

The matrix acceptance TODOs are explicit future obligations, not passing compatibility tests. Gateway routes now select upstreams independently of the incoming protocol and run the 3×3 JSON/SSE matrix. Basic text/tools, errors, cancellation and settlement withholding are tested; remaining capability and production gates stay open.


### Reasoning conversion policy

The Node gateway defaults to `X-Coati-Reasoning-Policy: preserve`. Native protocol routes retain their opaque reasoning fields. Messages ↔ Responses conversion preserves supported signature/encrypted-content fields, including JSON, SSE and replay history; this does not imply that different suppliers accept one another's signatures.

Chat has no implemented portable signature field. Signed history cannot be routed to Chat in preserve mode, and signed supplier output cannot be returned successfully as Chat. To explicitly accept signature loss while retaining available reasoning text, add:

```sh
-H 'X-Coati-Reasoning-Policy: text-only'
```

The selected policy is stored in `request_context.reasoning_policy` for both successful and recorded rejected requests; it records the requested policy, not a claim that every response lost data. The header is not forwarded upstream. Invalid policy values return 400. Prefer a Messages or Responses client if opaque replay data is needed. `redacted_thinking` remains native-Messages-only even in text-only mode. Requests without a compatible candidate fail before a supplier call; incompatible JSON responses fail with 502, and SSE reports a stream error without a success terminal.


### Stop sequences and structured output

Chat and Messages stop sequences are retained when routing between those protocols. The current Responses converter cannot represent those settings and rejects the route rather than dropping them. Chat `response_format` and Responses `text.format` map bidirectionally for JSON object/schema output; the current Messages conversion rejects structured-output requirements it cannot preserve. Native routes pass their protocol fields through. These checks preserve requested settings and do not guarantee that a supplier implements a particular output format.

### Slow downstream connections

Model-request responses have a downstream write deadline as well as supplier timeouts. The current 180-second gateway request limit is followed by a 1-second grace period for an error response; a response that still cannot finish writing is disconnected. Normal completion and early disconnect remove the timer. This applies to JSON and SSE model endpoints and their legacy aliases, after authentication. A forcibly disconnected client may see a network error rather than a final SSE error event and must not infer successful completion from partial content.

### Messages input-token estimate

`POST /v1/messages/count_tokens` also supports `/api/agent/v1/messages/count_tokens` and `/api/agent/anthropic/v1/messages/count_tokens`. It requires a valid API key with `chat` scope and returns `{ "input_tokens": <number> }` plus the normal request-ID headers. Like the Python gateway, this is a local UTF-8-byte estimate (roughly bytes / 4), not a supplier tokenizer result. Model routing is not required; no supplier is called and no tokens are charged.

Only messages, non-server tool declarations, system and tool_choice contribute. Known search/fetch server-tool history is normalized to the legacy text representation before estimating. Server-side tool execution and its limits are documented in [server-tools.md](server-tools.md).


### Public route pool API (development preview)

The cookie/CSRF-protected `/api/admin/gateway/public-routes` API accepts a unique `model`, optional `upstream_id`, optional `upstream_model` (otherwise the public name), `vision_model`, `fallback_enabled` (false by default), `upstream_base`, `description`, and `enabled`. Omitting an account selects declared-model accounts automatically. Binding an account keeps it first and only allows other accounts when fallback is enabled. Account `priority` is 1–1000, higher first; weight breaks ties. Address override requires a bound same-origin account and is never propagated to backups. PUT supports partial updates; DELETE requires a disabled route. Existing route permissions apply.

The console exposes these routes under 模型与路由 → 公开路由; account priority is available in 模型服务. The Python compatibility listing and writes are available through the legacy route alias. Existing explicit candidate configurations remain in `/api/admin/gateway/routes`; an alias cannot be configured in both systems. An explicit preflight/apply/history/rollback workflow is available; see [route-migration.md](route-migration.md). Do not drop old routes merely to bypass this conflict.


Current delivery status: [roadmap.md](roadmap.md). Installation, backup/restore and image checks: [deployment.md](deployment.md).

Official SDK examples and local interoperability evidence: [sdk-examples.md](sdk-examples.md).
