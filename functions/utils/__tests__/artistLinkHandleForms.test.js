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
const MATRIX = {
  bandcamp: ["https://femto519.bandcamp.com/", "femto519", "femto519.bandcamp.com", "https://femto519.bandcamp.com"],
  instagram: ["https://instagram.com/femto519", "femto519", "instagram.com/femto519", "https://instagram.com/femto519"],
  facebook: ["https://facebook.com/femto519", "femto519", "facebook.com/femto519", "https://facebook.com/femto519"],
  linktree: ["https://linktr.ee/femto519", "femto519", "linktr.ee/femto519", "https://linktr.ee/femto519"],
  youtube: ["https://youtube.com/@femto519", "@femto519", "youtube.com/@femto519", "https://youtube.com/@femto519"],
};

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
