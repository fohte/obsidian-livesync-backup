// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — hence
// `import '#bootstrap'` as the very first statement of `src/main.ts`.
import { initObservabilityIfConfigured } from '@fohte/service-kit/observability'
import { Result } from 'neverthrow'

import { SafeLogger } from '#logger'

// initObservabilityIfConfigured throws synchronously on invalid config (e.g.
// SENTRY_DSN set without SENTRY_ENVIRONMENT) — observability is best-effort
// and must not crash the backup job itself.
const initResult = Result.fromThrowable(
  () => initObservabilityIfConfigured(process.env),
  () => undefined,
)()

export const observability = initResult.isOk() ? initResult.value : undefined

if (initResult.isErr()) {
  new SafeLogger().error('observability_init_failed')
}
