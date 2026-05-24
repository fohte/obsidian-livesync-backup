# obsidian-livesync-backup

@fohte's personal backup tool for Self-hosted LiveSync Obsidian vault.

The container is intended to be run as a Kubernetes CronJob. It connects to
the in-cluster CouchDB, enumerates the vault via the
[`DirectFileManipulator`](https://github.com/vrtmrz/livesync-bridge) API
(vendored via git submodule), decrypts the E2E-encrypted chunks, filters
secrets, and commits the result to a private git repository.

See `.env.example` for the environment variables. No environment-specific
values live in this repo.

## Development

```sh
git clone --recurse-submodules <this repo>
mise install
pnpm install
pnpm test
pnpm build
```

`pnpm build` runs `scripts/build-vendor.mjs` to esbuild the `DirectFileManipulator`
bundle from `vendor/livesync-bridge`, then `scripts/build-app.mjs` to bundle
the entry point into `dist/main.js`.
