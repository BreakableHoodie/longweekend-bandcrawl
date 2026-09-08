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

  // The p1 half of the reveal guard. Without a case here only p2 is covered,
  // and the p1 clause could be deleted with the suite still green -- the
  // vacuous shape this repo keeps finding.
  it("returns nothing for an artist whose own set is unannounced", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Reveal Venue 2" });
    const event = insertEvent(rawDb, { name: "Reveal2", slug: "reveal2", status: "published" });
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(event.id);
    insertBand(rawDb, { name: "Hidden Act", event_id: event.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Public Act", event_id: event.id, venue_id: venue.id });
    rawDb
      .prepare(
        `UPDATE performances SET is_announced = 0
         WHERE band_profile_id = (SELECT id FROM band_profiles WHERE name = 'Hidden Act')`,
      )
      .run();

    const res = await stageMates.onRequestGet({
      request: new Request("https://example.test/api/bands/Hidden-Act/stage-mates"),
      env,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  // "1.9", "1e2" and "0x10" all satisfied the old `!isNaN && parseInt > 0`
  // idiom and resolved to bands 1, 1 and 16 respectively -- a path resolving to
  // a record it does not name. They must now fall through to the slug branch
  // and 404 rather than silently serving someone else's data.
  it.each(["1.9", "1e2"])("does not resolve %s to a numeric id", async (segment) => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Numeric Venue" });
    const ev = insertEvent(rawDb, { name: "Num", slug: "num", status: "published" });
    insertBand(rawDb, { name: "First Band", event_id: ev.id, venue_id: venue.id });

    const res = await stageMates.onRequestGet({
      request: new Request(`https://example.test/api/bands/${segment}/stage-mates`),
      env,
    });
    expect(res.status).toBe(404);
  });

  // Hex needs its own case, built from a REAL id. A literal like "0x10" 404s
  // under both the old and the new parser -- old: parseInt gives 16 and band 16
  // does not exist; new: it falls through to the slug branch. Same status for
  // opposite reasons, so it proves nothing.
  //
  // Deriving the hex from an id that DOES exist is what makes it discriminating:
  // the old idiom resolves it and answers 200, the new one 404s.
  it("does not resolve a hex form of a real id", async () => {
    const { env, rawDb } = seedEnv();
    const venue = insertVenue(rawDb, { name: "Hex Venue" });
    const ev = insertEvent(rawDb, { name: "Hex", slug: "hex", status: "published" });
    const anchor = insertBand(rawDb, { name: "Hex Anchor", event_id: ev.id, venue_id: venue.id });
    insertBand(rawDb, { name: "Hex Mate", event_id: ev.id, venue_id: venue.id });

    const hex = `0x${anchor.band_profile_id.toString(16)}`;
    expect(Number.parseInt(hex, 10)).toBe(0); // parseInt base-10 stops at "x"
    expect(Number(hex)).toBe(anchor.band_profile_id); // but Number() resolves it

    const res = await stageMates.onRequestGet({
      request: new Request(`https://example.test/api/bands/${hex}/stage-mates`),
      env,
    });
    expect(res.status).toBe(404);
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
