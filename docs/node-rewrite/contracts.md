# Contract inventory against Python Coati

Reference: `robeshell/coati` main `e41bb06529ac346bf289e6fb5aa132ca1ecc3851`, specifically `portal/backend/app/agent/api/` and gateway/auth/usage services. This matrix is a migration checklist, not a parity claim.

| Capability | Python reference | Node preview |
| --- | --- | --- |
| Chat Completions | `/api/agent/v1/chat/completions` | Same alias + `/v1/chat/completions`, same-protocol native JSON/SSE |
| Messages | `/api/agent/v1/messages`, `/api/agent/anthropic/v1/messages` | First alias + `/v1/messages`; Anthropic-prefix alias pending |
| Responses | `/api/agent/v1/responses` | Same alias + `/v1/responses`, native JSON/SSE, `store:false` |
| Stored Responses lookup | Explicit unsupported response | Not implemented; 404 |
| Models | Chat-callable catalog + profile fields | Basic native-route catalog, no profile metadata yet |
| Messages count_tokens | Dedicated endpoint/estimation | Pending |
| Protocol conversion | Chat/Messages/Responses bridges incl. tools | Pending; mismatched protocol rejects instead of losing fields |
| PAT management | `/api/agent/auth/pat`, rotate/update/usage/revoke | New `/api/admin/gateway/keys`; legacy shape/rotation pending |
| Device grant | start/poll/confirm, `/api/agent/me` | Start/poll + new admin confirm endpoint; one-time redemption; `/me` pending |
| Quotas | User/account controls, detailed usage | Atomic per-key daily/concurrency/RPM reservations; user/shared budgets pending |
| Scheduling | Account pool, failure classification, cooldown, affinity | Priority route order + pre-stream 429/503 failover only |
| Server tools | Web search/fetch/tool conversion | Pending |
| Model profiles/personal channels/cache testing | Dedicated management APIs | Pending |
| Logs | Detailed usage and operational views | Requests, attempts, timing, redacted errors, source-labelled usage |
| Data/token migration | Existing production data | No importer; fresh isolated database only |

## Compatibility rules

- Gateway bearer authentication never accepts a management cookie as model authorization.
- Both path families in the implemented matrix share one handler; this does **not** imply compatibility with every Python management/client endpoint.
- Preserve native protocol unknown fields and tool blocks. The preview does not implement a generic normalized message object or lossy fallback conversion.
- Reject unsupported stateful Responses features explicitly. Pass complete conversation history.
- HTTP failures before a stream use a structured `error` object and request ID. Mid-stream errors use a protocol-appropriate SSE error, without a fabricated completion.
- Usage is approximate when upstream usage is absent. The daily quota is reservation-based admission control; estimates cannot be advertised as exact provider billing limits.

## Demonstrate device login without publishing a CLI

1. A demo application POSTs `{}` to `/api/agent/auth/device/start` and receives `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`.
2. The user opens the returned relative verification path on the same Coati console origin, signs in, enters the displayed `user_code` and confirms the described access.
3. The demo application POSTs `{ "device_code": "..." }` to `/api/agent/auth/device/poll` no faster than the returned interval. `authorization_pending` means keep waiting; expiry/denial means stop.
4. A successful poll returns the access token once. Concurrent/subsequent redemptions fail. The device token lasts 30 days, permits routed models and has a 100,000-token per-key daily budget; it is listed and can be revoked under access keys.

This protocol example replaces the need to publish the private CLI. A complete SDK/client compatibility suite is still required before migration.
