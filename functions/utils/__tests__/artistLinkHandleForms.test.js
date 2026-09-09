/**
 * Every artist link field accepts every form of the same link (#1064).
 *
 * #1066 built handle support and it was RIGHT for four of five fields. Bandcamp
 * was wrong, for a structural reason worth stating: the other four put the
 * handle in a PATH, so `linktr.ee/femto519` contains a slash and the existing
 * slash rule already reads it as a URL. Bandcamp is the only SUBDOMAIN platform,
 * so `femto519.bandcamp.com` arrives with no slash, was read as a handle, and
 * was expanded a second time into
 *
 *     https://femto519.bandcamp.com.bandcamp.com/
 *
 * stored silently, no error, a dead link — the exact class #1066 existed to kill.
 *
 * The matrix below is per FIELD × per FORM because a single-field test cannot
 * show that the forms agree, and agreeing is the whole feature: whatever the
 * owner types, the same link comes out.
 */
import { describe, expect, it } from "vitest";
import { sanitizeBandSocialLinks } from "../validation/urls.js";

const one = (field, value) => JSON.parse(sanitizeBandSocialLinks({ [field]: value }))[field];

// field -> [expected canonical URL, ...every input form that must produce it]
//
// The `?utm_source=` forms are here because a link pasted out of a browser
// carries tracking parameters far more often than not, and the bare-host form
// is exactly the one this feature is telling owners they may use. Bandcamp was
// the live defect: the host was split on "/" alone, so `?utm_source=x` stayed
// glued to the host, matched no domain, fell through to the handle path and was
// REJECTED -- while the identical string with `https://` in front was accepted
// and had the parameter stripped. Same link, two answers.
const MATRIX = {
  bandcamp: [
    "https://femto519.bandcamp.com/",
    "femto519",
    "femto519.bandcamp.com",
    "https://femto519.bandcamp.com",
    "femto519.bandcamp.com?utm_source=x",
    "https://femto519.bandcamp.com?utm_source=x",
  ],
  instagram: [
    "https://instagram.com/femto519",
    "femto519",
    "instagram.com/femto519",
    "https://instagram.com/femto519",
    "instagram.com/femto519?utm_source=x",
  ],
  facebook: [
    "https://facebook.com/femto519",
    "femto519",
    "facebook.com/femto519",
    "https://facebook.com/femto519",
    "facebook.com/femto519?utm_source=x",
  ],
  linktree: [
    "https://linktr.ee/femto519",
    "femto519",
    "linktr.ee/femto519",
    "https://linktr.ee/femto519",
    "linktr.ee/femto519?utm_source=x",
  ],
  youtube: [
    "https://youtube.com/@femto519",
    "@femto519",
    "youtube.com/@femto519",
    "https://youtube.com/@femto519",
    "youtube.com/@femto519?utm_source=x",
  ],
};

describe('the "looks like a URL" check reads the host, not the query', () => {
  // Sibling of the host-split bug above, found by sweeping the class rather
  // than reported. The check requires a dot so a bare word is not silently
  // turned into a URL -- but it split on "/" alone, so a dot anywhere after
  // "?" or "#" satisfied it. `nodot?a=b.c` therefore became
  // `https://nodot/?a=b.c`: a dead link written with no error, which is the
  // exact outcome the check exists to prevent.
  it.each(["nodot?a=b.c", "nodot#x.y", "nodot"])("website: %s is rejected", (input) => {
    expect(() => sanitizeBandSocialLinks({ website: input })).toThrow();
  });

  it.each(["example.com?utm_source=x", "example.com#x"])("website: %s still passes", (input) => {
    expect(one("website", input)).toMatch(/^https:\/\/example\.com\//);
  });
});

describe("a bare host keeps its own fragment rather than being rejected", () => {
  // A fragment is part of the resource, not tracking, so unlike `?utm_source=`
  // it survives normalisation -- which is why it cannot sit in MATRIX above.
  // It still has to be READ as a host: before the fix, `#` stayed in the host
  // string and the value was rejected outright.
  it("bandcamp: femto519.bandcamp.com#music", () => {
    expect(one("bandcamp", "femto519.bandcamp.com#music")).toBe("https://femto519.bandcamp.com/#music");
  });
});

describe("artist link fields accept handle, bare domain, and full URL alike", () => {
  for (const [field, [expected, ...forms]] of Object.entries(MATRIX)) {
    it.each(forms)(`${field}: %s resolves to the same canonical URL`, (input) => {
      expect(one(field, input)).toBe(expected);
    });
  }

  // The bug, asserted directly rather than only via the matrix, so a failure
  // names it.
  it("never appends a platform domain twice", () => {
    for (const [field, [, ...forms]] of Object.entries(MATRIX)) {
      for (const input of forms) {
        const out = one(field, input) ?? "";
        for (const domain of ["bandcamp.com", "instagram.com", "facebook.com", "linktr.ee", "youtube.com"]) {
          const count = out.split(domain).length - 1;
          expect(count, `${field} "${input}" -> ${out} repeats ${domain}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  // The constraint the fix had to preserve. Handles here routinely contain dots
  // -- this site's own Instagram handle is `settimes.ca` -- so the own-domain
  // check matches on the HOST, never on "contains a dot". A dot rule would turn
  // this into https://settimes.ca/, which is the bug #1066 fixed.
  it("still treats a dotted handle as a handle, not a domain", () => {
    expect(one("instagram", "settimes.ca")).toBe("https://instagram.com/settimes.ca");
  });

  // Spotify and Apple Music deliberately have NO handle form: their URLs carry
  // opaque ids, so there is nothing to expand and inventing one would fabricate
  // a link. A bare handle must be REJECTED, never mangled.
  it.each(["spotify", "apple_music"])("%s rejects a bare handle rather than inventing a URL", (field) => {
    expect(() => sanitizeBandSocialLinks({ [field]: "femto519" })).toThrow();
  });
});
