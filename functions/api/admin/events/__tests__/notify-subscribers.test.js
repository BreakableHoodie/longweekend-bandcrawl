import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestEnv, insertEvent } from "../../../test-utils.js";
import * as handler from "../[id]/notify-subscribers.js";
import { MAX_PER_INVOCATION, notifySubscribers, pendingSubscribers } from "../../../../utils/subscriberNotify.js";

vi.mock("../../../../utils/email.js", () => ({
  sendEmail: vi.fn(),
  isEmailConfigured: () => true,
}));
import { sendEmail } from "../../../../utils/email.js";

/**
 * The first sender the general subscriber list has ever had (#1149).
 *
 * email_subscriptions ran a working double opt-in since January while NOTHING
 * mailed it — /subscribe promised "Never Miss a Show" and delivered nothing.
 *
 * The fixtures below deliberately seed BOTH a verified and an unverified
 * subscriber in the gate test. On the band-follow path, ten test files all
 * seeded `verified = 1`, so deleting the gate left all 1,169 backend tests
 * green: no fixture could tell a gated query from an ungated one. A suite that
 * only seeds the passing case proves nothing about the gate it most needs to
 * prove.
 */
function sub(rawDb, { email, verified }) {
  return rawDb
    .prepare(
      "INSERT INTO email_subscriptions (email, city, genre, verified, unsubscribe_token) VALUES (?, 'KW', 'punk', ?, ?) RETURNING id",
    )
    .get(email, verified, `tok-${email}`);
}

const publish = (rawDb, id) => rawDb.prepare("UPDATE events SET status = 'published' WHERE id = ?").run(id);

