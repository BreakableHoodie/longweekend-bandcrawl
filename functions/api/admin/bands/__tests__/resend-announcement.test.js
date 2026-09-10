import { describe, expect, test, vi } from "vitest";

vi.mock("../../_middleware.js", () => ({
  checkPermission: async (context) => {
    const role = context?.data?.user?.role || context?.request?.headers?.get("x-test-role");
    if (!role) {
      return {
        error: true,
        response: new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      };
    }
    return { error: false, user: { userId: 1, email: "admin@x.co", role }, userId: 1 };
  },
  auditLog: vi.fn(async () => {}),
}));

vi.mock("../../../../utils/email.js", () => ({
  isEmailConfigured: () => true,
  sendEmail: vi.fn(() => Promise.resolve({ delivered: true })),
}));

import { onRequestPost } from "../[id]/resend-announcement.js";
import { createTestEnv, insertEvent, insertVenue, insertBand } from "../../../test-utils.js";

describe("POST /api/admin/bands/[id]/resend-announcement", () => {
  test("resends only to followers not yet notified for the performance", async () => {
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
      .run("a@x.co", bandProfileId, "tok-a").lastInsertRowid;
    const f2 = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("b@x.co", bandProfileId, "tok-b").lastInsertRowid;

    // f1 was already notified for this performance.
    rawDb
      .prepare("INSERT INTO band_follow_notifications (performance_id, band_follow_id) VALUES (?, ?)")
      .run(perf.id, f1);

    const res = await onRequestPost({
      request: new Request(`https://example.test/api/admin/bands/${perf.id}/resend-announcement`, {
        method: "POST",
        headers: { "x-test-role": "editor" },
      }),
      params: { id: String(perf.id) },
      env,
      data: { user: { userId: 1, email: "admin@x.co", role: "editor" } },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(0);

    const notified = rawDb
      .prepare("SELECT band_follow_id FROM band_follow_notifications WHERE performance_id = ? ORDER BY band_follow_id")
      .all(perf.id);
    expect(notified.map((r) => r.band_follow_id)).toEqual([f1, f2]);
  });
  // The two cases #1152 exists for. They are a PAIR: the first alone is
  // satisfied by making everything retryable, which would re-mail the entire
  // history, so neither is meaningful without the other.
  //
  // Seeding claimed_at/delivered_at directly is the point -- a killed Worker
  // is not reproducible from the handler, and the row it strands is exactly
  // what these rows are.
  test("retries a claim that was never delivered and is past its lease", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Fest", slug: "fest" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, {
      name: "The Band",
      event_id: event.id,
      venue_id: venue.id,
    });

    const stranded = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("stranded@x.co", perf.band_profile_id, "tok-stranded").lastInsertRowid;

    // What a Worker that died between claiming and sending leaves behind:
    // claimed, never delivered, lease long expired.
    rawDb
      .prepare(
        `INSERT INTO band_follow_notifications (performance_id, band_follow_id, claimed_at, delivered_at)
         VALUES (?, ?, datetime('now', '-60 minutes'), NULL)`,
      )
      .run(perf.id, stranded);

    const res = await onRequestPost({
      request: new Request(`https://example.test/api/admin/bands/${perf.id}/resend-announcement`, {
        method: "POST",
        headers: { "x-test-role": "editor" },
      }),
      params: { id: String(perf.id) },
      env,
      data: { user: { userId: 1, email: "admin@x.co", role: "editor" } },
    });

    expect(res.status).toBe(200);
    // Before #1152 this was 0: the claim row alone filtered the fan out of
    // every future run, so the send was dropped permanently and silently.
    expect((await res.json()).sent).toBe(1);

    const row = rawDb
      .prepare("SELECT delivered_at FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
      .get(perf.id, stranded);
    expect(row.delivered_at).not.toBeNull();
  });

  test("never retries a delivered row, however old the claim", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Fest", slug: "fest" });
    const venue = insertVenue(rawDb, { name: "Hall" });
    const perf = insertBand(rawDb, {
      name: "The Band",
      event_id: event.id,
      venue_id: venue.id,
    });

    const delivered = rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("delivered@x.co", perf.band_profile_id, "tok-delivered").lastInsertRowid;

    // A year past its lease, but DELIVERED. Age must not make it retryable.
    rawDb
      .prepare(
        `INSERT INTO band_follow_notifications (performance_id, band_follow_id, claimed_at, delivered_at)
         VALUES (?, ?, datetime('now', '-365 days'), datetime('now', '-365 days'))`,
      )
      .run(perf.id, delivered);

    const res = await onRequestPost({
      request: new Request(`https://example.test/api/admin/bands/${perf.id}/resend-announcement`, {
        method: "POST",
        headers: { "x-test-role": "editor" },
      }),
      params: { id: String(perf.id) },
      env,
      data: { user: { userId: 1, email: "admin@x.co", role: "editor" } },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(0);
  });
});
