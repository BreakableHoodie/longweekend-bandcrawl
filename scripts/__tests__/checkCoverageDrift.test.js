import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDrift, SLACK, METRICS } from "../check-coverage-drift.mjs";

/**
 * The drift gate, driven against fixtures rather than the real repository --
 * same shape as check-coverage-floor's self-test.
 *
 * A gate whose own failure path is never executed is the thing this repo keeps
 * getting caught by, so every case below asserts the FAILING direction too.
 */
const cfg = (t) => `export default { test: { coverage: { thresholds: ${JSON.stringify(t)} } } }`;
const summary = (pcts) => JSON.stringify({ total: Object.fromEntries(METRICS.map((m) => [m, { pct: pcts[m] }])) });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "covdrift-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

const ACTUAL = { statements: 86.13, branches: 78.24, functions: 95.95, lines: 86.74 };

describe("check-coverage-drift", () => {
  it("passes when every threshold is within slack", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("a.mjs", cfg({ statements: 85, branches: 77, functions: 94, lines: 85 })),
      summaryPath: write("a.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(true);
  });

  it("fails when a threshold has drifted, and names every drifted metric", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("b.mjs", cfg({ statements: 75, branches: 68, functions: 84, lines: 76 })),
      summaryPath: write("b.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(false);
    const out = r.lines.join("\n");
    for (const m of METRICS) expect(out).toContain(m);
  });

  it("prints thresholds that would actually pass, one point under actual", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("c.mjs", cfg({ statements: 75, branches: 68, functions: 84, lines: 76 })),
      summaryPath: write("c.json", summary(ACTUAL)),
    });
    const out = r.lines.join("\n");
    // floor(86.13) - 1 = 85, and so on. Not floor(actual): the config states
    // thresholds keep margin, and a threshold AT actual reddens on any dip.
    expect(out).toContain("statements: 85,");
    expect(out).toContain("branches: 77,");
    expect(out).toContain("functions: 94,");
    expect(out).toContain("lines: 85,");
  });

  it("is silent when coverage FALLS below threshold — that is vitest's job", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("d.mjs", cfg({ statements: 90, branches: 90, functions: 99, lines: 90 })),
      summaryPath: write("d.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(true);
  });

  it("does not fire exactly AT the slack boundary, and does one point past it", async () => {
    const atBoundary = await checkDrift({
      label: "t",
      configPath: write("e.mjs", cfg(Object.fromEntries(METRICS.map((m) => [m, ACTUAL[m] - SLACK])))),
      summaryPath: write("e.json", summary(ACTUAL)),
    });
    expect(atBoundary.ok).toBe(true);

    const past = await checkDrift({
      label: "t",
      configPath: write("f.mjs", cfg(Object.fromEntries(METRICS.map((m) => [m, ACTUAL[m] - SLACK - 1])))),
      summaryPath: write("f.json", summary(ACTUAL)),
    });
    expect(past.ok).toBe(false);
  });

  // A gate that passes because its input is absent is worse than no gate --
  // the rule check-coverage-floor states and this one inherits.
  it("FAILS on a missing summary rather than skipping, and says how to make one", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("g.mjs", cfg({ statements: 85, branches: 77, functions: 94, lines: 85 })),
      summaryPath: join(dir, "does-not-exist.json"),
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/json-summary|test:coverage/);
  });

  it("fails when the config carries no thresholds at all", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("h.mjs", "export default { test: { coverage: {} } }"),
      summaryPath: write("h.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(false);
  });
});
