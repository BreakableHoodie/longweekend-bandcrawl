# settimes.ca — canonical task runner for humans and agents.
# make propagates real exit codes; never wrap these in `cmd | tail` chains.
# E2E recipe mirrors .github/actions/e2e-env/action.yml.

SHELL := /bin/sh
# Every linter's file list. `--others --exclude-standard` adds files that are
# untracked but NOT gitignored: a brand-new file you have not `git add`ed is the
# one most likely to be wrong, and a bare `git ls-files` would skip it. Each
# recipe still tests `[ -f ]`, because this list also names TRACKED files that
# have been deleted but not yet staged — a legitimate state that would otherwise
# hand a missing path to the linter and fail the gate for no reason.
LINT_FILES := git ls-files --cached --others --exclude-standard
#
# Recipes read this list with `while IFS= read -r f` REDIRECTED FROM A FILE, not
# `for f in $(...)` and not a pipe. `for` word-splits on spaces and re-globs, so
# `bad name.yml` became two nonexistent paths that `[ -f ]` skipped — an invalid
# file linted by nobody, exit 0. A pipe would fix the splitting but run the loop
# in a subshell, where `rc=1` never reaches the recipe. Redirecting from a file
# gets both. Filenames containing NEWLINES are still out of scope; that needs
# -z/`read -d ''`, which is bash, and this Makefile is /bin/sh.
#
# Enumeration failure is checked explicitly. Without it, a failing `git ls-files`
# writes an empty list, the loop body never runs, rc stays 0, and the gate
# reports success having linted NOTHING — the same silent-pass shape as the
# missing .PHONY entry. lint-sql needs its own handling because a pipeline
# reports the LAST command's status, so a filter's success would mask git's
# failure. The filter is sed, not grep: grep exits 1 on "no match" AND 2 on a
# read error, so the `|| true` needed to tolerate the former also swallowed the
# latter. sed exits 0 when it deletes nothing and non-zero only on a real error.
WRANGLER := ./frontend/node_modules/.bin/wrangler
E2E_STATE := .wrangler/e2e-state
E2E_PID := .wrangler/e2e-state/wrangler.pid
E2E_ADMIN_EMAIL ?= e2e-admin@test.local
E2E_ADMIN_PASSWORD ?= e2e-test-password-Xk9
# Exported, never interpolated: make echoes recipe text, so a $(VAR) in a
# recipe prints the secret to the terminal and into CI logs. Exporting puts
# the value in the child environment instead, where $$VAR reads it at run
# time and the recipe text never contains it. Verify with `make -n e2e-setup`.
export E2E_ADMIN_EMAIL
export E2E_ADMIN_PASSWORD

.PHONY: coverage-drift help install build dev format format-check lint lint-md lint-sh lint-yaml lint-sql lint-json \
	lint-all test test-backend test-frontend mutation-gate coverage-floor gate review review-wip validate-openapi schema-check \
	probe-links e2e e2e-setup e2e-serve e2e-run e2e-clean hooks delegate-stats

# CodeRabbit emits PostHog telemetry errors when egress is blocked. They are
# noise, not review failures — the review still exits 0. They appear on BOTH
# stdout and stderr, so redirecting one stream is not enough.
#
# Every pattern here is anchored or names posthog/the CLI's own bundle path, so
# none can match review prose. Do NOT loosen these to bare tokens like `code:`
# or `path:` — a finding whose text contains one would be silently swallowed,
# and a filter that eats findings is worse than the noise it removes.
CR_NOISE := ^Error while flushing PostHog |^ *path: "https://us\.i\.posthog\.com/|\$$bunfs/root/cli\.js|^error: Unable to connect\.|^ *errno: 0,$$|^ *code: "ConnectionRefused"$$

help: ## List targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install root + frontend dependencies
	npm ci
	cd frontend && npm ci

build: ## Frontend production build (also what E2E serves)
	npm run build --prefix frontend

dev: ## Serve the built app + functions on :8788 against local D1 (foreground)
	$(WRANGLER) pages dev frontend/dist --port 8788 --persist-to .wrangler/state

format: ## Prettier --write, both stacks
	npm run format
	cd frontend && npx prettier --write "src/**/*.{js,jsx,json,css}"

format-check: ## Prettier --check, both stacks (what CI runs)
	npm run format:check
	cd frontend && npm run format:check

