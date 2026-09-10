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
  // The REAL configs are `.js`; these fixtures were `.mjs`, so they exercised a
  // module format production never uses. They are `.js` now, and this manifest
  // declares the same "type": "module" both of this repo's packages set --
  // making the fixture mirror the real resolution inputs rather than a
  // near-miss of them.
  //
  // BE PRECISE ABOUT WHAT IT BUYS, because the first version of this comment
  // was wrong: it claimed a `.js` fixture without the manifest would load as
  // CommonJS and fail. It does not. Node 26 detects module syntax in a `.js`
  // file and loads it accordingly -- measured, both `export default` and
  // `module.exports` resolve with no package.json present at all.
  //
  // So the manifest is not the difference between passing and failing here. It
  // is the difference between testing production's declared configuration and
  // relying on a version-dependent fallback, which is worth one line.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
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
      configPath: write("a.js", cfg({ statements: 85, branches: 77, functions: 94, lines: 85 })),
      summaryPath: write("a.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(true);
  });

  it("fails when a threshold has drifted, and names every drifted metric", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("b.js", cfg({ statements: 75, branches: 68, functions: 84, lines: 76 })),
      summaryPath: write("b.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(false);
    const out = r.lines.join("\n");
    for (const m of METRICS) expect(out).toContain(m);
  });

  it("prints thresholds that would actually pass, one point under actual", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("c.js", cfg({ statements: 75, branches: 68, functions: 84, lines: 76 })),
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
      configPath: write("d.js", cfg({ statements: 90, branches: 90, functions: 99, lines: 90 })),
      summaryPath: write("d.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(true);
  });

  it("does not fire exactly AT the slack boundary, and does one point past it", async () => {
    const atBoundary = await checkDrift({
      label: "t",
      configPath: write("e.js", cfg(Object.fromEntries(METRICS.map((m) => [m, ACTUAL[m] - SLACK])))),
      summaryPath: write("e.json", summary(ACTUAL)),
    });
    expect(atBoundary.ok).toBe(true);

    const past = await checkDrift({
      label: "t",
      configPath: write("f.js", cfg(Object.fromEntries(METRICS.map((m) => [m, ACTUAL[m] - SLACK - 1])))),
      summaryPath: write("f.json", summary(ACTUAL)),
    });
    expect(past.ok).toBe(false);
  });

  // A gate that passes because its input is absent is worse than no gate --
  // the rule check-coverage-floor states and this one inherits.
  it("FAILS on a missing summary rather than skipping, and says how to make one", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("g.js", cfg({ statements: 85, branches: 77, functions: 94, lines: 85 })),
      summaryPath: join(dir, "does-not-exist.json"),
    });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(/json-summary|test:coverage/);
  });

  // A malformed summary must fail the GATE, not crash it. `JSON.parse("null")`
  // returns null, so an unguarded `.total` raises a TypeError and the run exits
  // with a stack trace pointing at the crash instead of at the file to
  // regenerate -- the wrong thing to hand someone whose build just went red.
  it.each([
    ["null", "null"],
    ["truncated JSON", '{"total":'],
    ["an array", "[]"],
    ["a bare string", '"nope"'],
  ])("returns the controlled failure shape for %s, not a stack trace", async (_label, body) => {
    const r = await checkDrift({
      label: "t",
      configPath: write("i.js", cfg({ statements: 85, branches: 77, functions: 94, lines: 85 })),
      summaryPath: write("i.json", body),
    });
    expect(r.ok).toBe(false);
    expect(Array.isArray(r.lines)).toBe(true);
    // Every failure path names the way back, not just the problem.
    expect(r.lines.join("\n")).toMatch(/test:coverage/);
  });

  it("fails when the config carries no thresholds at all", async () => {
    const r = await checkDrift({
      label: "t",
      configPath: write("h.js", "export default { test: { coverage: {} } }"),
      summaryPath: write("h.json", summary(ACTUAL)),
    });
    expect(r.ok).toBe(false);
  });
});
