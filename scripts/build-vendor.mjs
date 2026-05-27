#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const entry = resolve(
  root,
  'vendor/livesync-bridge/lib/src/API/DirectFileManipulatorV2.ts',
)
const outfile = resolve(root, 'vendor-dist/direct-file-manipulator.mjs')

mkdirSync(dirname(outfile), { recursive: true })

const aliasPlugin = {
  name: 'livesync-aliases',
  setup(b) {
    b.onResolve({ filter: /(^|\/)bgWorker(\.ts)?$/ }, (args) => {
      if (args.path.endsWith('bgWorker.mock.ts')) return null
      return {
        path: resolve(
          root,
          'vendor/livesync-bridge/lib/src/worker/bgWorker.mock.ts',
        ),
      }
    })
  },
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node26',
  logLevel: 'info',
  resolveExtensions: ['.ts', '.mts', '.js', '.mjs'],
  loader: { '.ts': 'ts', '.mts': 'ts' },
  plugins: [aliasPlugin],
  banner: {
    js: "import { createRequire as __olbb_cr } from 'node:module'; const require = __olbb_cr(import.meta.url);",
  },
  tsconfigRaw: {
    compilerOptions: { target: 'es2022', module: 'esnext' },
  },
})
