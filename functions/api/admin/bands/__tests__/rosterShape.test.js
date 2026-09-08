import { describe, expect, it, vi } from "vitest";

vi.mock("../../_middleware.js", () => ({
  checkPermission: async () => ({ error: false, user: { userId: 1, role: "editor" }, userId: 1 }),
  auditLog: vi.fn(async () => {}),
}));

import * as bandsHandler from "../../bands.js";
import { createTestEnv, insertEvent, insertVenue, insertBand } from "../../../test-utils.js";

/**
 * Pins the EXACT roster response so the query behind it can be rewritten and
 * proven behaviour-identical (#907).
 *
 * That branch runs 8 correlated subqueries per row — follower_count, event_ids,
 * and three apiece for next_event_* / last_event_*, where each trio is the same
 * query differing only in the projected column. EXPLAIN QUERY PLAN shows every
 * event subquery building its own TEMP B-TREE FOR ORDER BY, per row. The
 * indexes it needs already exist, so this is a query rewrite, not a missing
 * index.
 *
 * A rewrite like that is only safe with the output pinned first. The endpoint
 * feeds RosterTab and LineupTab's ArtistPicker, both of which key off
 * band_profile_id, so a silently reshaped row breaks the admin UI without
 * failing anything.
 *
 * The fixture deliberately covers every branch the subqueries can take:
 * a band with BOTH past and future events, one with only past, one with only
 * future, one with none at all, and one with followers (verified and not).
 */

function seedRoster(rawDb) {
  // Dates chosen relative to nothing — the handler compares against Toronto's
  // festival "today", so these are far enough either side to stay stable.
  const past = insertEvent(rawDb, { name: "Past Fest", slug: "past-fest", date: "2020-01-15" });
  const past2 = insertEvent(rawDb, { name: "Older Fest", slug: "older-fest", date: "2019-06-01" });
  const future = insertEvent(rawDb, { name: "Future Fest", slug: "future-fest", date: "2099-10-11" });
  const future2 = insertEvent(rawDb, { name: "Later Fest", slug: "later-fest", date: "2099-12-25" });
  const venue = insertVenue(rawDb, { name: "Hall" });

  // Both sides: must pick the EARLIEST future and the LATEST past.
  const both = insertBand(rawDb, { name: "Both Sides", event_id: past.id, venue_id: venue.id });
  insertBand(rawDb, { name: "Both Sides", event_id: past2.id, venue_id: venue.id });
  insertBand(rawDb, { name: "Both Sides", event_id: future.id, venue_id: venue.id });
  insertBand(rawDb, { name: "Both Sides", event_id: future2.id, venue_id: venue.id });

  const pastOnly = insertBand(rawDb, { name: "Past Only", event_id: past.id, venue_id: venue.id });
  const futureOnly = insertBand(rawDb, { name: "Future Only", event_id: future.id, venue_id: venue.id });

  // No performances at all — every event subquery must yield null, not 0.
  rawDb
    .prepare("INSERT INTO band_profiles (name, name_normalized, is_active) VALUES (?, ?, 1)")
    .run("No Events", "noevents");

  // Followers: one verified, one not. Only the verified one counts.
  rawDb
    .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
    .run("yes@x.co", both.band_profile_id, "tok-1");
  rawDb
    .prepare(
      "INSERT INTO band_follows (email, band_profile_id, verified, verification_token, unsubscribe_token) VALUES (?, ?, 0, ?, ?)",
    )
    .run("no@x.co", both.band_profile_id, "pending", "tok-2");

  return { both, pastOnly, futureOnly };
}

