import { describe, expect, it } from "vitest";
import { createTestEnv, insertBand, insertEvent, insertVenue } from "../../test-utils";
import * as stageMates from "../[name]/stage-mates.js";

function seedEnv() {
  const { env, rawDb } = createTestEnv({ role: "editor" });
  env.PUBLIC_DATA_PUBLISH_ENABLED = "true";
  return { env, rawDb };
}

describe("GET /api/bands/:name/stage-mates", () => {
  it("counts shared public events, orders by count, and excludes draft events", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Stage Venue" });
    const first = insertEvent(rawDb, { name: "First", slug: "first", status: "published" });
    const second = insertEvent(rawDb, { name: "Second", slug: "second", status: "published" });
    const draft = insertEvent(rawDb, { name: "Draft", slug: "draft", status: "draft" });

    insertBand(rawDb, { name: "Anchor Act", event_id: first.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Anchor Act", event_id: second.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Frequent Mate", event_id: first.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Frequent Mate", event_id: second.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Draft Mate", event_id: draft.id, venue_id: venue.id });

    const res = await stageMates.onRequestGet({
      request: new Request("https://example.test/api/bands/Anchor-Act/stage-mates"),
      env,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual([{ id: expect.any(Number), name: "Frequent Mate", shared_events: 2 }]);
  });

  // The spec keys this endpoint on the canonical band_profiles.id; the `[name]`
  // directory is a Pages routing constraint (three sibling routes already bind
  // that param as `name`), NOT a licence to pass a display name. Without this
  // case the numeric branch is dead code no test reaches: disabling it outright
  // left the slug tests green.
  it("resolves the canonical numeric id, not just the slug", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Stage Venue" });
    const first = insertEvent(rawDb, { name: "First", slug: "first", status: "published" });
    const second = insertEvent(rawDb, { name: "Second", slug: "second", status: "published" });

    const anchor = insertBand(rawDb, { name: "Anchor Act", event_id: first.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Anchor Act", event_id: second.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Frequent Mate", event_id: first.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Frequent Mate", event_id: second.id, venue_id: venue.id });

    const res = await stageMates.onRequestGet({
      request: new Request(`https://example.test/api/bands/${anchor.band_profile_id}/stage-mates`),
      env,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual([{ id: expect.any(Number), name: "Frequent Mate", shared_events: 2 }]);
  });

  // A staged-reveal event (reveal_mode = 1) hides performances until they are
  // individually announced. This endpoint derives co-performers by self-joining
  // `performances` on event_id, so without a guard it reports an UNANNOUNCED
  // artist as a stage mate of an announced one -- disclosing a booking the
  // promoter has deliberately not revealed yet.
  //
  // CLAUDE.md's rule names "public read paths that return per-performance rows".
  // This one returns aggregated co-performers, so the letter does not cover it
  // while the reason plainly does.
  it("does not reveal an unannounced artist on a staged-reveal event", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Reveal Venue" });
    const event = insertEvent(rawDb, { name: "Reveal", slug: "reveal", status: "published" });
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(event.id);

    insertBand(rawDb, { name: "Announced Act", event_id: event.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Secret Act", event_id: event.id, venue_id: venue.id });
    // is_announced defaults to 1 (migration 0034: existing rows stay visible),
    // so the UNANNOUNCED side is what has to be set explicitly. Setting the
    // announced side instead is a no-op that leaves both visible -- a fixture
    // that cannot construct the case it claims to test.
    rawDb
      .prepare(
        `UPDATE performances SET is_announced = 0
         WHERE band_profile_id = (SELECT id FROM band_profiles WHERE name = 'Secret Act')`,
      )
      .run();

    const res = await stageMates.onRequestGet({
      request: new Request("https://example.test/api/bands/Announced-Act/stage-mates"),
      env,
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.map((b) => b.name)).not.toContain("Secret Act");
  });

  it("returns 404 for an unknown artist", async () => {
    const { env } = seedEnv();
    const res = await stageMates.onRequestGet({
      request: new Request("https://example.test/api/bands/unknown/stage-mates"),
      env,
    });
    expect(res.status).toBe(404);
  });
});
