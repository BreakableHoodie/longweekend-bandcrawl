/**
 * Guard: every workspace must be installable from its own manifest.
 *
 * THE BUG THIS CATCHES (found 2026-09-04, workers-mcp-server):
 * `package.json` declared `"workers-mcp": "^0.1.0"`. No such version was ever
 * published -- npm has 0.0.10-0.0.13 and four 0.1.0-N PRERELEASES, and a caret
 * range does not match a prerelease. So `npm install` in that directory failed
 * outright with ETARGET, and there was no lockfile to fall back on.
 *
 * That directory holds a DEPLOYED Cloudflare Worker bound to the production D1
 * database. Its own wrangler.toml header records that the Worker once had to be
 * reconstructed from Cloudflare's stored settings because no source existed in
 * any repository. The unbuildable manifest was that same failure returning in a
 * new form: the source existed, and still could not produce the artifact.
 *
 * Nothing caught it because the machine that deployed it had a working
 * node_modules from an earlier, different install. A stale tree on one laptop
 * is not a build.
 *
 * Two properties, both offline (`make gate` must stay fast and network-free):
 *   1. every manifest declaring dependencies has a lockfile beside it, and
 *   2. the lockfile actually SATISFIES the manifest's ranges -- which is the
 *      half that fails on `^0.1.0` vs `0.0.13`.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function trackedManifests() {
  const out = execFileSync("git", ["ls-files", "*package.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // Same trap as enginesFloor.test.js: `git ls-files` lists TRACKED files,
  // including ones deleted from the working tree but not yet staged. Reading
  // one throws ENOENT and fails the gate for a reason unrelated to the check.
  return out
    .split("\n")
    .filter((p) => p && !p.includes("node_modules/"))
    .filter((p) => existsSync(join(repoRoot, p)));
}

const manifests = trackedManifests();

describe("every workspace is installable from its own manifest", () => {
  // A scan that finds nothing reports "all clear" forever. The repo has three
  // workspaces; if that changes this number is meant to be updated deliberately,
  // not to silently shrink to zero.
  it("finds the workspaces it is meant to scan", () => {
    expect(manifests.length).toBeGreaterThanOrEqual(3);
    expect(manifests).toContain("workers-mcp-server/package.json");
  });

  // npm reads project config from the CURRENT directory and does NOT walk up to
  // a parent, so a root .npmrc protects only the root. When min-release-age was
  // first added it went into the two .npmrc files that already existed, leaving
  // workers-mcp-server -- the workspace holding a DEPLOYED Worker with production
  // DB credentials -- resolving new versions with no cooldown at all.
  //
  // The Semgrep rule that prompted the setting could not have caught this: it
  // flags an .npmrc whose value is missing or too low, and that directory had no
  // .npmrc to flag. A rule reports on files that exist; absence is invisible to
  // it. Hence a test that iterates WORKSPACES rather than config files.
  // Pins the semantics the check above depends on. Without this, someone
  // "fixing" a prerelease mismatch by adding includePrerelease would get a green
  // suite and a guard that no longer guards.
  it("treats a prerelease as NOT satisfying a caret range, exactly as npm does", () => {
    expect(semver.satisfies("0.1.0-3", "^0.1.0")).toBe(false);
    expect(semver.satisfies("0.0.13", "^0.1.0")).toBe(false);
    expect(semver.satisfies("0.0.13", "0.0.13")).toBe(true);
  });

  it.each(manifests)("%s sets a package-adoption cooldown", (relative) => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, relative), "utf8"));
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    if (Object.keys(declared).length === 0) return;

    const npmrcPath = join(dirname(join(repoRoot, relative)), ".npmrc");
    expect(
      existsSync(npmrcPath),
      `${relative} installs packages but has no .npmrc — npm does not inherit the root one`,
    ).toBe(true);

    // Ask npm for its EFFECTIVE value rather than regexing the file. Parsing
    // was wrong twice over, and the second way was silent:
    //   - `min-release-age=7days` matched a `(\d+)` prefix and read as 7.
    //   - With `7` on one line and `0` on a later one, npm honours the LAST
    //     assignment (verified: it reports 0) while a first-match regex reads 7.
    //     The guard would pass while no cooldown was in effect at all.
    // `npm config get`, run in the workspace, is the same resolution npm uses to
    // install, so it cannot disagree with it.
    const effective = execFileSync("npm", ["config", "get", "min-release-age"], {
      cwd: dirname(join(repoRoot, relative)),
      encoding: "utf8",
    }).trim();

    expect(
      /^\d+$/.test(effective),
      `${npmrcPath}: npm resolves min-release-age to ${JSON.stringify(effective)}, not a number`,
    ).toBe(true);
    expect(Number(effective), `${npmrcPath}: min-release-age must be at least 7 days`).toBeGreaterThanOrEqual(7);
  });

  it.each(manifests)("%s has a lockfile and the lockfile satisfies it", (relative) => {
    const manifestPath = join(repoRoot, relative);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    if (Object.keys(declared).length === 0) return;

    const lockPath = join(dirname(manifestPath), "package-lock.json");
    expect(existsSync(lockPath), `${relative} declares dependencies but has no package-lock.json`).toBe(true);

    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const packages = lock.packages ?? {};

    for (const [name, range] of Object.entries(declared)) {
      // Only plain semver ranges are checkable offline. A git/file/npm-alias
      // spec is skipped deliberately rather than guessed at.
      if (!semver.validRange(range)) continue;

      const entry = packages[`node_modules/${name}`];
      expect(entry, `${relative}: ${name} is declared but absent from the lockfile`).toBeDefined();

      // NO includePrerelease. npm excludes prereleases from a range by default,
      // and that default IS the bug: `^0.1.0` does not match `0.1.0-3`, which is
      // why `npm install` returned ETARGET. Passing the flag makes this guard
      // agree with a resolver npm is not using, so a lockfile pinning a
      // prerelease against a caret range would sail through the very check
      // written to catch it. Caught in review on #1109.
      expect(
        semver.satisfies(entry.version, range),
        `${relative}: declared ${name}@${range} but the lockfile pins ${entry.version} — ` +
          `a fresh 'npm install' cannot reproduce this tree`,
      ).toBe(true);
    }
  });
});
