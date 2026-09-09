/**
 * Guard: a URL path segment is treated as an id only in its canonical spelling.
 *
 * THE BUG (#1120). Three band routes decided "id or slug?" with
 * `!isNaN(x) && parseInt(x) > 0`, which accepts values that then resolve to a
 * record the URL does not name:
 *
 *   "1.9"  -> parseInt 1   band 1
 *   "1e2"  -> parseInt 1   band 1, though Number("1e2") is 100
 *   "0x10" -> parseInt 16  band 16, from a hex string
 *
 * On these routes a non-numeric segment falls through to a NAME lookup, so the
 * failure is silent: /api/bands/0x10 returns band 16 rather than 404. Two URLs
 * for one record is a canonical-URL problem in a repo that maintains 301s for
 * exactly that reason (#983).
 *
 * `validateId` does NOT close this — it coerces with Number() and accepts both
 * exotic forms. That is correct for ITS job (validating something already meant
 * to be an id) and wrong for this one (choosing between two readings of a path
 * segment). The two are deliberately separate; this file asserts the difference
 * so nobody "simplifies" one into the other.
 */
import { describe, expect, it } from "vitest";
import { isCanonicalPositiveId, validateId } from "../validation/ids.js";

describe("isCanonicalPositiveId", () => {
  it.each(["1", "42", "206", "9007199254740991"])("accepts the canonical form %s", (v) => {
    expect(isCanonicalPositiveId(v)).toBe(true);
  });

  it.each([
    ["a decimal", "1.9"],
    ["exponent notation", "1e2"],
    ["hex", "0x10"],
    ["a leading zero", "01"],
    ["surrounding whitespace", " 1 "],
    ["an explicit plus", "+1"],
    ["a trailing .0", "1.0"],
    ["zero", "0"],
    ["a negative", "-1"],
    ["empty", ""],
    ["a slug", "some-band"],
    ["beyond safe integer range", "9007199254740993"],
  ])("rejects %s", (_label, v) => {
    expect(isCanonicalPositiveId(v)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [[]]])("rejects the non-string %s", (v) => {
    expect(isCanonicalPositiveId(v)).toBe(false);
  });

  // The reason this helper exists rather than reusing validateId. If these ever
  // agree, one of them has been changed and a route is silently resolving hex.
  it("is STRICTER than validateId, which accepts the exotic forms", () => {
    for (const v of ["1e2", "0x10"]) {
      expect(validateId(v).valid, `validateId should still accept ${v}`).toBe(true);
      expect(isCanonicalPositiveId(v), `isCanonicalPositiveId must reject ${v}`).toBe(false);
    }
    // And they agree on the ordinary case.
    expect(validateId("42").valid).toBe(true);
    expect(isCanonicalPositiveId("42")).toBe(true);
  });
});
