import { describe, it, expect } from "vitest";
import {
  toMinutes,
  normalizeEndMinutes,
  buildIntervals,
  intervalsOverlap,
  computeNewEndTime,
  checkConflicts,
  detectBulkConflicts,
} from "../timeConflicts.js";
import { createTestEnv, insertBand, insertEvent, insertVenue } from "../../api/test-utils.js";

describe("toMinutes", () => {
  it("converts HH:MM to total minutes", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("01:00")).toBe(60);
    expect(toMinutes("23:59")).toBe(1439);
    expect(toMinutes("18:30")).toBe(1110);
  });
});

describe("normalizeEndMinutes", () => {
  it("returns end unchanged when end > start (same day)", () => {
    expect(normalizeEndMinutes(60, 120)).toBe(120);
  });

  it("adds 24h when end < start (midnight crossing)", () => {
    expect(normalizeEndMinutes(toMinutes("23:30"), toMinutes("00:30"))).toBe(toMinutes("00:30") + 24 * 60);
  });

  // Behaviour change, deliberate. This previously asserted that start === end
  // is a midnight crossing (60 -> 1500), matching the old `<=`. The frontend's
  // copy in `frontend/src/admin/utils/timeUtils.js` has always used `<`, so the
  // two sides disagreed about the same row: the server made a zero-length set
  // conflict with everything at its venue, the admin UI with nothing.
  //
  // `validateSetTimes` now rejects start === end on every write path, so this
  // input cannot reach here from an API call, and production held zero such
  // rows when the rule shipped (283 performances audited). The comparison is
  // aligned anyway so the two implementations cannot drift apart again — which
  // is the actual defect, not either individual reading.
  it("leaves a zero-length span unchanged, matching the frontend", () => {
    expect(normalizeEndMinutes(60, 60)).toBe(60);
  });
});

describe("buildIntervals", () => {
  it("produces two mirrored intervals for a same-day set", () => {
    const intervals = buildIntervals("18:00", "19:00");
    expect(intervals).toHaveLength(2);
    expect(intervals[0]).toEqual([18 * 60, 19 * 60]);
    expect(intervals[1]).toEqual([18 * 60 + 24 * 60, 19 * 60 + 24 * 60]);
  });

  it("normalizes end for after-midnight sets", () => {
    const intervals = buildIntervals("23:30", "00:30");
    expect(intervals[0][0]).toBe(23 * 60 + 30);
    expect(intervals[0][1]).toBe(24 * 60 + 30); // 00:30 + 24h
  });
});

describe("intervalsOverlap", () => {
  it("detects overlap when intervals share time", () => {
    expect(intervalsOverlap([0, 60], [30, 90])).toBe(true);
  });

  it("returns false for non-overlapping intervals", () => {
    expect(intervalsOverlap([0, 60], [60, 120])).toBe(false);
    expect(intervalsOverlap([60, 120], [0, 60])).toBe(false);
  });

  it("returns false for completely separate intervals", () => {
    expect(intervalsOverlap([0, 30], [60, 90])).toBe(false);
  });
});

describe("computeNewEndTime", () => {
  it("preserves duration for same-day sets", () => {
    // 18:00–19:00 is 60 minutes. Shift to 20:00 → should end at 21:00.
    expect(computeNewEndTime("18:00", "19:00", "20:00")).toBe("21:00");
  });

  it("preserves duration for after-midnight sets when shifting earlier", () => {
    // 23:40–00:10 is 30 minutes. Shift to 23:00 → should end at 23:30.
    expect(computeNewEndTime("23:40", "00:10", "23:00")).toBe("23:30");
  });

  it("preserves duration for after-midnight sets when result also crosses midnight", () => {
    // 23:30–00:30 is 60 minutes. Shift to 23:40 → should end at 00:40.
    expect(computeNewEndTime("23:30", "00:30", "23:40")).toBe("00:40");
  });

  it("handles a set that shifts across midnight", () => {
    // 22:00–23:00 is 60 minutes. Shift to 23:30 → should end at 00:30.
    expect(computeNewEndTime("22:00", "23:00", "23:30")).toBe("00:30");
  });
});

