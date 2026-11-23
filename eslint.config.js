import { config } from '@fohte/eslint-config'

export default config(
  {
    typescript: { typeChecked: true },
    errorHandling: {},
  },
  {
    ignores: [
      'vendor/**',
      'vendor-dist/**',
      'livesync/vendor-dist/**',
      'dist/**',
    ],
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Test stubs implement async interfaces and intentionally have no awaits.
      '@typescript-eslint/require-await': 'off',
    },
  },
)
