# Gateway master-key rotation

The API and worker read `GATEWAY_ENCRYPTION_KEY` for all new encryption. Optional `GATEWAY_PREVIOUS_ENCRYPTION_KEYS` is a JSON array of up to four read-only historical keys. Existing v2 AES-GCM ciphertext remains compatible. API keys, account proxy credentials and saved search-provider secrets are covered. Access-token digests are not encryption ciphertext and are unchanged.

## Offline rotation

1. Back up the Node database and its current encryption key separately. Confirm a restore on an isolated database first.
2. Stop **all** API and worker replicas and disable external writers. A database transaction cannot prevent an old process from writing old-key ciphertext after rotation completes.
3. Supply `ROTATION_DATABASE_URL`, `ROTATION_OLD_KEY`, `ROTATION_NEW_KEY` through a protected process environment. Do not place secrets in command-line arguments, shell history, logs or a committed file. `ROTATION_PREVIOUS_KEYS` may contain a JSON array of older source keys when the database is mixed.
4. Run `pnpm --filter @coati/api gateway:rotate-key` for the default dry run. It decrypts and validates every covered value but writes nothing. Output contains counts only.
5. Run `pnpm --filter @coati/api gateway:rotate-key --apply --offline` to apply. The production image contains `node dist/rotate-gateway-key.js` with the same flags. Source and destination keys must differ.
6. Change deployment secrets to the new active key and restart all replicas. No tool changes deployment configuration automatically. Validate credential decryption before restoring traffic. Remove historical read keys only after confirming all stored credentials and required backups are handled.

The operation locks account/search settings tables, prepares all ciphertext before any update, and commits all changes in one transaction. Lock acquisition has a five-second deadline. Any malformed ciphertext/wrong source key fails the entire transaction; no partial rotation is committed. Unrelated accounts, metadata, IDs and quotas remain intact. Dry run also briefly locks the tables, so use the maintenance window. Never run this tool against the Python database.

Rollback before reopening traffic may reverse the operation with swapped keys or restore the paired database/key backup. After traffic resumes, restoring an old database loses new writes: stop writers and reverse-reencrypt with the full current key ring instead. Do not merely switch the configured key back.

Session affinity currently derives from the active encryption key and therefore resets on rotation; no credentials or conversations are deleted. Trace IDs use the independent application secret when configured through the normal entrypoint. This is an offline rotation workflow, not a claim of rolling-upgrade or live-revocation acceptance.

## Evidence

An isolated PostgreSQL workflow verifies dry-run nonmutation, wrong-key rollback, account and proxy encryption, search settings, explicit empty overrides, historical read keys, and reverse rotation. No development/production key or actual environment file was changed.
