# Coati contributor instructions

Coati is a self-hosted enterprise model gateway. The Node rewrite lives in apps/api and apps/web. portal/ is the unchanged Python reference until migration acceptance.

Use TypeScript + Fastify + Drizzle + PostgreSQL; React + shadcn/ui + Tailwind for the new console. Backend layers: db/schema → schema → repository → service → routes. Import permission checks from common/auth. Frontend API calls use shared/api/request. Keep gateway API hooks isolated from admin cookie/CSRF/i18n/audit hooks.

Desktop clients, CLI implementations, agent plugins, runtime installers and company-specific services remain outside scope. Minimal protocol/device-auth examples are allowed. Preserve upstream MIT notice; project license remains Apache-2.0.

No live model calls or production writes during tests. Use isolated coati_node_dev/coati_node_test databases. Never apply Node migrations directly to the Python database. Validate migrations on a new database; run pnpm typecheck, pnpm test, pnpm build and pnpm verify:gateway. Preserve stream cancellation, bounded buffering, honest usage and atomic quota semantics. See docs/node-rewrite/ for contract and validation status.
