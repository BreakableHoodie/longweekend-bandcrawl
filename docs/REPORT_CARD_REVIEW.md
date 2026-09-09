# Codebase Report Card

Read **both** `AGENTS.md` and `CLAUDE.md` first — this repo has both and they are not
interchangeable. `AGENTS.md` is the short entry point and defers to `CLAUDE.md` in three
places, including for this review's own cadence and caveats; `CLAUDE.md` holds the full
invariant catalogue you are grading against. Reading only one skips the constraints that
make the grade meaningful. Use them for stack, conventions, and stated priorities. Then
review the codebase and grade it like a report card, using the categories below. Ground
every grade in specific files/lines, not vibes.

## Categories (grade each A–F)

- **Architecture & organization** — module boundaries, coupling, whether structure matches what AGENTS.md/CLAUDE.md describes.
- **Code quality & readability** — naming, duplication, dead code, complexity.
- **Test coverage & quality** — what's tested, what's not, whether tests actually catch regressions or just pad coverage.
- **Error handling & resilience** — failure modes, edge cases, what happens when external calls fail.
- **Security** — secrets handling, input validation, auth, injection risk, dependency vulnerabilities.
- **Performance** — obvious inefficiencies, N+1s, unbounded loops/queries, anything that won't scale.
- **Documentation** — README accuracy, inline comments where logic isn't self-evident, whether AGENTS.md/CLAUDE.md matches reality.
- **Dependency health** — outdated/abandoned packages, unnecessary bloat, version conflicts.
- **Consistency with stated conventions** — does the code actually follow what AGENTS.md/CLAUDE.md says it should?

## Step 1: Grade

For each category give: letter grade, 2–3 sentence justification, and the worst 1–3 concrete examples (file + line). No generic praise or generic criticism — if you can't point to a specific line, don't claim it.

Then give an overall grade and a one-paragraph summary of the biggest risk in this codebase right now.

## Step 2: Fix what you can safely fix

Rank all issues found by impact-to-effort ratio. Then actually fix the ones that are safe: no breaking changes, no unrequested architecture rewrites, no guessing at business logic you don't have context for. For anything riskier, leave it as a recommendation instead of touching it — flag why you're not fixing it.

**File every deferred finding as a GitHub issue and reference it from the PR.** A
recommendation that lives only in the report card is lost the moment the session ends —
which is the failure this whole review exists to catch, reproduced by the review itself.
Search existing issues first: the first run found a stalled tracking issue where three of
eight items were already done or no longer reproducible.

Show your work: what you changed and why, file by file.

## Step 3: Re-grade

After fixes, re-run the same categories and give updated grades. Call out what moved and what didn't. End with a short list of what's still holding the grade down — the stuff that needs a human decision (real refactors, product/business logic calls, anything ambiguous) rather than an agent's judgment call.

---

## Project-specific rules for this repo

Added after the first run (2026-08-20). Each one exists because the first run got
it wrong, not because it sounded good.

### Measure, don't estimate

Run the real gates before grading anything: `make gate`, `npm run test:coverage`
in both stacks, `npm audit` in **both** root and `frontend/`, `node
scripts/check-schema-drift.mjs`, `npm run validate:openapi`. A grade for "test
coverage" that never ran the suite is a vibe.

**The schema gate is the raw script here, deliberately — not `make schema-check`.**
That target regenerates `setup-complete.sql` *before* drift-checking it, so it
compares a freshly generated file against the migrations that just generated it.
It is the right command when you have edited `migrations/` and want the file
brought back in step; it is the wrong one for an audit because it repairs the
drift instead of reporting it. Measured on artificial drift (a removed index):
the raw check exits **1**, `make schema-check` exits **0**. Do not "fix" this to
use the Make target.

### Grade against this repo's own invariants, not generic best practice

`CLAUDE.md` states its invariants precisely enough to falsify — "8 files guard
`is_announced`", "exactly one `_routes.json`", "four routes write `status`". Check
them. On the first run every numeric claim held, which is itself a finding.

