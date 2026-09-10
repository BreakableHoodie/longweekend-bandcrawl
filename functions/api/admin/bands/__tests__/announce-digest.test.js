import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestEnv, insertEvent, insertVenue, insertBand } from "../../../test-utils.js";
import { flushAnnounceDigest } from "../../../../utils/announceDigest.js";
import { getPublicBaseUrl } from "../../../../utils/publicUrl.js";
import { logger } from "../../../../utils/logger.js";

vi.mock("../../../../utils/email.js", () => ({
  sendEmail: vi.fn(() => Promise.resolve({ delivered: true })),
  isEmailConfigured: () => true,
}));

import { sendEmail } from "../../../../utils/email.js";

describe("flushAnnounceDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends a single-band email when only one band is queued for a fan+event", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-single" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, {
      name: "The Band",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", perf.band_profile_id, "tok-unsub").lastInsertRowid;

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
       (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(followId, perf.id, ev.id, "The Band", "Fest", "fest-single", perf.band_profile_id);

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(0);
    expect(sendEmail).toHaveBeenCalledOnce();
    const [, { subject, text, html }] = sendEmail.mock.calls[0];
    expect(subject).toBe("The Band just joined the lineup for Fest!");

    // Regression: the "View the schedule" link must point at the singular
    // /event/:slug route (frontend/src/main.jsx), not the plural /events/
    // route (which only exists for /events/:slug/recap and 404s otherwise).
    const publicUrl = getPublicBaseUrl(env);
    const correctEventUrl = `${publicUrl}/event/fest-single`;
    const wrongEventUrl = `${publicUrl}/events/fest-single`;
    expect(text).toContain(correctEventUrl);
    expect(html).toContain(correctEventUrl);
    expect(text).not.toContain(wrongEventUrl);
    expect(html).not.toContain(wrongEventUrl);

    // Queue entry consumed
    const remaining = rawDb.prepare("SELECT * FROM band_announce_queue").all();
    expect(remaining).toHaveLength(0);
    // Notification row recorded
    const notif = rawDb.prepare("SELECT * FROM band_follow_notifications").all();
    expect(notif).toHaveLength(1);
  });

  it("sends a digest when a fan follows multiple announced bands on the same event", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Crawl", slug: "crawl-digest" });
    const venue = insertVenue(rawDb, { name: "Stage" });

    const perfA = insertBand(rawDb, {
      name: "Band A",
      event_id: ev.id,
      venue_id: venue.id,
    });
    const perfB = insertBand(rawDb, {
      name: "Band B",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const fanFollowA = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", perfA.band_profile_id, "tok-a").lastInsertRowid;

    const fanFollowB = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", perfB.band_profile_id, "tok-b").lastInsertRowid;

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
       (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fanFollowA, perfA.id, ev.id, "Band A", "Crawl", "crawl-digest", perfA.band_profile_id);

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
       (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fanFollowB, perfB.id, ev.id, "Band B", "Crawl", "crawl-digest", perfB.band_profile_id);

    const stats = await flushAnnounceDigest(env, env.DB);

    // One email for the fan, not two
    expect(stats.sent).toBe(1);
    expect(sendEmail).toHaveBeenCalledOnce();
    const [, { subject, text, html }] = sendEmail.mock.calls[0];
    expect(subject).toBe("2 bands you follow are playing Crawl!");

    // Regression: digest emails must also use the singular /event/:slug route.
    const publicUrl = getPublicBaseUrl(env);
    const correctEventUrl = `${publicUrl}/event/crawl-digest`;
    const wrongEventUrl = `${publicUrl}/events/crawl-digest`;
    expect(text).toContain(correctEventUrl);
    expect(html).toContain(correctEventUrl);
    expect(text).not.toContain(wrongEventUrl);
    expect(html).not.toContain(wrongEventUrl);

    // Both queue entries consumed, both notification rows written
    expect(rawDb.prepare("SELECT * FROM band_announce_queue").all()).toHaveLength(0);
    expect(rawDb.prepare("SELECT * FROM band_follow_notifications").all()).toHaveLength(2);
  });

  it("sends separate digests for different fans", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-fans" });
    const venue = insertVenue(rawDb, { name: "Spot" });
    const perf = insertBand(rawDb, {
      name: "Band X",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const f1 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan1@example.com", perf.band_profile_id, "tok-f1").lastInsertRowid;

    const f2 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan2@example.com", perf.band_profile_id, "tok-f2").lastInsertRowid;

    for (const [followId, _token] of [
      [f1, "tok-f1"],
      [f2, "tok-f2"],
    ]) {
      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, "Band X", "Fest", "fest-fans", perf.band_profile_id);
    }

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.sent).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it("returns empty stats when the queue is empty", async () => {
    const { env } = createTestEnv();
    const stats = await flushAnnounceDigest(env, env.DB);
    expect(stats).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("releases the claim and increments failed when send fails", async () => {
    const { env, rawDb } = createTestEnv();
    sendEmail.mockResolvedValueOnce({
      delivered: false,
      reason: "provider_error",
    });

    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-fail" });
    const venue = insertVenue(rawDb, { name: "Room" });
    const perf = insertBand(rawDb, {
      name: "Band Z",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fail@example.com", perf.band_profile_id, "tok-z").lastInsertRowid;

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
       (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(followId, perf.id, ev.id, "Band Z", "Fest", "fest-fail", perf.band_profile_id);

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.failed).toBe(1);
    // Queue consumed (won't retry via digest; resend-announcement handles recovery)
    expect(rawDb.prepare("SELECT * FROM band_announce_queue").all()).toHaveLength(0);
    // Claim released so resend-announcement can recover
    expect(rawDb.prepare("SELECT * FROM band_follow_notifications").all()).toHaveLength(0);
  });

  it("skips entries already claimed by a concurrent flush or resend", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-skip" });
    const venue = insertVenue(rawDb, { name: "Stage" });
    const perf = insertBand(rawDb, {
      name: "Band Q",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("skip@example.com", perf.band_profile_id, "tok-q").lastInsertRowid;

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
       (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(followId, perf.id, ev.id, "Band Q", "Fest", "fest-skip", perf.band_profile_id);

    // Simulate a concurrent resend that already claimed the notification row
    rawDb
      .prepare("INSERT INTO band_follow_notifications (performance_id, band_follow_id) VALUES (?, ?)")
      .run(perf.id, followId);

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.skipped).toBe(1);
    expect(stats.sent).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    // Queue entry still cleaned up
    expect(rawDb.prepare("SELECT * FROM band_announce_queue").all()).toHaveLength(0);
  });

  it("correctly tallies sent/failed/skipped across multiple groups when some sends fail", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Multi", slug: "multi-mixed" });
    const venue = insertVenue(rawDb, { name: "Hall" });

    const perfA = insertBand(rawDb, {
      name: "Band A",
      event_id: ev.id,
      venue_id: venue.id,
    });
    const perfB = insertBand(rawDb, {
      name: "Band B",
      event_id: ev.id,
      venue_id: venue.id,
    });
    const perfC = insertBand(rawDb, {
      name: "Band C",
      event_id: ev.id,
      venue_id: venue.id,
    });

    // fan1 follows Band A — send will succeed
    const f1 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan1@example.com", perfA.band_profile_id, "tok1").lastInsertRowid;

    // fan2 follows Band B — send will fail
    const f2 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan2@example.com", perfB.band_profile_id, "tok2").lastInsertRowid;

    // fan3 follows Band C — already claimed (skipped)
    const f3 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan3@example.com", perfC.band_profile_id, "tok3").lastInsertRowid;

    for (const [followId, perf] of [
      [f1, perfA],
      [f2, perfB],
      [f3, perfC],
    ]) {
      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, perf.name ?? "Band", "Multi", "multi-mixed", perf.band_profile_id);
    }

    // Pre-claim fan3's slot to simulate concurrent flush
    rawDb
      .prepare("INSERT INTO band_follow_notifications (performance_id, band_follow_id) VALUES (?, ?)")
      .run(perfC.id, f3);

    // First call succeeds (fan1), second fails (fan2)
    sendEmail
      .mockResolvedValueOnce({ delivered: true })
      .mockResolvedValueOnce({ delivered: false, reason: "provider_error" });

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.skipped).toBe(1);

    // All queue entries consumed
    expect(rawDb.prepare("SELECT * FROM band_announce_queue").all()).toHaveLength(0);

    // fan1's notification row kept; fan2's released; fan3's pre-existing row kept
    const notifs = rawDb.prepare("SELECT band_follow_id FROM band_follow_notifications ORDER BY band_follow_id").all();
    const followIds = notifs.map((n) => n.band_follow_id);
    expect(followIds).toContain(Number(f1));
    expect(followIds).not.toContain(Number(f2)); // released on failure
    expect(followIds).toContain(Number(f3)); // pre-existing, untouched
  });

  it("releases all claims for a failed group so resend can recover the whole digest", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-release" });
    const venue = insertVenue(rawDb, { name: "Stage" });

    const perfA = insertBand(rawDb, {
      name: "BandR1",
      event_id: ev.id,
      venue_id: venue.id,
    });
    const perfB = insertBand(rawDb, {
      name: "BandR2",
      event_id: ev.id,
      venue_id: venue.id,
    });

    const f1 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("release@example.com", perfA.band_profile_id, "tok-r1").lastInsertRowid;

    const f2 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("release@example.com", perfB.band_profile_id, "tok-r2").lastInsertRowid;

    for (const [followId, perf] of [
      [f1, perfA],
      [f2, perfB],
    ]) {
      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, perf.name ?? "Band", "Fest", "fest-release", perf.band_profile_id);
    }

    sendEmail.mockResolvedValueOnce({ delivered: false });

    const stats = await flushAnnounceDigest(env, env.DB);

    expect(stats.failed).toBe(1);
    expect(stats.sent).toBe(0);

    // Both claims for the failed digest group must be released
    expect(rawDb.prepare("SELECT * FROM band_follow_notifications").all()).toHaveLength(0);
    // Queue entries consumed regardless of send outcome
    expect(rawDb.prepare("SELECT * FROM band_announce_queue").all()).toHaveLength(0);
  });

  // #672: sendOne no longer lets an internal throw escape uncaught (the
  // claim-release failure path is now caught and counted inside sendOne
  // itself — see the dedicated tests below). This test exercises the
  // Promise.allSettled backstop for the case sendOne rejects anyway (here,
  // because sendEmail itself throws) — it must still log AND count the fan
  // as failed, so a future refactor that reintroduces a throw can't quietly
  // drop a fan from the returned counts.
  it("treats a thrown sendEmail as a delivery failure: releases claims, logs ids, counts it failed", async () => {
    const { env, rawDb } = createTestEnv();
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error("boom"));

    try {
      const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-throw" });
      const venue = insertVenue(rawDb, { name: "Room" });
      const perf = insertBand(rawDb, {
        name: "Band Throw",
        event_id: ev.id,
        venue_id: venue.id,
      });

      const followId = rawDb
        .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
        .run("throw@example.com", perf.band_profile_id, "tok-throw").lastInsertRowid;

      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, "Band Throw", "Fest", "fest-throw", perf.band_profile_id);

      const stats = await flushAnnounceDigest(env, env.DB);

      // A throw must take the SAME path as `{ delivered: false }`. Previously
      // sendEmail was unguarded, so a throw skipped the claim release entirely
      // and the fan was stranded with a surviving notification row.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("sendEmail threw"),
        expect.objectContaining({
          performance_id: perf.id,
          band_follow_id: Number(followId),
          error: expect.any(Error),
        }),
      );
      expect(stats.failed).toBe(1);
      expect(stats.sent).toBe(0);

      // The claim must be released, so resend-announcement can recover the fan.
      const claims = rawDb
        .prepare("SELECT * FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
        .all(perf.id, Number(followId));
      expect(claims).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
  });

  describe("#672: claim-release failure inside sendOne", () => {
    // Stubs DB.batch to throw ONLY for the phase-B claim-release batch (the
    // `DELETE FROM band_follow_notifications` statements announceDigest.js
    // issues on delivery failure), simulating a D1 failure specific to the
    // release path described in #672. Every other batch call — including the
    // phase-A band_announce_queue cleanup that runs per group — passes
    // through to the real implementation unchanged.
    //
    // Identifies the release batch by inspecting each statement's SQL text
    // (exposed by test-utils.js's DB shim as `.sql`) rather than counting
    // calls: a call-counter stub silently fails the WRONG statement if
    // another DB.batch() call is ever added ahead of the release (e.g. more
    // phase-A cleanup), and the release path stops being exercised without
    // any test going red (#695).
    function stubBatchToFailOnClaimRelease(env) {
      const originalBatch = env.DB.batch.bind(env.DB);
      return vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
        // Normalise whitespace/case before matching: a harmless SQL reflow or
        // casing change in announceDigest.js would otherwise make the
        // release batch silently forward to originalBatch(), leaving the
        // release path unexercised while the tests stayed green.
        // Match the FULL predicate, not just the table: another batch deleting
        // from band_follow_notifications would otherwise trip the simulated
        // failure before the claim-release runs, leaving that path unexercised
        // while this test still passed.
        const isClaimRelease = statements.some((stmt) => {
          const sql = typeof stmt.sql === "string" ? stmt.sql.replace(/\s+/g, " ").trim().toUpperCase() : "";
          return sql.includes("DELETE FROM BAND_FOLLOW_NOTIFICATIONS WHERE PERFORMANCE_ID = ? AND BAND_FOLLOW_ID = ?");
        });
        if (isClaimRelease) {
          throw new Error("simulated D1 batch failure");
        }
        return originalBatch(statements);
      });
    }

    it("counts a claim-release failure as failed and logs the ids for manual recovery", async () => {
      const { env, rawDb } = createTestEnv();
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

      const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-release-fail" });
      const venue = insertVenue(rawDb, { name: "Room" });
      const perf = insertBand(rawDb, {
        name: "Band Fail",
        event_id: ev.id,
        venue_id: venue.id,
      });

      const followId = rawDb
        .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
        .run("release-fail@example.com", perf.band_profile_id, "tok-release-fail").lastInsertRowid;

      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, "Band Fail", "Fest", "fest-release-fail", perf.band_profile_id);

      // Delivery fails, which is what triggers the claim-release DB.batch.
      sendEmail.mockResolvedValueOnce({ delivered: false, reason: "provider_error" });
      const batchSpy = stubBatchToFailOnClaimRelease(env);

      try {
        const stats = await flushAnnounceDigest(env, env.DB);

        // The fan must be visible in the counts, not silently dropped.
        expect(stats.sent).toBe(0);
        expect(stats.failed).toBe(1);
        expect(stats.skipped).toBe(0);

        // Identifying ids are logged so the row can be found and cleared
        // by hand — no email address is logged (this module never logs
        // addresses; see functions/utils/logger.js SENSITIVE_KEYS).
        expect(errorSpy).toHaveBeenCalledWith(
          "announce digest claim release failed; fan requires manual recovery",
          expect.objectContaining({
            performance_id: perf.id,
            band_follow_id: Number(followId),
            error: expect.any(Error),
          }),
        );

        // The existing failed > 0 warning must still fire.
        expect(warnSpy).toHaveBeenCalledWith(
          "announce digest partially failed",
          expect.objectContaining({ sent: 0, failed: 1, skipped: 0 }),
        );
      } finally {
        batchSpy.mockRestore();
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    // This is the important residual-limitation check: a claim-release
    // failure is deliberately NOT retried (see the comment in
    // announceDigest.js), so the band_follow_notifications row survives.
    // resend-announcement.js only recovers followers WITHOUT a notification
    // row, so this fan is NOT automatically recoverable — only identifiable
    // via the logged ids above for manual (human) recovery.
    it("leaves the fan unrecoverable via resend-announcement's query after a claim-release failure", async () => {
      const { env, rawDb } = createTestEnv();
      vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.spyOn(logger, "warn").mockImplementation(() => {});

      const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-recovery-check" });
      const venue = insertVenue(rawDb, { name: "Room" });
      const perf = insertBand(rawDb, {
        name: "Band Stranded",
        event_id: ev.id,
        venue_id: venue.id,
      });

      const followId = rawDb
        .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
        .run("stranded@example.com", perf.band_profile_id, "tok-stranded").lastInsertRowid;

      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followId, perf.id, ev.id, "Band Stranded", "Fest", "fest-recovery-check", perf.band_profile_id);

      sendEmail.mockResolvedValueOnce({ delivered: false, reason: "provider_error" });
      const batchSpy = stubBatchToFailOnClaimRelease(env);

      try {
        const stats = await flushAnnounceDigest(env, env.DB);
        expect(stats.failed).toBe(1);

        // The claim row survives the failed release.
        const notif = rawDb
          .prepare("SELECT * FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
          .get(perf.id, followId);
        expect(notif).toBeDefined();

        // This mirrors the exact SELECT resend-announcement.js uses
        // (functions/api/admin/bands/[id]/resend-announcement.js) to find
        // followers still owed an announcement for this performance.
        const recoverable = rawDb
          .prepare(
            `SELECT bf.id, bf.email, bf.unsubscribe_token
             FROM band_follows bf
             LEFT JOIN band_follow_notifications bfn
               ON bfn.band_follow_id = bf.id AND bfn.performance_id = ?
             WHERE bf.band_profile_id = ? AND bf.verified = 1 AND bfn.id IS NULL`,
          )
          .all(perf.id, perf.band_profile_id);

        // Because the notification row survived, the LEFT JOIN matches it
        // and `bfn.id IS NULL` excludes this follower — resend-announcement
        // will NOT pick this fan up. Documented residual limitation.
        expect(recoverable.find((f) => Number(f.id) === Number(followId))).toBeUndefined();
      } finally {
        batchSpy.mockRestore();
        vi.restoreAllMocks();
      }
    });
  });

  describe("#732 MAJOR: Phase A claim batch failure-injection", () => {
    // Poisons the specific claim statement (INSERT OR IGNORE INTO
    // band_follow_notifications for one (performance_id, band_follow_id)
    // pair) so it throws on execution. This is deliberately done at the
    // DB.prepare/.bind() layer, not at DB.batch() — a per-item loop executes
    // the poisoned statement via a direct `.run()`, while a per-group batch
    // executes the SAME bound statement object inside `DB.batch([...])`.
    // Poisoning at this layer means the test exercises the real defect
    // (CodeRabbit #732 MAJOR: "Phase A claims notification-ledger rows in a
    // per-item loop with no error handling") against whichever code shape is
    // live, rather than assuming the fix's own DB.batch() call already
    // exists.
    function stubClaimToThrow(env, { performanceId, followId }) {
      const originalPrepare = env.DB.prepare.bind(env.DB);
      return vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
        const wrapper = originalPrepare(sql);
        const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
        if (!normalized.startsWith("INSERT OR IGNORE INTO BAND_FOLLOW_NOTIFICATIONS")) {
          return wrapper;
        }
        const originalBind = wrapper.bind.bind(wrapper);
        return {
          ...wrapper,
          bind(...args) {
            const [boundPerformanceId, boundFollowId] = args;
            if (Number(boundPerformanceId) === Number(performanceId) && Number(boundFollowId) === Number(followId)) {
              const poisoned = () => {
                throw new Error("simulated D1 claim failure");
              };
              return { sql, run: poisoned, all: poisoned, first: poisoned };
            }
            return originalBind(...args);
          },
        };
      });
    }

    it("still delivers an earlier group's email, leaves the failing group's queue rows for retry, and claims no orphan notification row for it", async () => {
      const { env, rawDb } = createTestEnv();
      const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
      const ev = insertEvent(rawDb, { name: "Batch Fest", slug: "batch-fail-fest" });
      const venue = insertVenue(rawDb, { name: "Batch Hall" });

      // Same event, so group order is driven by email — "a-..." sorts before
      // "z-..." in the flush's own `ORDER BY q.event_id, bf.email,
      // q.queued_at`, making group A the "earlier, already prepared" group
      // and group B the "later" one whose claim fails.
      const perfA = insertBand(rawDb, { name: "Band Early", event_id: ev.id, venue_id: venue.id });
      const perfB = insertBand(rawDb, { name: "Band Late", event_id: ev.id, venue_id: venue.id });

      const followA = rawDb
        .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
        .run("a-claim-fail@example.com", perfA.band_profile_id, "tok-a-claim").lastInsertRowid;
      const followB = rawDb
        .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
        .run("z-claim-fail@example.com", perfB.band_profile_id, "tok-b-claim").lastInsertRowid;

      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followA, perfA.id, ev.id, "Band Early", "Batch Fest", "batch-fail-fest", perfA.band_profile_id);
      rawDb
        .prepare(
          `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(followB, perfB.id, ev.id, "Band Late", "Batch Fest", "batch-fail-fest", perfB.band_profile_id);

      const queueRowB = rawDb.prepare("SELECT id FROM band_announce_queue WHERE band_follow_id = ?").get(followB);

      const prepareSpy = stubClaimToThrow(env, { performanceId: perfB.id, followId: followB });

      try {
        const stats = await flushAnnounceDigest(env, env.DB);

        // (a) group A was already fully prepared (claimed + queue row
        // deleted) before group B's claim throws — its email must still go
        // out. Under the pre-fix per-item loop, group B's throw propagates
        // out of the whole flush before Phase B (delivery) ever runs, so
        // sendEmail is never called at all and this assertion is what fails.
        expect(sendEmail).toHaveBeenCalledOnce();
        const [, { subject }] = sendEmail.mock.calls[0];
        expect(subject).toContain("Band Early");
        expect(stats.sent).toBe(1);

        // (b) group B's queue row survives, retryable on the next flush —
        // proves the failure was handled locally rather than aborting with
        // the row already deleted.
        const remaining = rawDb.prepare("SELECT id FROM band_announce_queue WHERE id = ?").get(queueRowB.id);
        expect(remaining).toBeDefined();

        // (c) the atomicity proof: no orphan notification row for group B.
        // A non-batched (or partially-batched) implementation could commit
        // the claim before hitting the failure that aborts the delete/send —
        // stranding this follower exactly like #672, but with no queue row
        // left behind to explain why resend-announcement never finds them.
        const orphan = rawDb
          .prepare("SELECT * FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
          .get(perfB.id, followB);
        expect(orphan).toBeUndefined();

        // The batch failure is logged so a human can see it happened.
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        prepareSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
  // Failure-path code, so it is tested by BREAKING the thing it guards -- the
  // happy path never enters this catch. Sibling of the same case in
  // functions/utils/__tests__/bandFollowNotify.test.js; this one was missed on
  // the first pass and caught by review, which is the sweep working late.
  it("counts a digest as sent when the delivery-confirmation batch fails", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Fest", slug: "fest-confirm-fails" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, { name: "The Band", event_id: ev.id, venue_id: venue.id });

    const followId = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("fan@example.com", perf.band_profile_id, "tok-cf").lastInsertRowid;

    rawDb
      .prepare(
        `INSERT INTO band_announce_queue
         (band_follow_id, performance_id, event_id, band_name, event_name, event_slug, band_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(followId, perf.id, ev.id, "The Band", "Fest", "fest-confirm-fails", perf.band_profile_id);

    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});

    // Break ONLY the confirmation batch. The claim batch must still succeed --
    // otherwise nothing is ever sent and the test proves nothing about this
    // branch. The two are told apart by the statement the confirmation writes.
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = (statements) => {
      const isConfirmation = statements.some((st) =>
        String(st?.sql ?? st?.statement ?? "").includes("SET delivered_at"),
      );
      if (isConfirmation) return Promise.reject(new Error("D1 batch failed"));
      return realBatch(statements);
    };

    const stats = await flushAnnounceDigest(env, env.DB);

    // The email went out. Reporting it failed would invite the resend that is
    // the one action turning a lost write into a duplicate (#1153).
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(stats.sent).toBe(1);
    expect(stats.failed).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });
});
