#!/usr/bin/env node
/**
 * mutation-gate — converts prose invariants into executable proof.
 *
 * Why this exists
 * ----------------
 * This repo has a documented, recurring "vacuous test" defect class: tests
 * that pass against BOTH the correct and the broken implementation. The
 * worst instance (see CLAUDE.md "Band Announcements"): deleting
 * `AND verified = 1` from either band-announcement recipient query left all
 * 1,169 backend tests green, because ten test files all seeded
 * `verified = 1` — no fixture could distinguish a gated query from an
 * ungated one.
 *
 * CLAUDE.md documents many invariants in prose and asks contributors to
 * "verify by mutation" by hand. Nothing enforced that, so it decayed. This
 * script automates it: for each documented invariant, it applies the exact
 * one-line source mutation that would break it, runs the named test file(s),
 * and requires them to go RED. A mutation that does not go red is a real
 * vacuous-test gap — reported loudly, not swallowed.
 *
 * Scope (v1): backend (`functions/`) only. The frontend after-midnight
 * threshold (`frontend/src/utils/festivalDays.js`) runs under a SEPARATE
 * vitest project (`cd frontend && npm test`) with its own config, module
 * resolution, and jsdom environment — wiring it in here would mean either a
 * second vitest invocation with different flags/cwd or duplicating the
 * frontend config's `include`/environment, either of which is more moving
 * parts than this file's job warrants. Worth a v2 with its own
 * `frontend/scripts/mutation-gate.mjs`, not a branch in this one.
 *
 * Algorithm, per mutation:
 *   1. Read the target file.
 *   2. Assert `find` occurs EXACTLY ONCE. Zero occurrences or more than one
 *      is a GATE FAILURE, not a skip — patterns drift as code changes, and a
 *      gate whose patterns silently no-op reports all-green while testing
 *      nothing (see: `lint-md` missing from `.PHONY`, Makefile history).
 *   3. Write the mutated content.
 *   4. Run ONLY the listed test file(s) via `npx vitest run <files>`.
 *   5. Expect a NON-ZERO exit code. Zero (tests still pass against the
 *      broken code) is a SURVIVING MUTANT — a real vacuous-test finding,
 *      reported loudly with the invariant, file, and tests named.
 *   6. Restore the original content in a `finally`, then verify the restore
 *      both in-process (byte comparison) and via `git diff --quiet`. A
 *      restore that fails to verify exits non-zero immediately with a loud,
 *      specific message — leaving a mutated source file on disk silently is
 *      worse than any test failure this script could report.
 *
 * Refuses to run at all on a dirty working tree (scoped to the files this
 * table touches): the gate cannot tell its own mutation apart from a real
 * edit already in progress, and a crash mid-run could then destroy it.
 *
 * Usage
 * -----
 *   node scripts/mutation-gate.mjs
 *   make mutation-gate
 *
 * Exit codes:
 *   0  every mutation was caught (or is a documented KNOWN_SURVIVING gap)
 *   1  a gate failure (pattern drift), a genuine surviving mutant, or a
 *      restore that failed to verify
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, "..");

// ============================================================================
// The mutation table — one entry per documented invariant.
//
// `find` MUST be unique within `file` (verified at run time, not just when
// this table was written — code drifts). `replace` is the exact one-line (or
// small) mutation that breaks the invariant. `tests` is the minimal set of
// test files that should go red.
//
// Every `find` string below was verified unique in its file at the time this
// table was written (2026-08-31) via a byte-exact `indexOf` scan, not `grep`
// (grep's own regex metacharacters would misreport strings containing `(`,
// `.`, `?`, all of which appear below).
// ============================================================================

/** @typedef {{ id: string, invariant: string, file: string, find: string, replace: string, tests: string[] }} Mutation */

