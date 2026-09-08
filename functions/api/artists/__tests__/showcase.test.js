import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestEnv, insertBand, insertEvent, insertVenue } from "../../test-utils";
import * as shuffle from "../shuffle.js";
import * as oneOfOne from "../one-of-one.js";

function seedEnv() {
  const { env, rawDb } = createTestEnv({ role: "editor" });
  env.PUBLIC_DATA_PUBLISH_ENABLED = "true";
  return { env, rawDb };
}

function publicEvent(rawDb, name, slug) {
  const event = insertEvent(rawDb, { name, slug, status: "published" });
  return event.id;
}

describe("artist showcase endpoints", () => {
  it("clamps shuffle limits, rejects junk, and excludes inactive artists", async () => {
    const { env, rawDb } = seedEnv();
    const eventId = publicEvent(rawDb, "Showcase", "showcase");
    const venue = insertVenue(rawDb, { name: "Showcase Venue" });
    insertBand(rawDb, { name: "Active One", event_id: eventId, venue_id: venue.id });
    const inactive = insertBand(rawDb, { name: "Inactive One", event_id: eventId, venue_id: venue.id });
    rawDb.prepare("UPDATE band_profiles SET is_active = 0 WHERE id = ?").run(inactive.band_profile_id);

    const oversized = await shuffle.onRequestGet({
      request: new Request("https://example.test/api/artists/shuffle?limit=999"),
      env,
    });
    const oversizedBody = await oversized.json();
    expect(oversized.status).toBe(200);
    expect(oversizedBody).toHaveLength(1);
    expect(oversizedBody[0].name).toBe("Active One");

    const junk = await shuffle.onRequestGet({
      request: new Request("https://example.test/api/artists/shuffle?limit=2.5"),
      env,
    });
    expect(junk.status).toBe(400);
  });

  it("weights never-viewed artists ahead of popular artists", async () => {
    const { env, rawDb } = seedEnv();
    const eventId = publicEvent(rawDb, "Weighting", "weighting");
    const venue = insertVenue(rawDb, { name: "Weighting Venue" });

    for (const name of ["Unseen One", "Unseen Two", "Unseen Three"]) {
      const band = insertBand(rawDb, { name, event_id: eventId, venue_id: venue.id });
      rawDb.prepare("UPDATE band_profiles SET total_views = 0 WHERE id = ?").run(band.band_profile_id);
    }
    for (const name of ["Popular One", "Popular Two", "Popular Three"]) {
      const band = insertBand(rawDb, { name, event_id: eventId, venue_id: venue.id });
      rawDb.prepare("UPDATE band_profiles SET total_views = 100 WHERE id = ?").run(band.band_profile_id);
    }

    let unseen = 0;
    let popular = 0;
    for (let draw = 0; draw < 100; draw += 1) {
      const res = await shuffle.onRequestGet({
        request: new Request("https://example.test/api/artists/shuffle?limit=1"),
        env,
      });
      const [artist] = await res.json();
      if (artist.name.startsWith("Unseen")) unseen += 1;
      if (artist.name.startsWith("Popular")) popular += 1;
    }

    expect(unseen).toBeGreaterThan(popular);
    expect(unseen).toBeGreaterThan(70);
  });

  // The behavioural test above catches the weighting being REMOVED (100 draws,
  // unseen must beat 70), but it cannot separate a correct 6:1 from a biased
  // 10:1 -- telling those apart needs thousands of draws and would be flaky.
  // So the algorithm is pinned by source scan, which is deterministic and is
  // how this repo guards its other one-canonical-form invariants.
  //
  // What this prevents: reverting to `ORDER BY RANDOM() / weight`, which looks
  // equivalent and is not. Measured over 300k single draws at weights 6/3/1 it
  // selects 69.3 / 23.7 / 7.0 where proportionality needs 60 / 30 / 10 -- an
  // effective ratio near 10:1 from a stated 6:1. U^(1/w) returns 60/30/10.
  it("draws with Efraimidis-Spirakis, not a plain random-over-weight sort", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "shuffle.js"), "utf8");

    // The scan must be able to find what it hunts, or it reports all-clear forever.
    expect(source).toContain("ORDER BY");

    expect(source, "shuffle must raise U to the 1/weight power (Efraimidis-Spirakis)").toMatch(/ORDER BY\s+POW\(/);
    expect(source, "keys must sort descending -- largest U^(1/w) wins").toMatch(/\)\s*DESC/);
    expect(source, "dividing a raw RANDOM() by the weight is the biased form this replaced").not.toMatch(
      /RANDOM\(\)\s*\*?\s*[\d.]*\s*\/\s*CASE/,
    );

    // Weights are the spec's 6/3/1. The unseen bucket was 9 in code while the
    // merged spec said 6, in prose, twice -- they shipped disagreeing.
    // All THREE branches, matched as ONE expression. Asserting the branches
    // separately leaves the last one unpinned: `ELSE 2` changes every selection
    // probability and passed the earlier version of this guard, verified.
    expect(source, "the weight CASE must be exactly 6 / 3 / 1 -- the spec's stated ratio, all three branches").toMatch(
      /WHEN COALESCE\(total_views, 0\) = 0 THEN 6\s*\n\s*WHEN total_views BETWEEN 1 AND 9 THEN 3\s*\n\s*ELSE 1\s*\n\s*END/,
    );
  });

  it("returns only case-insensitive single-artist genre tags split by commas and slashes", async () => {
    const { env, rawDb } = seedEnv();
    const eventId = publicEvent(rawDb, "Genres", "genres");
    const venue = insertVenue(rawDb, { name: "Genre Venue" });
    insertBand(rawDb, {
      name: "First",
      event_id: eventId,
      venue_id: venue.id,
      genre: "Punk, Frog Funk / Art Rock",
    });
    insertBand(rawDb, { name: "Second", event_id: eventId, venue_id: venue.id, genre: "punk / Jazz" });
    const inactive = insertBand(rawDb, {
      name: "Inactive",
      event_id: eventId,
      venue_id: venue.id,
      genre: "Only Inactive",
    });
    rawDb.prepare("UPDATE band_profiles SET is_active = 0 WHERE id = ?").run(inactive.band_profile_id);

    const res = await oneOfOne.onRequestGet({
      request: new Request("https://example.test/api/artists/one-of-one"),
      env,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.map((entry) => entry.tag)).toEqual(["Art Rock", "Frog Funk", "Jazz"]);
    expect(body.find((entry) => entry.tag === "Frog Funk").artist.name).toBe("First");
    expect(body.map((entry) => entry.tag)).not.toContain("Punk");
    expect(body.map((entry) => entry.tag)).not.toContain("Only Inactive");
  });

  it("does not expose artists found only on unpublished events", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Private Venue" });
    const draft = insertEvent(rawDb, { name: "Private", slug: "private" });
    insertBand(rawDb, {
      name: "Private Artist",
      event_id: draft.id,
      venue_id: venue.id,
      genre: "Private Genre",
    });

    const shuffleRes = await shuffle.onRequestGet({
      request: new Request("https://example.test/api/artists/shuffle?limit=20"),
      env,
    });
    expect((await shuffleRes.json()).map((artist) => artist.name)).not.toContain("Private Artist");

    const oneOfOneRes = await oneOfOne.onRequestGet({
      request: new Request("https://example.test/api/artists/one-of-one"),
      env,
    });
    expect((await oneOfOneRes.json()).map((entry) => entry.artist.name)).not.toContain("Private Artist");
  });
});

describe("GET /api/artists/shuffle — a random endpoint cannot be cached", () => {
  // CACHE_BROWSE is `public, max-age=300` and the URL never changes, so a
  // browser would serve the SAME five artists for five minutes: a shuffle that
  // does not shuffle. The other two showcase routes are stable aggregates and
  // correctly keep the tier; this one cannot share a cache key with its own
  // previous answer.
  it("responds no-store, never a max-age tier", async () => {
    const { env, rawDb } = seedEnv();
    const eventId = publicEvent(rawDb, "Cache Fest", "cache-fest");
    const venue = insertVenue(rawDb, { name: "Cache Venue" });
    insertBand(rawDb, { name: "Cache Band", event_id: eventId, venue_id: venue.id });

    const res = await shuffle.onRequestGet({
      request: new Request("https://example.test/api/artists/shuffle"),
      env,
    });
    expect(res.status).toBe(200);

    const cacheControl = res.headers.get("Cache-Control");
    expect(cacheControl).toBe("no-store");
    // Asserted by SHAPE too: any max-age at all reopens the window in which the
    // button does nothing, whatever number someone picks.
    expect(cacheControl).not.toMatch(/max-age/);
  });
});
