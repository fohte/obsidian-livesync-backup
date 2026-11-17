# obsidian-livesync-backup

@fohte's personal backup tool for Self-hosted LiveSync Obsidian vault.

The container is intended to be run as a Kubernetes CronJob. It connects to the in-cluster CouchDB, enumerates the vault via the [`DirectFileManipulator`](https://github.com/vrtmrz/livesync-bridge) API (vendored via git submodule), decrypts the E2E-encrypted chunks, filters secrets, and commits the result to a private git repository.

See `.env.example` for the environment variables. No environment-specific values live in this repo.

## Development

```sh
git clone --recurse-submodules <this repo>
mise install
pnpm install
pnpm test
pnpm build
```

`pnpm build` runs `scripts/build-vendor.mjs` to esbuild the `DirectFileManipulator` bundle from `vendor/livesync-bridge`, then `scripts/build-app.mjs` to bundle the entry point into `dist/main.js`.

## Apply pushed changes

The `apply` command compares each non-backup commit between two refs with the current vault. When UTF-8 text differs from the commit's parent, it writes a line-based three-way merge if the edits do not overlap. Overlapping edits, deletion/edit pairs, non-text files, and conflicting content at a new path are reported as conflicts. Revision changes are retried up to three times. It uses the same CouchDB, E2E, and exclusion environment variables as the backup command. Set `BACKUP_AUTHOR_EMAIL` to the author email used by backup snapshot commits; commits with that author are skipped.

```sh
node dist/main.js apply \
  --checkout-path "$CHECKOUT_PATH" \
  --from "$APPLIED_REF" \
  --to "$TARGET_REF" \
  --vault-dir src \
  --exclude-author-email "$BACKUP_AUTHOR_EMAIL"
```

Exit code `0` means all eligible changes were applied or already present; paths matched by the configured exclusions are skipped. Exit code `1` means one or more files conflicted; other eligible files were still applied. Exit code `2` means the arguments or configuration are invalid, the starting ref is not an ancestor of the target ref, or Git/CouchDB processing failed.
