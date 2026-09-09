import { describe, expect, test } from "vitest";
import { onRequestPost } from "../build.js";
import { createTestEnv, insertBand, insertEvent, insertVenue } from "../../test-utils.js";

// Every event here is seeded `published`, and that is load-bearing rather than
// tidy. These fixtures used insertEvent's default -- `draft` -- and passed,
// because the handler inserted caller-supplied performance ids with no join to
// `events` at all (#1135). A fan cannot reach a draft event's ids: App.jsx
// builds this request from `eventData`, which comes from the already-gated
// schedule fetch. So the old fixtures asserted a state the product cannot
// produce, and their passing said nothing about the gate.
//
// Third instance of this exact shape in one session, after follow-batch (#1133)
// and the announce suite's ten `verified = 1` files. When a fixture uses a
// helper's DEFAULT for a column that gates visibility, check whether the
// default is the permissive value before trusting a green test.
describe("POST /api/schedule/build", () => {
  test("records schedule build for performance ids", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "Build Event", slug: "build-event", status: "published" });
    const venue = insertVenue(rawDb, { name: "Build Venue" });
    const performance = insertBand(rawDb, {
      name: "Build Band",
      event_id: event.id,
      venue_id: venue.id,
      start_time: "20:00",
      end_time: "21:00",
    });

    const request = new Request("https://example.test/api/schedule/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_id: event.id,
        performance_ids: [performance.id],
        user_session: "session-123",
      }),
    });

    const response = await onRequestPost({ request, env });
    expect(response.status).toBe(200);

    const row = rawDb.prepare("SELECT * FROM schedule_builds WHERE event_id = ?").get(event.id);
    expect(row).toMatchObject({
      event_id: event.id,
      performance_id: performance.id,
      user_session: "session-123",
    });
  });

  test("validates event_id", async () => {
    const { env } = createTestEnv();
    const request = new Request("https://example.test/api/schedule/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ performance_ids: [1], user_session: "session-123" }),
    });

    const response = await onRequestPost({ request, env });
    expect(response.status).toBe(400);
  });

  test("requires user_session", async () => {
    const { env } = createTestEnv();
    const request = new Request("https://example.test/api/schedule/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: 1, performance_ids: [1] }),
    });

    const response = await onRequestPost({ request, env });
    expect(response.status).toBe(400);
  });

  test("requires performance ids", async () => {
    const { env } = createTestEnv();
    const request = new Request("https://example.test/api/schedule/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_id: 1, user_session: "session-123" }),
    });

    const response = await onRequestPost({ request, env });
    expect(response.status).toBe(400);
  });
});

/**
 * The endpoint inserts CALLER-SUPPLIED performance ids (#1135), unauthenticated,
 * behind a rate limiter that fails open.
 *
 * Two defects, one fix. The oracle is the sharper one and the harder to test:
 * these assert that a nonexistent id and a valid id are INDISTINGUISHABLE from
 * outside -- same status, same body -- so the test has to compare two responses
 * rather than assert on one. Asserting only "200 for a bad id" would pass
 * against a handler that still leaked through some other channel.
 */
describe("POST /api/schedule/build — non-public ids are dropped, not reported", () => {
  const post = (env, body) =>
    onRequestPost({
      request: new Request("https://example.test/api/schedule/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
    });

  const buildRows = (rawDb) => rawDb.prepare("SELECT event_id, performance_id FROM schedule_builds").all();

  test("a nonexistent id is indistinguishable from a valid one", async () => {
    const { env, rawDb } = createTestEnv();
    const event = insertEvent(rawDb, { name: "E", slug: "oracle", status: "published" });
    const perf = insertBand(rawDb, { name: "Real Band", event_id: event.id });

    const valid = await post(env, { event_id: event.id, performance_ids: [perf.id], user_session: "s1" });
    const bogus = await post(env, { event_id: event.id, performance_ids: [999999], user_session: "s2" });

    // Before the fix: valid -> 200, nonexistent -> 500 (the FK error did not
    // contain "performance_id", so the legacy-schema catch rethrew it).
    expect(bogus.status).toBe(valid.status);
    expect(await bogus.text()).toBe(await valid.text());

    // And the bogus id wrote nothing.
    expect(buildRows(rawDb)).toEqual([{ event_id: event.id, performance_id: perf.id }]);
  });

  test("a performance on a draft event writes no row", async () => {
    const { env, rawDb } = createTestEnv();
    const live = insertEvent(rawDb, { name: "Live", slug: "b-live", status: "published" });
    const draft = insertEvent(rawDb, { name: "Draft", slug: "b-draft" });
    expect(rawDb.prepare("SELECT status FROM events WHERE id = ?").get(draft.id).status).toBe("draft");

    const hidden = insertBand(rawDb, { name: "Draft Band", event_id: draft.id });

    const res = await post(env, { event_id: draft.id, performance_ids: [hidden.id], user_session: "s3" });
    expect(res.status).toBe(200);
    expect(buildRows(rawDb)).toEqual([]);

    // Control: the same shape on a published event DOES write, so the test
    // above is showing a gate rather than a broken handler.
    const shown = insertBand(rawDb, { name: "Live Band", event_id: live.id });
    await post(env, { event_id: live.id, performance_ids: [shown.id], user_session: "s4" });
    expect(buildRows(rawDb)).toEqual([{ event_id: live.id, performance_id: shown.id }]);
  });

  test("an id belonging to a different event writes no row", async () => {
    const { env, rawDb } = createTestEnv();
    const ours = insertEvent(rawDb, { name: "Ours", slug: "b-ours", status: "published" });
    const other = insertEvent(rawDb, { name: "Other", slug: "b-other", status: "published" });
    const theirs = insertBand(rawDb, { name: "Their Band", event_id: other.id });

    // Both events are public, so a status gate alone would let this through --
    // only `p.event_id = ?` stops a caller inflating one event's build count
    // with another's performances.
    await post(env, { event_id: ours.id, performance_ids: [theirs.id], user_session: "s5" });
    expect(buildRows(rawDb)).toEqual([]);
  });

  test("an unannounced set on a staged-reveal event writes no row", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Reveal", slug: "b-reveal", status: "published" });
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(ev.id);
    const shown = insertBand(rawDb, { name: "Announced", event_id: ev.id });
    const hidden = insertBand(rawDb, { name: "Secret", event_id: ev.id });
    rawDb.prepare("UPDATE performances SET is_announced = 0 WHERE id = ?").run(hidden.id);

    // Both columns default to the permissive value; verify rather than assume.
    expect(rawDb.prepare("SELECT reveal_mode FROM events WHERE id = ?").get(ev.id).reveal_mode).toBe(1);
    expect(rawDb.prepare("SELECT is_announced FROM performances WHERE id = ?").get(hidden.id).is_announced).toBe(0);

    await post(env, { event_id: ev.id, performance_ids: [shown.id, hidden.id], user_session: "s6" });
    expect(buildRows(rawDb)).toEqual([{ event_id: ev.id, performance_id: shown.id }]);
  });
});