/** @type {Mutation[]} */
export const MUTATIONS = [
  {
    id: "sitemap-upcoming-event-priority",
    invariant:
      "CLAUDE.md 'The sitemap is the event-discovery signal — spend it (#1158)' — an upcoming event outranks a concluded one",
    file: "functions/sitemap.xml.js",
    // Mutates ONLY the upcoming branch. Flattening both to a single value was
    // a weaker test: it was caught by the ordering assertion alone, so it never
    // exercised the case that actually erodes the signal -- quietly demoting
    // the live event a notch while leaving the concluded one alone.
    find: '<priority>${upcoming ? "1.0" : "0.5"}</priority>',
    replace: '<priority>${upcoming ? "0.9" : "0.5"}</priority>',
    tests: ["functions/__tests__/sitemap.test.js"],
  },
  {
    id: "sitemap-upcoming-event-changefreq",
    invariant:
      "CLAUDE.md 'The sitemap is the event-discovery signal — spend it (#1158)' — an upcoming event is crawled daily, not weekly",
    file: "functions/sitemap.xml.js",
    find: '<changefreq>${upcoming ? "daily" : "monthly"}</changefreq>',
    replace: '<changefreq>${upcoming ? "weekly" : "monthly"}</changefreq>',
    tests: ["functions/__tests__/sitemap.test.js"],
  },
  {
    id: "band-follow-claim-lease",
    invariant:
      "CLAUDE.md 'A claim is not a delivery record (#1152)' — an UNDELIVERED claim past its lease is abandoned and must be retried",
    file: "functions/utils/bandFollowNotify.js",
    find: "AND claimed_at <= datetime('now', '-${CLAIM_LEASE_MINUTES} minutes')",
    replace: "AND 1 = 0",
    tests: ["functions/utils/__tests__/bandFollowNotify.test.js"],
  },
  {
    id: "band-follow-delivered-never-retried",
    invariant:
      "CLAUDE.md 'A claim is not a delivery record (#1152)' — a DELIVERED row is never retried, however old the claim",
    file: "functions/utils/bandFollowNotify.js",
    find: "AND delivered_at IS NULL",
    replace: "",
    tests: ["functions/utils/__tests__/bandFollowNotify.test.js"],
  },
  {
    id: "announce-double-opt-in-primary",
    invariant:
      "CLAUDE.md 'Band Announcements' — announcement emails target verified = 1 followers only (primary announce query)",
    file: "functions/api/admin/bands/[id].js",
    find: "AND verified = 1",
    replace: "",
    tests: ["functions/api/admin/bands/__tests__/announce-double-opt-in.test.js"],
  },
  {
    id: "announce-double-opt-in-resend",
    invariant:
      "CLAUDE.md 'Band Announcements' — resend-announcement recovers only followers without a notification row, and still only verified ones",
    file: "functions/api/admin/bands/[id]/resend-announcement.js",
    find: "AND bf.verified = 1",
    replace: "",
    tests: ["functions/api/admin/bands/__tests__/announce-double-opt-in.test.js"],
  },
  {
    id: "after-midnight-threshold-server",
    invariant:
      "CLAUDE.md 'After-midnight band sorting' — AFTER_MIDNIGHT_THRESHOLD_HOUR is 6 (server canonical home); sets before this hour belong to the previous festival day",
    file: "functions/utils/eventDay.js",
    find: "AFTER_MIDNIGHT_THRESHOLD_HOUR = 6",
    replace: "AFTER_MIDNIGHT_THRESHOLD_HOUR = 0",
    tests: ["functions/utils/__tests__/eventDay.test.js"],
  },
  {
    id: "archive-race-predicate",
    invariant:
      "CLAUDE.md 'Public event visibility' — archiving carries `AND status IN ('draft','published')` so a concurrent archive between read and write cannot be silently overwritten (archive.js)",
    file: "functions/api/admin/events/[id]/archive.js",
    find: "AND status IN ('draft', 'published')",
    replace: "",
    tests: ["functions/api/admin/events/__tests__/events.test.js"],
  },
  {
    id: "patch-race-predicate-dynamic",
    invariant:
      "CLAUDE.md 'Public event visibility' — PATCH's status guard is built dynamically (statusGuardSql), so it is the site a `SET status` grep misses; it must still carry the concurrent-archive predicate",
    file: "functions/api/admin/events/[id].js",
    // A JS ternary, not SQL inside a template literal — the other three sites
    // are raw SQL, so this find string is a different shape by necessity. It is
    // also the site CLAUDE.md warns is invisible to the obvious grep, which is
    // exactly why leaving it unpinned was the wrong two-of-four to have.
    find: "const statusGuardSql = patchesStatus ? \" AND status IN ('draft', 'published')\" : \"\";",
    replace: 'const statusGuardSql = "";',
    tests: ["functions/api/admin/events/__tests__/events.test.js"],
  },
  {
    id: "put-toggle-race-predicate",
    invariant:
      "CLAUDE.md 'Public event visibility' — the PUT publish-toggle carries the same concurrent-archive predicate as archive.js and publish.js",
    file: "functions/api/admin/events/[id].js",
    find: "WHERE id = ? AND status IN ('draft', 'published')",
    replace: "WHERE id = ?",
    tests: ["functions/api/admin/events/__tests__/events.test.js"],
  },
  {
    id: "publish-race-predicate",
    invariant: "CLAUDE.md 'Public event visibility' — same race predicate on the publish route (POST .../publish)",
    file: "functions/api/admin/events/[id]/publish.js",
    find: "AND status IN ('draft', 'published')",
    replace: "",
    tests: ["functions/api/admin/events/__tests__/events.test.js"],
  },
  {
    id: "reset-password-session-invalidation",
    invariant:
      "CLAUDE.md 'Security Notes' — session invalidation on password reset: lucia.invalidateUserSessions equivalent must actually clear every session for that user",
    file: "functions/api/auth/reset-password-complete.js",
    find: "WHERE user_id = ?",
    replace: "WHERE user_id = ? AND 0",
    tests: ["functions/api/auth/__tests__/reset-password-complete.test.js"],
  },
  {
    id: "api-key-role-never-creator",
    invariant:
      "CLAUDE.md 'API keys' — context.data.user.role is the KEY's role, never its creator's; getting this backwards makes every key an admin key",
    file: "functions/api/admin/_middleware.js",
    find: "email: key.creator_email ?? null,\n        role: key.role,",
    replace: 'email: key.creator_email ?? null,\n        role: "admin",',
    tests: ["functions/api/admin/__tests__/api-key-auth.test.js"],
  },
  {
    id: "verify-api-key-active-user",
    invariant:
      "CLAUDE.md 'API keys' — verifyApiKey's INNER JOIN requires the creator's users.is_active = 1, a backstop for a deactivation path that forgets to revoke keys explicitly",
    file: "functions/utils/apiKeys.js",
    find: "WHERE k.key_hash = ? AND u.is_active = 1",
    replace: "WHERE k.key_hash = ?",
    tests: ["functions/api/admin/api-keys/__tests__/api-keys.test.js"],
  },
  {
    id: "public-event-visibility-gate",
    invariant:
      "CLAUDE.md 'Public event visibility is status, never is_published' — publicEventStatusSql() must gate to published/archived only, never draft",
    file: "functions/utils/eventVisibility.js",
    find: "return `${columnRef(alias)} IN ('published', 'archived')`;",
    replace: "return `${columnRef(alias)} IN ('draft', 'published', 'archived')`;",
    tests: ["functions/api/events/__tests__/public.test.js"],
  },
  {
    id: "reveal-mode-is-announced-gate",
    invariant:
      "CLAUDE.md 'Pulling a band from a live lineup' — public reads must guard with (reveal_mode = 0 OR is_announced = 1); this is one of 8 files carrying the gate, picked as the representative for v1",
    file: "functions/api/schedule.js",
    find: "AND (? = 0 OR p.is_announced = 1)",
    replace: "AND (? = 0 OR 1 = 1)",
    tests: ["functions/api/__tests__/schedule-reveal.test.js"],
  },
  {
    id: "ical-no-fabricated-start-time",
    invariant:
      "CLAUDE.md 'Pulling a band from a live lineup' — the iCal feed never invents a time for an unscheduled set (#1079)",
    file: "functions/api/feeds/ical.js",
    find: "if (!band.start_time) continue;",
    replace: "",
    tests: ["functions/api/feeds/__tests__/ical.test.js"],
  },
  {
    id: "ical-end-time-derived-not-constant",
    invariant:
      "CLAUDE.md 'Pulling a band from a live lineup' — a missing end_time is derived from the start, never a constant that can precede it (#1079)",
    file: "functions/api/feeds/ical.js",
    find: "band.end_time || addOneHour(startTime)",
    replace: 'band.end_time || "21:00"',
    tests: ["functions/api/feeds/__tests__/ical.test.js"],
  },
  {
    id: "time-validation-range-not-just-shape",
    invariant:
      "CLAUDE.md 'Time validation is shape AND range' — admin write paths bound hours/minutes via isValidTime, never an inline shape regex (#1089)",
    file: "functions/api/admin/bands.js",
    find: "(startTime && !isValidTime(startTime).valid)",
    replace: "(startTime && !/^\\d{2}:\\d{2}$/.test(startTime))",
    tests: ["functions/api/admin/bands/__tests__/bands.test.js"],
  },
  {
    id: "time-validation-range-put-performance",
    invariant:
      "CLAUDE.md 'Time validation is shape AND range' — the PUT performance path bounds hours/minutes too (#1089)",
    file: "functions/api/admin/bands/[id].js",
    find: 'startTime !== undefined && startTime !== "" && !isValidTime(startTime).valid',
    replace: 'startTime !== undefined && startTime !== "" && !/^\\d{2}:\\d{2}$/.test(startTime)',
    tests: ["functions/api/admin/bands/__tests__/bands.test.js"],
  },
  {
    id: "time-validation-range-put-profile",
    invariant: "CLAUDE.md 'Time validation is shape AND range' — the profile PUT path bounds hours/minutes too (#1089)",
    file: "functions/utils/bandProfileResource.js",
    find: 'startTime !== undefined && startTime !== "" && !isValidTime(startTime).valid',
    replace: 'startTime !== undefined && startTime !== "" && !/^\\d{2}:\\d{2}$/.test(startTime)',
    tests: ["functions/api/admin/bands/__tests__/bands.test.js"],
  },
];

