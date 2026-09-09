import { describe, it, expect } from "vitest";
import { createTestEnv, insertBand, insertEvent } from "../../test-utils";
import * as followBatchHandler from "../follow-batch.js";
import * as confirmBatchHandler from "../confirm-follow-batch.js";

// waitUntil in tests: run the promise synchronously so email side-effects
// execute before assertions (mirrors follow.test.js pattern).
//
// EVERY event below is seeded `published`, and that is load-bearing rather than
// tidy. These fixtures used insertEvent's default -- `draft` -- and passed,
// because the handler resolved caller-supplied performance ids with no join to
// `events` at all (#1133). A fan cannot reach a draft event's ids: the panel
// that posts them renders from MySchedule / SharePreviewPage, both fed by
// already-gated published data. So the old fixtures asserted an unreachable
// state, and their passing said nothing about the gate -- the same shape as the
// ten announce test files that all seeded `verified = 1` and so could not
// distinguish a gated recipient query from an ungated one.
//
// The draft and unannounced cases now have their own tests below.
const waitUntil = (p) => p;

describe("POST /api/bands/follow-batch", () => {
  it("inserts N verified=0 rows all sharing one batch_token", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-batch", status: "published" });
    const b1 = insertBand(rawDb, { name: "Alpha", event_id: ev.id });
    const b2 = insertBand(rawDb, { name: "Beta", event_id: ev.id });
    const b3 = insertBand(rawDb, { name: "Gamma", event_id: ev.id });

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "fan@example.com",
        performance_ids: [b1.id, b2.id, b3.id],
      }),
    });
    const res = await followBatchHandler.onRequestPost({
      request: req,
      env,
      waitUntil,
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const rows = rawDb.prepare("SELECT * FROM band_follows WHERE email = ? ORDER BY id").all("fan@example.com");

    // Three rows — one per band
    expect(rows).toHaveLength(3);

    // Security invariant: every row must be unverified
    for (const row of rows) {
      expect(row.verified).toBe(0);
      expect(row.verification_token).toBeTruthy();
      expect(row.unsubscribe_token).toBeTruthy();
      expect(row.consent_method).toBe("web_form");
    }

    // All three rows share the same batch_token
    const tokens = new Set(rows.map((r) => r.batch_token));
    expect(tokens.size).toBe(1);
    expect([...tokens][0]).toBeTruthy();
  });

  it("returns confirmUrl in dev (email unconfigured) instead of sending email", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-confirmurl", status: "published" });
    const b1 = insertBand(rawDb, { name: "Dev Band A", event_id: ev.id });
    const b2 = insertBand(rawDb, { name: "Dev Band B", event_id: ev.id });

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dev@example.com",
        performance_ids: [b1.id, b2.id],
      }),
    });
    const res = await followBatchHandler.onRequestPost({
      request: req,
      env,
      waitUntil,
    });

    const data = await res.json();
    expect(data.success).toBe(true);
    // Dev env: email not configured → confirmUrl included
    expect(data.confirmUrl).toMatch(/\/api\/bands\/confirm-follow-batch\?token=/);
  });

  it("is idempotent — re-submitting the same email returns 200 with no duplicate rows", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-idempotent", status: "published" });
    const b1 = insertBand(rawDb, { name: "Idem Band", event_id: ev.id });

    const makeReq = () =>
      new Request("https://example.test/api/bands/follow-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "idem@example.com",
          performance_ids: [b1.id],
        }),
      });

    const r1 = await followBatchHandler.onRequestPost({ request: makeReq(), env, waitUntil });
    const r2 = await followBatchHandler.onRequestPost({ request: makeReq(), env, waitUntil });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = rawDb.prepare("SELECT * FROM band_follows WHERE email = ?").all("idem@example.com");
    // INSERT OR IGNORE: no duplicate rows
    expect(rows).toHaveLength(1);
  });

  it("no-enumeration: existing follows return 200 without leaking state", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-noenum", status: "published" });
    const band = insertBand(rawDb, { name: "Existing Band", event_id: ev.id });

    // Pre-seed a verified follow
    rawDb
      .prepare("INSERT INTO band_follows (email, band_profile_id, verified, unsubscribe_token) VALUES (?, ?, 1, ?)")
      .run("existing@example.com", band.band_profile_id, "existing-unsub");

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "existing@example.com",
        performance_ids: [band.id],
      }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // No confirmUrl leaked — no new row was created
    expect(data.confirmUrl).toBeUndefined();

    // Original verified row untouched; no duplicate
    const rows = rawDb.prepare("SELECT * FROM band_follows WHERE email = ?").all("existing@example.com");
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(1);
  });

  it("returns 400 for an invalid email", async () => {
    const { env } = createTestEnv();

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", performance_ids: [1] }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/email/i);
  });

  it("returns 400 when performance_ids is missing", async () => {
    const { env } = createTestEnv();

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com" }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(400);
  });

  it("returns 400 when performance_ids is empty", async () => {
    const { env } = createTestEnv();

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com", performance_ids: [] }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(400);
  });

  it(`returns 400 when performance_ids exceeds MAX_BATCH_SIZE (30)`, async () => {
    const { env } = createTestEnv();
    const tooMany = Array.from({ length: 31 }, (_, i) => i + 1);

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com", performance_ids: tooMany }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(400);
  });

  it("returns 400 when performance_ids contains non-integers", async () => {
    const { env } = createTestEnv();

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com", performance_ids: ["one", 2] }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(400);
  });

  it("returns 200 silently when all performance_ids are unknown (no enumeration)", async () => {
    const { env } = createTestEnv();

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "fan@example.com", performance_ids: [99999, 99998] }),
    });
    const res = await followBatchHandler.onRequestPost({ request: req, env, waitUntil });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it("records consent_ip from CF-Connecting-IP", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-ip", status: "published" });
    const band = insertBand(rawDb, { name: "IP Band Batch", event_id: ev.id });

    const req = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.10",
      },
      body: JSON.stringify({ email: "ip@example.com", performance_ids: [band.id] }),
    });
    await followBatchHandler.onRequestPost({ request: req, env, waitUntil });

    const row = rawDb.prepare("SELECT consent_ip FROM band_follows WHERE email = ?").get("ip@example.com");
    expect(row.consent_ip).toBe("203.0.113.10");
  });
});

