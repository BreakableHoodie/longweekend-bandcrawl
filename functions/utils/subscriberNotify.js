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
       )
     ORDER BY s.id
     LIMIT ?`,
  )
    .bind(eventId, kind, limit)
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
       )`,
  )
    .bind(eventId, kind)
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
    // Claim atomically BEFORE delivery. INSERT OR IGNORE returns changes=0
    // when another request already claimed this recipient, which is what
    // stops two concurrent sends mailing the same person twice.
    const claim = await DB.prepare(
      "INSERT OR IGNORE INTO subscription_notifications (subscription_id, event_id, kind) VALUES (?, ?, ?)",
    )
      .bind(sub.id, eventId, kind)
      .run();

    if (claim.meta.changes === 0) {
      return false;
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

    const delivered = result?.delivered === true;
    if (!delivered) {
      // Release the claim so a resend can retry this recipient. Without this
      // a transient failure would silently drop them forever, which is the
      // exact bug the band-follow path replaced.
      await DB.prepare("DELETE FROM subscription_notifications WHERE subscription_id = ? AND event_id = ? AND kind = ?")
        .bind(sub.id, eventId, kind)
        .run();
      return false;
    }

    // Bookkeeping only — `last_email_sent` predates this sender and had never
    // been written by anything. Not used for gating: the notifications table
    // is the record, because a single timestamp cannot say WHICH notice was
    // received.
    await DB.prepare("UPDATE email_subscriptions SET last_email_sent = datetime('now') WHERE id = ?")
      .bind(sub.id)
      .run();
    return true;
  };

  let sent = 0;
  let failed = 0;
  for (let i = 0; i < subscribers.length; i += SEND_CONCURRENCY) {
    const results = await Promise.allSettled(subscribers.slice(i, i + SEND_CONCURRENCY).map(sendOne));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value === true) sent++;
      else failed++;
    }
  }
  if (failed > 0) {
    logger.warn("subscriber notifications partially failed", { eventId, kind, sent, failed });
  }
  return { sent, failed };
}
