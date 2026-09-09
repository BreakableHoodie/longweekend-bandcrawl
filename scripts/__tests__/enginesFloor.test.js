/**
 * Guard: the declared Node floor must actually cover the APIs the code uses.
 *
 * THE GAP (#1121). Four test files use `import.meta.dirname`, which landed in
 * Node 20.11.0, while `package.json` declared no `engines` at all. A contributor
 * on 20.0-20.10 got a module-load failure rather than a clear version error, and
 * CI runs 22 — so nothing in CI could ever surface it.
 *
 * Declaring the floor documents the constraint. This test stops the two halves
 * drifting: adding an API with a higher requirement, or lowering the floor
 * below what the code already needs, fails here rather than on someone's laptop.
 *
 * Scope, honestly: it knows about the version-gated APIs listed in
 * `VERSION_GATED_APIS`. It cannot discover a new one on its own — that list is
 * maintained by hand, and this is a backstop against the case that has actually
 * happened, not proof no other exists.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// API -> the first Node version that provides it.
const VERSION_GATED_APIS = [
  { pattern: /\bimport\.meta\.dirname\b/, since: "20.11.0", name: "import.meta.dirname" },
  { pattern: /\bimport\.meta\.filename\b/, since: "20.11.0", name: "import.meta.filename" },
];

function trackedJsFiles() {
  return execFileSync("git", ["ls-files", "*.js", "*.mjs", "*.jsx"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p && !p.includes("node_modules/"));
}

const declared = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).engines?.node;

describe("engines.node covers the APIs the code actually uses", () => {
  it("declares a floor at all", () => {
    expect(declared, "package.json must declare engines.node").toBeTruthy();
    expect(semver.validRange(declared), `engines.node ${declared} is not a valid range`).toBeTruthy();
  });

  // A scan that reads no files reports all-clear forever.
  it("finds files to scan", () => {
    expect(trackedJsFiles().length).toBeGreaterThan(100);
  });

  it.each(VERSION_GATED_APIS)("floor covers $name (since $since)", ({ pattern, since, name }) => {
    const users = trackedJsFiles().filter((rel) => pattern.test(readFileSync(join(repoRoot, rel), "utf8")));
    if (users.length === 0) return; // nothing uses it; nothing to require

    // The lowest version the declared range admits must still provide the API.
    const lowest = semver.minVersion(declared);
    expect(
      semver.gte(lowest, since),
      `${users.length} file(s) use ${name}, which needs Node >= ${since}, but engines.node ` +
        `"${declared}" admits ${lowest.version}. Either raise the floor or stop using ${name}.\n` +
        users
          .slice(0, 6)
          .map((u) => `  ${u}`)
          .join("\n"),
    ).toBe(true);
  });
});
