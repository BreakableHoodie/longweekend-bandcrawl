// A delivery-confirmation write must never be able to fail a delivered send.
//
// The shape: send the email, then record delivery. Those are two phases with no
// atomicity between them -- one is an external side effect, the other a D1
// write. If the confirmation write throws and the throw ESCAPES, the caller's
// Promise.allSettled tally counts a delivered email as FAILED, which invites
// the resend that turns a lost write into a duplicate (#1153).
//
// Three instances existed at once (#1152): bandFollowNotify.js, announceDigest.js
// and subscriberNotify.js. Two were found by a reviewer naming them, and the
// third only by sweeping for the class afterwards -- it had shipped in #1149.
// That is the argument for a scan rather than a repeat audit: nothing about
// writing an unguarded `await` at one of these call sites looks wrong locally.
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FUNCTIONS_DIR = new URL("../..", import.meta.url).pathname;
const CONFIRMATION_WRITE = "SET delivered_at";

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

// Walks backwards from `index` tracking brace depth. When the walk leaves the
// block that encloses the position, it reports whether that block opened with
// `try`. Comparing depth rather than searching for a nearby "try {" is what
// stops a try block that ENDED earlier in the function from counting.
function enclosedByTry(src, index) {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) {
        return /\btry\s*$/.test(src.slice(Math.max(0, i - 12), i));
      }
      depth--;
    }
  }
  return false;
}

describe("delivery-confirmation writes cannot fail a delivered send", () => {
  const files = sourceFiles(FUNCTIONS_DIR);
  const sites = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    let from = 0;
    for (;;) {
      const at = src.indexOf(CONFIRMATION_WRITE, from);
      if (at === -1) break;
      sites.push({ file, at, src });
      from = at + CONFIRMATION_WRITE.length;
    }
  }

  // A scan that matches nothing reports "all clear" forever. This is the same
  // failure as `lint-md` missing from .PHONY: green because it never looked.
  test("the scan still finds the writes it is meant to police", () => {
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  test.each(sites.map((s) => [s.file.replace(FUNCTIONS_DIR, ""), s]))(
    "%s guards its confirmation write with try/catch",
    (_label, site) => {
      expect(enclosedByTry(site.src, site.at)).toBe(true);
    },
  );

  // Proves the detector can return false -- otherwise every assertion above
  // passes vacuously and the guard is decoration.
  test("the detector reports an UNGUARDED write as unguarded", () => {
    const guarded = `async function f() { try { await DB.prepare("SET delivered_at"); } catch (e) {} }`;
    const bare = `async function f() { await DB.prepare("SET delivered_at"); }`;
    expect(enclosedByTry(guarded, guarded.indexOf(CONFIRMATION_WRITE))).toBe(true);
    expect(enclosedByTry(bare, bare.indexOf(CONFIRMATION_WRITE))).toBe(false);
  });
});
