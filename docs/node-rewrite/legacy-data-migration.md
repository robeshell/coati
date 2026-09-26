# Python data migration

The tools operate offline against an **empty, migrated Node database before RBAC bootstrap**. They never write to the source database and never alter deployed environment files. They are not an in-place upgrade of the Python database.

## Export

Set `LEGACY_SOURCE_DATABASE_URL` and a separate random `LEGACY_ARCHIVE_KEY` (at least 32 characters) in a protected environment. Run:

```sh
pnpm --filter @coati/api gateway:legacy-archive export /secure-backup/coati.archive
pnpm --filter @coati/api gateway:legacy-archive inspect /secure-backup/coati.archive
```

Export uses one repeatable-read/read-only PostgreSQL snapshot, cursors, and an allowlist: users, roles, menu grants, PATs, model accounts/routes/profiles, user quotas, usage and cache-verification history. Device codes, sessions, private clients/plugins and runtime installers are excluded. Datetimes are serialized by PostgreSQL without local-time reinterpretation. The 128 MiB archive limit fails explicitly; larger installations require a separately planned batch migration.

The file is AES-GCM encrypted, created exclusively with mode0600, and never overwrites an existing file. Keep its key separate. Output reports counts/row identifiers and blockers, never row bodies or credentials. Store archives outside the checkout. All allowlisted tables must exist in the source version.

## Import

Create a new database, run Node migrations, **do not run setup-once/seed-rbac yet**. Set explicit `LEGACY_TARGET_DATABASE_URL`, `LEGACY_SOURCE_ENCRYPTION_KEY` (Python AGENT_CREDENTIAL_ENCRYPTION_KEY), `LEGACY_TARGET_ENCRYPTION_KEY` and `LEGACY_ARCHIVE_KEY`.

```sh
# Default dry-run inserts/validates the full plan, then rolls back.
pnpm --filter @coati/api gateway:legacy-import /secure-backup/coati.archive
# After stopping every target API/worker/external writer:
pnpm --filter @coati/api gateway:legacy-import /secure-backup/coati.archive --apply --offline
```

Production image entries are `node dist/legacy-archive.js` and `node dist/legacy-import.js` with the same arguments. Invalid source rows, unknown password/token formats, invalid references, wrong encryption keys and nonempty target databases abort. Unknown permissions granted to non-super-admin roles block migration. Set `LEGACY_PERMISSION_MAP_FILE` to a reviewed JSON object from source codes to target codes; an explicit null discards that grant. Super-admin retains all Node permissions. Other grants are never silently promoted. Custom/private menu grants require explicit disposition.

Users, roles, accounts, public routes, profiles, PATs and cache-verification records retain their source IDs. Menu IDs map to the Node catalog; the import journal records that map. Missing/deleted historical PATs get per-owner **revoked**, unguessable synthetic keys so usage remains attributable without creating a usable credential. Unknown cache counts remain null; reported zero remains zero. Historical request IDs and raw legacy provenance remain available. Historical token usage is conservatively labelled estimated because the old schema does not reliably distinguish estimates from supplier reports. Old per-attempt payloads are not invented.

Python Fernet credentials are authenticated/decrypted in memory and re-encrypted under Node AES-GCM. Plaintext legacy credential values are blocked for explicit remediation. Existing supported PBKDF2 password hashes and SHA-256 token digests remain usable; only chat/profile scopes are accepted, and no raw PAT is needed. Old device login handshakes are not resumed. Verify login/token behavior on the isolated candidate before cutover.

One transaction writes data and a source-snapshot checksum journal. Reapplying the identical archive is a no-op; importing a changed snapshot into a populated database is refused. Dry-run does not advance sequences. Apply updates sequences for preserved IDs. Failure rolls back table changes; an interrupted transaction may have advanced a sequence, which does not create partial imported rows.

## Reconciliation and cutover

Compare reported source/target counts, journal ID maps, user role grants, account ownership and historical token/cache sums. New Node limits default where Python had no equivalent limit. Copy deployment-wide default quota/timezone and search settings deliberately; they are not part of this table archive. The tools do not automatically modify secrets, network/proxy configuration or global settings.

Only after checks pass should the target be started with its new encryption key and incremental bootstrap. Keep the Python database and paired backup intact. Before admitting new traffic, rollback is simply discarding the isolated target. After new traffic has written to Node, stop writers and reconcile/export those writes before switching back; restoring an old backup alone loses data. Automated reverse import of new Node writes is not implemented.

## Evidence

A new temporary PostgreSQL database was migrated through0037, dry-run validated and rolled back, then imported with preserved IDs, re-encrypted secrets, cache null/zero and history linkage. Repeat import was a no-op; a different archive was rejected without changes. The database was dropped afterward. A Fernet fixture generated by Python cryptography verifies exact cross-language decryption and tamper/wrong-key rejection. No real source or production database was read or changed.

## Local source rehearsal — 2026-09-26

Read the actual local Python `coati_dev` database using a read-only snapshot. Source: 1 user, 2 roles, 158 menu entries, 173 role-menu grants, and no accounts/routes/PATs/usage/cache runs. The default preflight correctly stopped on the obsolete `dashboard` grant.

For this isolated rehearsal only, explicitly discarded four retired navigation grants: `dashboard`, `agent_my_usage`, `agent_device_confirm`, `agent_device_confirm_action`. Do not map personal dashboard access to `gateway_overview` automatically. Personal usage uses login/owner checks; its export permission remains mapped separately. This mapping is source-specific and does not modify global importer defaults.

Encrypted in-memory archive roundtrip, full dry-run rollback, import into a newly migrated temporary database, exact user ID/username/password-hash reconciliation and idempotent repeat all passed. Target contained 1 user, 2 roles, 63 Node menus and 74 mapped role-menu grants. The temporary database was removed. No source or running Node database was written and no persistent archive was retained.

This verifies the local source's identity/configuration migration only. It does not establish real account decryption, historical usage totals, actual login with the original password, or provider billing: this source has no corresponding records. Correction: the initial Node inventory used the default Unix socket, which reaches a different local PostgreSQL instance from the application's localhost TCP connection. That empty result does not describe the running application. The actual localhost/coati_node_dev contains enabled DeepSeek account ID 3. All further inventories must use the exact configured connection URL. No account was deleted or restored during this investigation.
