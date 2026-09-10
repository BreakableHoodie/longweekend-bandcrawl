import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Pin the test timezone. Several suites assert DST behaviour (#770), and DST
// does not exist in UTC — under a UTC runner those fixtures pass against the
// broken implementation as readily as the fixed one, which is worse than no
// test at all. America/Toronto is the zone the product actually runs in.
process.env.TZ = 'America/Toronto'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      exclude: ['node_modules/', 'src/test/', '*.config.js', 'dist/'],
      // Ratchet re-measured 2026-08-30 (stmts 71.21 / branch 65.80 /
      // funcs 72.85 / lines 71.81), after App.jsx gained a real suite and went
      // 44.59 -> 83.37. Thresholds are set to actuals minus a
      // margin for run-to-run variance. This blocks regressions without
      // being an aspiration — raise deliberately, never lower silently
      // (#478 item 9, ratcheted by #519).
      //
      // The previous baseline (57/50/60/58, measured 2026-07-05) had drifted
      // ~7 points below actual, so it would have passed a seven-point
      // regression in silence. Re-measure whenever coverage rises.
      //
      // Watch the denominator here: frontend coverage counts only files a test
      // loads, so a new test that imports a large untested component can drop
      // the global percentage while strictly adding coverage. Prefer extracting
      // and testing a small unit over importing a 1,000-line tab component.
      // Raised 2026-09-09 from 66/60/68/66 by scripts/check-coverage-drift.mjs,
      // which now FAILS when actual outruns these by more than 3 points.
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 72,
        lines: 71,
      },
    },
  },
})
