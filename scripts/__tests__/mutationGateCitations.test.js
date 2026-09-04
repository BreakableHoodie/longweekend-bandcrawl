/**
 * Guard: every CLAUDE.md section the mutation gate cites must still exist.
 *
 * THE GAP THIS CLOSES, named in CLAUDE.md's own "The mutation gate" section:
 *
 *   "It does NOT read this file. Each entry carries the CLAUDE.md section name
 *    as a plain string, for whoever reads a failure -- it is a pointer, not a
 *    checked cross-reference. So editing or deleting the prose here leaves the
 *    gate green ... Validating that every cited section still exists is
 *    tractable and is tracked separately -- until it lands, do not read a green
 *    gate as evidence that the words above are current."
 *
 * This lands it. `make mutation-gate` proves each guarded BEHAVIOUR still has a
 * test that fails when the behaviour breaks; this proves each entry's POINTER
 * still resolves, so a failure message names a section a reader can actually
 * find. The two are complementary and neither implies the other: renaming a
 * heading leaves every mutation caught and every citation dangling.
 *
 * Scope, honestly: this checks that a heading by that name EXISTS. It cannot
 * check that the prose underneath still describes the invariant -- that needs a
 * human. It closes "the pointer dangles", not "the docs drifted".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const gateSource = readFileSync(join(repoRoot, "scripts", "mutation-gate.mjs"), "utf8");
const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");

/**
 * Headings compare with backticks stripped and whitespace collapsed.
 *
 * Not cosmetic: the live heading is
 *   "Public event visibility is `status`, never `is_published` (#800) — ..."
 * while the citation is the plain-text "Public event visibility is status,
 * never is_published". A naive substring match reports that as a dangling
 * pointer -- which it did on the first run here, a false positive caught by
 * reading the heading rather than trusting the matcher.
 */
function normalise(text) {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const headings = claudeMd
  .split("\n")
  .filter((line) => /^#{2,4}\s+/.test(line))
  .map((line) => normalise(line.replace(/^#{2,4}\s+/, "")));

const citations = [...gateSource.matchAll(/invariant:\s*\n?\s*"CLAUDE\.md '([^']+)'/g)].map((m) => m[1]);

describe("mutation-gate entries cite CLAUDE.md sections that exist", () => {
  // A scan that matches nothing reports "all clear" forever. Both counts are
  // asserted because either one silently going to zero disables the check: no
  // citations parsed, or no headings parsed.
  it("parses one citation for EVERY mutation entry", () => {
    // Parity, not a floor. A `>= 15` threshold passed while the table held 17
    // entries -- so two entries could change their `invariant` wording, fall out
    // of the regex, and have their heading references silently unchecked while
    // this test stayed green. Counting both sides and requiring equality is the
    // only assertion that cannot drift.
    const entryCount = (gateSource.match(/^\s*id: "/gm) ?? []).length;
    expect(entryCount).toBeGreaterThanOrEqual(15);
    expect(
      citations.length,
      `scripts/mutation-gate.mjs has ${entryCount} entries but only ${citations.length} parsed a ` +
        `CLAUDE.md citation. An entry whose 'invariant' string does not start with ` +
        `CLAUDE.md '<Section>' is not being checked at all.`,
    ).toBe(entryCount);
    expect(headings.length).toBeGreaterThanOrEqual(30);
    expect(citations).toContain("Band Announcements");
  });

  it.each([...new Set(citations)])("CLAUDE.md still has a '%s' section", (cited) => {
    const target = normalise(cited);
    // Boundary-aware, NOT includes(). A bare substring match accepts the
    // citation anywhere in an unrelated heading: delete `## Band Announcements`,
    // leave `## Archived Band Announcements`, and includes() still passes --
    // verified, it returns true. The citation must BE the heading, or be its
    // opening followed by a qualifier (`API keys` -> `API keys (#744) — ...`).
    const found = headings.some((h) => h === target || h.startsWith(`${target} `));
    expect(
      found,
      `scripts/mutation-gate.mjs cites CLAUDE.md '${cited}', but no heading matches.\n` +
        `Either the section was renamed or removed. Update the entry's 'invariant' string\n` +
        `to the new heading, or -- if the invariant itself is gone -- remove the entry.`,
    ).toBe(true);
  });
});