lint: ## ESLint, both stacks
	npm run lint
	cd frontend && npm run lint

lint-md: ## markdownlint across the docs we maintain (see .markdownlint-cli2.jsonc)
	npm run lint:md

# Each external linter FAILS with an install hint rather than skipping. A gate
# that quietly passes when its tool is absent is worse than no gate — that is
# exactly the failure `lint-md` had before it reached .PHONY.

# File lists come from $(LINT_FILES); see its definition for the scope rules.
# .githooks/* is listed explicitly: those files are shell but carry NO .sh
# extension, so the '*.sh' glob alone would silently skip them -- a linter that
# does not see a file is indistinguishable from one that passes it.
lint-sh: ## shellcheck every shell script incl. git hooks (tracked + untracked, minus gitignored)
	@command -v shellcheck >/dev/null 2>&1 || { \
		echo "shellcheck not found. Install: brew install shellcheck"; exit 1; }
	@list=$$(mktemp); \
	$(LINT_FILES) '*.sh' '.githooks/*' > "$$list" || { rm -f "$$list"; \
		echo "lint: could not enumerate files (git ls-files failed)"; exit 1; }; \
	rc=0; while IFS= read -r f; do \
		[ -f "$$f" ] || continue; \
		shellcheck "$$f" || rc=1; \
	done < "$$list"; rm -f "$$list"; exit $$rc

lint-yaml: ## yamllint every YAML file (tracked + untracked, minus gitignored; config: .yamllint)
	@command -v yamllint >/dev/null 2>&1 || { \
		echo "yamllint not found. Install: brew install yamllint"; exit 1; }
	@list=$$(mktemp); \
	$(LINT_FILES) '*.yml' '*.yaml' > "$$list" || { rm -f "$$list"; \
		echo "lint: could not enumerate files (git ls-files failed)"; exit 1; }; \
	rc=0; while IFS= read -r f; do \
		[ -f "$$f" ] || continue; \
		yamllint "$$f" || rc=1; \
	done < "$$list"; rm -f "$$list"; exit $$rc

# archive/ is excluded: those migrations use `ALTER TABLE ... ADD COLUMN IF NOT
# EXISTS`, which SQLite does not support and sqlfluff cannot parse. They are
# archived and never applied, so fixing them buys nothing.
lint-sql: ## sqlfluff every SQL file outside archive/ (tracked + untracked, minus gitignored; config: .sqlfluff)
	@command -v sqlfluff >/dev/null 2>&1 || { \
		echo "sqlfluff not found. Install: brew install sqlfluff"; exit 1; }
	@list=$$(mktemp); raw=$$(mktemp); \
	$(LINT_FILES) '*.sql' > "$$raw" || { rm -f "$$raw" "$$list"; \
		echo "lint: could not enumerate files (git ls-files failed)"; exit 1; }; \
	sed '/^archive\//d' "$$raw" > "$$list" || { rm -f "$$raw" "$$list"; \
		echo "lint: could not filter the SQL file list"; exit 1; }; \
	rc=0; while IFS= read -r f; do \
		[ -f "$$f" ] || continue; \
		sqlfluff lint "$$f" || rc=1; \
	done < "$$list"; rm -f "$$raw" "$$list"; exit $$rc

# Validity, deliberately NOT formatting. Prettier on these files only explodes
# compact arrays past printWidth — churn on load-bearing files (_routes.json)
# for no defect caught. An unparseable file is the real failure, and
# ground-truth.json in particular has no code that reads it to fail loudly.
#
# The path goes in as ARGV, never interpolated into the -e source: a filename
# containing a single quote would otherwise close the JS string literal and run
# whatever followed, on every `make gate`.
#
# node is checked up front like the external linters above. Without the check a
# missing node does not merely fail — every invocation errors and the recipe
# reports "invalid JSON:" for EVERY file, sending you hunting for corruption in
# files that are fine.
lint-json: ## assert every JSON file parses (tracked + untracked, minus gitignored)
	@command -v node >/dev/null 2>&1 || { \
		echo "node not found. Install Node.js, then: make install"; exit 1; }
	@list=$$(mktemp); \
	$(LINT_FILES) '*.json' > "$$list" || { rm -f "$$list"; \
		echo "lint: could not enumerate files (git ls-files failed)"; exit 1; }; \
	rc=0; while IFS= read -r f; do \
		[ -f "$$f" ] || continue; \
		node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$$f" \
			|| { echo "invalid JSON: $$f"; rc=1; }; \
	done < "$$list"; rm -f "$$list"; exit $$rc

