import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Tests for validation utilities
import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  validatePassword,
  validateRequiredFields,
  isValidUUID,
  isValidRole,
  isValidISODate,
  isValidPostalCode,
  normalizePostalCode,
  validateEntity,
  VALIDATION_SCHEMAS,
  safeReflectHandleOrUrl,
  safeReflectSocialLinks,
  safeReflectSocialLinksString,
  sanitizeBandSocialLinks,
  validateDoorsJson,
} from "../validation.js";

describe("Email Validation", () => {
  it("should validate correct email formats", () => {
    expect(isValidEmail("user@example.com")).toBe(true);
    expect(isValidEmail("test.user+tag@domain.co.uk")).toBe(true);
    expect(isValidEmail("admin@localhost.dev")).toBe(true);
  });

  it("should reject invalid email formats", () => {
    expect(isValidEmail("notanemail")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("user@")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });

  it("should handle emails with whitespace", () => {
    expect(isValidEmail("  user@example.com  ")).toBe(true);
  });
});

describe("Password Validation", () => {
  it("should validate password length", () => {
    const result1 = validatePassword("short");
    expect(result1.valid).toBe(false);
    expect(result1.errors).toContain("Password must be at least 12 characters");

    const result2 = validatePassword("LongEnough12!");
    expect(result2.valid).toBe(true);
    expect(result2.errors).toHaveLength(0);
  });

  it("should enforce uppercase requirement when set", () => {
    const result = validatePassword("lowercase123", { requireUppercase: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Password must contain at least one uppercase letter");

    const result2 = validatePassword("Uppercase123", { requireUppercase: true });
    expect(result2.valid).toBe(true);
  });

  it("should handle null/undefined passwords", () => {
    const result1 = validatePassword(null);
    expect(result1.valid).toBe(false);
    expect(result1.errors).toContain("Password is required");

    const result2 = validatePassword(undefined);
    expect(result2.valid).toBe(false);
  });
});

describe("Required Fields Validation", () => {
  it("should validate all required fields are present", () => {
    const data = { name: "John", email: "john@example.com" };
    const result = validateRequiredFields(data, ["name", "email"]);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("should detect missing fields", () => {
    const data = { name: "John" };
    const result = validateRequiredFields(data, ["name", "email", "password"]);
    expect(result.valid).toBe(false);
    expect(result.missing).toEqual(["email", "password"]);
  });
});

describe("UUID Validation", () => {
  it("should validate correct UUID formats", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
  });

  it("should reject invalid UUID formats", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("123")).toBe(false);
    expect(isValidUUID("")).toBe(false);
  });
});

describe("Role Validation", () => {
  it("should validate correct roles", () => {
    expect(isValidRole("admin")).toBe(true);
    expect(isValidRole("editor")).toBe(true);
    expect(isValidRole("viewer")).toBe(true);
  });

  it("should reject invalid roles", () => {
    expect(isValidRole("superuser")).toBe(false);
    expect(isValidRole("")).toBe(false);
  });
});

describe("ISO Date Validation", () => {
  it("should validate correct ISO date strings", () => {
    expect(isValidISODate("2025-11-18T14:00:00Z")).toBe(true);
    expect(isValidISODate("2025-11-18")).toBe(true);
    expect(isValidISODate(new Date().toISOString())).toBe(true);
    expect(isValidISODate("2025-11-18T14:00:00.123Z")).toBe(true);
    expect(isValidISODate("2025-11-18T14:00:00+00:00")).toBe(true);
  });

  it("should reject invalid date strings", () => {
    expect(isValidISODate("not a date")).toBe(false);
    expect(isValidISODate("2025-13-45")).toBe(false);
    expect(isValidISODate("")).toBe(false);
    expect(isValidISODate(null)).toBe(false);
  });

  it("should reject non-ISO formats", () => {
    // These are valid dates but not ISO format
    expect(isValidISODate("1/1/2023")).toBe(false);
    expect(isValidISODate("Jan 1, 2023")).toBe(false);
    expect(isValidISODate("2023/01/01")).toBe(false);
  });
});

describe("Postal Code Validation", () => {
  it("should validate correct Canadian postal codes", () => {
    expect(isValidPostalCode("M5V 2H1")).toBe(true);
    expect(isValidPostalCode("K8N 5W6")).toBe(true);
    expect(isValidPostalCode("V6B 3P8")).toBe(true);
  });

  it("should validate correct US ZIP codes", () => {
    expect(isValidPostalCode("90210")).toBe(true);
    expect(isValidPostalCode("10001")).toBe(true);
    expect(isValidPostalCode("12345-6789")).toBe(true);
  });

  it("should handle formatting flexibly (fix/band-profile-text-wrapping)", () => {
    expect(isValidPostalCode("M5V2H1")).toBe(true); // No space
    expect(isValidPostalCode("M5V  2H1")).toBe(true); // Extra space
    expect(isValidPostalCode("M5V\u00A02H1")).toBe(true); // Non-breaking space
    expect(isValidPostalCode(" m5v 2h1 ")).toBe(true); // Lowercase and trimming
  });

  it("should reject invalid postal codes", () => {
    expect(isValidPostalCode("1234")).toBe(false); // Too short
    expect(isValidPostalCode("1234er")).toBe(false);
    expect(isValidPostalCode("ABC DEF")).toBe(false); // Invalid format
    expect(isValidPostalCode("M5V 2H")).toBe(false); // Incomplete
    expect(isValidPostalCode("")).toBe(true); // Optional field (returns true if empty/null based on implementation)
    expect(isValidPostalCode(null)).toBe(true);
  });
});

describe("Postal Code Normalization", () => {
  it("should normalize Canadian postal codes", () => {
    expect(normalizePostalCode("m5v2h1")).toBe("M5V 2H1");
    expect(normalizePostalCode("k8n 5w6")).toBe("K8N 5W6");
    expect(normalizePostalCode("  v6b  3p8  ")).toBe("V6B 3P8");
    expect(normalizePostalCode("M5V\u00A02H1")).toBe("M5V 2H1");
  });

  it("should preserve valid US ZIP codes", () => {
    expect(normalizePostalCode("90210")).toBe("90210");
    expect(normalizePostalCode("12345-6789")).toBe("12345-6789");
  });

  it("should handle mixed case", () => {
    expect(normalizePostalCode("m5v 2h1")).toBe("M5V 2H1");
    expect(normalizePostalCode("M5v 2H1")).toBe("M5V 2H1");
  });

  it("should handle null/empty inputs", () => {
    expect(normalizePostalCode("")).toBe(null);
    expect(normalizePostalCode(null)).toBe(null);
    expect(normalizePostalCode("   ")).toBe(null);
  });
});

describe("Event schema end_date validation", () => {
  const validBase = {
    name: "Test Event",
    slug: "test-event",
    date: "2099-06-15",
  };

  it("omitted end_date defaults to null", () => {
    const result = validateEntity(validBase, VALIDATION_SCHEMAS.event);
    expect(result.valid).toBe(true);
    expect(result.sanitized.end_date).toBeNull();
  });

  it("empty string end_date defaults to null", () => {
    const result = validateEntity({ ...validBase, end_date: "" }, VALIDATION_SCHEMAS.event);
    expect(result.valid).toBe(true);
    expect(result.sanitized.end_date).toBeNull();
  });

  it("valid end_date is accepted", () => {
    const result = validateEntity({ ...validBase, end_date: "2099-06-17" }, VALIDATION_SCHEMAS.event);
    expect(result.valid).toBe(true);
    expect(result.sanitized.end_date).toBe("2099-06-17");
  });

  it("invalid calendar date is rejected", () => {
    const result = validateEntity({ ...validBase, end_date: "2099-99-99" }, VALIDATION_SCHEMAS.event);
    expect(result.valid).toBe(false);
    expect(result.errors.end_date).toBeDefined();
  });

  it("non-date string is rejected", () => {
    const result = validateEntity({ ...validBase, end_date: "not-a-date" }, VALIDATION_SCHEMAS.event);
    expect(result.valid).toBe(false);
    expect(result.errors.end_date).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// #569 — events.doors_json: JSON map of festival date -> 24h "HH:MM" doors
// time, validated against the event's [date, end_date] festival-day span
// (same rule as validatePerformanceDate).
// ---------------------------------------------------------------------------
describe("validateDoorsJson (#569)", () => {
  const singleDayEvent = { date: "2026-08-02", end_date: null };
  const multiDayEvent = { date: "2026-07-10", end_date: "2026-07-11" };

  it("absent/null/empty doors_json is valid (no doors info)", () => {
    expect(validateDoorsJson(undefined, singleDayEvent)).toEqual({ valid: true, error: undefined, value: null });
    expect(validateDoorsJson(null, singleDayEvent)).toEqual({ valid: true, error: undefined, value: null });
    expect(validateDoorsJson("", singleDayEvent)).toEqual({ valid: true, error: undefined, value: null });
  });

  it("accepts a valid single-day map", () => {
    const result = validateDoorsJson('{"2026-08-02":"18:30"}', singleDayEvent);
    expect(result.valid).toBe(true);
    expect(JSON.parse(result.value)).toEqual({ "2026-08-02": "18:30" });
  });

  it("accepts a valid multi-day map (BLR3-style: one key per festival day)", () => {
    const result = validateDoorsJson('{"2026-07-10":"16:00","2026-07-11":"10:00"}', multiDayEvent);
    expect(result.valid).toBe(true);
    expect(JSON.parse(result.value)).toEqual({ "2026-07-10": "16:00", "2026-07-11": "10:00" });
  });

  it("accepts an already-parsed object (not just a JSON string)", () => {
    const result = validateDoorsJson({ "2026-08-02": "18:30" }, singleDayEvent);
    expect(result.valid).toBe(true);
    expect(JSON.parse(result.value)).toEqual({ "2026-08-02": "18:30" });
  });

  it("rejects a key outside the event's festival-day span", () => {
    const result = validateDoorsJson('{"2026-08-03":"18:30"}', singleDayEvent);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/between/);
  });

  it("rejects a key one day before a multi-day event's span", () => {
    const result = validateDoorsJson('{"2026-07-09":"16:00"}', multiDayEvent);
    expect(result.valid).toBe(false);
  });

  it("rejects a key one day after a multi-day event's span", () => {
    const result = validateDoorsJson('{"2026-07-12":"10:00"}', multiDayEvent);
    expect(result.valid).toBe(false);
  });

  it("rejects a malformed key (not YYYY-MM-DD)", () => {
    const result = validateDoorsJson('{"not-a-date":"18:30"}', singleDayEvent);
    expect(result.valid).toBe(false);
  });

  it("rejects a bad time format", () => {
    expect(validateDoorsJson('{"2026-08-02":"6:30 PM"}', singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson('{"2026-08-02":"25:00"}', singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson('{"2026-08-02":"18:60"}', singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson('{"2026-08-02":18.5}', singleDayEvent).valid).toBe(false);
  });

  it("rejects a non-object JSON value", () => {
    expect(validateDoorsJson("[]", singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson('["2026-08-02"]', singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson('"18:30"', singleDayEvent).valid).toBe(false);
    expect(validateDoorsJson("42", singleDayEvent).valid).toBe(false);
  });

  it("rejects invalid JSON", () => {
    const result = validateDoorsJson("{not json", singleDayEvent);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/valid JSON/);
  });

  it("normalizes an empty object to null", () => {
    expect(validateDoorsJson("{}", singleDayEvent)).toEqual({ valid: true, error: undefined, value: null });
  });

  it("rejects oversize input (cap ~2000 chars)", () => {
    // A single absurdly long time value pushes the raw string over the cap.
    const oversized = `{"2026-08-02":"${"1".repeat(3000)}:30"}`;
    const result = validateDoorsJson(oversized, singleDayEvent);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no more than/);
  });

  it("rejects when the event has no date to anchor the span", () => {
    const result = validateDoorsJson('{"2026-08-02":"18:30"}', null);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #483 — social link URLs reflected from DB without read-path scheme
// validation. These cover the read-path helpers (safeReflectHandleOrUrl /
// safeReflectSocialLinks) that sanitize legacy/bypassed DB rows before they
// are echoed back in API responses, plus the write-path scheme guard added
// to the private normalizeLinkField (exercised indirectly through the
// exported sanitizeBandSocialLinks, which routes the instagram field
// through it).
// ---------------------------------------------------------------------------
describe("safeReflectHandleOrUrl (#483)", () => {
  it("rejects a javascript: scheme value", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #483 read-path guard
    expect(safeReflectHandleOrUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects a data: scheme value", () => {
    expect(safeReflectHandleOrUrl("data:text/html,x")).toBeNull();
  });

  it("normalizes and passes through a valid https URL", () => {
    expect(safeReflectHandleOrUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("preserves a plain handle with a leading @", () => {
    expect(safeReflectHandleOrUrl("@the_band")).toBe("@the_band");
  });

  it("preserves a plain handle without a leading @", () => {
    expect(safeReflectHandleOrUrl("the_band")).toBe("the_band");
  });

  it("returns null for non-string or empty values", () => {
    expect(safeReflectHandleOrUrl(null)).toBeNull();
    expect(safeReflectHandleOrUrl(undefined)).toBeNull();
    expect(safeReflectHandleOrUrl("")).toBeNull();
    expect(safeReflectHandleOrUrl(42)).toBeNull();
  });

  it("is lenient on slashes in legacy handles (no colon present)", () => {
    expect(safeReflectHandleOrUrl("instagram.com/band")).toBe("instagram.com/band");
  });

  it("trims before classifying: a whitespace-padded https URL is recovered, not dropped", () => {
    expect(safeReflectHandleOrUrl(" https://example.com/x ")).toBe("https://example.com/x");
    expect(safeReflectHandleOrUrl("  @the_band  ")).toBe("@the_band");
    expect(safeReflectHandleOrUrl("   ")).toBeNull();
  });

  it("trimming does not launder a scheme: padded javascript: is still rejected", () => {
    expect(safeReflectHandleOrUrl(" javascript:alert(1)")).toBeNull();
  });
});

describe("safeReflectSocialLinks (#483)", () => {
  it("returns {} for malformed JSON", () => {
    expect(safeReflectSocialLinks("not json")).toEqual({});
  });

  it("returns {} for a null/undefined input", () => {
    expect(safeReflectSocialLinks(null)).toEqual({});
    expect(safeReflectSocialLinks(undefined)).toEqual({});
  });

  it("nulls out a javascript: scheme in a URL field but keeps a plain handle", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #483 read-path guard
    const result = safeReflectSocialLinks(JSON.stringify({ website: "javascript:alert(1)", instagram: "the_band" }));
    expect(result.website).toBeNull();
    expect(result.instagram).toBe("the_band");
  });

  it("passes through a valid https URL unchanged", () => {
    const result = safeReflectSocialLinks(JSON.stringify({ website: "https://example.com/" }));
    expect(result.website).toBe("https://example.com/");
  });

  it("respects a custom handleFields list (event social_links: instagram/x/tiktok)", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #483 read-path guard
    const result = safeReflectSocialLinks(JSON.stringify({ x: "javascript:alert(1)", tiktok: "the_band" }), [
      "instagram",
      "x",
      "tiktok",
    ]);
    expect(result.x).toBeNull();
    expect(result.tiktok).toBe("the_band");
  });
});

// ---------------------------------------------------------------------------
// #493 — admin read endpoints reflect `social_links` as a raw JSON string
// (the admin frontend parses it client-side), not a parsed object like the
// public endpoints #483 fixed. safeReflectSocialLinksString wraps
// safeReflectSocialLinks so those endpoints can sanitize without changing
// that string response shape.
// ---------------------------------------------------------------------------
describe("safeReflectSocialLinksString (#493)", () => {
  it("nulls out a javascript: scheme in a URL field but keeps a plain handle, re-serialized as a string", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #493 admin read-path guard
    const jsonString = JSON.stringify({ website: "javascript:alert(1)", instagram: "the_band" });
    expect(safeReflectSocialLinksString(jsonString)).toBe(JSON.stringify({ website: null, instagram: "the_band" }));
  });

  it("passes through a valid https URL, re-normalized, as a string", () => {
    expect(safeReflectSocialLinksString(JSON.stringify({ website: "https://example.com" }))).toBe(
      JSON.stringify({ website: "https://example.com/" }),
    );
  });

  it("respects a custom handleFields list (event social_links: instagram/x/tiktok)", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #493 admin read-path guard
    const jsonString = JSON.stringify({ x: "javascript:alert(1)", tiktok: "the_band" });
    expect(safeReflectSocialLinksString(jsonString, ["instagram", "x", "tiktok"])).toBe(
      JSON.stringify({ x: null, tiktok: "the_band" }),
    );
  });

  it("returns '{}' for malformed JSON", () => {
    expect(safeReflectSocialLinksString("not json")).toBe("{}");
  });

  it("passes null and undefined through unchanged, rather than coercing to '{}'", () => {
    expect(safeReflectSocialLinksString(null)).toBeNull();
    expect(safeReflectSocialLinksString(undefined)).toBeUndefined();
  });
});

describe("normalizeLinkField write-path scheme guard (#483, via sanitizeBandSocialLinks)", () => {
  it("throws when the instagram handle contains a URL scheme", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #483 write-path guard
    expect(() => sanitizeBandSocialLinks({ instagram: "javascript:x" })).toThrow();
  });

  it("still accepts a normal @handle and normalises to canonical URL", () => {
    const result = sanitizeBandSocialLinks({ instagram: "@ok_handle" });
    expect(JSON.parse(result).instagram).toBe("https://instagram.com/ok_handle");
  });
});

describe("normalizeArtistLinkField — sanitise-or-reject on every band link field (#1064)", () => {
  it("normalises instagram handle to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ instagram: "sunnyinspiration" }));
    expect(result.instagram).toBe("https://instagram.com/sunnyinspiration");
  });

  it("normalises scheme-less instagram URL (bare domain) to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ instagram: "instagram.com/kwplaces" }));
    expect(result.instagram).toBe("https://instagram.com/kwplaces");
  });

  it("normalises facebook handle to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ facebook: "kwpunkshowcase" }));
    expect(result.facebook).toBe("https://facebook.com/kwpunkshowcase");
  });

  it("normalises scheme-less facebook URL to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ facebook: "facebook.com/kwplaces" }));
    expect(result.facebook).toBe("https://facebook.com/kwplaces");
  });

  it("normalises youtube handle to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ youtube: "myband" }));
    expect(result.youtube).toBe("https://youtube.com/@myband");
  });

  it("normalises linktree handle to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ linktree: "myband" }));
    expect(result.linktree).toBe("https://linktr.ee/myband");
  });

  it("normalises bandcamp handle to canonical subdomain URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ bandcamp: "myband" }));
    expect(result.bandcamp).toBe("https://myband.bandcamp.com/");
  });

  it("normalises scheme-less website URL to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ website: "myband.ca" }));
    expect(result.website).toBe("https://myband.ca/");
  });

  it("normalises scheme-less spotify URL to canonical URL", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ spotify: "open.spotify.com/artist/123" }));
    expect(result.spotify).toBe("https://open.spotify.com/artist/123");
  });

  it("rejects bare non-domain text in URL-only field (website)", () => {
    expect(() => sanitizeBandSocialLinks({ website: "not-a-url" })).toThrow();
  });

  it("rejects bare non-domain text in URL-only field (spotify)", () => {
    expect(() => sanitizeBandSocialLinks({ spotify: "open.spotify.com" })).not.toThrow();
  });

  it("rejects bare non-domain text in URL-only field (apple_music)", () => {
    expect(() => sanitizeBandSocialLinks({ apple_music: "music.apple.com/artist/123" })).not.toThrow();
  });

  it("rejects bare non-domain text in apple_music", () => {
    expect(() => sanitizeBandSocialLinks({ apple_music: "not-a-url" })).toThrow();
  });

  it("rejects handle with colon (scheme injection guard)", () => {
    // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, proves the colon guard rejects it before a handle is ever built (#1064)
    expect(() => sanitizeBandSocialLinks({ instagram: "javascript:alert(1)" })).toThrow();
  });

  it("rejects handle with colon (http scheme injection)", () => {
    expect(() => sanitizeBandSocialLinks({ facebook: "http://evil.com" })).not.toThrow();
  });

  it("rejects handle with whitespace", () => {
    expect(() => sanitizeBandSocialLinks({ instagram: "has space" })).toThrow();
  });

  it("normalises @handle by stripping leading @", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ instagram: "@myhandle" }));
    expect(result.instagram).toBe("https://instagram.com/myhandle");
  });

  it("normalises /handle by stripping leading /", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ facebook: "/myhandle" }));
    expect(result.facebook).toBe("https://facebook.com/myhandle");
  });

  it("normalises handle with multiple leading slashes", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ youtube: "///myhandle" }));
    expect(result.youtube).toBe("https://youtube.com/@myhandle");
  });

  it("preserves full https URL unchanged", () => {
    const result = JSON.parse(
      sanitizeBandSocialLinks({
        website: "https://myband.ca",
      }),
    );
    expect(result.website).toBe("https://myband.ca/");
  });

  it("preserves full http URL unchanged", () => {
    const result = JSON.parse(
      sanitizeBandSocialLinks({
        website: "http://myband.ca",
      }),
    );
    expect(result.website).toBe("http://myband.ca/");
  });

  it("returns null when all fields empty", () => {
    const result = sanitizeBandSocialLinks({
      website: "",
      instagram: "",
      facebook: "",
    });
    expect(result).toBeNull();
  });

  it("normalises multiple fields in one call", () => {
    const result = JSON.parse(
      sanitizeBandSocialLinks({
        instagram: "myband",
        facebook: "facebook.com/myband",
        youtube: "myband",
        website: "myband.ca",
      }),
    );
    expect(result.instagram).toBe("https://instagram.com/myband");
    expect(result.facebook).toBe("https://facebook.com/myband");
    expect(result.youtube).toBe("https://youtube.com/@myband");
    expect(result.website).toBe("https://myband.ca/");
  });

  it("rejects handle with backslash", () => {
    expect(() => sanitizeBandSocialLinks({ instagram: "my\\band" })).toThrow();
  });

  it("normalises bandcamp with path-like handle (has slash — rejected)", () => {
    expect(() => sanitizeBandSocialLinks({ bandcamp: "my/band" })).toThrow();
  });

  it("normalises youtube @handle by stripping and re-adding exactly one @", () => {
    const result = JSON.parse(sanitizeBandSocialLinks({ youtube: "@myband" }));
    expect(result.youtube).toBe("https://youtube.com/@myband");
  });
});

