import { defineConfig } from 'vitest/config'

// A test's timeout is a hang detector, not a speed check. These suites run beside builds,
// end-to-end runs and DSH sessions on developer machines, where a test that takes 0.2 s
// alone has taken over 5 s (Vitest's default). 30 s still catches a hang; a test that
// needs longer says so itself.
export default defineConfig({ test: { testTimeout: 30_000 } })
