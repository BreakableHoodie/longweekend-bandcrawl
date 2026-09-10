import { describe, expect, it } from "vitest";
import { sanitizeEventSocialLinks } from "../validation/urls.js";

/**
 * Every event link field accepts every form of the same link (#1132).
 *
 * The artist side got this in #1064/#1066. Events kept a SECOND, simpler
 * implementation that gave one concept three behaviours:
 *
 *   instagram/x/tiktok    accepted a handle, STORED IT RAW, and rejected
 *                         `instagram.com/foo` outright
 *   facebook/youtube/     demanded a full URL, so a handle was refused for a
 *   bandcamp/website      value the artist form accepts on the same screen
 *
 * The stored SHAPE differing is the part that matters beyond data entry: the
 * column held bare handles for three fields and URLs for the rest, so anything
 * reading it had to know which was which. Both sides now resolve through
 * `normalizeLinkField` and store one canonical URL.
 *
 * The matrix is per FIELD x per FORM because a single-field test cannot show
 * that the forms AGREE, and agreeing is the whole feature.
 */
const one = (field, value) => JSON.parse(sanitizeEventSocialLinks(JSON.stringify({ [field]: value })) ?? "{}")[field];

// field -> [expected canonical URL, ...every input form that must produce it]
const MATRIX = {
  instagram: [
    "https://instagram.com/buddiesfest",
    "buddiesfest",
    "instagram.com/buddiesfest",
    "https://instagram.com/buddiesfest",
    "instagram.com/buddiesfest?utm_source=x",
  ],
  facebook: [
    "https://facebook.com/buddiesfest",
    "buddiesfest",
    "facebook.com/buddiesfest",
    "https://facebook.com/buddiesfest",
  ],
  x: ["https://x.com/buddiesfest", "buddiesfest", "x.com/buddiesfest", "https://x.com/buddiesfest"],
  tiktok: [
    "https://tiktok.com/@buddiesfest",
    "@buddiesfest",
    "tiktok.com/@buddiesfest",
    "https://tiktok.com/@buddiesfest",
  ],
  youtube: [
    "https://youtube.com/@buddiesfest",
    "@buddiesfest",
    "youtube.com/@buddiesfest",
    "https://youtube.com/@buddiesfest",
  ],
  bandcamp: [
    "https://buddiesfest.bandcamp.com/",
    "buddiesfest",
    "buddiesfest.bandcamp.com",
    "https://buddiesfest.bandcamp.com",
  ],
};

describe("event link fields accept handle, bare domain, and full URL alike", () => {
  for (const [field, [expected, ...forms]] of Object.entries(MATRIX)) {
    it.each(forms)(`${field}: %s resolves to the same canonical URL`, (input) => {
      expect(one(field, input)).toBe(expected);
    });
  }
});

describe("a handle is STORED as a URL, not kept raw", () => {
  // The defect this replaces: instagram/x/tiktok stored the bare handle, so the
  // column carried two different kinds of value and every reader needed to
  // cope with both.
  it.each(["instagram", "x", "tiktok"])("%s stores a resolved URL", (field) => {
    expect(one(field, "buddiesfest")).toMatch(/^https:\/\//);
  });
});

describe("website has no platform to infer, so it is not invented", () => {
  it("accepts a bare domain", () => {
    expect(one("website", "buddiesfest.com")).toBe("https://buddiesfest.com/");
  });

  it("accepts a full URL", () => {
    expect(one("website", "https://buddiesfest.com")).toBe("https://buddiesfest.com/");
  });

  // No handleToUrl, so a bare word is refused rather than turned into a
  // guessed host -- the one field where handle semantics would be wrong.
  it("rejects a bare word rather than guessing a host", () => {
    expect(() => sanitizeEventSocialLinks(JSON.stringify({ website: "buddiesfest" }))).toThrow();
  });
});

describe("the #1066 dotted-handle behaviour still holds on events", () => {
  // A handle containing a dot must stay a handle. settimes.ca is this site's
  // own Instagram handle; a "contains a dot" rule would turn it into a domain.
  it("instagram: settimes.ca is a handle, not a domain", () => {
    expect(one("instagram", "settimes.ca")).toBe("https://instagram.com/settimes.ca");
  });

  // Bandcamp is the SUBDOMAIN platform, so its own domain must not be
  // double-suffixed into <handle>.bandcamp.com.bandcamp.com.
  it("bandcamp: its own domain is not suffixed twice", () => {
    expect(one("bandcamp", "buddiesfest.bandcamp.com")).toBe("https://buddiesfest.bandcamp.com/");
  });
});

describe("scheme injection is refused on every event field", () => {
  it.each(["instagram", "facebook", "x", "tiktok", "youtube", "bandcamp", "website"])(
    "%s rejects javascript:",
    (field) => {
      // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the #483 write-path guard
      expect(() => sanitizeEventSocialLinks(JSON.stringify({ [field]: "javascript:alert(1)" }))).toThrow();
    },
  );
});