// checkConflicts — single create/update conflict check (#540)
//
// Shared by the admin create (bands.js) and update (bands/[id].js) write
// paths. Day-scoped since #540: same venue + clock time on different festival
// days is a distinct slot, not a conflict.

describe("checkConflicts", () => {
  function fixture() {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, {
      name: "Conflict Check Event",
      slug: "conflict-check-event",
      date: "2026-08-01",
    });
    const venue = insertVenue(rawDb, { name: "Conflict Check Venue" });
    return { env, rawDb, event, venue };
  }

  it("returns a conflict entry with type conflict for the exact same time", async () => {
    const { env, rawDb, event, venue } = fixture();
    insertBand(rawDb, {
      name: "Existing Set",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:00",
      endTime: "21:00",
      eventDate: event.date,
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      name: "Existing Set",
      startTime: "20:00",
      endTime: "21:00",
      type: "conflict",
    });
    expect(conflicts[0].id).toBeTypeOf("number");
  });

  it("returns type overlap for a non-exact overlap", async () => {
    const { env, rawDb, event, venue } = fixture();
    insertBand(rawDb, {
      name: "Existing Set",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:30",
      endTime: "21:30",
      eventDate: event.date,
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].type).toBe("overlap");
  });

  it("scopes to venue and event", async () => {
    const { env, rawDb, event, venue } = fixture();
    const otherVenue = insertVenue(rawDb, { name: "Other Venue" });
    const otherEvent = insertEvent(rawDb, {
      name: "Other Event",
      slug: "other-event",
      date: "2026-08-01",
    });
    insertBand(rawDb, {
      name: "Elsewhere Set",
      event_id: otherEvent.id,
      venue_id: otherVenue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:00",
      endTime: "21:00",
      eventDate: event.date,
    });

    expect(conflicts).toEqual([]);
  });

  it("ignores the excluded performance (self during update)", async () => {
    const { env, rawDb, event, venue } = fixture();
    const existing = insertBand(rawDb, {
      name: "Self",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:00",
      endTime: "21:00",
      excludePerformanceId: existing.id,
      eventDate: event.date,
    });

    expect(conflicts).toEqual([]);
  });

  it("different festival days at the same venue and time do NOT conflict (#540)", async () => {
    const { env, rawDb, event, venue } = fixture();
    const day1 = insertBand(rawDb, {
      name: "Day One Set",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    rawDb.prepare("UPDATE performances SET performance_date=? WHERE id=?").run("2026-08-01", day1.id);

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:00",
      endTime: "21:00",
      performanceDate: "2026-08-02",
      eventDate: event.date,
    });

    expect(conflicts).toEqual([]);
  });

  it("NULL performance_date on both sides falls back to event date and still conflicts (single-day)", async () => {
    const { env, rawDb, event, venue } = fixture();
    insertBand(rawDb, {
      name: "Single Day Set",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await checkConflicts(env.DB, {
      eventId: event.id,
      venueId: venue.id,
      startTime: "20:00",
      endTime: "21:00",
      eventDate: event.date,
    });

    expect(conflicts).toHaveLength(1);
  });
});

// detectBulkConflicts — festival-day scoping (#551)
//
// #540 day-scoped the single create/update conflict check (checkConflicts, now
// in this file). detectBulkConflicts (bulk move_venue /
// change_time) was left out of that scope: it matched purely on
// event_id + venue_id + clock overlap, so a multi-day event's bulk move/retime
// would false-conflict against a different festival day. These tests cover
// both action branches (move_venue, change_time) across both comparison sites
// (batch member vs. existing performance, and pairwise within the batch).

describe("detectBulkConflicts — festival-day scoping (#551)", () => {
  function multiDayFixture() {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, {
      name: "Multi Day Event 551",
      slug: "multi-day-event-551",
      date: "2026-08-01",
      end_date: "2026-08-02",
      status: "draft",
    });
    const venueA = insertVenue(rawDb, { name: "Source Venue 551" });
    const venueB = insertVenue(rawDb, { name: "Target Venue 551" });
    return { env, rawDb, event, venueA, venueB };
  }

  function setPerformanceDate(rawDb, performanceId, date) {
    rawDb.prepare("UPDATE performances SET performance_date=? WHERE id=?").run(date, performanceId);
  }

  it("move_venue: different performance_date at same venue/time → no conflict", async () => {
    const { env, rawDb, event, venueA, venueB } = multiDayFixture();

    const moving = insertBand(rawDb, {
      name: "Day Two Mover",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, moving.id, "2026-08-02");

    const existing = insertBand(rawDb, {
      name: "Day One Resident",
      event_id: event.id,
      venue_id: venueB.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, existing.id, "2026-08-01");

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [moving.id],
      params: { venue_id: venueB.id },
    });
    expect(conflicts).toEqual([]);
  });

  it("move_venue: same performance_date at same venue/time → conflict still detected", async () => {
    const { env, rawDb, event, venueA, venueB } = multiDayFixture();

    const moving = insertBand(rawDb, {
      name: "Day One Mover",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, moving.id, "2026-08-01");

    const existing = insertBand(rawDb, {
      name: "Day One Resident",
      event_id: event.id,
      venue_id: venueB.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, existing.id, "2026-08-01");

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [moving.id],
      params: { venue_id: venueB.id },
    });
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].severity).toBe("error");
  });

  it("move_venue: NULL performance_date on both sides falls back to event date (single-day, still conflicts)", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, {
      name: "Single Day Event 551",
      slug: "single-day-event-551",
      date: "2026-08-01",
      status: "draft",
    });
    const venueA = insertVenue(rawDb, { name: "Single Source Venue" });
    const venueB = insertVenue(rawDb, { name: "Single Target Venue" });

    // performance_date is left NULL on both — single-day event, byte-identical
    // to pre-#551 behavior (both sides fall back to the same event date).
    const moving = insertBand(rawDb, {
      name: "Single Day Mover",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    insertBand(rawDb, {
      name: "Single Day Resident",
      event_id: event.id,
      venue_id: venueB.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [moving.id],
      params: { venue_id: venueB.id },
    });
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("change_time: different performance_date at same venue/time → no conflict", async () => {
    const { env, rawDb, event, venueA } = multiDayFixture();

    const changing = insertBand(rawDb, {
      name: "Day Two Changer",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "18:00",
      end_time: "19:00",
    });
    setPerformanceDate(rawDb, changing.id, "2026-08-02");

    const existing = insertBand(rawDb, {
      name: "Day One Resident At Venue A",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, existing.id, "2026-08-01");

    // Shift the Day-Two set's start onto the Day-One resident's clock slot.
    const conflicts = await detectBulkConflicts(env, {
      action: "change_time",
      bandIds: [changing.id],
      params: { start_time: "20:00" },
    });
    expect(conflicts).toEqual([]);
  });

  it("change_time: same performance_date at same venue/time → conflict still detected", async () => {
    const { env, rawDb, event, venueA } = multiDayFixture();

    const changing = insertBand(rawDb, {
      name: "Day One Changer",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "18:00",
      end_time: "19:00",
    });
    setPerformanceDate(rawDb, changing.id, "2026-08-01");

    const existing = insertBand(rawDb, {
      name: "Day One Resident At Venue A",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, existing.id, "2026-08-01");

    const conflicts = await detectBulkConflicts(env, {
      action: "change_time",
      bandIds: [changing.id],
      params: { start_time: "20:00" },
    });
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0].severity).toBe("error");
  });

  it("move_venue pairwise: two batch members at same venue/time but different performance_date → no conflict", async () => {
    const { env, rawDb, event, venueB } = multiDayFixture();
    const venueSource = insertVenue(rawDb, { name: "Pairwise Source Venue 551" });

    const memberDay1 = insertBand(rawDb, {
      name: "Pairwise Day One",
      event_id: event.id,
      venue_id: venueSource.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, memberDay1.id, "2026-08-01");

    const memberDay2 = insertBand(rawDb, {
      name: "Pairwise Day Two",
      event_id: event.id,
      venue_id: venueSource.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, memberDay2.id, "2026-08-02");

    // Both batch members move to the same target venue at the same clock
    // time. venueB has no existing performances, so only the pairwise check
    // could report a conflict here — and it must not, since they're on
    // different festival days.
    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [memberDay1.id, memberDay2.id],
      params: { venue_id: venueB.id },
    });
    expect(conflicts).toEqual([]);
  });

  it("move_venue pairwise: two batch members at same venue/time with same performance_date → conflict detected", async () => {
    const { env, rawDb, event, venueB } = multiDayFixture();
    const venueSource = insertVenue(rawDb, { name: "Pairwise Source Venue 551b" });

    const memberA = insertBand(rawDb, {
      name: "Pairwise Same Day A",
      event_id: event.id,
      venue_id: venueSource.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, memberA.id, "2026-08-01");

    const memberB = insertBand(rawDb, {
      name: "Pairwise Same Day B",
      event_id: event.id,
      venue_id: venueSource.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    setPerformanceDate(rawDb, memberB.id, "2026-08-01");

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [memberA.id, memberB.id],
      params: { venue_id: venueB.id },
    });
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it("change_time pairwise: two batch members at same venue with different performance_date → no conflict", async () => {
    const { env, rawDb, event, venueA } = multiDayFixture();

    const memberDay1 = insertBand(rawDb, {
      name: "CT Pairwise Day One",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "18:00",
      end_time: "19:00",
    });
    setPerformanceDate(rawDb, memberDay1.id, "2026-08-01");

    const memberDay2 = insertBand(rawDb, {
      name: "CT Pairwise Day Two",
      event_id: event.id,
      venue_id: venueA.id,
      start_time: "19:00",
      end_time: "20:00",
    });
    setPerformanceDate(rawDb, memberDay2.id, "2026-08-02");

    // Both shift to the same new start_time, landing at the same venue/clock
    // slot — but different festival days must not conflict.
    const conflicts = await detectBulkConflicts(env, {
      action: "change_time",
      bandIds: [memberDay1.id, memberDay2.id],
      params: { start_time: "20:00" },
    });
    expect(conflicts).toEqual([]);
  });
});

// detectBulkConflicts — batches spanning MULTIPLE events (#1130)
//
// The bulk PATCH/DELETE path validates `band_ids` only as an id array capped at
// 200, with NO event_id constraint, so a selection spanning several events is
// legal. move_venue used to issue one sequential query PER distinct event; it
// now issues one query for all of them and groups in JS.
//
// These tests exist because the existing suite passed under both shapes: every
// other fixture here seeds a single event, so nothing could tell a per-event
// loop from a batched query.

describe("detectBulkConflicts — batches spanning multiple events (#1130)", () => {
  it("detects conflicts in EVERY event of a multi-event batch, not just the first", async () => {
    const { env, rawDb } = createTestEnv();
    const target = insertVenue(rawDb, { name: "Shared Target 1130" });
    const source = insertVenue(rawDb, { name: "Source 1130" });

    const eventA = insertEvent(rawDb, { name: "Event A 1130", slug: "evt-a-1130", date: "2026-08-01" });
    const eventB = insertEvent(rawDb, { name: "Event B 1130", slug: "evt-b-1130", date: "2026-08-02" });

    // One mover per event, both at the same clock time, both moving to `target`.
    const moverA = insertBand(rawDb, {
      name: "Mover A",
      event_id: eventA.id,
      venue_id: source.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    const moverB = insertBand(rawDb, {
      name: "Mover B",
      event_id: eventB.id,
      venue_id: source.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    // An occupant already at `target` in EACH event, overlapping the movers.
    insertBand(rawDb, {
      name: "Occupant A",
      event_id: eventA.id,
      venue_id: target.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    insertBand(rawDb, {
      name: "Occupant B",
      event_id: eventB.id,
      venue_id: target.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [moverA.id, moverB.id],
      params: { venue_id: target.id },
    });

    const names = conflicts.map((c) => c.message).join(" | ");
    // Both events must be represented. A per-event loop that only ran for the
    // first event would report Occupant A and miss Occupant B entirely.
    expect(names, `both events must contribute a conflict, got: ${names}`).toContain("Occupant A");
    expect(names, `both events must contribute a conflict, got: ${names}`).toContain("Occupant B");
  });

  it("returns no conflict for an event in the batch that has no occupant", async () => {
    const { env, rawDb } = createTestEnv();
    const target = insertVenue(rawDb, { name: "Empty Target 1130" });
    const source = insertVenue(rawDb, { name: "Source2 1130" });

    const eventA = insertEvent(rawDb, { name: "Event C 1130", slug: "evt-c-1130", date: "2026-08-01" });
    const eventB = insertEvent(rawDb, { name: "Event D 1130", slug: "evt-d-1130", date: "2026-08-02" });

    const moverA = insertBand(rawDb, {
      name: "Mover C",
      event_id: eventA.id,
      venue_id: source.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    const moverB = insertBand(rawDb, {
      name: "Mover D",
      event_id: eventB.id,
      venue_id: source.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    // Only event A has an occupant at the target.
    insertBand(rawDb, {
      name: "Occupant C",
      event_id: eventA.id,
      venue_id: target.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [moverA.id, moverB.id],
      params: { venue_id: target.id },
    });

    // Event B has no occupant, so its mover must produce nothing — this is the
    // case the "seed every requested event with []" line exists for; without it
    // the lookup returns undefined.
    const forB = conflicts.filter((c) => c.band_id === moverB.id);
    expect(forB, `event with no occupant must yield no conflict, got ${JSON.stringify(forB)}`).toEqual([]);
    expect(conflicts.some((c) => c.band_id === moverA.id)).toBe(true);
  });
});

describe("detectBulkConflicts — D1's 100-parameter ceiling (#1131 review)", () => {
  // A legal batch: MAX_BULK_BAND_IDS is 200 and nothing constrains band_ids to
  // one event, so 50 performances across 50 events is ordinary input.
  //
  // Binding venue_id + every event id + every band id is 1 + 2N parameters --
  // 101 here, which D1 rejects outright, so the bulk route answered 500 before
  // touching anything. The pre-batched code had the same ceiling at 99 bands.
  //
  // This test is the reason the exclusion moved out of SQL and the event ids are
  // chunked: it fails with a parameter error if either is undone.
  it("handles 50 performances across 50 events without exceeding the bind limit", async () => {
    const { env, rawDb } = createTestEnv();
    const source = insertVenue(rawDb, { name: "Ceiling Source" });
    const target = insertVenue(rawDb, { name: "Ceiling Target" });

    const movers = [];
    for (let i = 0; i < 50; i += 1) {
      const event = insertEvent(rawDb, {
        name: `Ceiling Event ${i}`,
        slug: `ceiling-evt-${i}`,
        date: "2026-08-01",
      });
      movers.push(
        insertBand(rawDb, {
          name: `Ceiling Mover ${i}`,
          event_id: event.id,
          venue_id: source.id,
          start_time: "20:00",
          end_time: "21:00",
        }),
      );
      // An occupant at the target in each event, so every one of the 50 must be
      // seen -- a chunking bug that dropped a chunk would lose conflicts here.
      insertBand(rawDb, {
        name: `Ceiling Occupant ${i}`,
        event_id: event.id,
        venue_id: target.id,
        start_time: "20:00",
        end_time: "21:00",
      });
    }

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: movers.map((m) => m.id),
      params: { venue_id: target.id },
    });

    // Every mover conflicts with its own event's occupant. Fewer means a chunk
    // was dropped.
    expect(conflicts.length).toBe(50);
    const ids = new Set(conflicts.map((c) => c.band_id));
    expect(ids.size, "each mover must be reported exactly once").toBe(50);
  });

  // THE CEILING ITSELF, asserted by counting binds rather than by running the
  // query -- because running it cannot fail here. The unit harness is
  // better-sqlite3, whose variable limit is ~32766; D1's is 100. A 101-parameter
  // query passes locally and 500s in production, so an execution test is
  // VACUOUS for this property. Verified: reinstating the 1+2N binding leaves the
  // 50-event test above green.
  //
  // Counting the arguments actually passed to .bind() is the only assertion here
  // that can fail for the right reason.
  it("never binds more than 100 parameters in one query — D1's ceiling", async () => {
    const { env, rawDb } = createTestEnv();
    const source = insertVenue(rawDb, { name: "Bind Source" });
    const target = insertVenue(rawDb, { name: "Bind Target" });

    const movers = [];
    for (let i = 0; i < 100; i += 1) {
      const event = insertEvent(rawDb, {
        name: `Bind Event ${i}`,
        slug: `bind-evt-${i}`,
        date: "2026-08-01",
      });
      movers.push(
        insertBand(rawDb, {
          name: `Bind Mover ${i}`,
          event_id: event.id,
          venue_id: source.id,
          start_time: "20:00",
          end_time: "21:00",
        }),
      );
    }

    const bindCounts = [];
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const stmt = realPrepare(sql);
      const realBind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        bindCounts.push(args.length);
        return realBind(...args);
      };
      return stmt;
    };

    await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: movers.map((m) => m.id),
      params: { venue_id: target.id },
    });
    // change_time is the SIBLING path and had the identical ceiling: it bound
    // venue + event + every band id, so 99 bands was 101 parameters. The review
    // flagged move_venue only; this covers both.
    await detectBulkConflicts(env, {
      action: "change_time",
      bandIds: movers.map((m) => m.id),
      params: { start_time: "21:00" },
    });

    expect(bindCounts.length, "no query ran, so this proves nothing").toBeGreaterThan(0);
    const worst = Math.max(...bindCounts);
    expect(worst, `largest bind was ${worst} parameters; D1 rejects above 100`).toBeLessThanOrEqual(100);
  });

  // The batch's own members are excluded so they are compared pairwise instead
  // of against themselves. That exclusion moved from SQL to JS; this asserts it
  // still happens.
  it("never reports a batch member as its own conflict", async () => {
    const { env, rawDb } = createTestEnv();
    const source = insertVenue(rawDb, { name: "Self Source" });
    const target = insertVenue(rawDb, { name: "Self Target" });
    const event = insertEvent(rawDb, { name: "Self Event", slug: "self-evt", date: "2026-08-01" });

    const a = insertBand(rawDb, {
      name: "Self A",
      event_id: event.id,
      venue_id: target.id,
      start_time: "20:00",
      end_time: "21:00",
    });
    const b = insertBand(rawDb, {
      name: "Self B",
      event_id: event.id,
      venue_id: source.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const conflicts = await detectBulkConflicts(env, {
      action: "move_venue",
      bandIds: [a.id, b.id],
      params: { venue_id: target.id },
    });

    const messages = conflicts.map((c) => c.message).join(" | ");
    expect(messages, `a batch member must not appear as an existing occupant: ${messages}`).not.toContain(
      "Self A" + '" at the new venue',
    );
  });
});