// ============================================================================
// KNOWN_SURVIVING — mutations that are real invariants but for which no
// current test goes red. An entry here is a genuine vacuous-test finding,
// not a skip: it still gets applied and tested every run (so a future test
// addition that starts catching it is visible), but a "surviving" result
// here does not fail the gate — it is reported prominently instead, with a
// TODO(#issue) to close the gap.
//
// Currently empty: every mutation in MUTATIONS above was verified (by
// actually running this gate) to be caught by its listed test(s). If you add
// a mutation whose listed test does NOT go red, move it here rather than
// deleting it or leaving the gate red — and open an issue.
//
// Shape, for the next one:
//   {
//     id: "...",
//     invariant: "...",
//     file: "...",
//     find: "...",
//     replace: "...",
//     tests: ["..."],           // the best current attempt, even if it doesn't catch it
//     issue: "#NNNN",
//     note: "why nothing currently catches this",
//   }
// ============================================================================

/** @type {Mutation[]} */
export const KNOWN_SURVIVING = [];

// ============================================================================
// Core mechanics — exported so scripts/__tests__/mutationGate.test.js can
// drive them against temp fixtures instead of the real table.
// ============================================================================

/** Byte-exact occurrence count. Deliberately not a regex/grep count: `find`
 * strings here contain `(`, `)`, `.`, `?`, `$` — all regex metacharacters —
 * and a regex-based count would misreport.
 *
 * @param {string} haystack - Text to search.
 * @param {string} needle - Literal substring; never treated as a pattern.
 * @returns {number} Non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack, needle) {
  if (needle === "") return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

/** Splice `replace` in for the single occurrence of `find`. Deliberately NOT
 * `String.prototype.replace(find, replace)`: when the second argument is a
 * string, `replace` treats `$&`, `$1`, etc. as special patterns. A mutation
 * table is exactly the kind of file that acquires a `$`-bearing replacement
 * eventually; splicing by index sidesteps the whole class. Caller must have
 * already verified exactly one occurrence.
 *
 * @param {string} content - Original file contents.
 * @param {string} find - Literal substring to replace; must occur exactly once.
 * @param {string} replace - Literal replacement, inserted verbatim (a `$` in it
 *   is NOT interpreted, which is the reason for splicing over String.replace).
 * @returns {string} `content` with the single occurrence replaced. */
