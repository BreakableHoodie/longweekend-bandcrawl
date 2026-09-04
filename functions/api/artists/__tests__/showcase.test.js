import { describe, expect, it } from "vitest";
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
