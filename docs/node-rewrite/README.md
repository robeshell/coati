# Coati Node rewrite — development preview

Coati is a self-hosted enterprise model gateway. This branch rebuilds its console and gateway using **castor-kit → TypeScript / Fastify / Drizzle / PostgreSQL + React / shadcn/ui**.

**This is a parallel development preview, not a drop-in replacement for the Python release.** Keep Python traffic and its database on the stable release until protocol parity, data migration, and comparative load testing have passed. `portal/` is retained unchanged for that comparison.

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

In the console: **模型服务 → 模型与路由 → 访问与授权**. An upstream base URL includes its API prefix (e.g. `https://api.openai.com/v1`); select the native protocol. Give clients a stable public model name. API keys are displayed once, then stored as SHA-256 digests. Provider keys are encrypted using AES-256-GCM; back up `GATEWAY_ENCRYPTION_KEY` separately from the database. Key rotation/re-encryption tooling is not implemented yet.

```sh
curl http://localhost:5004/v1/chat/completions \
  -H "Authorization: Bearer $COATI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-model","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

For a private upstream, explicitly set `GATEWAY_ALLOW_PRIVATE_UPSTREAMS=true` in your own deployment. The default permits public HTTPS and validates DNS results at connection time. Redirects are not followed.

## Container deployment

From this branch's root, `bash setup.sh` generates `.env.production` with independent secrets and starts the Node stack. It creates separate Node volumes; it does not import or reuse Python volumes. Port binding defaults to loopback. Set `BIND_HOST` deliberately when placing the service behind an HTTPS reverse proxy. Disable proxy buffering for SSE and configure a sufficient read timeout.

Manual deployment: fill the required production variables in `.env.production`, then:

```sh
docker compose --env-file .env.production up -d --build
```

Initialization runs migrations and incremental RBAC seeding under a PostgreSQL advisory lock. Do not put Node's `DATABASE_URL` on an existing Python database. `GATEWAY_ENCRYPTION_KEY`, `SECRET_KEY`, `ADMIN_PASSWORD`, and `POSTGRES_PASSWORD` are all required by Compose. The image runs as a non-root user.

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

## Remaining delivery stages

- Implement protocol conversion with golden fixtures for tools, reasoning, errors, cancellation and usage; no silent conversion today.
- Add account scheduling/cooldown, credential session affinity, provider model profiles, personal channels, server-side search/fetch, and existing client token-management compatibility.
- Add per-user/shared budgets, not just per-key limits; verify revocation/permission changes across active sessions and replicas.
- Build a read-only legacy export and idempotent import with dry-run counts, source IDs, credential re-encryption and rollback verification. Old tokens cannot currently be reused.
- Benchmark the Python and Node versions under identical workloads/process limits; verify slow-client memory bounds, multi-replica behavior and real upstream integration before cutover.

Do not merge this preview over the stable release on the strength of unit tests alone.
