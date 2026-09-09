import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    server: {
      deps: {
        inline: ["better-sqlite3"]
      }
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "json-summary"],
      // Ratchet re-measured 2026-08-20 (stmts 77.7 / branch 70.7 /
      // funcs 86.8 / lines 78.5). Thresholds are set to actuals minus a
      // margin for run-to-run variance. This blocks regressions without
      // being an aspiration — raise deliberately, never lower silently
      // (#478 item 9).
      //
      // The previous baseline (68/58/77/68, measured 2026-07-04) had drifted
      // ~10 points below actual, so it would have passed a ten-point
      // regression in silence. A ratchet only ratchets if it is re-measured
      // when coverage rises; treat re-measuring as part of adding tests.
      // Raised 2026-09-09 from 75/68/84/76 by scripts/check-coverage-drift.mjs,
      // which now FAILS when actual outruns these by more than 3 points -- so
      // this block cannot silently decay a third time.
      thresholds: {
        statements: 85,
        branches: 77,
        functions: 94,
        lines: 85,
      },
      exclude: [
        "node_modules/",
        "__tests__/",
        "mocks/",
        "*.config.js",
        "dist/",
        "frontend/",
        "backend/",
      ],
      include: ["functions/**/*.js"],
      reportsDirectory: "./coverage",
    },
    // `scripts/` is included so repo tooling (e.g. the streaming-link identity
    // audit) can be unit-tested. Coverage stays scoped to `functions/**` via
    // coverage.include above, so a script entering the test set does not move
    // the ratchet denominator.
    // workers-mcp-server/ holds the MCP Worker deployed against the PRODUCTION
    // database. Its read-only guard is the only thing bounding what a token
    // holder can do, so it is unit-tested here rather than left to a separate
    // runner nobody invokes.
    include: [
      "functions/**/__tests__/**/*.test.js",
      "scripts/**/__tests__/**/*.test.js",
      "workers-mcp-server/__tests__/**/*.test.js",
    ],
  },
});
