import { describe, expect, test, vi, afterEach } from "vitest";

vi.mock("../email.js", () => ({
  sendEmail: vi.fn(),
}));

import { sendEmail } from "../email.js";
import { notifyBandFollowers } from "../bandFollowNotify.js";
import * as loggerModule from "../logger.js";
import { createTestEnv, insertEvent, insertVenue, insertBand } from "../../api/test-utils.js";

describe("notifyBandFollowers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // restoreAllMocks restores SPIES; it does not reset the call history of a
    // vi.fn() from a module mock factory, so sendEmail's calls accumulated
    // across tests. Any assertion on a call COUNT then measured the whole file.
    vi.clearAllMocks();
  });
  test("records a notification for each delivered email and skips failures", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Fest", slug: "fest" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, {
      name: "The Band",
      event_id: event.id,
      venue_id: venue.id,
    });
    const bandProfileId = perf.band_profile_id;

    const f1 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("a@example.com", bandProfileId, "tok-a").lastInsertRowid;
    const f2 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("b@example.com", bandProfileId, "tok-b").lastInsertRowid;

    // First delivers, second fails.
    sendEmail.mockImplementation((_env, { to }) => Promise.resolve({ delivered: to === "a@example.com" }));

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId,
      bandName: "The Band",
      eventName: "Fest",
      followers: [
        { id: f1, email: "a@example.com", unsubscribe_token: "tok-a" },
        { id: f2, email: "b@example.com", unsubscribe_token: "tok-b" },
      ],
    });

    expect(result).toEqual({ sent: 1, failed: 1 });

    const notified = rawDb
      .prepare("SELECT band_follow_id FROM band_follow_notifications WHERE performance_id = ? ORDER BY band_follow_id")
      .all(perf.id);
    expect(notified.map((r) => r.band_follow_id)).toEqual([f1]);
  });

  test("skips followers already claimed by another concurrent request", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Test", slug: "test" });
    const venue = insertVenue(rawDb, { name: "Venue" });
    const perf = insertBand(rawDb, {
      name: "Band",
      event_id: event.id,
      venue_id: venue.id,
    });
    const bandProfileId = perf.band_profile_id;

    const fId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", bandProfileId, "tok").lastInsertRowid;

    // Pre-claim the follower as if another concurrent request already did
    rawDb
      .prepare("INSERT INTO band_follow_notifications (performance_id, band_follow_id) VALUES (?, ?)")
      .run(perf.id, fId);

    sendEmail.mockReset();
    sendEmail.mockImplementation(() => Promise.resolve({ delivered: true }));

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId,
      bandName: "Band",
      eventName: "Test",
      followers: [{ id: fId, email: "fan@example.com", unsubscribe_token: "tok" }],
    });

    expect(result).toEqual({ sent: 0, failed: 1 });
    // sendEmail should not have been called — the race was won by the other request
    expect(sendEmail).not.toHaveBeenCalled();
  });

  test("logs a warning when any notification fails", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Test", slug: "test" });
    const venue = insertVenue(rawDb, { name: "Venue" });
    const perf = insertBand(rawDb, {
      name: "Band",
      event_id: event.id,
      venue_id: venue.id,
    });
    const bandProfileId = perf.band_profile_id;

    const fId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", bandProfileId, "tok").lastInsertRowid;

    sendEmail.mockReset();
    sendEmail.mockImplementation(() => Promise.resolve({ delivered: false }));

    const warnSpy = vi.spyOn(loggerModule.logger, "warn");

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId,
      bandName: "Band",
      eventName: "Test",
      followers: [{ id: fId, email: "fan@example.com", unsubscribe_token: "tok" }],
    });

    expect(result.failed).toBeGreaterThan(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("partially failed"),
      expect.objectContaining({
        performanceId: perf.id,
        failed: result.failed,
      }),
    );
  });

  test("releases claim when email fails so resend can retry", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Test", slug: "test" });
    const venue = insertVenue(rawDb, { name: "Venue" });
    const perf = insertBand(rawDb, {
      name: "Band",
      event_id: event.id,
      venue_id: venue.id,
    });
    const bandProfileId = perf.band_profile_id;

    const fId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", bandProfileId, "tok").lastInsertRowid;

    sendEmail.mockReset();
    sendEmail.mockImplementation(() => Promise.resolve({ delivered: false }));

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId,
      bandName: "Band",
      eventName: "Test",
      followers: [{ id: fId, email: "fan@example.com", unsubscribe_token: "tok" }],
    });

    expect(result).toEqual({ sent: 0, failed: 1 });

    // The claim row should have been deleted — resend will pick up this follower
    const rows = rawDb
      .prepare("SELECT id FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
      .all(perf.id, fId);
    expect(rows).toHaveLength(0);
  });
  // Sender-level companions to the handler tests in
  // api/admin/bands/__tests__/resend-announcement.test.js.
  //
  // They exist BECAUSE the handler tests cannot prove these lines. The read
  // filter and the takeover's own delivered_at check are each independently
  // sufficient to stop a re-send, so breaking either one alone leaves every
  // handler test green -- verified by mutation, not assumed. Calling the
  // sender directly puts exactly one guard in play, which is what makes these
  // two able to fail.
  //
  // Both assert on sendEmail -- the side effect that actually reaches a
  // person -- rather than only the returned counts.
  test("takes over a claim that was never delivered and is past its lease", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Fest", slug: "fest" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, { name: "The Band", event_id: event.id, venue_id: venue.id });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("stranded@example.com", perf.band_profile_id, "tok-s").lastInsertRowid;

    // Exactly what a Worker killed between claiming and sending leaves behind.
    rawDb
      .prepare(
        `INSERT INTO band_follow_notifications (performance_id, band_follow_id, claimed_at, delivered_at)
         VALUES (?, ?, datetime('now', '-60 minutes'), NULL)`,
      )
      .run(perf.id, followId);

    sendEmail.mockResolvedValue({ delivered: true });

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId: perf.band_profile_id,
      bandName: "The Band",
      eventName: "Fest",
      followers: [{ id: followId, email: "stranded@example.com", unsubscribe_token: "tok-s" }],
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);

    const row = rawDb
      .prepare("SELECT delivered_at FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
      .get(perf.id, followId);
    expect(row.delivered_at).not.toBeNull();
  });

  test("never takes over a delivered row, however old the claim", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Fest", slug: "fest" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, { name: "The Band", event_id: event.id, venue_id: venue.id });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("done@example.com", perf.band_profile_id, "tok-d").lastInsertRowid;

    // A year past its lease -- but delivered. Age must not make it retryable,
    // or the first resend after the lease re-mails the whole history.
    rawDb
      .prepare(
        `INSERT INTO band_follow_notifications (performance_id, band_follow_id, claimed_at, delivered_at)
         VALUES (?, ?, datetime('now', '-365 days'), datetime('now', '-365 days'))`,
      )
      .run(perf.id, followId);

    sendEmail.mockResolvedValue({ delivered: true });

    const result = await notifyBandFollowers(env, env.DB, {
      performanceId: perf.id,
      bandProfileId: perf.band_profile_id,
      bandName: "The Band",
      eventName: "Fest",
      followers: [{ id: followId, email: "done@example.com", unsubscribe_token: "tok-d" }],
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });
});