function post(env, headers, id, body) {
  return handler.onRequestPost({
    request: new Request(`https://example.test/api/admin/events/${id}/notify-subscribers`, {
      method: "POST",
      headers: { ...Object.fromEntries(new Headers(headers).entries()), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    params: { id: String(id) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ delivered: true });
});

describe("POST /api/admin/events/[id]/notify-subscribers", () => {
  it("mails verified subscribers and never unverified ones", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "yes@example.com", verified: 1 });
    sub(rawDb, { email: "no@example.com", verified: 0 });

    const res = await post(env, headers, ev.id, { kind: "schedule_announced" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 1, failed: 0 });

    const to = sendEmail.mock.calls.map((c) => c[1].to);
    expect(to).toEqual(["yes@example.com"]);
  });

  it("is idempotent — a second call mails nobody twice", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    await post(env, headers, ev.id, { kind: "schedule_announced" });
    sendEmail.mockClear();
    const second = await post(env, headers, ev.id, { kind: "schedule_announced" });

    expect(sendEmail).not.toHaveBeenCalled();
    // Success, not an error: "everyone already has it" is what a second call
    // after a complete send looks like.
    expect(await second.json()).toMatchObject({ success: true, sent: 0 });
  });

  it("retries only the recipients whose send failed", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "ok@example.com", verified: 1 });
    sub(rawDb, { email: "bounces@example.com", verified: 1 });

    sendEmail.mockImplementation(async (_env, { to }) => ({ delivered: to === "ok@example.com" }));
    const first = await post(env, headers, ev.id, { kind: "schedule_announced" });
    expect(await first.json()).toMatchObject({ sent: 1, failed: 1 });

    // The claim for the failed address must have been RELEASED. Without that,
    // a transient failure drops that subscriber forever — the exact bug the
    // band-follow path replaced.
    sendEmail.mockClear();
    sendEmail.mockResolvedValue({ delivered: true });
    const second = await post(env, headers, ev.id, { kind: "schedule_announced" });

    expect(sendEmail.mock.calls.map((c) => c[1].to)).toEqual(["bounces@example.com"]);
    expect(await second.json()).toMatchObject({ sent: 1, failed: 0 });
  });

  it("treats each kind separately for the same event", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    await post(env, headers, ev.id, { kind: "lineup_announced" });
    sendEmail.mockClear();
    const res = await post(env, headers, ev.id, { kind: "schedule_announced" });

    // A lineup notice must not suppress a later schedule notice.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ sent: 1 });
  });

  // The claim only matters under CONCURRENCY. A sequential second call is
  // already filtered by pendingSubscribers, so the endpoint tests above pass
  // even with the claim check removed -- verified by mutation. This drives the
  // helper directly with the same pending list twice, which is the shape two
  // simultaneous requests produce.
  it("two concurrent sends mail each subscriber exactly once", async () => {
    const { env, rawDb } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });
    sub(rawDb, { email: "b@example.com", verified: 1 });

    const args = {
      eventId: ev.id,
      kind: "schedule_announced",
      eventName: "Vol. 18",
      eventSlug: "lwbc18",
      subject: "s",
      lead: "l",
    };
    const list = await pendingSubscribers(env.DB, { eventId: ev.id, kind: "schedule_announced" });
    expect(list).toHaveLength(2);

    const [first, second] = await Promise.all([
      notifySubscribers(env, env.DB, { ...args, subscribers: list }),
      notifySubscribers(env, env.DB, { ...args, subscribers: list }),
    ]);

    // Two runs over the same list: every address must be mailed once in total,
    // not once per run.
    expect(first.sent + second.sent).toBe(2);
    const to = sendEmail.mock.calls.map((c) => c[1].to).sort();
    expect(to).toEqual(["a@example.com", "b@example.com"]);
  });

  it("every email carries an unsubscribe link", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    await post(env, headers, ev.id, { kind: "schedule_announced" });
    const mail = sendEmail.mock.calls[0][1];
    expect(mail.text).toContain("/api/subscriptions/unsubscribe?token=");
    expect(mail.html).toContain("/api/subscriptions/unsubscribe?token=");
  });

  it("caps one invocation and reports what is left", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    const over = MAX_PER_INVOCATION + 5;
    for (let i = 0; i < over; i += 1) sub(rawDb, { email: `s${i}@example.com`, verified: 1 });

    const res = await post(env, headers, ev.id, { kind: "schedule_announced" });
    const body = await res.json();

    // Bounded: each subscriber costs ~3 subrequests, so an unbounded fan-out
    // over a long list exhausts the Worker's budget mid-send.
    expect(body.sent).toBe(MAX_PER_INVOCATION);
    // And the caller is told to come back, with the REAL figure.
    expect(body.remaining).toBe(5);

    const second = await post(env, headers, ev.id, { kind: "schedule_announced" });
    expect(await second.json()).toMatchObject({ sent: 5, remaining: 0 });
  });

  it("reports remaining from a re-query, not the pre-send count", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "ok@example.com", verified: 1 });
    sub(rawDb, { email: "bounces@example.com", verified: 1 });

    sendEmail.mockImplementation(async (_e, { to }) => ({ delivered: to === "ok@example.com" }));
    const body = await (await post(env, headers, ev.id, { kind: "schedule_announced" })).json();

    // The pre-send count was 2 either way. Only a re-query can say that one
    // address still needs a retry.
    expect(body).toMatchObject({ sent: 1, failed: 1, remaining: 1 });
  });

  it("refuses an unknown kind rather than mailing under a new key", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    // A typo must not become a fresh delivery key that re-mails everyone.
    const res = await post(env, headers, ev.id, { kind: "schedule_anounced" });
    expect(res.status).toBe(400);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["draft", "archived"])("refuses to mail about a %s event", async (status) => {
    const { env, rawDb, headers } = createTestEnv({ role: "editor" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    rawDb.prepare("UPDATE events SET status = ? WHERE id = ?").run(status, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    const res = await post(env, headers, ev.id, { kind: "schedule_announced" });
    expect(res.status).toBe(404);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("requires editor — a viewer cannot mail the list", async () => {
    const { env, rawDb, headers } = createTestEnv({ role: "viewer" });
    const ev = insertEvent(rawDb, { name: "Vol. 18", slug: "lwbc18" });
    publish(rawDb, ev.id);
    sub(rawDb, { email: "a@example.com", verified: 1 });

    const res = await post(env, headers, ev.id, { kind: "schedule_announced" });
    expect(res.status).toBe(403);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
