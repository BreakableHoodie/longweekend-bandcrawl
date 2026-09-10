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

/**
 * Subscribers who have NOT yet received `kind` for this event.
 *
 * `verified = 1` is not optional. Double opt-in exists so an address the
 * submitter does not control can never be enrolled in a mail stream, and this
 * is the query that would silently undo it — the same gate whose removal left
 * all 1,169 backend tests green on the band-follow path, because every fixture
 * seeded the passing case.
 */
export async function pendingSubscribers(DB, { eventId, kind }) {
  const { results } = await DB.prepare(
    `SELECT s.id, s.email, s.unsubscribe_token
     FROM email_subscriptions s
     WHERE s.verified = 1
       AND NOT EXISTS (
         SELECT 1 FROM subscription_notifications n
         WHERE n.subscription_id = s.id AND n.event_id = ? AND n.kind = ?
       )`,
  )
    .bind(eventId, kind)
    .all();
  return results || [];
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

  const results = await Promise.allSettled(
    subscribers.map(async (sub) => {
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
        await DB.prepare(
          "DELETE FROM subscription_notifications WHERE subscription_id = ? AND event_id = ? AND kind = ?",
        )
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
    }),
  );

  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === true) sent++;
    else failed++;
  }
  if (failed > 0) {
    logger.warn("subscriber notifications partially failed", { eventId, kind, sent, failed });
  }
  return { sent, failed };
}
