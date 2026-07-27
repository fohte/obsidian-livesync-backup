import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['vendor/**', 'vendor-dist/**', 'node_modules/**', 'dist/**'],
  },
})
