#!/usr/bin/env node
import { resolve } from 'node:path'

import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(root, 'dist/main.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node26',
  logLevel: 'info',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: [],
  alias: {
    '@': resolve(root, 'src'),
  },
  tsconfigRaw: {
    compilerOptions: { target: 'es2022', module: 'esnext' },
  },
  // The Direct File Manipulator bundle is loaded at runtime via a relative
  // import; keep it external so we don't double-bundle a 1.3 MB blob.
  plugins: [
    {
      name: 'mark-vendor-external',
      setup(b) {
        b.onResolve(
          { filter: /vendor-dist\/direct-file-manipulator\.mjs$/ },
          (args) => ({
            path: '../vendor-dist/direct-file-manipulator.mjs',
            external: true,
          }),
        )
      },
    },
  ],
})
