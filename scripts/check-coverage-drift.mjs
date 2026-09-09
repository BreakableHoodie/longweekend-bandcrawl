#!/usr/bin/env node
/**
 * check-coverage-drift — a ratchet that ratchets itself.
 *
 * Why this exists
 * ----------------
 * The coverage thresholds in vitest.config.js only block a regression down to
 * the number written there. When real coverage rises and nobody re-writes it,
 * the gap becomes the size of the regression that can ship in silence.
 *
 * That has now happened TWICE, to the same distance both times. CLAUDE.md
 * records the first: "a coverage ratchet that drifted ten points below actual
 * and would have passed a double-digit regression." It was raised, and by
 * 2026-09-09 the backend was 11.0 points clear again (86.02 actual vs 75).
 *
 * Raising the numbers a third time fixes today and guarantees a fourth. The
 * decay is structural: a ratchet that must be re-tightened BY HAND decays to
 * exactly this state, because nothing fails while it is decaying. So this makes
 * the drift itself the failure.
 *
 * What it does
 * ------------
 * Fails when actual exceeds its threshold by more than SLACK, and prints the
 * exact values to paste in. It never lowers anything, and it has no opinion
 * when actual is BELOW threshold — vitest already fails that case, and this
 * gate deliberately does not duplicate it.
 *
 * Thresholds are READ FROM THE CONFIG, never restated here. A second copy of
 * those four numbers is precisely the drift this file exists to stop.
 *
 * Choosing SLACK
 * --------------
 * Too tight and it flaps on ordinary variation; too loose and it IS the current
 * situation. 3 points is deliberate: coverage for a given commit is
 * deterministic in CI (the full suite, same files), so run-to-run variance is
 * ~0 and the slack is spent entirely on letting a normal PR land without
 * bookkeeping. A change big enough to move a whole stack 3 points is a change
 * worth re-baselining on purpose.
 *
 * What it does NOT do
 * -------------------
 * It says nothing about whether the covered lines are TESTED — a file executed
 * by a test that asserts nothing counts fully. That is the mutation gate's job
 * (scripts/mutation-gate.mjs), and the file-shaped-hole case is
 * check-coverage-floor.mjs. Three gates, three different blindnesses.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

export const SLACK = 3;
export const METRICS = ["statements", "branches", "functions", "lines"];

/**
 * Run the check.
 *
 * Exported and fully parameterised so the self-test can drive it against
 * fixtures rather than the real repository — the same shape as
 * check-coverage-floor.mjs.
 */
export async function checkDrift({ label, configPath, summaryPath, slack = SLACK }) {
  // A missing summary is a FAILURE, not a skip. A gate that passes because its
  // input is absent is worse than no gate — the same rule check-coverage-floor
  // states, and the same reason it names the command to produce the file.
  if (!existsSync(summaryPath)) {
    return {
      ok: false,
      lines: [
        `✗ ${label}: no coverage summary at ${summaryPath}`,
        `  Produce it first — the 'json-summary' reporter must be enabled in the config.`,
        `  e.g. npm run test:coverage`,
      ],
    };
  }

  // pathToFileURL, not the bare path. A raw absolute path passed to import()
  // is not a valid module specifier once it contains a space, "#", "?" or "%",
  // and fails outright on Windows -- so a checkout directory nobody thought
  // about would break the coverage gate before it read a single number.
  let config;
  try {
    config = await import(pathToFileURL(configPath).href);
  } catch (err) {
    return { ok: false, lines: [`✗ ${label}: could not load ${configPath}: ${err.message}`] };
  }
  const thresholds = config.default?.test?.coverage?.thresholds;
  if (!thresholds) {
    return { ok: false, lines: [`✗ ${label}: no coverage thresholds found in ${configPath}`] };
  }

  const total = JSON.parse(readFileSync(summaryPath, "utf8")).total;
  if (!total) {
    return { ok: false, lines: [`✗ ${label}: coverage summary has no 'total' block`] };
  }

  const drifted = [];
  const suggested = {};
  for (const metric of METRICS) {
    const threshold = thresholds[metric];
    const actual = total[metric]?.pct;
    if (typeof threshold !== "number" || typeof actual !== "number") {
      return { ok: false, lines: [`✗ ${label}: missing ${metric} in config or summary`] };
    }
    // Suggest one point BELOW the floor of actual, not the floor itself.
    // vitest.config.js states the intent -- thresholds keep "margin for
    // run-to-run variance" and are not an aspiration -- and a threshold set at
    // actual turns any trivial dip (deleting a well-covered file, say) into a
    // red build. One point is comfortably inside SLACK, so applying the
    // suggestion does not immediately re-trigger this gate.
    suggested[metric] = Math.max(0, Math.floor(actual) - 1);
    if (actual - threshold > slack) {
      drifted.push({ metric, threshold, actual, gap: actual - threshold });
    }
  }

  if (drifted.length === 0) {
    return { ok: true, lines: [`✓ ${label}: every threshold within ${slack} points of actual`] };
  }

  const lines = [`✗ ${label}: coverage has risen ${drifted.length > 1 ? "well " : ""}above its thresholds`, ""];
  for (const d of drifted) {
    lines.push(
      `    ${d.metric.padEnd(11)} threshold ${String(d.threshold).padStart(3)}   actual ${d.actual.toFixed(2).padStart(6)}   gap ${d.gap.toFixed(2)}`,
    );
  }
  lines.push(
    "",
    `  A gap over ${slack} points is the size of the regression that could ship unnoticed.`,
    `  Raise the thresholds in ${configPath.replace(REPO_ROOT + "/", "")} to:`,
    "",
    "    thresholds: {",
    ...METRICS.map((m) => `      ${m}: ${suggested[m]},`),
    "    },",
    "",
    "  This gate never lowers a threshold, and does not fire when coverage",
    "  FALLS — vitest already fails that case.",
  );
  return { ok: false, lines };
}

const STACKS = [
  {
    label: "backend",
    configPath: join(REPO_ROOT, "vitest.config.js"),
    summaryPath: join(REPO_ROOT, "coverage", "coverage-summary.json"),
  },
  {
    label: "frontend",
    configPath: join(REPO_ROOT, "frontend", "vitest.config.js"),
    summaryPath: join(REPO_ROOT, "frontend", "coverage", "coverage-summary.json"),
  },
];

// Only the backend summary exists in the backend coverage job, and only the
// frontend's in the frontend job, so a stack whose summary is absent is skipped
// HERE rather than failed -- unlike the checkDrift-level rule above, which
// fails when a stack it was explicitly asked about has no input. Pass a label
// to demand one stack specifically.
async function main() {
  const only = process.argv[2];
  const stacks = only ? STACKS.filter((s) => s.label === only) : STACKS;
  if (stacks.length === 0) {
    console.error(`✗ unknown stack '${only}' — expected one of: ${STACKS.map((s) => s.label).join(", ")}`);
    process.exit(2);
  }

  let failed = false;
  let ran = 0;
  for (const stack of stacks) {
    if (!only && !existsSync(stack.summaryPath)) continue;
    ran += 1;
    const { ok, lines } = await checkDrift(stack);
    console.log(lines.join("\n"));
    if (!ok) failed = true;
  }

  if (ran === 0) {
    console.error("✗ no coverage summary found for any stack — run the coverage suite first");
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}

// Same reason as the import above: string-concatenating "file://" onto argv[1]
// mis-compares for any path needing escaping, which would silently skip main().
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
