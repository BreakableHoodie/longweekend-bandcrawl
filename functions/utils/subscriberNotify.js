// Shared "something happened with this event" notification logic for the
// general subscriber list (#1149).
//
// email_subscriptions had a working double opt-in, an unsubscribe token, and a
// `last_email_sent` column since January -- and no sender at all. /subscribe
// promised "Never Miss a Show" and delivered nothing to anyone.
//
// Deliberately modelled on bandFollowNotify.js rather than written fresh: that
// path already solved per-recipient recovery, and its failure mode is recorded
// in CLAUDE.md ("do not reintroduce a fire-once latch without per-follower
// tracking -- it silently drops fans whose first send failed"). The same
// applies here, so the same shape applies: CLAIM before sending, release the
// claim if delivery fails, and let a later resend pick up only the gaps.
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { getPublicBaseUrl } from "./publicUrl.js";
import { escapeHtml } from "./html.js";

// Mirrors announceDigest.js, which bounds its sends for the same reason.
//
// NOT TEST-COVERED, and cannot be: chunk size changes how many sends are in
// flight at once, not what any of them do, so no behavioural assertion can tell
// 8 from 800. Verified by mutation -- raising it leaves the suite green. It is a
// resource bound, and the bound that IS testable is MAX_PER_INVOCATION below,
// which changes the observable result.
const SEND_CONCURRENCY = 8;

/**
 * Ceiling on subscribers handled by ONE invocation.
 *
 * Chunking bounds how many sends run at once; it does NOT bound the total work
 * in a request. Each subscriber costs roughly three subrequests -- the claim,
 * the send, and the `last_email_sent` write (four when a failure releases the
 * claim) -- against a Workers cap of 1000, so ~200 leaves comfortable headroom
 * for the event lookup and the audit row.
 *
 * A list larger than this is not an error: the caller POSTs again, and the
 * claim table means the second call picks up exactly where the first stopped.
 * That is why the endpoint returns a REAL remaining count.
 */
export const MAX_PER_INVOCATION = 200;

/**
 * How long a claim is honoured before it is treated as abandoned.
 *
 * A CLAIM IS NOT A DELIVERY RECORD. If the Worker dies between claiming and
 * sending -- CPU limit, eviction, an unhandled throw -- the row survives with
 * `delivered_at` still NULL. Excluding on the claim alone would drop that
 * subscriber from every later run forever, having mailed them nothing: the
 * exact fire-once failure this design exists to avoid, reintroduced through
 * the back door.
 *
 * So an undelivered claim older than this is retryable. Fifteen minutes is far
 * longer than any send can legitimately take (a Worker invocation is bounded in
 * seconds) while short enough that recovery does not need a human.
 */
export const CLAIM_LEASE_MINUTES = 15;

/**
 * Subscribers who have NOT yet received `kind` for this event.
 *
 * `verified = 1` is not optional. Double opt-in exists so an address the
 * submitter does not control can never be enrolled in a mail stream, and this
 * is the query that would silently undo it — the same gate whose removal left
 * all 1,169 backend tests green on the band-follow path, because every fixture
 * seeded the passing case.
 */
export async function pendingSubscribers(DB, { eventId, kind, limit = MAX_PER_INVOCATION }) {
  const { results } = await DB.prepare(
    `SELECT s.id, s.email, s.unsubscribe_token
     FROM email_subscriptions s
     WHERE s.verified = 1
       AND NOT EXISTS (
         SELECT 1 FROM subscription_notifications n
         WHERE n.subscription_id = s.id AND n.event_id = ? AND n.kind = ?
           AND (
             -- Delivered: permanent, never resend.
             n.delivered_at IS NOT NULL
             -- Or claimed recently and still in flight elsewhere. Past the
             -- lease with no delivery, the claim is abandoned and this
             -- subscriber becomes eligible again.
             OR n.claimed_at > datetime('now', ?)
           )
       )
     ORDER BY s.id
     LIMIT ?`,
  )
    .bind(eventId, kind, `-${CLAIM_LEASE_MINUTES} minutes`, limit)
    .all();
  return results || [];
}

/**
 * How many verified subscribers still have not received `kind`.
 *
 * Called AFTER a send so the caller learns whether another POST is needed.
 * `subscribers.length` cannot answer that -- it is the pre-send count, and it
 * says nothing about failures or about a list longer than one invocation.
 */
export async function countPending(DB, { eventId, kind }) {
  const row = await DB.prepare(
    `SELECT COUNT(*) AS n
     FROM email_subscriptions s
     WHERE s.verified = 1
       AND NOT EXISTS (
         SELECT 1 FROM subscription_notifications n
         WHERE n.subscription_id = s.id AND n.event_id = ? AND n.kind = ?
           AND (n.delivered_at IS NOT NULL OR n.claimed_at > datetime('now', ?))
       )`,
  )
    .bind(eventId, kind, `-${CLAIM_LEASE_MINUTES} minutes`)
    .first();
  return row?.n ?? 0;
}

/**
 * Send `kind` to each given subscriber, recording delivery per recipient.
 *
 * Returns { sent, failed }. A failure is logged, never thrown: one bad address
 * must not abort the rest of the list.
 */