export function applyReplacement(content, find, replace) {
  const idx = content.indexOf(find);
  if (idx === -1) {
    throw new Error("applyReplacement called with a find string that is not present");
  }
  return content.slice(0, idx) + replace + content.slice(idx + find.length);
}

/** `git status --porcelain` scoped to specific paths. Empty array = clean.
 *
 * @param {string[]} files - Repo-relative paths to check.
 * @param {string} cwd - Directory to run git in.
 * @returns {string[]} The subset of `files` git reports as modified.
 * @throws {Error} If git itself fails to run — never silently treated as clean,
 *   since "clean" is the answer that lets the gate start mutating sources. */
export function dirtyFiles(files, cwd) {
  if (files.length === 0) return [];
  const result = spawnSync("git", ["status", "--porcelain", "--", ...files], {
    cwd,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`git status failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git status exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** True iff git sees no diff for this single file (working tree vs index).
 *
 * @param {string} filePath - Repo-relative path.
 * @param {string} cwd - Directory to run git in.
 * @returns {boolean} true when `git diff --quiet` reports no change.
 * @throws {Error} If git fails to run. Used to verify a restore, so a failure
 *   here must be loud rather than optimistic. */
export function isGitClean(filePath, cwd) {
  const result = spawnSync("git", ["diff", "--quiet", "--", filePath], { cwd });
  if (result.error) {
    throw new Error(`git diff failed to run: ${result.error.message}`);
  }
  return result.status === 0;
}

/** Strip ANSI SGR sequences. vitest colorizes whenever it believes a terminal
 * is watching -- which includes GitHub Actions -- so its summary line arrives
 * as an escape sequence followed by " Tests ", not as plain text. A regex
 * anchored on `^\s*Tests` silently fails to match that, because an escape
 * sequence is not whitespace.
 *
 * @param {string} text - Raw captured output, possibly containing SGR escapes.
 * @returns {string} The same text with every SGR sequence removed. */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** True iff vitest's own summary reports at least one FAILING test.
 *
 * The gate's central predicate, and deliberately positive: a non-zero exit
 * says something went wrong, never WHAT. A killed process, a missing test
 * file, a transform error, or a mutation that made the source unparseable all
 * exit non-zero with nothing asserted -- and because "caught" is this gate's
 * PASSING direction, reading any of them as caught prints PASS while proving
 * nothing.
 *
 * The ANSI strip is load-bearing, not cosmetic: without it this returned false
 * for EVERY mutation on the first CI run (colour on in Actions, off locally),
 * turning a healthy gate into ten inconclusive failures. Local-only
 * verification could not have caught it -- the output format differs by
 * environment, so the bug is invisible until CI runs.
 *
 * @param {string} rawOutput - vitest's combined stdout+stderr, coloured or not.
 * @returns {boolean} true only when vitest's summary reports >= 1 failing
 *   test. False for every "it never got that far" case -- no test files, a
 *   transform error, a killed process, or a summary reading "Tests  no tests".
 */
export function outputShowsFailingTest(rawOutput) {
  const match = stripAnsi(rawOutput).match(/^\s*Tests\s+.*?\b(\d+)\s+failed/m);
  // String.match yields null on no-match; read it through optional chaining so
  // the absent case and a literal "0 failed" collapse to the same answer.
  return Number(match?.[1] ?? 0) > 0;
}

/** Run `npx vitest run <testFiles> [...extraArgs]` from `cwd`, synchronously.
 *
 * Returns the raw exit code plus `signal` and `spawnError`, and does NOT
 * decide what they mean. A killed process is normalized to a non-zero exit so
 * no caller can mistake it for a clean pass -- but "non-zero" is deliberately
 * NOT sufficient for the caller to conclude a mutation was caught. See
 * classifyTestRun: for this gate, "caught" is the PASSING direction, so every
 * non-zero exit must be positively attributed to a failing test rather than
 * assumed.
 *
 * @param {string[]} testFiles - Test paths to pass to vitest.
 * @param {object} [options]
 * @param {string} [options.cwd=REPO_ROOT] - Working directory for the spawn.
 * @param {string[]} [options.extraArgs=[]] - Extra vitest CLI args.
 * @returns {{exitCode: number, stdout: string, stderr: string,
 *   signal: string|null, spawnError: Error|null}} A killed process is
 *   normalized to a non-zero `exitCode`, but callers must still consult
 *   `signal`/`spawnError` — see outputShowsFailingTest. */
export function runVitestFiles(testFiles, { cwd = REPO_ROOT, extraArgs = [] } = {}) {
  const result = spawnSync("npx", ["vitest", "run", ...testFiles, ...extraArgs], {
    cwd,
    encoding: "utf8",
  });
  const exitCode = result.status === null ? 1 : result.status;
  return {
    exitCode,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    signal: result.signal ?? null,
    spawnError: result.error ?? null,
  };
}

// Tracks the file currently mutated on disk (if any), so the process-exit
// safety net below can restore it even if something throws or the process is
// interrupted between the write and the per-mutation `finally`.
let currentMutation = null;

function scaryRestoreFailureMessage(filePath, reason) {
  return [
    "",
    "=".repeat(78),
    " FATAL: mutation-gate could not verify that it restored a source file.",
    ` File: ${filePath}`,
    ` Reason: ${reason}`,
    "",
    " The working tree may still contain a MUTATED version of this file.",
    " STOP. Do not commit. Before doing anything else, run:",
    `   git diff -- "${filePath}"`,
    `   git checkout -- "${filePath}"`,
    "=".repeat(78),
    "",
  ].join("\n");
}

/** Best-effort synchronous restore used by the exit-time safety net. Never
 * throws — this runs inside process 'exit'/signal handlers, where an
 * unhandled throw would itself abort restoration. */
function forceRestoreCurrentMutation() {
  if (!currentMutation) return;
  const { filePath, original } = currentMutation;
  try {
    writeFileSync(filePath, original);
  } catch {
    // Nothing more we can do from an exit handler; the per-mutation
    // synchronous path below is the primary guarantee and already ran.
  }
  currentMutation = null;
}

let signalHandlersInstalled = false;
/** Installs the process-exit / SIGINT safety net exactly once. Exported so
 * the self-test can assert it exists without relying on module load order.
 *
 * @returns {void} Idempotent; repeated calls register no additional handlers. */
export function installExitSafetyNet() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.on("exit", forceRestoreCurrentMutation);
  process.on("SIGINT", () => {
    forceRestoreCurrentMutation();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    forceRestoreCurrentMutation();
    process.exit(143);
  });
}

/**
 * Runs a single mutation end to end: verify uniqueness, mutate, test,
 * restore, verify restore. Returns a result object; never leaves the file
 * mutated on a normal return (a restore-verification failure calls
 * `process.exit(1)` directly rather than returning, per the hard requirement
 * that this is worse than any test failure the gate could report).
 *
 * `cwd` is the project root: mutation.file/mutation.tests resolve relative to
 * it, and it's where git status/diff run. `vitestCwd` (defaults to `cwd`) is
 * only where the `npx vitest` subprocess is launched FROM — separated so a
 * fixture tree with no local `node_modules` (the self-test) can still
 * resolve the repo's real vitest binary by launching from `REPO_ROOT` while
 * pointing vitest AT the fixture tree via `vitestExtraArgs`
 * (`--root <fixtureDir> --config <fixtureDir>/vitest.config.mjs`).
 *
 * @param {Mutation} mutation
 * @param {{ cwd?: string, vitestCwd?: string, vitestExtraArgs?: string[] }} [options]
 */
export function runOneMutation(mutation, { cwd = REPO_ROOT, vitestCwd = cwd, vitestExtraArgs = [] } = {}) {
  const filePath = path.join(cwd, mutation.file);

  if (!existsSync(filePath)) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "drift",
      reason: `file does not exist: ${mutation.file}`,
    };
  }

  const original = readFileSync(filePath, "utf8");
  const occurrences = countOccurrences(original, mutation.find);

  if (occurrences === 0) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "drift",
      reason: `find string not found in ${mutation.file} — the pattern has drifted from the source; update the mutation table's "find" field`,
    };
  }
  if (occurrences > 1) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "drift",
      reason: `find string occurs ${occurrences} times in ${mutation.file} — must be exactly 1; narrow the pattern so the mutation is unambiguous`,
    };
  }

  const absoluteTests = mutation.tests.map((t) => (path.isAbsolute(t) ? t : path.join(cwd, t)));

  // A missing test path is the same class of failure as an absent `find`
  // string: a silent no-op that would otherwise report "caught" for the
  // wrong reason (vitest exits non-zero for "no test files found" too --
  // see the check on testResult below for the case where the path exists
  // but doesn't resolve under vitest's own root/include).
  const missingTests = absoluteTests.filter((t) => !existsSync(t));
  if (missingTests.length > 0) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "drift",
      reason: `listed test file(s) do not exist: ${missingTests.join(", ")} — update the mutation table's "tests" field`,
    };
  }

  const mutated = applyReplacement(original, mutation.find, mutation.replace);

  let testResult;
  try {
    writeFileSync(filePath, mutated);
    currentMutation = { filePath, original };
    testResult = runVitestFiles(absoluteTests, { cwd: vitestCwd, extraArgs: vitestExtraArgs });
  } finally {
    // Restore happens even if runVitestFiles somehow throws.
    writeFileSync(filePath, original);
    currentMutation = null;

    const restoredContent = readFileSync(filePath, "utf8");
    if (restoredContent !== original) {
      console.error(
        scaryRestoreFailureMessage(filePath, "in-memory content does not match the original after restore"),
      );
      process.exit(1);
    }
    if (!isGitClean(filePath, cwd)) {
      console.error(scaryRestoreFailureMessage(filePath, "`git diff --quiet` reports a difference after restore"));
      process.exit(1);
    }
  }

  // A non-zero exit that actually means "vitest never ran the test" (wrong
  // include glob, bad --root, etc.) must NOT be read as "caught" -- that
  // would be exactly the false-confidence bug class this tool exists to
  // prevent, just moved into the harness instead of the invariant. Both
  // vitest's stdout and stderr are checked: which stream carries this
  // message is a vitest-version detail, not something to depend on.
  const combinedOutput = stripAnsi(`${testResult.stdout}\n${testResult.stderr}`);

  // A killed or unspawnable vitest exits non-zero for reasons that have
  // nothing to do with the invariant: an OOM kill, the CI job timeout's
  // SIGKILL, or `npx` missing from PATH. Reading any of those as "caught"
  // would print PASS while nothing was ever asserted.
  if (testResult.spawnError || testResult.signal) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "inconclusive",
      reason: `vitest did not exit normally (signal: ${testResult.signal ?? "none"}, spawn error: ${
        testResult.spawnError?.message ?? "none"
      }) — the run proves nothing about ${mutation.tests.join(", ")}`,
      testExitCode: testResult.exitCode,
    };
  }

  if (/No test files found/i.test(combinedOutput)) {
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "inconclusive",
      reason: `vitest reported "No test files found" for ${mutation.tests.join(", ")} — the harness did not actually run the test, so this is not a verified result`,
      testExitCode: testResult.exitCode,
    };
  }

  // The general form of the two guards above. "caught" is this gate's PASSING
  // direction, so it is never inferred from a non-zero exit alone -- a
  // mutation that makes the source unparseable, a broken import, or a config
  // error all exit non-zero without a single assertion running, and each would
  // otherwise print PASS. Require vitest to report an actually-failing test.
  const sawFailingTest = outputShowsFailingTest(combinedOutput);

  if (testResult.exitCode !== 0 && !sawFailingTest) {
    // Show what vitest ACTUALLY printed. Without this the message states only
    // that the run proved nothing, which is true but unactionable -- and the
    // causes look identical from the outside (missing dep, config error,
    // unparseable mutation, an output format this predicate does not
    // recognise). Diagnosing those apart from a local machine is guesswork;
    // the tail is what turns the next failure into a fact.
    const tail = combinedOutput.trimEnd().split("\n").slice(-25).join("\n      ");
    return {
      id: mutation.id,
      status: "gate-failure",
      failureKind: "inconclusive",
      reason: `vitest exited ${testResult.exitCode} but reported no failing test for ${mutation.tests.join(
        ", ",
      )} — the run did not verify the invariant (a load/transform/config error exits non-zero without asserting anything).\n    vitest output (last 25 lines, ANSI stripped):\n      ${tail}`,
      testExitCode: testResult.exitCode,
    };
  }

  const caught = testResult.exitCode !== 0 && sawFailingTest;
  return {
    id: mutation.id,
    status: caught ? "caught" : "surviving",
    reason: caught ? null : "listed test(s) still passed against the mutated (broken) source",
    testExitCode: testResult.exitCode,
    testStdout: testResult.stdout,
    testStderr: testResult.stderr,
  };
}