lint-all: lint lint-md lint-sh lint-yaml lint-sql lint-json ## every linter, all file types

test-backend: ## Backend unit tests (better-sqlite3; runs fine on Apple Silicon, a few seconds)
	npm test

test-frontend: ## Frontend unit tests
	cd frontend && npm test -- --run

test: test-backend test-frontend ## All unit tests

mutation-gate: ## Convert documented invariants into executable proof (~8s; NOT part of `gate` -- see .github/workflows/quality.yml)
	node scripts/mutation-gate.mjs

coverage-floor: ## Fail if any functions/api handler has 0% coverage (runs the coverage suite first)
	npm run test:coverage
	node scripts/check-coverage-floor.mjs

coverage-drift: ## Fail if coverage thresholds have drifted below actual (runs both coverage suites first)
	npm run test:coverage
	node scripts/check-coverage-drift.mjs backend
	npm run test:coverage --prefix frontend
	node scripts/check-coverage-drift.mjs frontend

gate: format format-check lint-all test build ## FULL pre-commit gate — run before every commit

hooks: ## Install the tracked git hooks (pre-push CodeRabbit rate-limit guard)
	@git config core.hooksPath .githooks
	@echo "core.hooksPath -> .githooks"
	@echo "pre-push now guards the CodeRabbit rolling-hour limit ($$(sed -n 's/^LIMIT=\([0-9][0-9]*\)$$/\1/p' .githooks/pre-push) review(s)/hour)."
	@echo "Override for a genuine emergency: CODERABBIT_OVERAGE=1 git push"

review: ## AI code review of this branch vs origin/main — run BEFORE opening a PR
	@command -v coderabbit >/dev/null 2>&1 || { \
		echo "coderabbit CLI not found. Install: brew install --cask coderabbit"; exit 1; }
	@coderabbit auth status >/dev/null 2>&1 || { \
		echo "Not signed in. Run: coderabbit auth login"; exit 1; }
	@# Refresh the remote ref first: the CLI compares against origin/main when
	@# local main has drifted, so a stale origin/main yields the wrong diff.
	@git fetch origin --quiet
	@out=$$(mktemp); coderabbit review --base main >"$$out" 2>&1; status=$$?; \
		grep -aivE '$(CR_NOISE)' "$$out" || true; rm -f "$$out"; exit $$status

review-wip: ## AI code review of uncommitted changes — run before committing
	@command -v coderabbit >/dev/null 2>&1 || { \
		echo "coderabbit CLI not found. Install: brew install --cask coderabbit"; exit 1; }
	@coderabbit auth status >/dev/null 2>&1 || { \
		echo "Not signed in. Run: coderabbit auth login"; exit 1; }
	@out=$$(mktemp); coderabbit review --type uncommitted >"$$out" 2>&1; status=$$?; \
		grep -aivE '$(CR_NOISE)' "$$out" || true; rm -f "$$out"; exit $$status

delegate-stats: ## Token usage and cost for delegated (OpenCode) runs on this project
	@command -v opencode >/dev/null 2>&1 || { \
		echo "opencode CLI not found. Install it, or see CLAUDE.md 'Delegating to OpenCode'."; exit 1; }
	@# Capture ONCE and check the command's own status before filtering. A
	@# `opencode stats | sed` pipeline returns SED's status, so a failed stats
	@# call still exits 0 and this target reports nothing while looking fine --
	@# the pipe-masks-exit-codes trap (PR #609), and a violation of the
	@# real-exit-codes contract at the top of this file.
	@#
	@# --project "" scopes to the CURRENT project; the default is every project.
	@# DAYS overrides the window (default 7).
	@#
	@# Reads LOCAL session history, so it reports consumption, not entitlement,
	@# and cannot see runs from another machine. There is no quota endpoint to
	@# ask: opencode.ai/v2/docs/api is the local SERVER api (sessions, fs, shell)
	@# and documents nothing for usage, billing or limits.
	@out=$$(mktemp); \
	if ! opencode stats --days $${DAYS:-7} --models --project "" >"$$out" 2>&1; then \
		echo "opencode stats failed:"; cat "$$out"; rm -f "$$out"; exit 1; \
	fi; \
	status=0; \
	sed -n '/COST/,/└/p' "$$out" || status=$$?; \
	sed -n '/MODEL/,/└/p' "$$out" || status=$$?; \
	rm -f "$$out"; \
	exit $$status
	@echo ""
	@echo "  A \$$0.00 model is free FOR NOW, not free by contract. Big Pickle is"
	@echo "  documented as free on OpenCode 'for a limited time'. If a delegation"
	@echo "  starts reporting a cost, that window closed -- see opencode.ai/docs/zen."

