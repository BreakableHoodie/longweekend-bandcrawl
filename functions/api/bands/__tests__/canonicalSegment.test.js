/**
 * Route-level guard for #1120: a non-canonical numeric segment must NOT resolve
 * to a band id.
 *
 * The unit tests on `isCanonicalPositiveId` prove the predicate. They do not
 * prove these ROUTES call it — a route could keep the old
 * `!isNaN(x) && parseInt(x) > 0` and every predicate test would still pass. That
 * gap is the whole reason this file exists.
 *
 * The discriminating fixture is a hex spelling of an id that REALLY EXISTS. A
 * literal like "0x10" 404s under both the old and new parser when band 16 is
 * absent — old: parseInt gives 16 and there is no such row; new: it falls
 * through to the slug branch. Same status, opposite reasons, proving nothing.
 * Deriving the hex from a real id is what separates them: the old idiom answers
 * 200, the new one 404s.
 */
import { describe, expect, it } from "vitest";
import { onRequestGet as bandProfile } from "../[name].js";
import { onRequestGet as bandStats } from "../stats/[name].js";
import { createTestEnv, insertEvent, insertVenue, insertBand } from "../../test-utils.js";

function seed(bandName = "Real Band") {
  const { env, rawDb } = createTestEnv();
  env.PUBLIC_DATA_PUBLISH_ENABLED = "true";
  const event = insertEvent(rawDb, {
    name: "Canon Event",
    slug: `canon-${Math.random().toString(36).slice(2)}`,
    date: "2099-08-01",
  });
  rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(event.id);
  const venue = insertVenue(rawDb, { name: "Canon Venue" });
  const band = insertBand(rawDb, { name: bandName, event_id: event.id, venue_id: venue.id });
  return { env, bandProfileId: band.band_profile_id };
}

const routes = [
  ["/api/bands/{seg}", bandProfile, (seg) => `https://example.test/api/bands/${seg}`],
  ["/api/bands/stats/{seg}", bandStats, (seg) => `https://example.test/api/bands/stats/${seg}`],
];

describe.each(routes)("%s rejects non-canonical numeric segments (#1120)", (_label, handler, url) => {
  it("resolves the plain canonical id", async () => {
    const { env, bandProfileId } = seed();
    const res = await handler({ request: new Request(url(String(bandProfileId))), env, params: {} });
    expect(res.status).toBe(200);
  });

  it("does not resolve a hex spelling of a REAL id", async () => {
    const { env, bandProfileId } = seed();
    const hex = `0x${bandProfileId.toString(16)}`;
    // Guards the fixture itself: the old idiom really would have resolved this.
    expect(Number(hex)).toBe(bandProfileId);
    const res = await handler({ request: new Request(url(hex)), env, params: {} });
    expect(res.status, `${hex} must not resolve to band ${bandProfileId}`).toBe(404);
  });

  // These two assert the CONTRACT but do not discriminate on these routes:
  // measured under the reverted parser, "1.9" and "1e2" both still answer 404,
  // while the hex case above answers 200. So the hex test is what proves the
  // fix; these guard the stated behaviour without being the evidence for it.
  // Recorded so nobody reads three passing cases as three independent proofs.
  it.each(["1.9", "1e2"])("does not resolve %s to a numeric id", async (seg) => {
    const { env } = seed();
    const res = await handler({ request: new Request(url(seg)), env, params: {} });
    expect(res.status).toBe(404);
  });
});