// ============================================================================
// Reporting
// ============================================================================

function padId(id) {
  return id.padEnd(38);
}

/** Render the human-readable report.
 *
 * @param {Array<object>} results - Per-mutation results from runOneMutation.
 * @param {Mutation[]} mutations - The table that was run, for file lookup.
 * @param {Mutation[]} knownSurviving - Documented-surviving entries; these
 *   report as KNOWN SURVIVING and do not fail the gate.
 * @returns {{message: string, ok: boolean}} `ok` is false if ANY mutation
 *   survived undocumented or produced a gate failure. */
export function formatReport(results, mutations, knownSurviving) {
  const knownIds = new Set(knownSurviving.map((k) => k.id));
  const lines = [];
  lines.push("");
  lines.push("mutation-gate report");
  lines.push("=".repeat(78));
  lines.push(`${padId("id")}applied  caught  status`);
  lines.push("-".repeat(78));

  let hardFailures = 0;
  const surviving = [];
  const knownSurvivingHit = [];

  for (const r of results) {
    // A drift failure never reached the write; an inconclusive one did.
    const applied = r.status !== "gate-failure" || r.failureKind === "inconclusive";
    // A gate failure never determined caught-ness either way; "NO" would
    // read as "it survived", which is a different and answerable finding.
    const caughtCol = r.status === "gate-failure" ? "n/a" : r.status === "caught" ? "yes" : "NO";
    let statusCol;
    if (r.status === "gate-failure") {
      statusCol = "GATE FAILURE";
      hardFailures++;
    } else if (r.status === "caught") {
      statusCol = "caught";
    } else {
      // surviving
      if (knownIds.has(r.id)) {
        statusCol = "KNOWN SURVIVING";
        knownSurvivingHit.push(r);
      } else {
        statusCol = "SURVIVING (FAIL)";
        hardFailures++;
        surviving.push(r);
      }
    }
    lines.push(`${padId(r.id)}${String(applied).padEnd(9)}${caughtCol.padEnd(8)}${statusCol}`);
  }
  lines.push("-".repeat(78));

  if (hardFailures === 0) {
    lines.push(`PASS — ${results.length} mutations checked, all caught or documented as known-surviving.`);
  } else {
    lines.push(`FAIL — ${hardFailures} of ${results.length} mutations did not verify.`);
  }

  const describeFailures = (rows, heading) => {
    if (rows.length === 0) return;
    lines.push("");
    lines.push(heading);
    for (const r of rows) {
      const m = mutations.find((mm) => mm.id === r.id) ?? knownSurviving.find((mm) => mm.id === r.id);
      lines.push(`  [${r.id}] ${m?.file ?? "?"}`);
      lines.push(`    ${r.reason}`);
    }
  };

  const gateFailures = results.filter((r) => r.status === "gate-failure");
  describeFailures(
    gateFailures.filter((r) => r.failureKind === "drift"),
    "Table drift (the mutation was NOT applied) — gate failures, not skips. Fix the table:",
  );
  describeFailures(
    gateFailures.filter((r) => r.failureKind === "inconclusive"),
    "Inconclusive runs (the mutation WAS applied, but the test run proved nothing) — never read as caught:",
  );

  if (surviving.length > 0) {
    lines.push("");
    lines.push("SURVIVING MUTANTS — the invariant broke and no listed test noticed:");
    for (const r of surviving) {
      const m = mutations.find((mm) => mm.id === r.id);
      lines.push(`  [${r.id}]`);
      lines.push(`    invariant: ${m?.invariant}`);
      lines.push(`    file:      ${m?.file}`);
      lines.push(`    expected one of these tests to go RED: ${m?.tests.join(", ")}`);
    }
  }

  if (knownSurvivingHit.length > 0) {
    lines.push("");
    lines.push("KNOWN SURVIVING (documented gap, does not fail the gate — fix these when you can):");
    for (const r of knownSurvivingHit) {
      const m = knownSurviving.find((mm) => mm.id === r.id);
      lines.push(`  [${r.id}] ${m?.issue ?? "(no issue filed)"}  — ${m?.note ?? ""}`);
    }
  }

  lines.push("");
  return { text: lines.join("\n"), hardFailures };
}