validate-openapi: ## Required when docs/api-spec.yaml changed
	npm run validate:openapi

schema-check: ## Required after touching migrations/ — regenerate + drift-check setup-complete.sql
	node scripts/regenerate-setup-complete.mjs
	node scripts/check-schema-drift.mjs

e2e-setup: build ## Init + seed an isolated local D1 for E2E (safe to re-run)
	rm -rf $(E2E_STATE)
	$(WRANGLER) d1 execute settimes-production-db --local --persist-to $(E2E_STATE) --file=database/setup-complete.sql
	$(WRANGLER) d1 execute settimes-production-db --local --persist-to $(E2E_STATE) --file=database/seed-test-data.sql
	SEED_SQL=$$(node scripts/seed-e2e-admin.mjs --email "$$E2E_ADMIN_EMAIL"); \
	$(WRANGLER) d1 execute settimes-production-db --local --persist-to $(E2E_STATE) --command="$$SEED_SQL"

e2e-serve: ## Start wrangler for E2E in the background (writes pidfile); retries boot once, never test failures (mirrors e2e-env action.yml, #625)
	try_boot() { \
		$(WRANGLER) pages dev frontend/dist --port 8788 --persist-to $(E2E_STATE) > $(E2E_STATE)/wrangler.log 2>&1 & \
		echo $$! > $(E2E_PID); \
		i=1; \
		while [ $$i -le 90 ]; do \
			kill -0 "$$(cat $(E2E_PID))" 2>/dev/null || { echo "wrangler process exited unexpectedly (attempt $$1)"; tail -20 $(E2E_STATE)/wrangler.log; return 1; }; \
			curl -s -o /dev/null http://localhost:8788/ && { echo "server ready on port 8788 (attempt $$1, $$((i*2))s)"; return 0; }; \
			[ $$((i % 10)) -eq 0 ] && { echo "--- wrangler log so far (attempt $$1, iteration $$i) ---"; tail -20 $(E2E_STATE)/wrangler.log; }; \
			i=$$((i+1)); sleep 2; \
		done; \
		echo "wrangler failed to start after 180s (attempt $$1)"; tail -20 $(E2E_STATE)/wrangler.log; return 1; \
	}; \
	try_boot 1 && exit 0; \
	kill "$$(cat $(E2E_PID))" 2>/dev/null || true; \
	for pid in $$(lsof -ti:8788 2>/dev/null); do kill -9 "$$pid" 2>/dev/null || true; done; \
	sleep 2; \
	try_boot 2 && exit 0; \
	echo "wrangler failed to start after 2 attempts"; exit 1

e2e-run: ## Run Playwright (server must be up; credentials required even for --list)
	ADMIN_EMAIL="$$E2E_ADMIN_EMAIL" ADMIN_PASSWORD="$$E2E_ADMIN_PASSWORD" npx playwright test $(SPEC) --reporter=list

e2e-clean: ## Kill the E2E server by pidfile and remove isolated state
	-[ -f $(E2E_PID) ] && kill $$(cat $(E2E_PID)) 2>/dev/null || true
	rm -rf $(E2E_STATE)

e2e: e2e-setup e2e-serve ## Full local E2E: setup, serve, run, always clean up
	ADMIN_EMAIL="$$E2E_ADMIN_EMAIL" ADMIN_PASSWORD="$$E2E_ADMIN_PASSWORD" npx playwright test $(SPEC) --reporter=list; \
	status=$$?; \
	$(MAKE) e2e-clean; \
	exit $$status

probe-links: ## Probe canonical bandcamp URLs for linkless bands (FILE=names.txt, newline-separated)
	node scripts/probe-band-links.mjs --file $(FILE)