describe("GET /api/bands/confirm-follow-batch", () => {
  it("verifies all pending follows in the batch and clears batch_token", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-confirm-batch", status: "published" });
    const b1 = insertBand(rawDb, { name: "Confirm A", event_id: ev.id });
    const b2 = insertBand(rawDb, { name: "Confirm B", event_id: ev.id });

    // Create the batch follows
    const followReq = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "confirmbatch@example.com",
        performance_ids: [b1.id, b2.id],
      }),
    });
    const followRes = await followBatchHandler.onRequestPost({
      request: followReq,
      env,
      waitUntil,
    });
    const { confirmUrl } = await followRes.json();
    expect(confirmUrl).toBeTruthy();

    const batchToken = new URL(confirmUrl).searchParams.get("token");
    expect(batchToken).toBeTruthy();

    // Verify both rows are pending before confirm
    const pending = rawDb.prepare("SELECT verified FROM band_follows WHERE email = ?").all("confirmbatch@example.com");
    expect(pending.every((r) => r.verified === 0)).toBe(true);

    // Confirm the batch
    const confirmReq = new Request(`https://example.test/api/bands/confirm-follow-batch?token=${batchToken}`);
    const confirmRes = await confirmBatchHandler.onRequestGet({
      request: confirmReq,
      env,
    });
    expect(confirmRes.status).toBe(200);
    const html = await confirmRes.text();
    expect(html).toMatch(/you're all set/i);

    // All rows now verified=1, batch_token cleared
    const confirmed = rawDb
      .prepare("SELECT verified, batch_token FROM band_follows WHERE email = ?")
      .all("confirmbatch@example.com");
    expect(confirmed).toHaveLength(2);
    for (const row of confirmed) {
      expect(row.verified).toBe(1);
      expect(row.batch_token).toBeNull();
    }
  });

  it("is idempotent — a second click on a used token still returns 200", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Vol17", slug: "vol17-idem-confirm", status: "published" });
    const band = insertBand(rawDb, { name: "Idem Confirm", event_id: ev.id });

    const followReq = new Request("https://example.test/api/bands/follow-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "idem2@example.com",
        performance_ids: [band.id],
      }),
    });
    const followRes = await followBatchHandler.onRequestPost({
      request: followReq,
      env,
      waitUntil,
    });
    const { confirmUrl } = await followRes.json();
    const batchToken = new URL(confirmUrl).searchParams.get("token");

    const makeConfirmReq = () => new Request(`https://example.test/api/bands/confirm-follow-batch?token=${batchToken}`);

    const first = await confirmBatchHandler.onRequestGet({ request: makeConfirmReq(), env });
    const second = await confirmBatchHandler.onRequestGet({ request: makeConfirmReq(), env });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Row still verified=1 after both clicks
    const row = rawDb.prepare("SELECT verified FROM band_follows WHERE email = ?").get("idem2@example.com");
    expect(row.verified).toBe(1);
  });

  it("returns 400 for a missing token", async () => {
    const { env } = createTestEnv();
    const req = new Request("https://example.test/api/bands/confirm-follow-batch");
    const res = await confirmBatchHandler.onRequestGet({ request: req, env });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an oversized token", async () => {
    const { env } = createTestEnv();
    const longToken = "a".repeat(257);
    const req = new Request(`https://example.test/api/bands/confirm-follow-batch?token=${longToken}`);
    const res = await confirmBatchHandler.onRequestGet({ request: req, env });
    expect(res.status).toBe(400);
  });

  it("returns 200 for an unknown token (no enumeration)", async () => {
    const { env } = createTestEnv();
    const req = new Request("https://example.test/api/bands/confirm-follow-batch?token=nonexistent-batch-token");
    const res = await confirmBatchHandler.onRequestGet({ request: req, env });
    // Unknown token: changes=0, but we still show the success page (generic/no-enumeration)
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/you're all set/i);
  });
});