// ============================================================================
// Orchestration
// ============================================================================

/**
 * Runs the full table (MUTATIONS + KNOWN_SURVIVING) against `cwd`. Refuses
 * up front if any target file already has uncommitted changes. Exported so
 * the self-test can call it directly against a synthetic table/cwd.
 *
 * @param {object} [options]
 * @param {Mutation[]} [options.mutations=MUTATIONS] - Table to verify.
 * @param {Mutation[]} [options.knownSurviving=KNOWN_SURVIVING] - Documented
 *   surviving mutants; present but not failing.
 * @param {string} [options.cwd=REPO_ROOT] - Repo root to mutate within.
 * @param {string} [options.vitestCwd=cwd] - Directory to spawn vitest from.
 * @param {string[]} [options.vitestExtraArgs=[]] - Extra vitest CLI args.
 * @returns {{message: string, ok: boolean}} Caller maps `ok` to the exit code.
 */
export function runMutationGate({
  mutations = MUTATIONS,
  knownSurviving = KNOWN_SURVIVING,
  cwd = REPO_ROOT,
  vitestCwd = cwd,
  vitestExtraArgs = [],
} = {}) {
  installExitSafetyNet();

  const all = [...mutations, ...knownSurviving];
  const targetFiles = [...new Set(all.map((m) => m.file))];
  const dirty = dirtyFiles(targetFiles, cwd);
  if (dirty.length > 0) {
    const message = [
      "Refusing to run: the working tree already has uncommitted changes to files",
      "this mutation table touches. The gate cannot tell its own mutation apart",
      "from a real edit in progress, and a crash mid-run could then destroy it.",
      "",
      "Commit, stash, or revert these before running the mutation gate:",
      ...dirty.map((d) => `  ${d}`),
      "",
    ].join("\n");
    return { ok: false, reason: "dirty-working-tree", message, results: [] };
  }

  const results = all.map((mutation) => runOneMutation(mutation, { cwd, vitestCwd, vitestExtraArgs }));
  const { text, hardFailures } = formatReport(results, all, knownSurviving);
  return { ok: hardFailures === 0, reason: null, message: text, results };
}

// ============================================================================
// CLI entry point
// ============================================================================

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const start = Date.now();
  console.log(`mutation-gate: verifying ${MUTATIONS.length} invariant mutation(s)...`);
  for (const m of MUTATIONS) {
    console.log(`  - ${m.id}`);
  }
  if (KNOWN_SURVIVING.length > 0) {
    console.log(`  + ${KNOWN_SURVIVING.length} documented KNOWN_SURVIVING (checked, don't fail the gate)`);
  }

  const outcome = runMutationGate({});
  console.log(outcome.message);

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`mutation-gate finished in ${elapsedSec}s`);

  if (!outcome.ok) {
    process.exit(1);
  }
}
