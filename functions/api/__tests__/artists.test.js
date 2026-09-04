import { describe, it, expect } from "vitest";
import { createTestEnv, insertEvent, insertBand, insertVenue } from "../test-utils";
import * as artists from "../artists.js";

function seedEnv() {
  const { env, rawDb } = createTestEnv({ role: "editor" });
  env.PUBLIC_DATA_PUBLISH_ENABLED = "true";
  return { env, rawDb };
}

function publish(rawDb, eventId) {
  rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(eventId);
}

async function getArtists(env, query = "") {
  return artists.onRequestGet({
    request: new Request(`https://example.test/api/artists${query}`),
    env,
  });
}

describe("Public artists directory - GET /api/artists", () => {
  it("lists only artists who performed at a published or archived event", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });

    const pub = insertEvent(rawDb, { name: "Pub", slug: "pub-evt" });
    publish(rawDb, pub.id);
    insertBand(rawDb, {
      name: "Published Band",
      event_id: pub.id,
      venue_id: venue.id,
      genre: "punk",
    });

    const arch = insertEvent(rawDb, {
      name: "Arch",
      slug: "arch-evt",
      status: "archived",
    });
    insertBand(rawDb, {
      name: "Archived Band",
      event_id: arch.id,
      venue_id: venue.id,
    });

    // Draft event -> not published, not archived -> excluded
    const draft = insertEvent(rawDb, {
      name: "Draft",
      slug: "draft-evt",
      status: "draft",
    });
    insertBand(rawDb, {
      name: "Draft Band",
      event_id: draft.id,
      venue_id: venue.id,
    });

    const res = await getArtists(env);
    expect(res.status).toBe(200);
    const { artists: list } = await res.json();
    const names = list.map((a) => a.name);
    expect(names).toContain("Published Band");
    expect(names).toContain("Archived Band");
    expect(names).not.toContain("Draft Band");

    const pubBand = list.find((a) => a.name === "Published Band");
    expect(pubBand.performance_count).toBeGreaterThanOrEqual(1);
    expect(pubBand).toHaveProperty("photo_url");
  });

  it("filters by search query (name or genre), case-insensitive", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "E", slug: "e-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "The Punks",
      event_id: ev.id,
      venue_id: venue.id,
      genre: "punk",
    });
    insertBand(rawDb, {
      name: "Jazz Cats",
      event_id: ev.id,
      venue_id: venue.id,
      genre: "jazz",
    });

    const res = await getArtists(env, "?q=JAZZ");
    const { artists: list } = await res.json();
    const names = list.map((a) => a.name);
    expect(names).toContain("Jazz Cats");
    expect(names).not.toContain("The Punks");
  });

  it("returns 503 when public data is gated off", async () => {
    const { env } = seedEnv();
    env.PUBLIC_DATA_PUBLISH_ENABLED = "false";
    const res = await getArtists(env);
    expect(res.status).toBe(503);
  });

  it("orders results alphabetically ignoring a leading article (#587)", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "Sort Fest", slug: "sort-fest" });
    publish(rawDb, ev.id);

    // Inserted out of both raw-name and article-stripped order.
    for (const name of ["Zebras", "The Anti-Queens", "Beatles", "An Horse"]) {
      insertBand(rawDb, { name, event_id: ev.id, venue_id: venue.id });
    }

    const res = await getArtists(env);
    expect(res.status).toBe(200);
    const { artists: list } = await res.json();
    const names = list.map((a) => a.name);

    // Article-stripped order: Anti-Queens, Beatles, Horse, Zebras — NOT the
    // raw-byte order (which would put "The Anti-Queens" under T, after "Beatles").
    expect(names).toEqual(["The Anti-Queens", "Beatles", "An Horse", "Zebras"]);
  });

  it("round-trips valid social_links JSON into a `social` object (#607)", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "Soc", slug: "soc-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "Social Band",
      event_id: ev.id,
      venue_id: venue.id,
      social_links: JSON.stringify({ bandcamp: "https://socialband.bandcamp.com", instagram: "socialband" }),
    });

    const res = await getArtists(env);
    const { artists: list } = await res.json();
    const band = list.find((a) => a.name === "Social Band");
    expect(band.social).toEqual({ bandcamp: "https://socialband.bandcamp.com/", instagram: "socialband" });
    expect(band).not.toHaveProperty("social_links");
  });

  it("yields social: {} for malformed social_links JSON, never throwing (safeReflectSocialLinks convention)", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "Bad", slug: "bad-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "Malformed Band",
      event_id: ev.id,
      venue_id: venue.id,
      social_links: "{not valid json",
    });

    const res = await getArtists(env);
    expect(res.status).toBe(200);
    const { artists: list } = await res.json();
    const band = list.find((a) => a.name === "Malformed Band");
    expect(band.social).toEqual({});
    expect(band).not.toHaveProperty("social_links");
  });

  it("sanitizes unsafe social URLs server-side (javascript: scheme nulled)", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "Unsafe", slug: "unsafe-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "Unsafe Band",
      event_id: ev.id,
      venue_id: venue.id,
      social_links: JSON.stringify({
        // eslint-disable-next-line no-script-url -- test fixture: intentional unsafe scheme, exercises the safeReflectSocialLinks read-path guard
        bandcamp: "javascript:alert(1)",
        website: "https://unsafeband.example.com",
      }),
    });

    const res = await getArtists(env);
    const { artists: list } = await res.json();
    const band = list.find((a) => a.name === "Unsafe Band");
    expect(band.social.bandcamp).toBeNull();
    expect(band.social.website).toBe("https://unsafeband.example.com/");
  });

  it("reports only link fields that resolve to real links", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "Links", slug: "links-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "Resolved Links",
      event_id: ev.id,
      venue_id: venue.id,
      social_links: JSON.stringify({
        // eslint-disable-next-line no-script-url -- fixture intentionally exercises an unsafe scheme
        website: "javascript:alert(1)",
        instagram: "bad handle",
        bandcamp: "https://resolved.bandcamp.com",
      }),
    });

    const res = await getArtists(env);
    const { artists: list } = await res.json();
    const band = list.find((artist) => artist.name === "Resolved Links");
    expect(band.link_fields).toEqual(["bandcamp"]);
  });

  it("yields social: null when social_links is absent, and never exposes the raw column", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Main" });
    const ev = insertEvent(rawDb, { name: "None", slug: "none-evt" });
    publish(rawDb, ev.id);
    insertBand(rawDb, {
      name: "No Social Band",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const res = await getArtists(env);
    const { artists: list } = await res.json();
    const band = list.find((a) => a.name === "No Social Band");
    expect(band.social).toBeNull();
    expect(band).not.toHaveProperty("social_links");
  });
});