### Verify test QUALITY by mutation, never by the suite passing

Break an invariant and confirm the suite goes red. On the first run this is what
separated real guards from decorative ones: mutating the after-midnight threshold
failed 10 tests, mutating event visibility failed 14 — but **deleting `AND
verified = 1`, the entire anti-email-bombing control, left all 1,169 tests
green**. Every follower fixture in ten test files seeded `verified = 1`, so no
test could tell a gated query from an ungated one.

A suite that looks exhaustive can prove nothing about the property it most needs
to prove. Passing is not evidence.

### Mutate the FIXTURES too, not just the code

The first run mutated production code diligently and still shipped three vacuous
tests of its own, all caught in review:

| Vacuity | Why it passed |
|---|---|
| `source.includes(CONST)` | satisfied by a comment or a leftover import |
| a hand-listed file inventory | cannot fail for a path nobody added to it |
| a fixture that short-circuited | the code under test never ran; only status was asserted |

The pattern is asserting on a **proxy** — a substring, a status range, a curated
list — instead of the outcome. Derive inventories from source, assert on
persisted state, and check that reverting the fixture makes the test fail.

### Sweep for siblings, then guard the class

One fixed instance of a systemic bug is a false sense of completion. Deriving the
write-path list from source instead of hand-listing it is what exposed a second
missing validation call that four rounds of manual review had missed. Prefer a
source-scanning guard over a repeat audit.

### Audit production before shipping a new constraint

A new validation rule can make existing rows uneditable. Query D1 first
(`mcp__settimesdotca__queryDB`, read-only) and report counts. The zero-length-set
rule shipped only because the audit showed 0 of 283 affected rows — and it kept
`end < start` and NULL `end_time` legal because 5 and 175 rows respectively
depend on that.

### Check whether it is already tracked

Search issues before filing. The first run found a stalled tracking issue where
**three of eight items were already done or no longer reproducible** — filing
against it blind would have duplicated closed work.

### Correct yourself in public

The first run made three wrong claims that survived into filed issues: "nothing
validates zero-length sets" (three of five paths did), "these components have no
tests" (a bad `find`), "the roster query is unbounded" (capped at 500). Post the
correction on the issue. A confidently wrong report card is worse than none.

### A markdown needs a line number, not an instinct

Added after the second run (2026-09-09). Three of nine grades were marked down
for reasons that did not survive being checked, and all three were generic
instinct applied without measurement:

| Marked down for | What checking found |
|---|---|
| Architecture — five files over 1,000 lines | #1020 had already measured composition: 49–64% JSX, extraction *relocates* lines rather than deleting them. The size is known and largely irreducible. |
| Error handling — no reason stated at all | A scan found 7 "swallowed-looking" catch blocks; **all 7** carry explicit fallbacks or a documented reason. One was a false positive from the scan's own regex. |
| Dependency health — 21 outdated frontend packages | Every one is a single patch/minor step, i.e. normal churn between weekly Dependabot runs. All 8 audit findings are dev-only; both production trees are clean. |

Overall went A− to A on inspection alone, with no code changed.

The failure mode is subtle because it produces a *plausible* report: big files,
outdated deps and empty-looking catches are real smells in general. They were
not smells here, and the difference is only visible by opening the file. The
doc already says "if you can't point to a specific line, don't claim it" — the
addition is that this applies to the GRADE, not just the examples under it. A
category marked down with no cited line is a category not yet graded.

Corollary: **a grep count is not a finding.** Each of the three above came from
counting something — files over N lines, packages behind, catch blocks matching
a pattern. Every one dissolved on reading the matches.

### Then run the standing gates

`make review` (CodeRabbit) before opening each PR. Note the CLI does **not** load
`.github/instructions/**` while the PR bot does, so a post-open finding is
expected, not a gate failure.