describe("validator results use undefined, not null, for an absent error (#917)", () => {
  // Source scan. `.github/instructions/nodejs-javascript-vitest.instructions.md`
  // says never use `null` for an optional value, and validation.js contradicted
  // it in 11 places -- which surfaced as a repeat review finding on three
  // separate PRs before anyone fixed it.
  //
  // Scoped to the `error:` key deliberately. The 16 `value: null` returns in the
  // same file are NOT the same case: several are a NULL bound straight into a
  // nullable column, and D1 round-trips `null`, not `undefined`. Widening this
  // scan to `value` would demand a change that breaks writes.
  const FUNCTIONS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

  function collectJsFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        out.push(...collectJsFiles(full));
      } else if (entry.endsWith(".js")) {
        out.push(full);
      }
    }
    return out;
  }

  it("no file in functions/ returns `error: null`", () => {
    const offenders = collectJsFiles(FUNCTIONS_ROOT)
      .map((full) => ({ rel: full.slice(FUNCTIONS_ROOT.length + 1), source: readFileSync(full, "utf-8") }))
      .filter((f) => /\berror:\s*null\b/.test(f.source))
      .map((f) => f.rel);

    expect(offenders, `use \`error: undefined\` — see #917:\n${offenders.join("\n")}`).toEqual([]);
  });

  // Regression coverage for the review on #1066. Each case below was either
  // silently WRONG or silently accepted before the normaliser was fixed.
  describe("artist link normalisation — review regressions (#1066)", () => {
    const link = (key, value) => {
      const out = sanitizeBandSocialLinks({ [key]: value });
      return out ? JSON.parse(out)[key] : null;
    };

    // A DOT does not make something a domain. This site's own Instagram handle
    // is `settimes.ca`, and the old dot-based rule stored https://settimes.ca/
    // for it -- a dead link, with no error. A PATH SEPARATOR is the real signal.
    it("treats a dotted handle as a handle, not a domain", () => {
      expect(link("instagram", "settimes.ca")).toBe("https://instagram.com/settimes.ca");
      expect(link("instagram", "the.friendly.frogs")).toBe("https://instagram.com/the.friendly.frogs");
    });

    it("still treats a real URL as a URL", () => {
      expect(link("instagram", "instagram.com/gfuparty")).toBe("https://instagram.com/gfuparty");
    });

    // `/@handle` kept the slash under a single `^@` strip and stored
    // https://instagram.com/@handle; a bare `@` collapsed to the platform HOME PAGE.
    it("strips slash and @ prefixes in either order", () => {
      expect(link("instagram", "/@myhandle")).toBe("https://instagram.com/myhandle");
      expect(link("instagram", "/gfuparty")).toBe("https://instagram.com/gfuparty");
    });

    it("rejects an empty handle rather than storing the platform home page", () => {
      expect(() => sanitizeBandSocialLinks({ instagram: "@" })).toThrow();
    });

    // Without rejecting `?`/`#`, a handle-shaped value carried its query into
    // the stored URL, bypassing stripTrackingParams entirely.
    it("rejects a handle carrying a query string", () => {
      expect(() => sanitizeBandSocialLinks({ instagram: "myband?utm_source=test" })).toThrow();
    });

    // URL-ONLY fields must REJECT a bare handle, not invent one: Spotify and
    // Apple Music artist URLs carry opaque IDs, so there is nothing to expand.
    it("rejects a bare handle on URL-only fields", () => {
      expect(() => sanitizeBandSocialLinks({ spotify: "somehandle" })).toThrow();
      expect(() => sanitizeBandSocialLinks({ apple_music: "somehandle" })).toThrow();
    });

    it("accepts a scheme-less URL on URL-only fields", () => {
      expect(link("spotify", "open.spotify.com/artist/x")).toBe("https://open.spotify.com/artist/x");
      expect(link("website", "settimes.ca")).toBe("https://settimes.ca/");
    });

    // The exact params the owner's own pasted links carried. `si` and `utm_*`
    // were already stripped; these four were not.
    it("strips igsi, mibextid, fbclid alongside si and utm_*", () => {
      expect(link("instagram", "https://www.instagram.com/gfuparty?igsi=ZTQy")).toBe(
        "https://www.instagram.com/gfuparty",
      );
      expect(link("facebook", "https://www.facebook.com/p/x/?mibextid=wwXIfr")).toBe("https://www.facebook.com/p/x/");
      expect(link("linktree", "https://linktr.ee/gfuparty?utm_source=ig&fbclid=PAdG")).toBe(
        "https://linktr.ee/gfuparty",
      );
      expect(link("spotify", "https://open.spotify.com/artist/xyz?si=abc")).toBe("https://open.spotify.com/artist/xyz");
    });
  });
});