export async function notifySubscribers(env, DB, { eventId, kind, eventName, eventSlug, subject, lead, subscribers }) {
  const publicUrl = getPublicBaseUrl(env);
  const eventUrl = `${publicUrl}/event/${eventSlug}`;

  // One task per subscriber, dispatched in bounded chunks below rather than all
  // at once: an unbounded allSettled over a large list starts every D1 call and
  // every send simultaneously, which is how a Worker exhausts its subrequest
  // budget. Same reason announceDigest.js chunks.
  const sendOne = async (sub) => {
    // Claim BEFORE delivery, so two concurrent runs cannot mail one person
    // twice. A claim is NOT a delivery record, though -- see delivered_at.
    const claim = await DB.prepare(
      "INSERT OR IGNORE INTO subscription_notifications (subscription_id, event_id, kind) VALUES (?, ?, ?)",
    )
      .bind(sub.id, eventId, kind)
      .run();

    let owned = claim.meta.changes === 1;
    if (!owned) {
      // Take over an ABANDONED claim. If a Worker died between claiming and
      // sending, the row survives undelivered and INSERT OR IGNORE can never
      // reclaim it -- that subscriber would be skipped forever, mailed nothing.
      // Conditional on both delivered_at IS NULL and the lease having expired,
      // so a live sender's claim is never stolen.
      const retake = await DB.prepare(
        `UPDATE subscription_notifications
         SET claimed_at = datetime('now')
         WHERE subscription_id = ? AND event_id = ? AND kind = ?
           AND delivered_at IS NULL
           AND claimed_at <= datetime('now', ?)`,
      )
        .bind(sub.id, eventId, kind, `-${CLAIM_LEASE_MINUTES} minutes`)
        .run();
      owned = retake.meta.changes === 1;
    }

    if (!owned) {
      // Someone else holds a LIVE claim. Not a failure -- they are sending, or
      // already have. Counting this as `failed` makes two concurrent runs look
      // like delivery problems when every subscriber was in fact mailed.
      return "skipped";
    }

    // Every send carries an unsubscribe link. The token already exists on the
    // row; there is no excuse for a list that cannot be left.
    const unsubUrl = `${publicUrl}/api/subscriptions/unsubscribe?token=${sub.unsubscribe_token}`;
    const result = await sendEmail(env, {
      to: sub.email,
      subject,
      text: `${lead}\n\n${eventName}: ${eventUrl}\n\nUnsubscribe: ${unsubUrl}`,
      html:
        `<p>${escapeHtml(lead)}</p>` +
        `<p><a href="${eventUrl}">${escapeHtml(eventName)}</a></p>` +
        `<p><a href="${unsubUrl}">Unsubscribe</a></p>`,
    });

    if (result?.delivered !== true) {
      // Release immediately rather than waiting for the lease to lapse, so a
      // resend can retry this recipient now.
      await DB.prepare("DELETE FROM subscription_notifications WHERE subscription_id = ? AND event_id = ? AND kind = ?")
        .bind(sub.id, eventId, kind)
        .run();
      return "failed";
    }

    // Delivery confirmed by the provider. ONLY now is the row a delivery
    // record, and only now is it permanent.
    //
    // Caught locally because the mail has already gone out and cannot be
    // recalled. A rejection escaping sendOne reaches the Promise.allSettled
    // tally below, where `r.status !== "fulfilled"` counts it as FAILED -- a
    // delivered email reported as a failure, which invites the resend that
    // turns a lost write into a duplicate. The row stays retryable until #1153
    // adds a provider idempotency key; the log is what makes that visible.
    try {
      await DB.prepare(
        "UPDATE subscription_notifications SET delivered_at = datetime('now') WHERE subscription_id = ? AND event_id = ? AND kind = ?",
      )
        .bind(sub.id, eventId, kind)
        .run();

      // Bookkeeping only -- `last_email_sent` predates this sender and had never
      // been written by anything. Not used for gating: the notifications table is
      // the record, because one timestamp cannot say WHICH notice was received.
      await DB.prepare("UPDATE email_subscriptions SET last_email_sent = datetime('now') WHERE id = ?")
        .bind(sub.id)
        .run();
    } catch (confirmError) {
      logger.error("subscriber delivery confirmation failed; email WAS sent, claim may be retried", {
        subscriptionId: sub.id,
        eventId,
        kind,
        error: confirmError?.message,
      });
    }
    // Outside the try on purpose: it was sent.
    return "sent";
  };

  // THREE outcomes, not two. `skipped` means another invocation owns the claim
  // -- that subscriber is being handled, not dropped -- so folding it into
  // `failed` would report delivery problems on a run where everyone was mailed.
  let sent = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < subscribers.length; i += SEND_CONCURRENCY) {
    const results = await Promise.allSettled(subscribers.slice(i, i + SEND_CONCURRENCY).map(sendOne));
    for (const r of results) {
      if (r.status !== "fulfilled") failed++;
      else if (r.value === "sent") sent++;
      else if (r.value === "skipped") skipped++;
      else failed++;
    }
  }
  if (failed > 0) {
    logger.warn("subscriber notifications partially failed", { eventId, kind, sent, failed, skipped });
  }
  return { sent, failed, skipped };
}
