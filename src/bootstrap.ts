// Must run before any instrumented module is imported, otherwise
// @opentelemetry/auto-instrumentations-node cannot patch them — hence
// `import './bootstrap'` as the very first statement of `index.ts`.
import { initObservabilityIfConfigured } from '@fohte/service-kit/observability'

initObservabilityIfConfigured(process.env)