/**
 * The band list is resolved from CALLER-SUPPLIED performance ids (#1133).
 *
 * The HTTP response deliberately reveals nothing -- `{ success: true }` either
 * way, so it never enumerates which ids were valid. But the confirmation email
 * LISTS THE BAND NAMES, so an ungated resolve enumerated over email exactly
 * what the response refuses to enumerate over HTTP.
 *
 * These assert on the PERSISTED FOLLOW ROWS, not the status code, for that
 * reason: a test that checked the response could not fail, because the response
 * is identical in both directions by design. The rows are a sound proxy for the
 * email rather than a substitute -- the INSERTs and the email's band list are
 * built from the same `bands.results` set -- but no email BODY is inspected
 * here, so do not read these as email-content coverage.
 */
describe("POST /api/bands/follow-batch — non-public bands are never resolved", () => {
  const waitUntilSync = (p) => p;

  function post(env, performance_ids) {
    return followBatchHandler.onRequestPost({
      request: new Request("https://example.test/api/bands/follow-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fan@example.com", performance_ids }),
      }),
      env,
      waitUntil: waitUntilSync,
    });
  }

  it("omits a band whose only performance is on a draft event", async () => {
    const { env, rawDb } = createTestEnv();
    const live = insertEvent(rawDb, { name: "Live", slug: "gate-live", status: "published" });
    const draft = insertEvent(rawDb, { name: "Draft", slug: "gate-draft" });
    expect(rawDb.prepare("SELECT status FROM events WHERE id = ?").get(draft.id).status).toBe("draft");

    const ok = insertBand(rawDb, { name: "Public Act", event_id: live.id });
    const secret = insertBand(rawDb, { name: "Unannounced Draft Act", event_id: draft.id });

    const res = await post(env, [ok.id, secret.id]);
    expect(res.status).toBe(200);

    const rows = rawDb
      .prepare("SELECT bp.name FROM band_follows bf JOIN band_profiles bp ON bp.id = bf.band_profile_id")
      .all();
    const followed = rows.map((r) => r.name);
    expect(followed).toContain("Public Act");
    expect(followed).not.toContain("Unannounced Draft Act");
  });

  it("omits an unannounced set on a staged-reveal event, keeping its announced sibling", async () => {
    const { env, rawDb } = createTestEnv();
    const ev = insertEvent(rawDb, { name: "Reveal", slug: "gate-reveal", status: "published" });
    rawDb.prepare("UPDATE events SET reveal_mode = 1 WHERE id = ?").run(ev.id);

    const shown = insertBand(rawDb, { name: "Announced Act", event_id: ev.id });
    const hidden = insertBand(rawDb, { name: "Secret Headliner", event_id: ev.id });
    rawDb.prepare("UPDATE performances SET is_announced = 0 WHERE id = ?").run(hidden.id);

    // Both columns default to the PERMISSIVE value, so verify rather than assume.
    expect(rawDb.prepare("SELECT reveal_mode FROM events WHERE id = ?").get(ev.id).reveal_mode).toBe(1);
    expect(rawDb.prepare("SELECT is_announced FROM performances WHERE id = ?").get(hidden.id).is_announced).toBe(0);
    expect(rawDb.prepare("SELECT is_announced FROM performances WHERE id = ?").get(shown.id).is_announced).toBe(1);

    await post(env, [shown.id, hidden.id]);

    const followed = rawDb
      .prepare("SELECT bp.name FROM band_follows bf JOIN band_profiles bp ON bp.id = bf.band_profile_id")
      .all()
      .map((r) => r.name);
    // The announced sibling proves the gate withholds rather than empties.
    expect(followed).toEqual(["Announced Act"]);
  });
});
