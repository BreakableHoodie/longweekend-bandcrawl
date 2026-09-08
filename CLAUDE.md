# CLAUDE.md — settimesdotca

AI assistant context for this codebase. Captures non-obvious invariants, known gotchas, and conventions that aren't derivable from reading the code.

---

## Proactive Quality Gates

Invoke these without being asked — don't wait for the user to request them:

| Trigger | Action |
|---------|--------|
| **Before opening any PR** | `make review` (CodeRabbit) — the standing review gate |
| Multi-file feature touching a documented invariant, a migration, or an architectural decision | Invoke `pr-review-toolkit:code-reviewer` agent **in addition** to CodeRabbit |
| **Any bug you diagnose** | Sweep for other instances of the same class before calling it fixed — see "Sweep for siblings" below |
| **Adding/changing a test for a documented invariant in `functions/`** | Add/refresh its entry in `scripts/mutation-gate.mjs` — see "The mutation gate" below. A test only ever seen passing proves nothing. Backend only: the gate does not cover `frontend/` yet |
| **Adding a new handler under `functions/api/`** | It must be executed by at least one test. `make coverage-floor` fails on any file at 0% — the global coverage average cannot see a file-shaped hole |
| After editing `functions/utils/auth.js`, session endpoints (`sessions/`), or follow/unfollow/confirm-follow flows | Invoke `cloudflare-security-reviewer` agent |
| After writing or modifying error handling (`catch` blocks, `.catch()`, `try/finally`) in `functions/` | Invoke `pr-review-toolkit:silent-failure-hunter` agent |
| After editing `frontend/src/` public pages (outside `admin/`) | Scan for `text-white`/`bg-white` theme violations before finishing |
| After adding/editing anything in `migrations/` | Run `node scripts/regenerate-setup-complete.mjs` then `node scripts/check-schema-drift.mjs` — `setup-complete.sql`'s schema section is generated, never hand-edit it (CI enforces via quality.yml) |
| When SEO-relevant pages change (band pages, event pages, venue pages) | Check structured data and `document.title` assignments |
| **Start of a release cycle, or ~quarterly** | Run the codebase report card — `docs/REPORT_CARD_REVIEW.md` (see below) |

The `hooks` in `.claude/settings.local.json` automate the mechanical parts (prettier, ESLint, pre-PR gate). The triggers above require judgment — apply them proactively.

**CodeRabbit is the standing gate; the code-reviewer agent is trigger-only.** CodeRabbit is diff-scoped and reliably catches convention breaks, unscoped test selectors, dead code, and latent time-bombs — and it runs on the PR regardless, so `make review` beforehand only saves a force-push cycle. The code-reviewer agent reads across files and earns its cost when the question is "does this violate an invariant or drift from the architecture." Don't block on Copilot; in practice it duplicates CodeRabbit.

### The codebase report card — run it on a cadence

`docs/REPORT_CARD_REVIEW.md` grades the whole repo across nine
categories, fixes what is safe, and re-grades. It is **tracked in this repo on
purpose**: the original lived outside the working tree, where a fresh clone,
CI, or a delegated run would never find it — the same failure as the untracked
`instructions/` tree in #818.

**Tracked in git, deliberately excluded from the published site** (owner decision,
2026-08-20). `docs/*.md` is published to docs.settimes.ca regardless of the mkdocs
`nav`, so the exclusion is what keeps it internal — it is listed in `mkdocs.yml`'s
`exclude_docs` block. The doc names past security gaps by name, which is what makes
it useful to us and not something to serve publicly. Do not "fix" the missing nav
entry by adding one; the file is meant to be absent from the site, not unlinked in it.

**Cadence: at the start of a release cycle, or roughly quarterly — whichever
comes first.** It is deliberately not a per-PR gate. It reads the whole tree and
runs every gate, so it costs real time; CodeRabbit and the trigger-based agents
above cover the per-change surface. Run it when the question is *"what has
drifted while we were shipping?"*, not *"is this diff correct?"*.

**Run it after a season ends, before the next edition's build-out starts.** That
is when accumulated drift is cheapest to fix and least likely to collide with
event-critical work.

**What it is for, and what it is not.** It catches the class of problem no
diff-scoped reviewer can see: a coverage ratchet that drifted ten points below
actual and would have passed a double-digit regression; a two-tier cache module
whose second tier was exported and imported by nothing while five endpoints
copy-pasted its value; a dependency override pinned *inside* its own vulnerable
range; a security control with zero test coverage because every fixture in ten
files seeded the passing case. None of those appear in any single diff. All four
were found by the first run (2026-08-20, #900–#917).

**Its findings are claims until verified.** That first run also produced three
wrong assertions that reached filed issues — "nothing validates zero-length
sets" (three of five write paths did), "these components have no tests" (a bad
`find`), "the roster query is unbounded" (capped at 500) — and three vacuous
tests of its own. Treat the output as a lead list to check, not a verdict, and
correct the record on the issue when a lead does not survive contact.

### Sweep for siblings

**When you diagnose a bug, find every other instance of that class before declaring it fixed** — and report the sweep, whether or not it found anything. No line-level reviewer does this; it sees only the diff in front of it.