async function fetchRoster(env) {
  const res = await bandsHandler.onRequestGet({
    request: new Request("https://example.test/api/admin/bands"),
    env,
    data: { user: { role: "editor", id: 2 } },
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("admin roster ordering mechanics (#907)", () => {
  it("uses COALESCE(end_date, date), so a multi-day event still running counts as NEXT", async () => {
    // The distinguishing case. This event STARTED in the past but ends far in
    // the future. Under COALESCE(end_date, date) >= today it is upcoming; under
    // a plain `date >= today` it would be classified as past instead.
    //
    // Without this fixture the CTE could drop the COALESCE entirely and every
    // other assertion would still pass, because every other event has a NULL
    // end_date where the two expressions agree.
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const spanning = insertEvent(rawDb, {
      name: "Still Running",
      slug: "still-running",
      date: "2020-01-01",
      end_date: "2099-01-01",
    });
    const venue = insertVenue(rawDb, { name: "Hall" });
    insertBand(rawDb, { name: "Spanning Band", event_id: spanning.id, venue_id: venue.id });

    const body = await fetchRoster(env);
    const row = body.bands.find((b) => b.name === "Spanning Band");

    expect(row.next_event_name).toBe("Still Running");
    expect(row.last_event_id).toBeNull();
  });

  it("breaks a same-date tie by event id — lowest for next, highest for last", async () => {
    // Every other fixture uses unique dates, so the ORDER BY's second term
    // (e.id ASC / e.id DESC) is never exercised. Two events sharing a date make
    // the tie-break the only thing deciding the answer.
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const venue = insertVenue(rawDb, { name: "Hall" });

    const futureLow = insertEvent(rawDb, { name: "Future A", slug: "future-a", date: "2099-05-05" });
    const futureHigh = insertEvent(rawDb, { name: "Future B", slug: "future-b", date: "2099-05-05" });
    const pastLow = insertEvent(rawDb, { name: "Past A", slug: "past-a", date: "2020-05-05" });
    const pastHigh = insertEvent(rawDb, { name: "Past B", slug: "past-b", date: "2020-05-05" });

    for (const ev of [futureLow, futureHigh, pastLow, pastHigh]) {
      insertBand(rawDb, { name: "Tied Band", event_id: ev.id, venue_id: venue.id });
    }

    const body = await fetchRoster(env);
    const row = body.bands.find((b) => b.name === "Tied Band");

    // Ascending for next: the lower id wins.
    expect(row.next_event_id).toBe(Math.min(futureLow.id, futureHigh.id));
    // Descending for last: the higher id wins.
    expect(row.last_event_id).toBe(Math.max(pastLow.id, pastHigh.id));
  });
});

describe("admin roster response shape (#907 rewrite guard)", () => {
  it("returns one row per band profile, not one per performance", async () => {
    // The LIMIT+JOIN truncation class: a join-multiplied roster once hid 47 of
    // 218 bands. "Both Sides" has four performances and must appear once.
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    const names = body.bands.map((b) => b.name);
    expect(names.filter((n) => n === "Both Sides")).toHaveLength(1);
  });

  it("projects exactly the expected columns", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    const row = body.bands.find((b) => b.name === "Both Sides");

    // Exhaustive, not a subset: a rewrite that drops or renames a column would
    // otherwise pass. RosterTab and ArtistPicker key off band_profile_id.
    // Exhaustive, not a subset: a rewrite that drops or renames a column would
    // otherwise pass. RosterTab and ArtistPicker key off band_profile_id.
    //
    // The eight link fields come from unpackSocialLinks flattening the
    // social_links JSON — that flattened form IS the contract the admin UI
    // consumes, so it belongs in the pin alongside the raw column.
    expect(Object.keys(row).sort()).toEqual([
      "apple_music",
      "band_profile_id",
      "bandcamp",
      "contact_email",
      "description",
      "event_ids",
      "facebook",
      "follower_count",
      "for_fans_of",
      "genre",
      "id",
      "instagram",
      "is_active",
      "last_event_date",
      "last_event_id",
      "last_event_name",
      "linktree",
      "members",
      "name",
      "next_event_date",
      "next_event_id",
      "next_event_name",
      "origin",
      "origin_city",
      "origin_region",
      "photo_alt_text",
      "photo_url",
      "social_links",
      "spotify",
      "url",
      "youtube",
    ]);
    expect(row.id).toBe(`profile_${row.band_profile_id}`);
  });

  it("picks the EARLIEST future event and the LATEST past event", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    const row = body.bands.find((b) => b.name === "Both Sides");

    // The band plays four events. A rewrite that picks any-future or any-past
    // still returns a non-null value and would pass a null check.
    expect(row.next_event_name).toBe("Future Fest");
    expect(row.next_event_date).toBe("2099-10-11");
    expect(row.last_event_name).toBe("Past Fest");
    expect(row.last_event_date).toBe("2020-01-15");
  });

  it("leaves the unused side NULL rather than falling back to the other", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);

    const pastOnly = body.bands.find((b) => b.name === "Past Only");
    expect(pastOnly.next_event_id).toBeNull();
    expect(pastOnly.last_event_name).toBe("Past Fest");

    const futureOnly = body.bands.find((b) => b.name === "Future Only");
    expect(futureOnly.last_event_id).toBeNull();
    expect(futureOnly.next_event_name).toBe("Future Fest");
  });

  it("gives a band with no performances nulls and a zero follower count", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    const none = body.bands.find((b) => b.name === "No Events");

    expect(none.next_event_id).toBeNull();
    expect(none.last_event_id).toBeNull();
    expect(none.event_ids).toBeNull();
    // Zero, not null — a COUNT over no rows is 0, and the UI renders it.
    expect(none.follower_count).toBe(0);
  });

  it("counts only VERIFIED followers", async () => {
    // The double opt-in gate. An unverified follower must not appear in a count
    // an operator reads as "people who will be emailed".
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    expect(body.bands.find((b) => b.name === "Both Sides").follower_count).toBe(1);
  });

  it("lists every event the band played in event_ids", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    seedRoster(rawDb);
    const body = await fetchRoster(env);
    const row = body.bands.find((b) => b.name === "Both Sides");
    expect(String(row.event_ids).split(",").sort()).toHaveLength(4);
  });
});