The worked example is `performance_date` (#739 → #741 → #743). One endpoint dropped the field from its projection, so a multi-day event's sets all rendered with the event's start date. Fixing that one endpoint felt complete. It wasn't: the same defect was live on the venue page, on GenreDiscovery, and in the event recap's sort. Three more surfaces, found only because the class was swept afterwards — and one of them had already been stumbled on by hand.

The mechanical form is usually one grep. "Which files select `p.start_time` but never mention `performance_date`?" turns a vague worry into a table.

Prefer a durable guard over a repeat audit: a source-scanning test (as `bandFields.test.js` does for Tailwind class literals) collapses a whole bug class into one failing test.

### Verify guards against the failure they guard, not the success

**Code whose only job runs when something breaks must be tested broken.** A
guard, a diagnostic, a timeout, a retry, an error handler — none of it is
exercised by the happy path, so a green run says nothing about whether it works.

Five instances in one day (2026-08-19), all shipped after reading the code and
all caught only by *running* the failure:

| Guard | What it did on the failure path |
|---|---|
| `curl` probe in the Lighthouse diagnostics (#879) | Unbounded — would hang to the 15-minute job timeout in the *wedged* case it existed to detect, costing the artifact upload |
| `ss` listener check (#879) | Printed nothing when nothing was listening — "no listener" is the crashed-vs-wedged signal, and silence reads as command failure |
| Exit-status capture in the apt bound (#882) | `code=$?` after `if cmd; then return 0; fi` read the **if-statement's** status, not the command's — an `if` whose condition fails with no `else` returns 0, so **every failure was captured as 0 and treated as success** |
| `timeout` without `-k` (#882) | Sends SIGTERM, which apt-get can ignore — process survives, step still hangs |
| Retry around the apt bound (#883) | Attempt 1's SIGKILLed apt-get orphan kept `/var/lib/apt/lists/lock`, so attempt 2 could never succeed |

The pattern is identical every time: the happy path was written and verified;
the failure path was written and *assumed*.

**What actually catches these** is cheap — substitute the failing thing and run
it:

```bash
# Prove the listener check reports "none" when ss returns an empty header
ss() { return 0; }; run_listener_check          # -> "  none", not silence

# Prove the bound kills a process that IGNORES SIGTERM
run_bounded "stubborn" bash -c 'trap "" TERM; sleep 60'   # -> 137 in ~3s, not 60s

# Prove the exit status you capture is the COMMAND's, not a compound's
f() { if false; then return 0; fi; code=$?; echo "$code"; }   # -> 0  WRONG
g() { code=0; false || code=$?; echo "$code"; }               # -> 1  right

# Prove the bounded probe cannot outlive its own budget
time run_bounded "hang" sleep 600                # -> ~300s, not 600s

# Prove a retry survives a KILLED predecessor, not just a cleanly-failed one
```

That last line is the one that cost the most: the retry was tested against a
command that failed *cleanly*, never against one that had been *killed* — the
only case the step actually produces. It has no one-liner because proving it
needs the predecessor's orphaned children still holding a lock, which is the
whole reason a naive retry fails (#883).

**The status-capture probe earns its place twice over.** The original diagnosis
of that bug was itself wrong — it blamed `local` for resetting `$?`, which
`false; local code=$?` disproves in one line (it yields 1). The real culprit is
that an `if` whose condition fails and has no `else` returns 0. A wrong
explanation shipped into a code comment and this file before a probe caught it;
running the two-line comparison above would have caught it immediately.

**Ask before shipping any guard: what does this print, and what does it return,
when the thing it guards is actually broken?** If you cannot answer from a run
rather than from reading, it is not verified. This is the same discipline as
mutation-testing an assertion (see the vacuous-test class), applied to
operational code instead of tests.

### The efficiency ladder — before you write

Adapted from the [ponytail](https://github.com/DietrichGebert/ponytail) ruleset. Before writing code, stop at the first rung that applies:

1. **YAGNI** — does this need to exist at all?
2. **Reuse** — does it already exist here? (`functions/utils/`, `frontend/src/utils/`, the `bandFields.js` registry, `prepareBands`)
3. **Standard library / platform** — does JS, Web Crypto, or D1 already do it? (see the PBKDF2 and TOTP invariants — this repo has repeatedly chosen the platform primitive over a dependency)
4. **Existing dependency** — does something already in `package.json` solve it?
5. **One line** — can it be one line?
6. **Minimum working code** — only then.

Deletion over addition. Boring over clever. Fewest files that work.

**The ladder runs after you understand the problem, not instead of it.** Trace the real flow end-to-end first. A short diff that patches a symptom is worse than a longer one that fixes the cause — the ladder ranks *solutions to the actual problem*; it does not rank problems by how cheap they are to make disappear. It defers to the debugging discipline, always.

**The ladder governs the fix. It does not govern the sweep.** The sibling sweep and its durable guard test are *requested work* — part of the definition of done for any bug fix — never speculative additions for rung 1 to eliminate. And on the merits: one source-scanning test that retires a bug class permanently is less total work than re-running that sweep by hand on every future PR. **The guard is the lazy option**, not the expensive one.

Never be lazy about understanding, input validation, error handling that prevents data loss, security, accessibility, theme-token correctness, or anything explicitly asked for.

> Adopted as doctrine only — the ponytail plugin itself was evaluated and **not installed** (2026-08-06). Its hard rules ("no boilerplate that wasn't asked for", "shortest working diff wins") cut against the sweep discipline above, and its benchmark is n=4 on Haiku 4.5. Take the ladder, skip the installation; don't re-litigate.

---

## Agent Delegation Workflow (standing default)

**Delegate by default — do not do everything inline.** This is a permanent preference and overrides any base "don't spawn agents unless asked" default.

- **Opus / Fable ("big brain")** → engineering design, architecture, planning, and code/security review.
- **Sonnet** → implementation / mechanical coding (well-specified edits, test writing).
- **Orchestrator (Opus) still verifies:** read the diffs, run tests/lint/build, and run the security/code-review gates above before declaring anything done. Delegation never removes the verification step.

When a task has a clear implementation spec, dispatch a Sonnet agent to build it; reserve Opus/Fable for the design up front and the review after. Always follow a Sonnet implementation with a big-brain review pass — that second perspective catches whole bug classes a to-spec implementer stops short of.

### Verifying any delegation — `scripts/delegate-verify.mjs`

**A delegate's exit code and self-reported status are claims, not evidence. `git status` is the evidence.** Wrap every delegated run:

```bash
node scripts/delegate-verify.mjs -- <the delegation command>
node scripts/delegate-verify.mjs --allow-empty -- <read-only command>   # research/digest tasks
```

Exit codes: `0` succeeded *and* changed files · `1` the command failed · `2` **reported success but changed nothing** · `3` the delegate committed on a protected branch · `4` usage.

Code `2` is the one that pays for the script. Measured 2026-08-13: an agy delegation returned exit `0` and `AGY_USAGE {"status":"SUCCESS"}` having touched **zero files** — headless agy had no `write_file` grant, so it described the work instead of doing it and still "succeeded". 96,825 tokens, nothing on disk, and nothing in its own output said so. The tool behaved exactly as its README documents ("ungranted writes leave the workspace untouched but report success"); the mistake was trusting the status field.

Code `3` enforces the other half of the contract below: **a delegate never moves `main`.** It may branch, commit and open a PR — that is the normal workflow now, and it routes the change through the ruleset (protected main, strict checks, threads resolved) rather than through someone remembering to look. What it must never do is commit on the default branch, which bypasses review entirely. A commit on a feature branch is reported, not failed.

The check is deliberately tool-agnostic — it wraps agy, OpenCode's relay, or anything else, because the failure is about *permissions and silent refusals*, not about any one vendor. It uses `git status --porcelain`, so a brand-new untracked file counts as real work (a `git diff`-only check would call that a no-op).

**Before the first real delegation on a new machine or after a tool upgrade, prove the write grant with a throwaway task** rather than discovering it on a task you cared about. One canary costs seconds; the failure above cost 96k tokens.

### Delegating to OpenCode

A third implementer, on a separate subscription: the `opencode-delegate` skill.

**It is not in this repo and a fresh clone will not have it.** It is an external prerequisite, installed per-machine into the gitignored `.agents/skills/` (see `.gitignore`), which is why `relay.mjs` will not appear in `git ls-files`:

```bash
npx skills add amElnagdy/delegate-skills --skill opencode-delegate
# lands in .agents/skills/opencode-delegate/, symlinked to .claude/skills/
```

It also needs the `opencode` CLI on PATH and an authenticated provider (`opencode auth list`).

Use it for well-specified work that would otherwise consume this session's context. **The relay does NOT commit.** It edits the working tree and stops; whoever dispatched it reads the diff, re-runs `make gate`, and commits. `relay.mjs --help` states it outright ("Committing is always the orchestrator's job"), the run prints "relay does not commit" on completion, and a delegation on 2026-09-01 left nine modified files uncommitted exactly as described. Both are checkable from this repo: run `--help`, or read `result.json`, which lists `touchedFiles` and no commit.

This paragraph previously claimed the opposite — that OpenCode "works issues end to end: it branches, commits, and opens a PR" — while the numbered rule four lines below it said the relay "never commits". Both were in this section at once, so whichever a reader reached first was the one they believed. Corrected against the installed relay's behaviour, which is the only authority here.

Because it does not commit, **dispatch it only from a CLEAN working tree on its own branch.** A new branch does not separate work that is already uncommitted — `git checkout -b` carries those changes along, so relay edits and your in-progress work end up in one tree and get committed together. Commit or stash first, or give it a separate `git worktree`. Verify with `git status --porcelain` before dispatching; `scripts/delegate-verify.mjs` reports what changed afterwards but cannot tell your edits from the relay's. The invariant is unchanged either way: **nothing lands on `main` unreviewed.**

Four rules, each learned by something breaking:

1. **Always go through `relay.mjs`; never a raw `opencode run`.** Not for permissions — `opencode run` auto-approves by default, and a raw run *did* edit files headlessly in testing, so `--auto` is belt-and-braces rather than load-bearing. The relay earns its place for three other reasons: it feeds the brief over **stdin** (rule 3), it writes a structured `result.json` carrying `cost`, `touchedFiles` and the session id, and it never commits. A raw run gives up all three.
2. **Always pass `--model` explicitly, and pick from the flat-rate provider.** Not because a bare run fails — with a valid `model` in `opencode.json` it resolves and runs fine. Pass it for **reproducibility**: the config default can change under you, and a delegation you cannot attribute to a model is a cost figure you cannot learn from. **Which prefix is flat-rate vs metered is a lookup, not a memory** (see the staleness note below); routing paid work through a metered gateway by assumption is the mistake this rule prevents. A `claude-*` entry from any provider is redundant with the orchestrator regardless.
3. **The brief goes in a file (`--brief`), never on the command line.** Large content in argv hangs the CLI; the relay feeds it via stdin for exactly this reason.
4. **`opencode.json` is the tooling surface** — its `instructions` array feeds OpenCode this `CLAUDE.md` and the repo's instruction files, and it also declares the MCP servers, agents and commands a delegated run can reach. That is why a delegated diff can respect invariants nobody restated in the brief. **Read the file for the current inventory rather than trusting a count written here**, and keep `model`/`small_model` pointing at *authenticated* providers — a stale entry there fails every run that relies on the config default (see the dated anecdotes for the instance of this that actually happened).

   **The `instructions` array is a floor on every run's cost — keep it to invariants, not reference docs.** Every listed file is loaded before the brief is even read, on *every* delegation. It once held 18 entries totalling ~310 KB (~77k tokens), which is why a trivial one-file read still cost $0.246 (measured 2026-08-13). It is now five entries (~18k tokens), a ~77% cut.

   **Every path in the array must be tracked in git** (`functions/__tests__/opencodeInstructions.test.js` enforces it). Until #818 the array pointed at `instructions/`, which `.gitignore` excludes — so the committed config named three files that existed on one machine and nowhere else. A fresh clone, CI, or a clean Otto checkout resolved none of them, and **OpenCode says nothing when an instruction file is missing**; the run just proceeds with less context than the brief assumed. The tracked tree is `.github/instructions/`.

   The rule that decides membership: **OpenCode can already read any file in the repo on demand.** So the array is for things a delegated run must not violate *but would never know to look up* — `CLAUDE.md`'s invariants, the security defaults, and the conventions that shape *every* diff regardless of what the task touches. That last category is why `.github/instructions/nodejs-javascript-vitest.instructions.md` and `…/self-explanatory-code-commenting.instructions.md` are in the array: this repo is JavaScript and Vitest end to end, so those govern every delegation rather than a subset of them.

   Everything else stays out, including the rest of `.github/instructions/`. Reference material (`docs/DATABASE.md`, `docs/API_DOCUMENTATION.md`, `docs/BACKEND_FRAMEWORK.md`) and the per-domain instruction files (`a11y`, `playwright-typescript`, `tailwind-v4-vite`, `shell`, …) are **not** loaded, because a run that needs the schema can open the schema.

   The tradeoff is real and is handled in the brief: **a task that needs a domain instruction file must name it.** An a11y fix says, "read `.github/instructions/a11y.instructions.md` first"; a Playwright change names the Playwright one. That is one line in a brief, paid only by the runs that need it, instead of ~5.7k tokens charged to every backend fix that does not. Before adding an entry back, ask whether *every* delegation needs it — if not, name it in the brief instead.

**Cost is the throughput constraint, not the bill.** The subscription is flat-rate but capped in usage-dollar terms, so an expensive model buys fewer delegations per window rather than a larger invoice. Read the cost after **every delegated run** — but read it with `make delegate-stats`, NOT from `result.json`, whose `cost` field reports `$0.0000` on a free model and invites the conclusion that the run consumed nothing (see below). A raw `opencode run` writes no `result.json` at all, which is a separate reason to go through the relay.

**`make delegate-stats` is how you read the cost — not `result.json`.** The relay
writes a `cost` field, and on a free model it reads `$0.0000`, which invites the
conclusion that a delegation consumed nothing. It did not: measured 2026-09-02,
four dispatches on `opencode/big-pickle` came to **314 messages and 3.1M input
tokens** in this project alone. Counting *dispatches* understates the work by
roughly two orders of magnitude.

`opencode stats --days N --models --project ""` is the real view, wrapped as
`make delegate-stats` (override the window with `DAYS=30 make delegate-stats`).
The `--project ""` is load-bearing: the default is EVERY project on the machine.

Three limits on what it can tell you, all worth knowing before relying on it:

- It reads **local session history**, so it reports consumption, not entitlement,
  and cannot see runs from another machine.
- **There is no quota endpoint to ask.** `opencode.ai/v2/docs/api` is the local
  *server* API — sessions, filesystem, shell, MCP, 140 operations — and documents
  nothing for usage, billing or limits. An MCP server would not help; there is
  nothing account-shaped to expose.
- A **$0.00 model is free FOR NOW, not free by contract.** OpenCode's own Zen
  page describes Big Pickle as "a stealth model that's free on OpenCode for a
  limited time". A community GitHub comment claiming a ~200-request cap does not
  match the vendor's page and is four months old — the catalog has already
  rotated since (it named one Minimax; there are now three). If a delegation
  starts reporting a non-zero cost, that window closed.

**Model names, prices and caps go stale — look them up rather than trusting this file.** Providers rename, deprecate and reprice constantly; a doctrine that caches those values becomes confidently wrong, which is the failure mode the guards in this file exist to prevent elsewhere. Re-derive:

```bash
opencode auth list    # which providers are actually authenticated here
opencode models       # the live catalog, grouped by provider prefix
```

Then confirm from the vendor's current docs which prefix is the flat-rate subscription and which is metered. **Never infer it from the model name**, and ask rather than guess.

The durable part is the method:

- Cost is **tokens consumed × current price**. Tier labels predict neither: a "pro"/"max" model can consume fewer tokens by exploring less, and prices change independently of names. So never rank by tier label alone — and never ignore a price change either. Compare **token usage and reported cost together**.
- The only trustworthy comparison is **the same brief, on the same repository state, run per model**. Different tasks produce different exploration, so their costs are not comparable at all.
- Treat any model you have not run that way as unmeasured, and say so rather than implying a ranking.

> **Dated anecdotes — 2026-08-12** (OpenCode CLI 1.18.16, `opencode-delegate` 0.4.2, this repo). Three delegations, each a *different* task: a 2-file task on `deepseek-v4-pro` reported $0.125; a 3-file task on `glm-5.2` reported $0.65; a 10-file task on `glm-5.2` reported $2.14.
>
> **These do not compare the models.** Different briefs, different repository states, no token counts captured — the numbers reflect task size at least as much as model choice. They are recorded only as order-of-magnitude evidence that delegation cost varies enough to matter, and as a reminder that a "pro" tier is not automatically the expensive one. A real comparison needs the same brief run per model; none has been done.
>
> Also environment-specific and dated to this same day, both measured on **raw `opencode run`**, not through the relay: a ~1.5 KB brief passed in argv hung past 180s, while the identical text attached with `opencode run -f <file>` returned in 11s; and `opencode.json` named `anthropic/*` models while only OpenCode's own providers were authenticated, so every run falling back to the config default failed (rule 4).
>
> Note the flags belong to different tools and are not interchangeable: `-f` is a raw `opencode run` flag, whereas the relay takes `--brief <file>` and feeds it over **stdin**. So the 11s figure shows that *getting the brief out of argv* fixes the hang — it is not a measurement of the relay's own path, which was never argv-based. Rule 3 holds either way; only the mechanism differs. Re-verify rather than assume.

---

## Mission & Scope

settimes.ca is the multi-venue/multi-artist event platform for **Waterloo Region** (Kitchener-Waterloo, ON). The next edition is **Long Weekend Band Crawl Vol. 18** on **October 11, 2026** (event 37, `lwbc18`, single-day) — **`published` since 2026-08-28, with an empty lineup** (the supported "Lineup TBA" state; see the empty-lineup override under event visibility). It is live to the public now.

- **Focus:** Waterloo Region. This governs **product language** — marketing copy, meta descriptions, SEO targeting, "where this is for" statements. It is not a censor on fact: the platform has hosted an event outside the region (Buddies Fest 2, Tillsonburg) and those records stay accurate wherever they appear. The specific drift this rule exists to prevent is describing the site as serving Ottawa, which it does not.
- **Brand:** settimes.ca — no rebranding
- **Target event:** Vol. 18, October 11, 2026
- **Both fan-facing and admin tooling are equal priority**
- **SEO is a priority** (band pages, event pages, local discovery, structured data)
- **Colour themes:** 4 user-selectable (dark + light presets) via Tailwind v4 CSS custom properties + `data-theme` on `<html>`, persisted in localStorage
- **Single photo per band** — extends existing `photo_url` / R2 upload flow; no video embeds

**Shipped editions** (both `status = 'archived'`): Vol. 17 (event 21, 2026-08-02, 22 bands across 6 King St N venues — Blue Room, Princess Cafe, Prohibition Warehouse, Revive Karaoke, Room 47, Roost) and Buddies Fest 2 (event 36, 2026-08-07→09, Tillsonburg — the first multi-day production event). Their lineups and venue rosters are live data now, not spec; read them from D1 rather than from this file.

**Between seasons is a supported state, not a bug** — and as of 2026-08-28 we are no longer in it. Vol. 18 is `published` with zero performances, so the surfaces split into two groups that a stale reading of this section would get wrong:

| Surface | Now | Why |
|---|---|---|
| `/api/events/public` (defaults `upcoming=true`) | **1** (`lwbc18`) | event-driven; a published future event qualifies |
| `/api/events/timeline` | `now` 0, `upcoming` **1**, `past` 10 | same |
| **iCal feed** | **still 0** | `LEFT JOIN performances` — no announced sets, no `VEVENT`s |
| `/api/stats/public`, `sitemap.xml` | populated (283 performances, 277 URLs) | archived editions |

**The iCal zero is the trap.** It reads identically to the between-seasons zero and means something entirely different: *published event, lineup not yet announced*, not *no published event*. Diagnose the two apart by asking which layer the surface reads — an **event**-driven surface or a **performance**-driven one — rather than by the number.

`EventTimeline` still has its dedicated between-seasons empty state and auto-expands Past; that path is now dormant rather than gone, and will be live again after Vol. 18 is archived. Before treating any such zero as a bug, check both halves: is an event actually `published`, **and** does it have performances?

Canonical active roadmap: `docs/ROADMAP.md`. Use it for handoffs between Claude, OpenCode, and humans.

**Track remaining/deferred work as GitHub issues** (`gh issue create`) — not just chat threads or ad-hoc lists — so nothing is lost across sessions and contributors. Reference issues from PRs (`Closes #N`).

---

## Stack

- **Frontend**: React 19, Vite 8, Tailwind 4, React Router 7 (`frontend/`)
- **Backend**: Cloudflare Pages Functions (edge serverless, `functions/`)
- **Database**: Cloudflare D1 (SQLite-compatible), numbered migrations in `migrations/`
- **Auth**: Direct D1 session manager (`functions/utils/auth.js`), CSRF double-submit, TOTP MFA, trusted devices, RBAC
- **Storage**: Cloudflare R2 (band photos)
- **Email**: Postmark/Resend/MailChannels
- **Tests**: Vitest (unit, frontend), Playwright (E2E + a11y + visual regression)
- **CI/CD**: GitHub Actions (12 workflows), CodeQL, Dependabot

---

## Critical Invariants

### After-midnight band sorting — recurring bug class

Bands starting before 6 AM are "after-midnight" sets that belong to the *previous evening*. They must be offset by +1 day so they sort after the evening lineup, not at the top of the schedule.

- Threshold: `AFTER_MIDNIGHT_THRESHOLD_HOUR = 6`. There are **two** canonical homes, one per side of the build boundary — Pages Functions cannot import from `frontend/`, so a single definition is impossible:
  - **Frontend:** `frontend/src/utils/festivalDays.js` (#550). `frontend/src/utils/bandUtils.js` and `frontend/src/admin/utils/timeUtils.js` (`AFTER_MIDNIGHT_THRESHOLD_MINUTES = AFTER_MIDNIGHT_THRESHOLD_HOUR * 60`) both import it rather than re-encoding `6`.
  - **Server:** `functions/utils/eventDay.js`, which also exports `eventLocalFestivalToday()` — the festival-day equivalent of `eventLocalToday()`, stepping back one calendar day when the Toronto-local hour is below the threshold. Use it for any "which festival day is it?" question server-side; a plain calendar-day comparison flips at midnight while the festival day is still running (bug class fixed in #751). `eventDay.js` also exports `AFTER_MIDNIGHT_THRESHOLD_TIME` (`"06:00"`, zero-padded), **derived** from the hour rather than typed as a second literal — it exists because `functions/api/events/timeline.js` needs the `HH:MM` string shape for a lexicographic comparison against `performances.start_time`, while `eventLocalFestivalToday()` needs the numeric hour for arithmetic.
- **Two homes, not more.** `functions/api/events/timeline.js` and `functions/event/[slug].js` both used to re-encode the threshold privately (as `"06:00"` and `6` respectively) instead of importing it (#746, fixed) — both now import from `eventDay.js`. A source-scanning guard (`functions/utils/__tests__/afterMidnightThreshold.test.js`) enforces this **within `functions/` only**: no file there outside `eventDay.js` (and outside `__tests__/**`) may declare the threshold from a literal, and no bare `"06:00"` may appear there outside a comment. The frontend side is deliberately out of its scope — `festivalDays.js` is that side's canonical home and correctly declares `6` itself. **The numeric half is name-based and not airtight:** it matches declarations whose identifier contains `AFTER_MIDNIGHT`, so `const MIDNIGHT_HOUR = 6` would slip past. Widening it to every literal `6` in `functions/` would be pure noise, so the name is the only tractable signal for that shape — the `"06:00"` half is name-independent and has no such gap. Treat the guard as a backstop against the copy-paste that actually happened, not proof no third copy can exist. Do not add a third private copy; import from the appropriate canonical home.
- Logic: `prepareBands()` adds `MS_PER_DAY` to `startMs`/`endMs` for times below this threshold
- **Never remove or lower this threshold.** Any sort, filter, or conflict-detection that touches performance times must apply the same offset or delegate to `prepareBands`.

### Public event visibility is `status`, never `is_published` (#800) — history, guards still live

`events.is_published INTEGER` was deprecated by migration 0005 and, for years, never dropped (0036 even added a fresh index on it). Until #799, **`functions/api/admin/events/[id]/archive.js` wrote `status = 'archived', is_published = 0`** — archiving unpublished under the old column. On 2026-08-10 archiving the last un-archived event dropped 13 public read paths to zero rows simultaneously and took the public site dark.

**The column itself is gone as of migration 0059** (#799 part 2) — dropped from production, from `database/setup-complete.sql`, and from every test schema, along with its two indexes (`idx_events_published`, `idx_events_published_date`; replaced by `idx_events_status_date` on `(status, date)`, since every public query that used to filter+order on the old pair now does the same on `status`). This section stays in CLAUDE.md as **history, not a live warning**: the two source-scanning guards described below remain in the test suite even though there is no column left to accidentally read, because the postmortem they encode — one dead column silently zeroing 13 public read paths at the same instant — is worth more than the guards cost to keep. A future PR that reintroduces `is_published` (a copy-pasted old query, a reverted migration without reverted callers) fails CI on these guards instead of shipping.

`functions/utils/eventVisibility.js` is the single canonical home, mirroring `eventDay.js`'s role for the after-midnight threshold:

- `publicEventStatusSql(alias?)` → `status IN ('published','archived')`. The default for browse/history surfaces — **archived means concluded, not hidden.**
- `archivedEventStatusSql(alias?)` → recap-only surfaces.
- `publishedEventStatusSql(alias?)` → the narrower gate, for where serving a concluded event is *wrong* rather than merely unusual. Live case: `/api/schedule?event=current`, whose `-6 hours` buffer means an event archived on its own final day still passes the date filter.

**Bucket membership is a lifecycle question before a date question.** `/api/events/timeline` splits: `now`/`upcoming` = published-only; `past` = `archived OR (published AND concluded by date)`. Both halves are load-bearing — narrowing the live buckets without `archived OR` in past makes an archived event with a live or future date match no bucket and vanish entirely.

**Two** source-scanning guards enforce this, and they catch different things:

1. **No `is_published` read or write anywhere**, outside `__tests__/**` (the guard tests necessarily name the retired column) and `functions/utils/eventVisibility.js` (its own header narrates this incident by name) — scanned on both sides of the build boundary (`functions/utils/__tests__/eventVisibility.test.js`, `frontend/src/__tests__/isPublishedGuard.test.js`). The `functions/api/admin/**`, `frontend/src/admin/**` and `utils/adminApi.js` exemptions were **removed** by #799 part 1; the `functions/api/test-utils.js` exemption (the shared test schema, kept only while it mirrored production's still-live column) came out with #799 part 2 once migration 0059 dropped the column from the test schema too. Nothing in `functions/` may name it any more, outside those two allowlisted paths.
2. **No non-admin file queries `events` without importing the shared visibility helper.** The scan matches the helper *names* (`…EventStatusSql`, `concludedEventSql`), not SQL semantics — so an inline `status = 'published'` written by hand does **not** satisfy it, deliberately: the point is one canonical home, not merely "some gate exists". The first guard only catches the *old column*; this one catches a route with no gate at all. That gap was real: `functions/s/[slug].js` (the OG card crawlers fetch for a shared schedule link) joined `events` ungated while both siblings for the same slug gated correctly, so an event unpublished *after* a link was shared still produced a crawler-facing card naming it. Exempt by design, named in the guard: `api/metrics.js` (write-path existence check, projects only `id`) and `utils/timeConflicts.js` (admin-only, must see drafts).

Guard 2 is a file-level scan: it catches "never imported the helper" (the class that has occurred), not "imported it and missed one query". Don't mistake it for proof of the latter.

**Archiving is one-way, and every route that can write `status` enforces it — there are exactly four.** There is no unarchive endpoint. `POST .../publish`, the PUT publish-toggle, `POST .../archive` and `PATCH` all reject a status change on an archived event, and **each of those four `UPDATE`s carries `AND status IN ('draft','published')`** so a concurrent archive committing between the read and the write cannot be overwritten. A no-match returns 409, never a silent resurrection — and the null check is mandatory, not defensive: all four dereference `result` immediately, so the predicate without it converts a lost race into a 500.

Two traps, both of which bit during #803's review:

- **The four sites do not look alike.** Three are dedicated status endpoints with literal SQL; the fourth is PATCH's *dynamic* `UPDATE events SET ${updates.join(", ")}`, which writes status only when the body carries it. Grepping for the literal `SET status` finds three of four. Grep `UPDATE events` instead — `edit.js`, `posters.js`, `reveal-mode.js` and `users/[id].js` also match but provably never write `status`.
- **PATCH's predicate must stay conditional.** Editing an archived event's description, poster or venue info is legitimate and deliberately still allowed; only a *status* change is one-way. Applying the predicate unconditionally would silently break archived-event editing.

**Only one of those four routes checks the lineup, and that asymmetry is deliberate.** `POST .../publish` rejects publishing an event with zero performances (`400`, `code: "EMPTY_LINEUP"`) — but the rejection is *overridable* with an explicit `allowEmptyLineup: true`, because "Lineup TBA" is a supported published state (announcing before booking completes, e.g. for SEO runway). PATCH and the PUT toggle carry **no** lineup check at all, and both now say so in a comment. Do not "fix" that by tightening them: it would make them stricter than the guarded route and block the very workflow the override exists to allow.

The gap this leaves is a *UX* one, and #821 closed it on the **client**, not the API: `EventFormModal` strips `status` from the PATCH payload for a draft → published transition and calls `POST .../publish` instead, so the confirmation appears whichever control the admin used. The shared confirm lives in `frontend/src/admin/utils/publishWithLineupConfirm.js` and is used by both that form and the Events-list toggle — previously the toggle asked and the form did not. Two traps: only the *transition* is rerouted (re-saving an already-published event still PATCHes `status`, a no-op write that must stay allowed), and the empty-lineup rejection is detected by its `code`, never by matching `err.message`.

**Creating an event as `published` is refused outright** (`400`, `code: "CREATE_AS_PUBLISHED"`, #804) — a row is born with zero performances, so create-as-published is *always* a silent empty-lineup publish. `draft` and `archived` stay allowed on create; archived is historical back-fill (`HistoricalImportModal`) and carries no lineup requirement. Note the create path is an `INSERT`, so it does **not** appear in the `UPDATE events` grep above — that grep finds four writers, but there are five.

### Server-side "today"/"now" is Toronto-local — never UTC-sliced

Server-side event-day classification (timeline now/upcoming/past, any "is it today?" check) must use `eventLocalToday()` / `eventLocalClock()` from `functions/utils/eventDay.js` — never `new Date().toISOString().slice(0, 10)`, which flips to tomorrow at 8 PM Eastern and marked events "Happening Now" the evening before (bug class fixed in PR #568).

### `events.doors_json` + the "started" start edge (#569)

`events.doors_json` (TEXT, nullable) is a JSON map of festival date → 24h time, e.g. `{"2026-07-10":"16:00","2026-07-11":"10:00"}`. Absent/malformed = no doors info. On an event's **first day only**, the "started" edge (timeline "Happening Now", fan "Live Tonight") is, in precedence order: **doors time → first set start → local midnight**; the earliest available signal wins, so an already-playing set is never "upcoming". Day 2+ of a multi-day event is never re-gated, and sets before 6 AM never define the day-1 edge (after-midnight convention above). Validation is `validateDoorsJson()` in `functions/utils/validation.js` (keys within `[date, end_date]`, values `HH:MM`); event duplication deliberately drops `doors_json` (stale date keys).

### SQLite datetime format — do NOT use ISO 8601 T-separator

D1's `datetime('now')` returns `YYYY-MM-DD HH:MM:SS` (space separator).  
JavaScript's `toISOString()` returns `YYYY-MM-DDTHH:MM:SS.mmmZ` (T separator).

When a stored `expires_at` has a `T`, comparisons like `expires_at > datetime('now')` silently fail — the string comparison returns a wrong result. This caused a production invite-code expiry bypass (SEC-F1).

**Always normalize before storing:**
```js
new Date(Date.now() + ...).toISOString().replace("T", " ").slice(0, 19)
```

Helper: `toSqliteDateTime()` in `functions/utils/authAttempts.js`.

### `lucia_sessions.expires_at` is INTEGER (Unix epoch), not TEXT

Every other `expires_at` column in the schema is `TEXT` (ISO-8601 / space-separated). `lucia_sessions` uses `INTEGER` (Unix seconds). Do not compare it with `datetime('now')`.

- **JS (check if expired):** `row.expires_at * 1000 < Date.now()`
- **SQL (select active sessions):** `WHERE expires_at > unixepoch()`

### PBKDF2, not bcrypt

Password hashing uses PBKDF2-SHA256 via the Web Crypto API (`functions/utils/crypto.js`). Current format is `pbkdf2$iterations$salt$hash` and is self-describing — `verifyPassword` reads the iteration count from the string itself, so hashes created before the default was bumped from 100,000 to 600,000 (`DEFAULT_ITERATIONS`) still verify unchanged. A second, older `salt:hash` format (no `pbkdf2$` prefix, predating the versioned format entirely) carries no iteration count at all; it's verified against the hardcoded `LEGACY_ITERATIONS` (100,000) fallback instead.

bcrypt requires a native binary (`better-sqlite3` style) that cannot run on Cloudflare Workers. Do not introduce bcrypt anywhere in `functions/`.

MFA TOTP follows the same rule: `functions/utils/totp.js` computes HMAC-SHA1 directly via `crypto.subtle` (hand-rolled RFC 4226/6238, pinned by the RFC 6238 Appendix B test vectors). Do **not** reintroduce `otplib` or any pure-JS crypto (`@noble`) for MFA — keep the security primitive on the platform's native Web Crypto.

### D1 transactions: no BEGIN/COMMIT, but `DB.batch()` is atomic

The Cloudflare Workers D1 binding does not support explicit `BEGIN`/`COMMIT` transaction syntax. However, `env.DB.batch([stmt1, stmt2, ...])` executes all statements atomically — if any fails, all are rolled back. Prefer `DB.batch()` for multi-statement mutations.

For mutations that cannot be expressed as a single batch (e.g., the event-duplication pattern in `functions/api/admin/events/[id]/duplicate.js`), use compensating deletes: if step N fails, manually undo steps 1…N-1. **The rollback is NOT in `events/[id].js`** — that route was split into its own sub-path file because Cloudflare Pages needs a dedicated file per route segment, and this pointer named the old location long after the move.

The bulk band import (`functions/api/admin/bands/import.js`) follows this pattern and is **all-or-nothing**: it validates every row first (an invalid row aborts the whole import with per-row errors, writing nothing), then find-or-creates profiles and inserts performances, rolling back everything it created if any write fails. A lineup is never left half-imported.

`functions/api/admin/bands/bulk.js` is the larger sibling (599 lines vs. `import.js`'s 174): it handles bulk `DELETE`/`POST`/`PATCH` across bands, following the same `DB.batch()`/compensating-delete discipline.

### PRAGMA `foreign_keys = ON` is enforced in production

`functions/_middleware.js` runs `PRAGMA foreign_keys = ON` before the request handler fires for every **mutating** request. Read-only methods (`GET`/`HEAD`) skip it — read-only by HTTP semantics, and skipping saves a D1 round-trip on hot read paths. **That is a statement about intent, not a guarantee:** since #705 exactly one GET writes an FK-bearing row — `api/schedule/share/[slug].js` inserts into `share_link_views`. Its FK is therefore *unenforced* on that path, so it does not rely on one: the insert is `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM share_links WHERE slug = ?)` inside the same `DB.batch()`, re-checking the parent atomically rather than trusting the SELECT earlier in the request. An orphan there would be unreclaimable — the expiry cron finds ledger rows by joining to slugs that still exist, so it could never see one. Any future FK-writing GET must carry its own guard the same way; do not assume the pragma protects it. The guard is a strict read-only allowlist, so any other method (including unknown ones) still gets FK enforcement; never widen it to skip writes. Unit test helpers (`functions/api/test-utils.js`) set the PRAGMA unconditionally via `better-sqlite3`, so FK constraints are always active under test.

When recreating a table in a migration (SQLite has no ALTER COLUMN), surround the table-recreation block with `PRAGMA foreign_keys = OFF` / `PRAGMA foreign_keys = ON` as migration 0032 does — D1 will reject the DROP otherwise.

### Artist link presence: `bandFields.js` is the single source of truth (#712)

`frontend/src/admin/utils/bandFields.js` defines every filterable artist field — the eight link fields (`LINK_FIELDS`, in Links-column render order) and the profile fields (`PROFILE_FIELDS`) — pairing each with its label, icon, Tailwind colours, and **its own URL-safety resolver**.

**A link is "present" only if it resolves to a real href** — `resolveHref(value) !== '#'` — never `value !== ''`. `safeSocialProfileHref` rejects any handle containing whitespace or a colon (the necessary condition for `javascript:`, `data:`, and every other scheme), so a value can be non-empty in D1 and still render nothing. Anything asking "does this artist have Instagram?" must go through `hasField()` / `hasAnyLink()` / `countLinks()` — never inspect `social_links` directly.

Both the Links column (`admin/components/SocialLinksIcons.jsx`) and the gap filter (`admin/components/DataGapFilter.jsx` + `RosterTab`) map over this one registry. **Do not reintroduce a second list of link fields.** The bug class it prevents: a filter reporting that an artist "has Instagram" while the row shows nothing, so they get skipped in exactly the data-entry pass meant to catch them. Adding a ninth platform requires the frontend registry entry plus the server-side `BAND_LINK_FIELD_KEYS` and `sanitizeBandSocialLinks` entries; the runtime guard catches a missed server-side update.

`formatOrigin()` lives here too, shared by the Origin column, the origin sort, the search predicate, and the origin gap check.

**Tailwind colours in the registry must stay complete literal strings** (e.g. `'hover:text-pink-400 focus-visible:outline-pink-400'`). Tailwind v4 scans source *text* for whole class names and never evaluates template expressions, so `` `hover:text-${colour}` `` generates no CSS and silently drops every hover and focus style. A runtime assertion cannot catch this — the guard in `bandFields.test.js` is a `readFileSync` scan of the source.

### `ALLOW_ADMIN_SIGNUP` is test-only

This env var bypasses the invite-code requirement for signup. It must never be set in production. It appears only in test helpers and E2E seed scripts.

---

## React 19 Known Issues

### `react-helmet-async` `<Helmet>` does not reliably set `document.title` in React 19

Use `document.title = pageTitle` directly in a `useEffect` within the page component. Do NOT remove the direct assignment in favour of `<Helmet>` until react-helmet-async ships a React 19 compatible release.

Example: `frontend/src/pages/EventRecapPage.jsx` — uses both `<Helmet>` (for other meta) and `document.title = ...` for the title.

`BandProfilePage.jsx` was this example until #797 removed its `<meta name="keywords">` — the tag was its `<Helmet>`'s only child, so the wrapper and the `react-helmet-async` import went with it. That page now assigns `document.title` directly and declares no Helmet at all, which is why it no longer illustrates the pairing.

### SSR owns identity meta and JSON-LD where it emits either; the client `<Helmet>` owns only what SSR does not emit — never canonical/`og:*`/`twitter:*`/description, and never JSON-LD on a route whose SSR handler already emits it

`<Helmet>` only manages tags it created itself, marked internally with `data-rh`. Neither `index.html`'s baked-in defaults nor a Pages Function's server-injected `<meta>`/`<link>` carry that marker, so Helmet can't tell it already owns the slot — it **appends** a second copy on mount instead of replacing the first. `/artists` first showed this as `index.html`'s homepage `og:url="https://settimes.ca/"` sitting ahead of the page's own client-declared canonical: Google reads `og:url` as a canonicalization hint, prefers the first tag, and overrode our canonical — surfacing in Search Console as **"Duplicate, Google chose different canonical than user."**

The fix has two parts:

1. **`serveWithInjectedMeta()`** (`functions/utils/ssrMeta.js`) strips `index.html`'s baked-in defaults via `DEFAULT_META_RE` *before* injecting page-specific tags, so a crawler that never executes JS sees exactly one of each. **Every `og:*`/`twitter:*`/`description` property `index.html` declares must be listed in `DEFAULT_META_RE`** — the moment a Pages Function starts emitting a property `index.html` already has (`og:site_name` was the case that caught this, #784), an unstripped default turns into a second, live copy instead of a silent gap.
2. **The client `<Helmet>` on every SSR-injected route must not declare `canonical`, `og:*`, `twitter:*`, or `description`** — SSR is the single owner of identity meta, full stop, not merely "must agree with the client." `<Helmet>` may still set `<title>` (backed by the direct `document.title = ...` assignment above — same React 19 unreliability), but **when it does, the string must replicate the SSR `<title>` formula verbatim, and the assignment must be gated on the data having loaded** (#785): before the fix, the client's loading-state title replaced the server-sent title mid-render, so crawlers that execute JS (Googlebot's rendering queue) could register a title different from the raw-HTML one. `BandProfilePage.jsx` and `App.jsx`/`EventRecapPage.jsx` (which gate on `loading`) are the enforced pattern; `functions/api/venues/[id].js` exposes `city` precisely so the venue client title can reproduce `functions/venue/[id].js`'s formula. `ssrIdentityMeta.test.jsx` seeds the SSR `<title>` and asserts it survives mount (including with the fetch still in flight) — do not drop that deferred-fetch case when touching title effects. **The same rule applies to JSON-LD on any route whose SSR handler passes a `jsonLd` block** — `/band/*` and `/venue/*` duplicated their `MusicGroup`/`MusicVenue` schema client-side the same way until #790; the client copy is deleted, not merely trimmed, once SSR emits an equivalent (`functions/band/[id].js`'s JSON-LD `description` was truncated to the 200-char SERP length shared with `<meta name="description">` — fixed to a separate, untruncated value before the client copy was removed, since 44 of 62 artist bios in production exceed 200 chars). A route whose SSR handler passes no `jsonLd` (the `STATIC_PAGES` registry pages, the recap page) keeps its JSON-LD, if any, client-owned.

   **The rule is "SSR owns what SSR emits," not "the client may only own `<title>`."** A tag no SSR handler emits stays client-owned and must not be deleted in an ownership sweep — deleting it drops the tag rather than de-duplicating it. `BandProfilePage.jsx`'s `<meta name="keywords">` was the worked example: it had no SSR equivalent, so it correctly survived #790's ownership sweep — and was then removed by **#797** on the unrelated grounds that search engines have ignored `keywords` since 2009. Deleting it *for the ownership reason* would have been the error; deleting it because the tag is dead everywhere is not. That page's `<Helmet>` (and its `react-helmet-async` import) went with it, since the tag was its only child. This is the same trap as `og:site_name` in #784.

The rejected alternative was marking SSR-injected tags `data-rh="true"` so Helmet would adopt and replace them instead of appending. Rejected because it makes canonical correctness depend on Helmet *reliably adopting and replacing* tags it didn't create — the exact behavior already documented above as unreliable for `document.title` in React 19. Inverting ownership removes the duplicate class entirely without depending on Helmet's replace behavior working.

**Tradeoff, accepted:** since SSR only injects meta into the initial HTML response, identity meta now freezes at whatever that response's values were across client-side (in-app) navigation between SSR-injected routes — refreshed only by a full-page load. This doesn't affect crawlers or link-unfurl bots, which always fetch the specific URL fresh; it only affects a live DOM read after in-app navigation, which nothing in this codebase does.

- **Every indexable route needs a Pages Function that injects its own meta.** `/event/*`, `/band/*`, `/venue/*` have always had one; the eight static pages go through the `STATIC_PAGES` registry in `functions/utils/staticPageMeta.js`, one 2-line route file each; `/events/*/recap` (the archive recap page, distinct from singular `/event/*`) is D1-backed like `/event/*`/`/band/*`/`/venue/*` rather than registry-driven — `functions/events/[slug]/recap.js` — because its title/description embed per-event stats (`total_sets`, `venue_count`) a static registry entry can't express.

  **"Has a Function" is not the same as "the Function server-renders the URL people actually link to."** `/band/*` had a handler from the start, but it bailed to the un-injected shell for any non-numeric id — and *every* public link to an artist is slug-built (`buildBandProfileHref`, used by ArtistsPage, StatsPage, EventRecapPage, EventTimeline, BandCard), while only the sitemap used the id form. So Googlebot crawled `/band/<slug>`, got 200 with the **homepage** title and no canonical, and 14 of them entered the index as duplicates of their own `/band/<id>` page — one ranking at position 49, two drawing clicks. `BandProfilePage` corrected the URL client-side, so the fix existed only after JS ran. Fixed in #983: `functions/band/[id].js` now resolves the slug through `normalizeBandName` (which agrees with `slugifyBandName` by construction — both reduce to `/[a-z0-9]/`) and **301**s to `/band/<id>`, query string preserved.

  Three things about that fix are load-bearing and easy to undo:
  - **The `Location` is relative**, deliberately breaking the `CANONICAL_HOST` rule two bullets down. That rule stops a preview deploy self-*canonicalising*; an absolute `Location` would *bounce* preview and `www` traffic to production mid-request. Canonicals pin the host; redirects preserve it.
  - **The public-data gate runs before the lookup.** A redirect that fires only for real slugs is an existence oracle even when it leaks no field values.
  - **An unresolvable slug still renders the shell**, not a 404 — it may be a renamed artist whose old URL is still linked.

  `functions/venue/[id].js` carries the identical numeric guard and is safe only because every venue link is id-built. Adding a `/venue/<slug>` link builder without also adding the redirect reintroduces the whole class — there is a comment in that file saying so.
- **Before deleting a tag from a page's `<Helmet>`, confirm SSR emits an equivalent** — the ownership sweep isn't just "delete the client copy." `og:site_name` existed only in two pages' old client Helmet (`SubscribePage.jsx`, `App.jsx`'s `/event/:slug`) and had no SSR equivalent anywhere; deleting it outright would have silently dropped the tag rather than de-duplicating it. Two other disagreements surfaced the same way on `/event/:slug`: the old client `og:type="event"` (invalid without Facebook's required `event:start_time`/`event:end_time` properties, which this route never emitted) and `twitter:card="summary"` (no image) lost to SSR's already-established, spec-valid `og:type="website"` / `twitter:card="summary_large_image"` — the more complete value wins once there's only one.
- **`/` is deliberately excluded.** `index.html`'s baked-in defaults *are* the homepage's correct meta, and `EventsPage` keeps full client-side ownership of its identity meta there — the only route in the app that does.
- **The singular/plural prefix split is deliberate — do not "unify" it.** `/event/:slug` is the live event page; `/events/:slug/recap` is the archive recap, a *different resource*. Both are SSR-injected, listed in `_routes.json`, and emitted into `sitemap.xml`, so both are indexed. Anything that constructs an event URL — digest emails, share links, structured data — must pick the right prefix; building the wrong one is how #562 shipped broken links in digest emails, and it reads as an oversight precisely because nothing said otherwise. It is not one: an indexed URL is an external contract in the same way the public API paths and the `band_profiles` table name are, and migrating it would cost permanent 301s, a sitemap change, an SSR handler move and `_routes.json` surgery to buy guessability on the least-trafficked public surface we have. Declined deliberately in #910.

- **Build every URL from `CANONICAL_HOST`, never `request.url`** — preview deploys must not self-canonicalise.
- **`_routes.json` `exclude` beats `include`.** A path listed in both never reaches its Function, and the page silently regresses to the shared shell. The guard test in `functions/__tests__/staticPageMeta.test.js` scans `_routes.json` and fails if an included path lacks either a route file or a registry entry. **The file is `frontend/public/_routes.json`, and it is the only one** — `wrangler.toml` sets `pages_build_output_dir = "frontend/dist"`, so Cloudflare reads the copy Vite emits from `frontend/public/`. A second, stale `/_routes.json` sat at the repo root until #786; it listed only `/api/*` and `/s/*`, so anyone reading it would have concluded the SSR routes were never wired up. Do not recreate one — a root copy is dead on arrival and actively misleading.

Mocked unit tests prove the handler *builds* correct HTML; they cannot prove Cloudflare *dispatches* to it, and a pure string assertion on the SSR response can't prove Helmet doesn't duplicate it after mount. Verify routing changes against a real `npx wrangler pages dev --port 8788` and diff the tag counts per path; `frontend/src/pages/__tests__/ssrIdentityMeta.test.jsx` covers the mount side — it seeds `document.head` with the tags SSR would have injected, mounts the real page component the same way `main.jsx` does (`createRoot`, not `hydrateRoot` — this app is client-rendered, not server-rendered; see that file's header comment), and asserts exactly one `canonical`/`og:url` survives (plus, on `/band/*` and `/venue/*`, exactly one JSON-LD `script` per `@type`).

---

## Theming

Four user-selectable colour themes, set as `data-theme` on `<html>` by `frontend/src/components/ThemeProvider.jsx` and persisted in localStorage: `midnight-ember` (warm dark, default), `arctic-night` (cool dark), `daybreak` (warm light), `silver-lining` (cool light). All theme colours are CSS custom properties defined per `[data-theme]` block in `frontend/src/index.css`, exposed as Tailwind v4 utilities via `@theme`.

**On public / theme-following surfaces, use semantic tokens — never hardcoded white.** This is the recurring bug class (white text/surfaces invisible on the light themes):

- **Text:** `text-text-primary` / `-secondary` / `-tertiary` / `-disabled`. When converting opacity'd whites, map by weight: `text-white/90–70` → `secondary`, `/60–40` → `tertiary`, `/30–20` → `disabled`.
- **Surfaces / borders:** `bg-surface` (faint card/input fill), `bg-surface-hover` (hover state), `border-border` / `ring-border` (subtle edges/dividers). Never `bg-white/N` or `border-white/N`.
- **Status colours:** `success` / `warning` / `error` / `info` (e.g. `bg-warning-500/20 border-warning-500/50`) with `text-text-primary` for the label so it reads on both light and dark.

**Light-theme token values are WCAG-AA tuned** (accent ramp, `text-tertiary`, etc. clear 4.5:1 on the darker `bg-purple` surface). If you change a light-theme colour, verify contrast — don't just pick a lighter shade.

**Keep `text-white` only where it is theme-independent:** on a fixed colour (coloured/gradient buttons, brand/social buttons) or over a dark photo scrim.

**Admin is dark-pinned:** `frontend/src/admin/AdminApp.jsx` wraps the admin surface in `<div data-theme="midnight-ember">`, so hardcoded `text-white` inside `frontend/src/admin/` is correct and intentional — do not migrate it.

---

## Schedule Storage (localStorage)

Band selections are stored under the `selectedBandsByEvent` key as `{ [eventSlug]: [bandId, ...], __dates__: { [eventSlug]: "YYYY-MM-DD" } }`.

The `__dates__` namespace is used for stale detection. **Always use YYYY-MM-DD lexicographic string comparison** — do NOT use `new Date('YYYY-MM-DD')` which parses as UTC midnight and causes events to appear stale on their own day in UTC-negative timezones.

**`saveSelectedBands`'s date argument must be the event's `end_date || date`, never the start date alone.** Stale detection compares the stored date against today, so passing a multi-day event's START date marks the fan's saved schedule stale on day 2 — silently wiping their selections mid-festival (#542 PR-1). Single-day events have a NULL `end_date`, so the `||` fallback keeps them identical.

All interactions go through `frontend/src/utils/scheduleStorage.js`. Do not write to `selectedBandsByEvent` directly.

---

## Public cache TTLs — two tiers, one home

`functions/utils/cacheHeaders.js` owns both public-GET cache values, split by one
question: **can this change while a show is running?** `CACHE_SHOW_CRITICAL`
(60s) is for anything rendering live show state — set times, cancellations,
venue assignments; `CACHE_BROWSE` (300s) is for aggregate-only browse surfaces.
Deliberately no `stale-while-revalidate`: inside the SWR window a cache serves
the *stale* body, so a fan opening the page once still reads a cancelled set as
playing — see the module header for the full rationale.

**Judge the projection, not the route name.** `api/bands/stats/[name].js` is
named for its aggregates but returns per-performance rows, so it is
show-critical. Its sibling `api/bands/[name].js` was the same shape and sat at a
hardcoded 300s until the tiers were wired up — a cancelled set read as playing
for up to five minutes.

That drift was possible because `CACHE_BROWSE` was **exported and imported by
nothing** while five endpoints hardcoded its exact string. The constant existed;
the callers copy-pasted the value. `functions/utils/__tests__/cacheHeaders.test.js`
now scans source for both halves: no API route may hardcode a `max-age` a tier
already names, and any route projecting `p.start_time`/`p.is_cancelled` must
import `CACHE_SHOW_CRITICAL`. Three routes are exempt **by name, with reasons**
in the test — `schedule.js` (env-tunable, already defaults to 60s), `ical.js`
(a subscribed feed; clients poll on their own schedule and cancellations travel
as RFC 5545 `STATUS:CANCELLED`), and `events/[id]/recap.js` (gated by
`concludedEventSql()`, so it can only serve an event that already ended).

## Metrics & Analytics

Metrics write to D1 daily-aggregate tables (`page_views_daily`, `artist_daily_stats`) via `POST /api/metrics`, plus an optional Cloudflare Analytics Engine sink (`env.ANALYTICS`, configured in `wrangler.toml`). Ingestion is best-effort and fire-and-forget; failures must not surface to users.

**Share metrics come from `share_links`, not telemetry.** A share *create* is a `share_links` row. The admin event metrics endpoint reads these directly. Do **not** wire the allowlisted-but-unused `share_event` / `filter_use` events into `/api/metrics` for share counts — they would be redundant with `share_links`.

**`view_count` is unique visitors per link, all-time — not fetches (#705).** It is a *derived* value: `GET /api/schedule/share/[slug]` writes one `share_link_views(slug, visitor_hash)` row per visitor and recomputes `view_count` as `COUNT(*)` over that ledger, both in a single `DB.batch()`. Do not "optimise" it back to `view_count = view_count + 1`: the ledger row claims the slot permanently, so if a separate increment were lost the visitor could never be counted again, whereas a recomputed count self-heals on the next visit.

Two traps around this:

- **`import_count` is still per-fetch and undeduped.** It sits beside `view_count` in the same metrics payload and dashboard, so the two are different units. One person importing twice can produce imports > views.
- **The expiry cron must delete ledger rows explicitly** (`functions/scheduled/expire-share-links.js`). `share_link_views` declares `ON DELETE CASCADE`, but cron handlers reach D1 via `_scheduled.js` and never pass through `_middleware.js`, where `PRAGMA foreign_keys = ON` is set — D1 defaults it OFF, so the cascade does not fire there. It *does* fire on the event-deletion path, which is an HTTP request.

`view_count_legacy` preserves each link's pre-#705 count. Nothing reads it. It keeps the cutover reversible and the old figure queryable.

---

## RBAC Roles

Three roles in ascending order: `viewer` → `editor` → `admin`.

- `viewer`: read-only access to all admin data
- `editor`: can create/edit bands, events, lineup; cannot manage users
- `admin`: full access including user management and platform settings

Enforced via `checkPermission(context, "viewer"|"editor"|"admin")` in `functions/api/admin/_middleware.js`. Every mutating endpoint must call this before touching the database.

---

## API keys (#744) — a credential's life is tied to its creator's

`api_keys` rows are bearer credentials minted by an admin (`POST /api/admin/api-keys`, plaintext returned **exactly once**; there is no reveal endpoint and never will be). `functions/utils/apiKeys.js` owns generation and verification; the digest is deliberately **SHA-256, fast and unsalted** — read that file's header before "fixing" it to PBKDF2. The secret is 256 bits of `getRandomValues`, so there is no dictionary to slow down, and `WHERE key_hash = ?` cannot work against a per-row salt.

**Anything that changes a user's standing must revoke their keys, and there is more than one such endpoint.** `api_keys.role` is frozen at creation and never reconciled against its creator's current role, so an unrevoked key keeps whatever privilege it was minted with:

| Path | Must revoke |
|---|---|
| `PATCH /api/admin/users/:id` with a falsy `isActive` | yes |
| `PATCH /api/admin/users/:id` with a **changed `role`** | yes — otherwise a demoted admin keeps an admin-scoped key and can re-promote themselves |
| `POST /api/admin/users/:id/toggle-status` (deactivating) | yes |
| Reactivation, or a PATCH re-sending the role the user already has | **no** — revocation is one-way |

Three traps here, each of which was live:

- **`toggle-status.js` is a second, separate deactivation endpoint.** It is not a thin wrapper over the PATCH path — it has its own handler, and it deactivated accounts and deleted their sessions for months while leaving keys untouched. Grep `is_active =` rather than assuming one path — four hits, three of which write `users`: the two above plus `api/auth/activate.js`, which only ever writes `1`. The fourth, `utils/bandProfileFields.js`, writes `band_profiles.is_active` and is unrelated.
- **`isActive` is read by truthiness at every other site in `users/[id].js`** — the last-admin guard, the `is_active` write, and the `deactivated_at` stamp all use `!isActive`. A revocation gated on `isActive === false` therefore misses `{"isActive": 0}`, which deactivates the user everywhere else. Match the surrounding convention.
- **`verifyApiKey` INNER JOINs `users` and requires `is_active = 1`.** That is a backstop for a fourth path nobody has written yet, not the primary control — the explicit revocations above are. Do not delete it as redundant; it exists precisely because "every path remembers" was already false once.

**Deleting a user who owns keys is refused with 409 `USER_OWNS_API_KEYS`, and revoking does not unblock it.** `created_by` is `ON DELETE RESTRICT`, which fires on the **existence** of a referencing row, not its state — so a revoked key blocks deletion exactly as an active one does. There is deliberately no endpoint that deletes an `api_keys` row: that would destroy the attribution RESTRICT exists to protect. Deactivation is the supported answer, and the 409's message says so. Detect it by `code`, never by matching the message.

### The request path — a key borrows a person's identity, and that is the whole risk

`functions/api/admin/_middleware.js`'s `onRequest` gained an API-key branch. Its order is not stylistic:

1. A request is key-authenticated **iff** `Authorization: Bearer <v>` and `v` starts with `API_KEY_PREFIX` (`st_`). That prefix test is the discriminator because `resolveSession` **already** reads `Authorization: Bearer …` as a *Lucia session id* under `ALLOW_HEADER_AUTH` (non-production only). Both meanings coexist; the prefix separates them. Import `API_KEY_PREFIX` from `utils/apiKeys.js` — never retype `"st_"`.
2. **Key + any session cookie → 400 `AMBIGUOUS_AUTH`, before either credential is validated.**
3. The key branch `return next()`s early, which **structurally skips `validateCSRFMiddleware`**.

**What makes step 3 safe is that `Authorization` is not an ambient header** — a browser never attaches it cross-origin without a successful preflight, and `functions/_middleware.js` emits `Access-Control-Allow-Headers: …Authorization` only for an origin already on the allowlist, which an attacker does not control. That is a property of the platform, not of code anyone can edit here. **Step 2 is defence-in-depth against privilege confusion, not the load-bearing control** — an earlier draft of this section said it was, which was wrong twice over: it made the skip look one edit from a CSRF bypass, and it demanded an exactness the check did not have. `parseCookies` split on `=` without trimming the resulting *name*, so `__Host-session_token =abc` keyed the map on `"__Host-session_token "` and `getCookie` returned undefined while `lucia.readSessionCookie` (which compares `k.trim()`) read it fine. Fixed in `cookies.js` — which also stopped it truncating any value containing `=`.

`context.data.user.role` is **the key's role, never its creator's**. A `viewer` key minted by an admin authorises as `viewer`; getting this backwards makes every key an admin key. `context.data.apiKey` carries `{ id, keyPrefix, role }`. Endpoints need no changes — `checkPermission` already short-circuits on `context.data.user`.

**But `context.data.user.userId` is the creator's, and that is the sharp edge.** It has to be — audit attribution and every ownership check need a real user id. The consequence is that any endpoint reading `data.user.userId` as *"the human holding this browser session"* will act on the **creator's own account** when a key calls it. A security review of this branch found five such endpoints live:

| Route | Gate it had | What a `viewer` key got |
|---|---|---|
| `mfa/setup.js` + `mfa/enable.js` | `viewer` | planted an attacker-controlled TOTP secret **and backup codes on its admin creator** |
| `sessions.js` (GET) | **none** | the admin's live sessions, with IPs and user agents |
| `sessions/revoke-all.js` (POST) | **none** | invalidates every session and **mints a new one**; only failed because `data.lucia` is undefined on the key path |
| `trusted-devices.js` | **none** | device inventory with IPs; revokes them |

`KEY_FORBIDDEN_PREFIXES` in `_middleware.js` now 403s these families (`KEY_NOT_PERMITTED`), **checked before the key is verified** — the refusal is a property of the credential type and the path, so a forged key and a valid one are refused identically at zero D1 cost. **The role hierarchy is the wrong axis here: no key role belongs on these routes, including one minted `admin`.** `/api/admin/me` is deliberately *not* listed — a decision, not an omission.

`revoke-all.js` also got its own `checkPermission(context, "viewer")`. **`viewer`, not `admin`:** revoking your own sessions is legitimate self-service at every role, and raising the tier would break a viewer logging out everywhere. The point is that an endpoint which mints sessions must state its own requirement rather than inherit safety from middleware shape.

`functions/api/admin/__tests__/apiKeySelfService.test.js` keeps it closed: any admin route exporting an `onRequest*` handler with **no `checkPermission` call** must be covered by the denylist or recorded in `REVIEWED_UNGATED_ROUTES` with a reason. **Its scope is honest and partial** — it catches the *ungated* shape, not the MFA shape (viewer-gated, then acting on self), because nothing textual separates that from a viewer-gated route acting on `params.id`. The MFA family is covered by name instead. A sixth self-service family outside these prefixes still needs a human to notice.

**`ALLOW_HEADER_AUTH`'s production guard must use `isDevRequest`, not `!== "production"`.** The raw comparison passes for `"Production"`, `" production"` and `"PRODUCTION"` — and it is the switch deciding whether `Authorization: Bearer <session-id>` is a credential at all, which is now the *other* meaning of the header the `st_` prefix discriminates against. There were **two** copies (`_middleware.js` and `auth/logout.js`); both now use `isDevRequest`, which allowlists known dev values and fails closed (#425). Session ids are `crypto.randomUUID()` and can never begin with `st_`, so no single value satisfies both discriminators.

**An API key must never become CSRF HMAC input.** `csrf.js`'s `getSessionIdentifier` falls back to the `Authorization` bearer value for the `ALLOW_HEADER_AUTH` dev path; it now ignores anything starting with `API_KEY_PREFIX`. Not a leak — the identifier is only ever hashed — but a live 256-bit secret has no business flowing into a second subsystem.

Failure logging records `bearerValue.slice(0, DISPLAY_PREFIX_LENGTH)` — the non-secret display prefix — so brute force is visible without the presented secret reaching a log sink.

### Time validation is shape AND range — `isValidTime()` is the only home (#1089)

`isValidTime()` in `functions/utils/validation/datetime.js` checks the `HH:MM`
shape and *then* bounds hours to 0-23 and minutes to 0-59. Four write paths
called it (`bands/bulk.js`, `bulk-preview.js`, `import.js`, `events/wizard.js`);
three others re-implemented only the shape half inline as `/^\d{2}:\d{2}$/` and
skipped the bounds -- `api/admin/bands.js` (POST), `api/admin/bands/[id].js`
(PUT) and `utils/bandProfileResource.js` (profile PUT).

So `"25:99"`, `"24:00"` and `"12:60"` passed validation and were **written to
the database** as set times that do not exist. `frontend/src/utils/timeFormat.js`
then rendered `"25:99"` as **`"1:99 PM"`** (25 % 12 = 1, minutes printed
verbatim) -- worse than the fallback because a dash says "we do not know" while
`1:99 PM` states a time that is not real.

Nothing in production had such a value; this was a latent gap, found while
reviewing #1088 and fixed in #1089.

The frontend keeps its **own** bounds by necessity -- Pages Functions cannot be
imported from `frontend/`, the same two-homes constraint as the after-midnight
threshold. Keep the two in step.

`functions/utils/__tests__/timeRangeValidation.test.js` scans `functions/` for
an inline `HH:MM` shape regex outside the canonical validator, because nothing
about writing one looks wrong at the call site. It also asserts the scan's own
pattern still matches the shape it hunts -- a source scan whose regex has
drifted passes while checking nothing.

### Never use numbered `?N` SQL placeholders anywhere in `functions/`

D1 accepts them; **better-sqlite3, which backs the entire unit-test harness, does not** — it treats `?1`/`?2` as *named* parameters and refuses positional binding outright (`RangeError: Too many parameter values were provided`).

The failure is silent where it matters. `checkRateLimitByKey` catches its own errors and **fails closed**, so while `rateLimit.js` used numbered placeholders its success path had *never once executed under test* — every test reaching it got a 429 from the catch. The module sits on the auth, subscriptions, band-follow and `/api/metrics` paths. It was found only because a new caller's tests all came back 429 for no visible reason.

Repeat the value positionally instead. `functions/utils/__tests__/rateLimitPlaceholders.test.js` scans `functions/` for `?N` and separately asserts the limiter actually counts (`remaining` decrements) rather than returning the fail-closed shape — that second assertion is the one that catches a regression the scan cannot see.

`audit_log.api_key_id` (migration 0061) records which credential acted; NULL means cookie-authenticated. Both builders in `auditLogStatement.js` take it as a trailing optional argument, so existing call sites are unchanged and write NULL. The middleware also writes one `api_key.request` row per key-authenticated **mutating** request — that, correlated with the per-action rows sharing its `user_id`, is how "which credential did this" gets answered. Threading `api_key_id` through all ~15 per-action call sites was considered and deliberately not done.

**`api_key.request` is the one audit row not written in a batch, and it has its own retention tier.** It records a *request*, not a change, and is written before `next()` runs — so there is nothing to batch it with, and it captures requests that then 403 or 404. Do not read it as precedent for writing audit rows standalone. Because it is one row per mutating key request against a 60/min ceiling (~31.5M rows/year from a single saturated key), `retention.js` prunes `action = 'api_key.request'` at **90 days** while the rest of `audit_log` stays at 1 year; the two predicates are deliberately disjoint (`=` vs `!=`) so they cannot double-count.

Audit rows for the API-key routes otherwise go in the **same `DB.batch`** as the change. **That is a statement about this feature, not a repo-wide rule** — measured 2026-08-31, only 5 of the 26 admin handlers calling `auditLog` batch it with their write (`bands/[id].js`, `bands/bulk.js`, `events/[id].js`, `events/wizard.js`, `venues/[id].js`); the other 21 issue the change and the audit row as separate statements, so a failed audit write leaves an unattributed change. Whether that should be tightened repo-wide is an open question, not a settled invariant — read this sentence as scoped before citing it. It was previously unqualified and was read as universal while briefing work on `events/[id]/edit.js`, which does not batch. Creation is the awkward case — the key's id does not exist until the INSERT runs — so `auditLogStatementForInsertedRow()` (`functions/utils/auditLogStatement.js`) resolves `resource_id` with an `INSERT … SELECT … FROM <table> WHERE <col> = ?`. It takes a table and column **identifier**, not a SQL string, and validates both with an explicit `typeof value === "string"` check: `RegExp.prototype.test` coerces its argument, so a bare `/^[A-Za-z_]\w*$/.test(undefined)` tests the string `"undefined"` and **passes**. Note also that `INSERT … SELECT` over zero rows inserts nothing and does not error — only ever pass a value the preceding INSERT just wrote.

---

## Pulling a band from a live lineup

**Use the cancel toggle (`is_cancelled = 1`). Do not un-announce, and do not delete the row.**

`is_announced = 0` is **not** a way to hide a set. Every public read path **that returns per-performance rows** guards with `AND (e.reveal_mode = 0 OR p.is_announced = 1)` — **8 files**, and three of them bind `reveal_mode` as a parameter (`AND (? = 0 OR p.is_announced = 1)`): `api/events/[id]/details.js`, `api/schedule.js`, and `event/[slug].js`, which uses both forms. Grep for `is_announced = 1` rather than the literal `e.reveal_mode` form or you will undercount:

`api/bands/[name].js`, `api/bands/stats/[name].js`, `api/events/[id]/details.js`, `api/events/timeline.js`, `api/feeds/ical.js`, `api/schedule.js`, `api/venues/[id].js`, `event/[slug].js`

On a `reveal_mode = 0` event the left side short-circuits **true**, so `is_announced` is never consulted for visibility. The set stays on the schedule, the artist page, the venue page and the iCal feed. Nothing errors; the failure is invisible until fans arrive at a dark venue.

`is_announced` is not meaningless on such an event, though — the **`0 → 1` transition still drives the follower announcement email** (see "Band Announcements" below). Un-announcing and re-announcing a set on a `reveal_mode = 0` event changes nothing publicly while still being capable of sending mail.

`reveal_mode = 0` is the normal state for a published lineup — Buddies Fest 2 (event 36) is `reveal_mode = 0`. So this trap applies to exactly the events you are most likely to be editing during a show.

Deleting the performance row does hide it, but it is lossy: a fan who already saw the lineup gets no signal the set was cancelled, and since #733 the set is **dropped entirely** from already-shared routes — `schedule/share/[slug].js` resolves live performances and filters out ids that no longer exist, so a fan reopening their shared link finds the stop silently gone rather than marked off. (Before #733 it left an orphaned name with no time or venue, which read as a rendering bug; dropping it is better, but neither tells the fan the set was cancelled.)

Since #732 the correct action is the reversible cancel toggle in LineupTab (`PATCH /api/admin/bands/:id` with `is_cancelled: true`, `editor` role or above). It keeps the set visible and struck through with a "Cancelled" label on every fan surface, suppresses it from "up next" routing and live/starting-soon time math, makes it unselectable, emits `STATUS:CANCELLED` to calendar subscribers, and **blocks the announcement email** — a cancelled performance can neither queue nor send a follower notification.

**Un-cancelling does not resend anything.** The announce path fires only on an `is_announced` `0 → 1` transition (`hasAnnounced && newValue === 1 && isCancelled === 0 && performance.is_announced === 0 && !performance.band_follow_notified`). Restoring a set leaves `is_announced` untouched, so a performance that was already announced before being cancelled produces no new transition, no `band_announce_queue` rows, and no follower email. Un-cancel restores visibility and selectability only.

Operational detail: cancelling is scoped to *one performance*. A band playing two sets (ALL and Kepi Ghoulie each play twice at BF2) needs each set cancelled separately.

**The iCal feed omits a set with no `start_time` rather than inventing one (#1079).** It
used to substitute `"20:00"`, which on 2026-09-02 put all 15 of Vol 18's announced
sets in subscribers' calendars stacked at 8:00 PM -- the entire content of the feed,
fabricated -- while `/event/lwbc18` correctly said "Time To Be Announced". Two public
surfaces stating different things about the same rows.

Omitting is both the honest shape and the consistent one: the feed is
*performance*-driven, so it already reports an event with no lineup as no `VEVENT`s,
and an unscheduled set is that same case one row down. An absent entry is
recoverable; a wrong entry in a calendar someone trusts is not. A missing `end_time`
is likewise derived (`start + 1h`), never a constant -- a literal `"21:00"` against a
23:00 start is *before* it, which the midnight-straddle roll then reads as spanning
into the next day, turning an absent end time into a 22-hour event.

Both are in the mutation gate. A fallback is invisible to every happy-path test by
construction, which is how the constant survived in a file that already had four
describe blocks.

The human-facing version of this, plus what to do when a set time changes or something looks wrong mid-event, is `docs/SHOW_DAY_RUNBOOK.md`. Keep the two in step — if a procedure changes, change both in the same commit.

## Band Announcements

Band follows are **double opt-in**: `POST /api/bands/:name/follow` creates the row `verified = 0` with a `verification_token` and sends only a confirmation email. Clicking the link hits `GET /api/bands/:name/confirm-follow?token=…`, which sets `verified = 1` and clears the token (idempotent). Announcement emails target `verified = 1` followers **only** (the `WHERE … verified = 1` filter in `admin/bands/[id].js` and `resend-announcement.js`), so an address the submitter doesn't control can never be enrolled in the announcement stream — it receives at most one confirmation email. **Do not revert follow to auto-verify (`verified = 1` on insert)** — it reopens the email-bombing vector.

**The gate is now guarded by `functions/api/admin/bands/__tests__/announce-double-opt-in.test.js`, and it was previously unguarded.** Until that file existed, deleting `AND verified = 1` from *either* recipient query left all 1,169 backend tests green: ten announce-related test files seed followers, and every one of them wrote `verified = 1`, so no fixture could ever distinguish a gated query from an ungated one. The suite looked thorough and proved nothing about the property it most needed to prove. The new tests seed an **unverified** follower and assert they are never queued or emailed, one case per call site — verified by mutation, not by passing. **A third sender means a third case here**; a fixture-only suite is how this went unnoticed for so long.

When a performance is announced (`is_announced` 0→1), verified followers of that band are emailed once. Delivery is tracked **per-follower** in `band_follow_notifications (performance_id, band_follow_id)`: the announce records each *successful* send. Failed sends leave no row, so `POST /api/admin/bands/:id/resend-announcement` recovers them by emailing only followers without a notification row (never double-sending). Shared send+record logic lives in `functions/utils/bandFollowNotify.js`. **Do not reintroduce a fire-once latch without per-follower tracking** — it silently drops fans whose first send failed (the bug this replaced).

Bot protection on the public email-input endpoints (follow, subscribe) goes through `verifyTurnstile()` in `functions/utils/turnstile.js`, which **fails closed in production**: if `TURNSTILE_SECRET_KEY` is unset it allows only local-dev requests and rejects everything else (mirrors `CSRF_SECRET`). The secret **must** be configured in the production Pages project.

---

## Testing

### Backend unit tests
```bash
npm test         # from repo root
```
Runs fine locally, including on Apple Silicon (`better-sqlite3` loads natively on arm64) — the full suite completes in a few seconds. Prefer running it locally over waiting on CI.

### Frontend unit tests
```bash
cd frontend && npm test
```

### E2E tests
```bash
npx playwright test
```
Requires a running wrangler dev server or uses it automatically via `playwright.config.js`. Run `npm run build --prefix frontend` first.

### Lighthouse CI performance assertion (#728, #854, #851)

**The harness measures a served app, not a static build (#869).** Until then,
`lighthouserc.json` ran `npx serve dist` — static assets only, no Pages Functions,
no D1 — so every homepage API call failed in CI. `EventTimeline` rendered its tall
`EventsPageSkeleton`, the fetch failed fast, the skeleton collapsed into a short
error state, and `<Footer />` (its sibling in `EventsPage`'s `<main>`) moved.
Lighthouse scored that as a **total CLS of 0.2011**, of which **0.2007** was
the footer element's own shift score — an artefact of that static-build harness,
not of the wrangler-served app. Production measured 0.0004 on 2026-08-18 (3 runs,
same Lighthouse version and flags), so the shift did not reproduce there; that is
one dated measurement of one page, not a claim about every user's experience.

It now points at `http://localhost:8788`, served by `.github/actions/e2e-env`
(wrangler + a seeded D1 — the same environment E2E uses). Measured 2026-08-18,
Lighthouse 12.8.2, mobile, `--throttling-method=simulate`, 3 runs each:

| harness | perf (raw runs) | CLS (raw runs) |
|---|---|---|
| static `dist` (old) | 0.86 / 0.86 / 0.96 | 0.2011 / 0.2011 / 0.0000 |
| `https://settimes.ca` | 0.90 / 0.90 | 0.0004 / 0.0004 |
| wrangler + D1 (current) | CI **median** 0.94 | CI **median** 0.0008 |

Three runs each. The `settimes.ca` row lists only two: its first run was a
contended outlier (LCP 8.3 s, TBT 21 s) and is excluded rather than averaged in.
The current row reports CI's **uploaded median LHR** — which is what gets
published for humans to read, and is *not* what the assertions compare against:
performance aggregates `optimistic` (best run) and CLS `pessimistic` (worst),
so neither gated value is the median. Read the median for a sense of the page;
read the assert step's output for what actually passed or failed.

The old column is the whole story: the one run recording **zero** shift scored
**0.96**; the two recording 0.2011 scored 0.86. The shift and the ~0.10 deficit
were one phenomenon. **So #851's question is answered — ~0.84 was never a
regression**, and CLS was never a real defect (#854).

**The budget is back to 0.90**, restored on 2026-08-18 from five CI runs on the
fixed harness: **0.94 / 0.95 / 0.95 / 0.95 / 0.96** (median LHRs; the gate
asserts `optimistic`, so the gated value is at or above these). Both past
reductions — 0.90 → 0.85 in #532/#534, → 0.80 in #728 — were absorbing the
static-build artifact, not a real regression, so this is a restoration rather
than a raise.

**0.90, not 0.95, is deliberate.** A floor at the observed ceiling flakes with
no code cause; ~5 points of headroom matches the ±2–3 point runner noise
documented below.

**Never move this floor from a local number.** `lhci` collects all four
categories, while an ad-hoc `lighthouse --only-categories=performance` does
not, so the two are not comparable. On 2026-08-18 the same commit measured
**0.94–0.96** raw, **0.94–0.96** in CI, and **0.74 / 0.84** through local
`lhci` on a busy machine. Only CI samples count.

**`cumulative-layout-shift` is asserted at ≤ 0.1 with
`aggregationMethod: "pessimistic"`** so the artifact cannot return silently — it
sat at 2× the failing threshold for months with nothing going red, because only
the four category scores were gated. Current value is 0.0008, a ~125× margin.

**The `pessimistic` there is load-bearing, and differs deliberately from the
performance assertion's `optimistic`.** `optimistic` picks the most favourable
run *before* comparing, so against the old `0.2011 / 0.2011 / 0.0000` it would
aggregate to `0.0000` and pass — the guard would not have caught the very
artifact it exists to prevent. `pessimistic` takes the worst run, so any single
run above 0.1 fails the gate. That is safe here precisely because CLS is stable
under load (see below); do **not** copy it onto the performance assertion.

The assertion pins **`aggregationMethod: "optimistic"` (best of 3)** — the most
lenient option. **Do not switch it to `median`:** median ≤ max, so that only ever
makes the gate stricter and would re-introduce the flake (#728's original proposed
"fix" was exactly this, caught in the issue's own follow-up). Accessibility,
best-practices and seo stay at 0.90 on default aggregation; they have not been
observed to flake here. That is an observation, not a guarantee — if one starts
flaking, measure it before moving it.

**Performance numbers look contention-sensitive; CLS did not.** Across one
session's measurements (2026-08-18) CLS stayed within 0.0000–0.0008 while the
perf score ranged 0.63 → 0.96 on identical code, **correlating with** host load
— the runs were not controlled for other variables, so treat this as an observed
correlation rather than a demonstrated cause. It is still enough to act on:
measure perf on an idle host or take CI's number, and never re-baseline it from
a laptop doing other work.

### The mutation gate — documented invariants, proven executable

```bash
make mutation-gate      # ~8s; NOT part of `make gate`
```

**The problem it solves:** this repo has a recurring *vacuous test* class —
tests that pass against both the correct and the broken implementation. The
worst instance is recorded under "Band Announcements": deleting
`AND verified = 1` from either recipient query left **all 1,169 backend tests
green**, because ten test files all seeded `verified = 1`, so no fixture could
distinguish a gated query from an ungated one. The suite looked thorough and
proved nothing about the property it most needed to prove.

CLAUDE.md documents invariants in prose and asks contributors to "verify by
mutation" by hand. Nothing enforced it, so it decayed. `scripts/mutation-gate.mjs`
automates it: for each documented invariant it applies the exact one-line source
mutation that would break it, runs the named test file(s), and **requires them to
go red**. Then it restores the file and verifies the restore.

**What it does and does not tie together — read this before relying on it.**
The gate makes the listed *invariants* executable: it proves each guarded
behaviour still has a test that fails when the behaviour breaks, and a code
change that alters or renames a guarded line fails the build as pattern drift.

It does **not** read this file. Each entry carries the CLAUDE.md section name as
a plain string, for whoever reads a failure. An earlier draft of this section
claimed the gate cross-checked that name ("the prose cannot silently drift
without a red build"), which was exactly the confidently-wrong documentation
this whole file exists to prevent; it was caught in review, not by a test.

**The pointer half is now checked**, by
`scripts/__tests__/mutationGateCitations.test.js`: every `CLAUDE.md '<Section>'`
an entry cites must still match a heading here, so renaming or deleting a cited
section fails the build instead of leaving a dangling reference. The two gates
are complementary and neither implies the other — verified by renaming
`## Band Announcements` and watching `make mutation-gate` stay **green** while
the citation test went red.

Comparison strips backticks and collapses whitespace, which is load-bearing
rather than cosmetic: the live heading is ``Public event visibility is `status`,
never `is_published` (#800) — …`` while the citation is plain text, and a naive
substring match reports that as dangling. It did, on the first run — a false
positive caught by reading the heading instead of trusting the matcher.

**What is still unchecked is the prose itself.** The guard proves a heading by
that name exists, never that the words underneath still describe the invariant.
Editing the body of a correctly-named section leaves both gates green, so a
green build is still not evidence that this file's *content* is current — only
that its cross-references resolve.

Three properties are load-bearing, each learned from a failure recorded in this
file:

- **A `find` string that is absent — or matches more than once — is a GATE
  FAILURE, not a skip.** Patterns drift as code changes, and a gate whose
  patterns silently no-op reports all-green while testing nothing. Same shape as
  `lint-md` missing from `.PHONY`. If you rename or reword a guarded line, the
  gate fails and you update the `find` field; that failure is the tool working.
- **A surviving mutant is a real finding, reported loudly** with the invariant,
  file and expected tests named. It means that invariant's tests are vacuous.
  Do not delete the entry to get green — fix the test, or record it in
  `KNOWN_SURVIVING` with an issue reference.
- **It refuses to run on a dirty working tree** (scoped to the files its table
  touches). It cannot tell its own mutation from an edit in progress, and a
  crash mid-run could destroy real work.

**Deliberately NOT part of `make gate`.** `gate` must stay fast and
offline-capable; this shells out to git and spawns vitest once per mutation. It
runs as its own job in `quality.yml`.

**Scope is backend (`functions/`) only.** The frontend runs a separate vitest
project with its own config and jsdom environment; wiring it in here would mean
a second invocation with different flags and cwd. A `frontend/` companion is a
reasonable v2 — the frontend after-midnight threshold in
`frontend/src/utils/festivalDays.js` is the obvious first entry.

**What it does NOT do:** it proves a *named* test would catch a *specific*
break. It says nothing about invariants absent from its table, nor about test
quality generally. Ten entries is a floor, not a certificate — add one whenever
you add or change a test for something this file documents.

### The coverage floor — no handler may be entirely untested

```bash
make coverage-floor      # runs the coverage suite, then the check
```

**The problem it solves:** coverage thresholds in `vitest.config.js` are
**global averages**, and an average cannot see a file-shaped hole. A brand-new
200-line handler with no tests moves the global number by a rounding error and
passes. Measured on 2026-08-31: the backend sat at **81.67%** statements against
a 75% floor while **three files were at 0%** — every line unexecuted, no test
importing them at all.

`scripts/check-coverage-floor.mjs` reads `coverage/coverage-final.json` and
fails if any file under `functions/api/` has 0% statement coverage. It runs in
`quality.yml`'s existing **coverage** job, immediately after `npm run
test:coverage` — it must stay in that job, because the file it reads exists only
as a side effect of that step.

**It landed with an EMPTY allowlist** (`MAX_ALLOWED = 0`), deliberately: the
three dark files were covered first. An empty allowlist is strictly stronger
than a seeded debt register and removes the "seed then forget" failure entirely.
Adding an entry means shipping an untested handler — the thing being prevented.

Three properties are load-bearing:

- **It measures EXECUTION, not filenames.** The frontend ratchet
  (`missingTestGate.test.js`) keys on a matching test file over 400 lines. That
  does not transfer here: backend suites are feature-named — `api-key-auth.test.js`
  covers `_middleware.js` — so basename matching flags 23 files, 18 of them at
  59–92% coverage. Measuring execution has no false positives by construction.
- **A missing coverage file is a FAILURE, not a skip**, with the command to
  produce it. A gate that passes because its input is absent is worse than none.
- **It detects its own blindness.** vitest reports untested files only because
  `coverage.include` is set; if that changes, dark files vanish from the map and
  a naive check would report "all clear" while seeing nothing. It compares the
  on-disk inventory against the coverage map and fails when they diverge.

**Why not vitest's own thresholds** — both were measured and neither works: a
glob threshold group aggregates, so five 0% files hid inside the group average
and it exited 0; `perFile: true` applies the global 75/68/84/76 to *every* file
and produced 113 errors.

**What it does NOT do:** it proves a file was executed, not that it was tested
well. One test that imports a handler and asserts nothing takes it off this
list. That is why the mutation gate exists alongside it — this one catches
"nobody started", that one catches "the test cannot fail". Neither replaces the
other.

### Before every commit — required checklist

**Canonical entry point: `make gate`** — runs the Make targets `format` → `format-check` → `lint-all` → `test` → `build` (`format-check` wraps the `npm run format:check` script below) for both stacks with real exit codes (see `Makefile`, `AGENTS.md`). Run it before every commit; do not commit if it fails. The npm commands below are the explicit breakdown of what `make gate` runs, for when you need to run a subset or debug a failing step.

**`make gate` covers every file type we maintain, not just JavaScript.** Until
2026-08-29 it ran ESLint and Prettier and nothing else, so 69 SQL files, 17 YAML
files and 71 Markdown files were checked *only* by CodeRabbit — after the PR was
open, which is the force-push round-trip `make review` exists to avoid. `lint-all`
now fans out to `lint` (ESLint), `lint-md`, `lint-sh`, `lint-yaml`, `lint-sql`
and `lint-json`.

Five things about those targets are deliberate:

- **They fail with an install hint; they never skip.** `shellcheck`, `yamllint`
  and `sqlfluff` are external. A target that passes when its tool is missing is
  worse than no target — that is precisely the bug `lint-md` shipped with, where
  it was absent from `.PHONY`, so a stray file named `lint-md` made `make` report
  "up to date" and lint nothing. **Both that trap and the pipeline one below are
  now guarded** by `scripts/__tests__/makefileGuards.test.js` (#1070): it fails
  if any target is missing from `.PHONY`, or if a recipe ends in a filter whose
  status would mask the real one. Both halves assert they can still find what
  they scan for, because a parser that matches nothing reports "all clear"
  forever.
- **File lists use `git ls-files --cached --others --exclude-standard`**, not a
  bare `git ls-files`. The latter sees only *tracked* files, so a brand-new file
  you have not `git add`ed — the one most likely to be wrong — sails through.
  `--exclude-standard` still honours `.gitignore`. Each recipe then tests
  `[ -f "$f" ]`, because that list *also* names tracked files you have deleted
  but not yet staged — a legitimate state that would otherwise hand a missing
  path to the linter and fail the gate for no reason.
- **`lint-json` passes the path as `process.argv[1]`, never interpolated into
  the `node -e` source.** A filename containing a single quote would otherwise
  close the JS string literal and execute whatever followed, on every
  `make gate`. Each recipe also accumulates `rc=1` in a `while` loop
  **redirected from a file** rather than `exit`ing inside a pipeline — a `while`
  fed by a pipe runs in a subshell, where the exit never reaches the recipe. That is the same shape as the
  status-capture bug in #882.
- **`.yamllint` and `.markdownlint.json` are tuned to this corpus, not stock.**
  `extends: default` alone produced 435 YAML findings, 353 of them `line-length`
  at the default 80 chars, which no GitHub Actions workflow or OpenAPI spec
  respects. Tuning took it to 1 real defect. Treat a huge finding count as
  evidence the config is wrong for the corpus before treating it as debt.
- **`lint-json` checks validity, not formatting.** Running Prettier over these
  files only explodes compact arrays past `printWidth`, churning load-bearing
  files like `_routes.json` while catching no defect. An unparseable file is the
  real failure, and `ground-truth.json` has no code reading it that would fail
  loudly.

`sqlfluff` skips `archive/`: those migrations use `ALTER TABLE … ADD COLUMN IF
NOT EXISTS`, which SQLite does not support and sqlfluff cannot parse. They are
archived and never applied.

Run all steps that apply. Do not commit if any step fails.

**Frontend changes (`frontend/src/`):**
```bash
cd frontend
npx prettier --write "src/**/*.{js,jsx,json,css}"  # fix formatting first
npm run lint && npm run format:check                 # ESLint + verify format
npm test -- --run                                    # unit tests
npm run build                                        # catch import/compile errors E2E would catch
```

**Backend changes (`functions/`):**
```bash
npm run format              # prettier --write on functions/ + scripts/ (fix first)
npm run format:check        # verify formatting is clean
npm run lint                # ESLint on functions/ + scripts/ (must be 0 errors)
npm run validate:openapi    # if docs/api-spec.yaml changed
npm test                    # from repo root — runs fine locally, including Apple Silicon
```

**Why `--write` before `--check`:** `format:check` (what CI runs) only reports errors — it never fixes them. Always run `--write` first so the commit is already clean.

**Why `npm run build`:** E2E tests run against the built app. A build failure will fail E2E in CI without a clear error. Running `build` locally catches broken imports, missing exports, and Vite errors before they reach CI.

**E2E tests** require a live wrangler dev server and are slow — run them only when changing routes, auth flows, or anything the E2E suite targets. The build check above catches most issues.

### Before opening a PR — AI review gate

```bash
make review        # CodeRabbit review of this branch vs origin/main
make review-wip    # same, but for uncommitted working-tree changes
```

Requires the CodeRabbit CLI (`brew install --cask coderabbit`, then `coderabbit auth login`); both targets fail with an install/auth hint if it is missing.

**Run this before opening the PR, not after.** The same review runs automatically on the PR, so anything it finds post-open costs a fix plus a force-push round trip. Findings it has caught that the local gates did not: assertions that pass on the wrong branch's output, a spy recording statement *preparation* rather than *execution*, and a SQL guard that stayed inert for legacy rows after a write-side fix.

**`make review` is a strict subset of the PR review, and the gap is structural — not flake.** The CLI does not load `.github/instructions/**`; the PR bot does. That is why `coderabbit review` has a `-c, --config <files...>` flag for "additional instructions" at all. Three findings on 2026-08-19 (#866, #873 ×2) appeared only post-open and every one cited *"As per coding guidelines"*, tracing to rules in that directory — e.g. `nodejs-javascript-vitest.instructions.md`'s "Write tests for all new features and bug fixes". **So a post-open `Minor` is expected, not a sign the pre-PR gate failed.** The CLI *does* read `.coderabbit.yaml` and the `knowledge_base.learnings` (its output says "Based on learnings"); only the instruction files are missing.

**When the CLI cites a "coding guideline", look it up yourself — it is the one
claim it structurally cannot substantiate.** The CLI raises guideline findings it
inherited from the shared model but cannot point at the file, because it never
loaded `.github/instructions/**`. The PR bot raises the same finding *with* the
citation. Treating the uncited version as unfounded is how you end up reversing
yourself post-open.

Worked example, #1048 (2026-09-01). The CLI said "return `undefined`, not
`null`, per coding guideline". I grepped `.github/instructions/` for
`prefer.*undefined` and `return undefined`, found nothing, and declined it **in
the PR body**. The rule is real — `nodejs-javascript-vitest.instructions.md:16`,
"Never use `null`, always use `undefined` for optional values" — and my patterns
simply did not match its wording. The PR bot then raised it with the file and
line, and the decline had to be publicly retracted.

Two lessons, and the second is the general one: grep the *cited wording*, not a
paraphrase of it; and **a clean grep is a hypothesis, not a finding** (the same
trap as #996). The cheap habit that avoids the whole round trip: when a CLI
finding says "as per coding guidelines", open the five files in that directory
that apply to the changed file type before agreeing or disagreeing.

**Passing `-c .github/instructions/*.md` was tried and is NOT adopted.** In the one run measured, it failed to reproduce the PR's actual finding and instead emitted a false **critical** — claiming Vitest could not parse a file that parsed and passed 3/3 — on a run whose log was full of `fetchWithRetry` errors. A gate that emits false criticals trains you to skim the actionable bucket, which is the same "signal drowns" failure the streaming-link audit hit in #871. One degraded trial is not proof the flag is broken; it is enough not to wire it into a standing gate unmeasured. Re-test properly (several runs, good network) before revisiting.

`make gate` deliberately does **not** include it — `gate` must stay fast and offline-capable; `review` needs the network and takes minutes.

**A green CodeRabbit check does not NECESSARILY mean the diff was reviewed.** When every
changed file is excluded by a path filter, CodeRabbit posts *"Review skipped"*
and the status check still reports **pass**. Measured on #1083, a security bump
whose only change was `package-lock.json`: the badge was green and nothing had
been read.

The exclusion itself is correct and deliberate — `.coderabbit.yaml` sets
`!**/package-lock.json` and CodeRabbit ignores it by default too (the skip
message lists the pattern twice for that reason). A lockfile diff is generated
hashes; line-level review of it is noise.

**So for a dependency change, read `dependency-review`, not CodeRabbit.** That is
the check designed for the class, and it passed on #1083 alongside gitleaks and
GitGuardian.

**But be precise about what it covers, because two different threats hide behind
one green badge.** `dependency-review` compares the PR's dependency changes
against advisory databases and fails on a package with a *known* vulnerability at
or above its configured severity. That is the #1083 case exactly, and it is
genuinely covered.

It does **not** verify that a lockfile's `resolved` URLs still point at the
expected registry, nor re-check `integrity` against what it fetches. A lockfile
entry carries `version`, `resolved` and `integrity`; an edit repointing
`resolved` at an attacker-controlled host while leaving the version untouched
raises no advisory, and `npm ci` then fetches whatever `resolved` names.
**That gap is now GUARDED** by `scripts/__tests__/lockfileIntegrity.test.js`
(2026-09-04). It discovers every `package-lock.json` in the repo, asserts each
`resolved` URL points at an allowlisted registry host, and asserts every remote
entry carries an `integrity` hash. Baseline when added: 1,295 entries across two
lockfiles, all `registry.npmjs.org`, all hashed -- so the allowlist starts at one
host and a second is a deliberate diff.

Mutation-verified against the real attack shape: repointing one entry's
`resolved` at another host while leaving `version` untouched -- which raises no
advisory, so `dependency-review` stays green -- turns the guard red and names the
package. Lockfiles are discovered rather than listed, so a new workspace is
covered the day it appears.

The practical split: routine generated churn (a Dependabot group bump, a
transitive patch) is well served by the advisory check and needs no human diff
read. A lockfile change *not* produced by npm on your own machine deserves one,
whatever the checks say.

This is the same shape as `lint-md` missing from `.PHONY` (make reported "up to
date" having linted nothing), the Lighthouse artifact that uploaded nothing while
only warning, and axe reporting `incomplete` rather than a violation on a
gradient: **green meaning "did not look", not "looked and found nothing."** When
a gate goes green on a change you expected it to have opinions about, check
whether it ran at all.

**A review's findings are not all in its threads.** CodeRabbit posts
"outside diff range" comments in the review BODY, because GitHub cannot anchor
an inline comment to a line the diff does not touch. A GraphQL query over
`reviewThreads` -- the obvious way to enumerate findings, and the one used here
for a long time -- returns every inline thread and **none** of those. They are
invisible unless the body is read.

Missed one on #1105 (2026-09-04): `--match --color-accent-500` set
`flags.match = true` and died with "--match <pattern> is required", an error
about a flag that WAS supplied. Not hypothetical -- `--color-accent-500` is a
theme token used throughout the CSS and every SQL comment in `migrations/`
begins with `--`. The owner spotted it in the PR; the tooling had not.

So enumerate BOTH: the threads, and each review's `body`. An audit of #1097
through #1104 afterwards found no others, so this was a first occurrence rather
than a backlog -- but nothing in the thread query would have said so either way.

Same family as the rest of this section: a green-looking read that quietly saw
less than it appeared to.
**Nitpicks hide in the same place, and are not always nits.** Alongside
outside-diff findings, CodeRabbit collapses a "Nitpick comments" section into a
`<details>` block in that same body. On #1105 the one nitpick was that a test
asserting "a `--with-file` operand starting with `--` is still read as a path"
passed an ABSOLUTE path -- `/var/.../--repl.txt`, which does not begin with
`--` as an operand at all. The test could not fail for the reason it claimed,
and did pass against the broken parser. Labelled Trivial; it was a vacuous test,
which is the defect class this file cares most about.

So read the body for BOTH sections. Judge a finding by what it says, not by the
bucket it arrived in.
Related, and why the push-budget hook is not "wrong": it counts **pushes**, and a
skipped review consumes none of the hourly allowance. The count is therefore
conservative — you sometimes have more budget than it thinks. Do not "fix" that
by having the hook query the API; it is deliberately POSIX `sh` with no `gh`,
`jq` or network call, because a hook that fails open when a tool is missing is
worse than no hook.

### CodeRabbit costs money past 5 reviews an hour — batch your pushes

**Every push to a PR branch triggers a review.** CodeRabbit Pro allows **5 PR reviews per developer per ROLLING HOUR**, and this account has the usage-based add-on enabled — so past that, reviews are **not paused, they are billed**. There is no natural brake; the discipline has to come from the workflow.

**The expensive failure is concentration, not volume.** The same number of pushes spread across a day costs nothing, because the window keeps refilling. PR #998 burned **4 reviews in ~25 minutes on a two-line change** — which, with #997's review already inside the same rolling hour, is what reached the limit of 5. Fixes went out one at a time instead of batched — a stale comment, then an E2E failure, then an incomplete sweep of that same failure, then a nit on prose added two pushes earlier. Three of the four were avoidable by reading the diff and running the right suite locally first.

`make hooks` installs a tracked `pre-push` guard (`.githooks/pre-push`, wired via `core.hooksPath`). It warns at 3 reviews in the window and **blocks at 5**, reporting how many minutes until the budget refills. Run it once per clone — hooks are not cloned with the repo.

**The rule for overriding is urgency to land, NOT issue priority.** Priority is the wrong axis: a p1 fixed correctly costs one review, while a p3 botched four times costs four — overage comes from *rework*, not importance, and a "p1 only" rule would license sloppiness exactly where correctness matters most.

**Waiting is free.** The window is rolling, so the budget refills on its own. Ask only whether this must land *before it refills*:

- show day, a production incident, or someone blocked on you → override
- everything else → batch the remaining fixes and push once

```bash
CODERABBIT_OVERAGE=1 git push   # emergencies only; it bills
```

The hook is deliberately POSIX `sh` with no `gh`, `jq`, or network call — one that fails open when a tool is missing is worse than none, and it runs on every push. `lint-sh` globs `*.sh`, which would have skipped it silently, so that target now lists `.githooks/*` explicitly.

### Before every push (including follow-up commits during PR review)

```bash
git fetch origin
git rebase origin/main      # keep branch current with main
```

Do this **every time you push**, not just when opening the PR. Dependabot merges deps bumps to `main` frequently — if you push without rebasing, GitHub will require an "Update branch" click before merging, which adds round-trips. Rebasing before each push eliminates this entirely.

### Opening a pull request

Full PR standards are in `.github/instructions/pull-request-standards.instructions.md`. Key points:

- **Use the PR template** — GitHub loads `.github/pull_request_template.md` automatically. Fill every section; write "None" rather than deleting a section.
- **Title:** conventional-commit prefix + specific description. Put `Closes #N` on its own line in the body (GitHub does not auto-close from the title).
- **Labels:** always apply one type label (`bug`, `enhancement`, `ci`, `documentation`, `chore`, `security`) + one priority label (`priority:p1/p2/p3`) when opening — not after.
- **Verification checkboxes:** tick every `- [ ]` item before merging. An unchecked test plan is indistinguishable from a skipped one.
- **Attribution:** one line, no session URL: `Built by Sonny · Reviewed by Theo · 🤖 [Claude Code](https://claude.ai/claude-code)`

```bash
gh pr create --label "bug,priority:p1"   # example
```

---

## Security Notes

- All admin state-changing endpoints require both a valid session cookie AND a CSRF token (`X-CSRF-Token` header, read from the `csrf_token` cookie).
- Session invalidation: `lucia.invalidateUserSessions(userId)` must be called before `lucia.createSession(user.id, {})` on re-authentication (login, MFA verify). This kills stale sessions from prior compromised contexts. Both methods live on the object returned by `initializeLucia()` in `functions/utils/auth.js`.
- CSRF cookie must be regenerated whenever a new session is created (see `functions/api/admin/sessions/revoke-all.js`).
- `params.id` from Cloudflare Pages Functions URL params is a string; always run it through `validateId()` from `functions/utils/validation.js` before using it in a DB query.

### Content-Security-Policy (strict, no `unsafe-inline`) — TWO sources

There are **two** CSPs, and the one the browser enforces on a page is **not** the middleware:

- **`frontend/public/_headers`** sets the CSP (and COOP/COEP/CORP) on **static/document responses** — i.e. the HTML the browser loads. **This is the browser-enforced CSP for pages and the one that governs Turnstile, the service worker, and inline scripts.** Edit this for anything affecting what the page can load.
- **`functions/_middleware.js`** sets a CSP on **Pages Functions / API responses** (JSON), enforced when `ENVIRONMENT=production` unless `CSP_ENFORCE` overrides. It does not govern the document.

For the `_headers` document CSP:
- **Turnstile** needs `https://challenges.cloudflare.com` in `script-src`/`frame-src` ([CSP docs](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)); no `'unsafe-inline'`.
- **`Cross-Origin-Embedder-Policy: require-corp` must NOT be set** — it blocks the Turnstile iframe (which doesn't send COEP; `credentialless` isn't supported in Safari). The app needs no cross-origin isolation.
- **The inline theme-flash `<script>` in `frontend/index.html`** is allowed by a `'sha256-…'` hash in `script-src`. **If you edit that script, regenerate the hash** (sha256 of the exact built script body, base64) or it silently stops running and a theme flash returns. No test covers this — verify by building and hashing `dist/index.html`.
- **Cloudflare Rocket Loader must stay DISABLED** for the zone. It rewrites/inline-executes `<script>` tags, which strict CSP blocks ("Refused to execute inline script"). A modern code-split Vite SPA gains nothing from it.

### Where Cloudflare-facing settings actually live

Most of what follows is **not** in `wrangler.toml` or any other file here — it
is Cloudflare-side state, silently undoable, with nothing in the repo to hint
that it mattered. That is why it is written down.

**The last row is the deliberate exception, and it is the point of the table.**
HSTS *is* repo-managed; it appears here because the zone's own HSTS toggle reads
"off", so anyone auditing Cloudflare concludes it is missing and reaches for the
dashboard. The fix for anything HSTS-related is `frontend/public/_headers`, not
Cloudflare. Read the layer column before changing anything — it is what tells
you where to go:

| layer | where you change it | items |
|---|---|---|
| **Zone settings** | Cloudflare dashboard / API, zone `settimes.ca` (`77e5bb9ef071b25b9cb65885ed4b38e1`) | Rocket Loader, the `www` → apex redirect rule, SSL mode, minimum TLS |
| **DNS records** | same zone, DNS tab | the DMARC record |
| **Pages project** config | Cloudflare Pages project `settimesdotca` | environment variables |
| **Account** resources | Cloudflare account | D1 databases |
| **This repository** | `frontend/public/_headers` | **HSTS** — listed only because the zone toggle reading "off" is correct and looks like a gap |

- **Rocket Loader: disabled** — see the bullet above.
- **`www` → apex 301 redirect rule** (#984, added 2026-08-29). A zone
  `http_request_dynamic_redirect` phase ruleset, `www to apex (301, preserves
  path + query)`:

  ```text
  if    (http.host eq "www.settimes.ca")
  then  redirect 301 -> concat("https://settimes.ca", http.request.uri.path)
        preserve_query_string: true
  ```

  Before it, `www.settimes.ca` served the entire site at HTTP 200 as a full
  duplicate of the apex, and both hosts ranked separately — the apex at 243
  impressions / position 12.2 against `www` at 40 / 21.2.

  Three things not to "simplify":
  - **It must be a *dynamic* redirect, not static.** A static one sends every
    deep path to the homepage; the `concat(...)` expression is what carries
    `/band/31` across.
  - **Do not remove `www` as a Pages custom domain** to "clean up". The
    redirect can only answer if `www` still resolves and terminates TLS —
    removing it turns every old bookmark into a certificate error instead of a
    redirect.
  - **`/` still emits no raw-HTML canonical, deliberately** (see the SSR
    ownership section: the homepage keeps client-side ownership of its identity
    meta). That was survivable as a duplicate-host problem only because this
    rule now leaves one live host. If `www` ever stops redirecting, the
    duplicate returns and the canonical gap is what makes it bite.

- **SSL/TLS mode: Full (strict)**, and **minimum TLS version 1.2** (both set
  2026-08-29; they were `Full` and `1.0`). Strict is correct here because every
  proxied origin is Cloudflare-owned with a valid certificate — apex and `www`
  resolve to the Pages project, `band-photos` to `public.r2.dev`. Adding a
  proxied record pointing at an origin with a self-signed or expired cert will
  now fail closed rather than silently accept it, which is the intent.
- **HSTS is served by the application, not the zone.** `frontend/public/_headers`
  sends `max-age=31536000; includeSubDomains; preload`, so the zone-level HSTS
  toggle reading "off" is correct and **not** a gap. Do not "fix" it by enabling
  the zone setting as well; check the live header before concluding anything is
  missing.

**Removed 2026-08-29, recorded so they are not recreated by reflex:**

- `dev.settimes.ca` — a `CNAME` to tunnel `b94985aa…`, which no longer exists.
  It served HTTP 530 on the brand domain. The only live tunnel is a different id.
- `ADMIN_PASSWORD` and `MASTER_PASSWORD` Pages production environment variables.
  **Nothing read them** — every consumer in this repo uses `E2E_ADMIN_PASSWORD`
  (`scripts/seed-e2e-admin.mjs`), which is local-only. They were unused
  credentials sitting in production config.
- The `bandcrawl-db` D1 database — verified empty (only Cloudflare's internal
  `_cf_KV`, no user tables), referenced nowhere in the repo, bound to nothing.
  The only D1 database is `settimes-production-db`. Note the API's `num_tables`
  field is **not** trustworthy for this check: it reported `0` for the production
  database too. Query `sqlite_master` instead.

- **DMARC now reports** (added 2026-08-29). `_dmarc.settimes.ca` was
  `p=quarantine` with **no `rua=`** — enforcing a policy whose effects nobody
  could see, which is the worst of the two halves to have alone. `p` only
  *requests* a disposition; each receiver decides for itself, and a message
  handled as suspicious typically produces no bounce and no error the sender
  ever sees. Failures are therefore silent by default, which is exactly why the
  reporting half is not optional.
  Now:

  ```text
  v=DMARC1; p=quarantine; adkim=r; aspf=r; pct=100; rua=mailto:dmarc@settimes.ca
  ```

  Reports go to an iCloud **catch-all**, so no alias had to be created, and
  because `rua` is on the *same* domain as the record no external
  `settimes.ca._report._dmarc.<host>` authorization TXT is needed — that
  requirement only applies to a third-party reporting host.

  **`adkim=r` / `aspf=r` must stay relaxed.** The domain has two independent
  sending paths — iCloud for human mail (`sig1._domainkey`, `include:icloud.com`)
  and Resend via Amazon SES for application mail (`resend._domainkey`,
  `include:amazonses.com`, `send.settimes.ca`). Strict alignment would break the
  SES path. The application path is the one that matters operationally: it
  carries the **band-follow confirmation emails**, and since follows are double
  opt-in, silently quarantined confirmations mean followers are never verified
  and never receive announcements — with nothing anywhere reporting an error.

  Reports typically begin arriving within 24–48h and are XML, usually gzipped
  (compression is recommended by RFC 7489, not required — plain `.xml` is
  valid). Both are conventions, not guarantees: providers report on their own
  schedules and some never do. **If none arrive within a few days, treat that as
  a prompt to check whether the catch-all routes `dmarc@` — it is a signal to
  investigate, not proof of either a failure or of everything being fine.**

  Deliberately not set: `ruf=` (forensic reports carry recipient PII and almost
  no provider sends them), and `p=reject`, which is the stronger end state but
  should wait until a few weeks of reports confirm both sending paths pass
  cleanly.
