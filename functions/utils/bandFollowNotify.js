// Shared "band joined the lineup" notification logic for band followers.
//
// Sends the announcement email to each given follower and records every
// SUCCESSFUL delivery in band_follow_notifications, keyed by (performance,
// follower). This lets a resend target only followers who were not yet
// notified for a performance — guaranteeing eventual delivery without ever
// double-sending. Used by the announce flow (bands/[id].js) and the resend
// endpoint (bands/[id]/resend-announcement.js).
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { getPublicBaseUrl } from "./publicUrl.js";
import { escapeHtml } from "./html.js";

// A claim is not a delivery record (#1152).
//
// This module used to use ONE row to mean both "I am sending to this person"
// and "this person has been sent to". A Worker that died between the two --
// the crash window is a real network round-trip wide -- left a row that every
// later reader, resends included, read as "already notified". The follower was
// dropped permanently and silently, which is the worst shape a mail bug takes.
//
// So claimed_at and delivered_at are separate columns, and an UNDELIVERED
// claim past its lease is treated as abandoned and retryable. The lease is
// what makes that safe: without it "retry stale claims" degrades into "retry
// everything", which would re-mail the entire history.
export const CLAIM_LEASE_MINUTES = 15;

// The single home for "does this ledger row still speak for the follower?".
// Exported because the SENDER and every READER must agree exactly -- when they
// drift, one of them is silently wrong about who has been mailed, and the
// symptom is either a dropped fan or a duplicate.
export function claimIsLiveSql(alias = "bfn") {
  return `(${alias}.delivered_at IS NOT NULL OR ${alias}.claimed_at > datetime('now', '-${CLAIM_LEASE_MINUTES} minutes'))`;
}

export async function notifyBandFollowers(env, DB, { performanceId, bandProfileId, bandName, eventName, followers }) {
  const publicUrl = getPublicBaseUrl(env);

  const results = await Promise.allSettled(
    followers.map(async (follower) => {
      // Claim the follower atomically before delivery. INSERT OR IGNORE
      // returns changes=0 if a row already exists for this follower, which
      // prevents concurrent resends from double-sending to the same person.
      const claim = await DB.prepare(
        "INSERT OR IGNORE INTO band_follow_notifications (performance_id, band_follow_id) VALUES (?, ?)",
      )
        .bind(performanceId, follower.id)
        .run();

      if (claim.meta.changes === 0) {
        // A row exists -- but existing is not the same as HANDLED. Take it
        // over only if it is undelivered AND its lease has expired, which is
        // precisely the row a killed Worker leaves. Both conditions live in
        // the UPDATE's own WHERE clause rather than in a preceding SELECT, so
        // two Workers racing to recover the same stranded row cannot both win:
        // exactly one UPDATE reports changes=1.
        const takeover = await DB.prepare(
          `UPDATE band_follow_notifications
              SET claimed_at = datetime('now')
            WHERE performance_id = ? AND band_follow_id = ?
              AND delivered_at IS NULL
              AND claimed_at <= datetime('now', '-${CLAIM_LEASE_MINUTES} minutes')`,
        )
          .bind(performanceId, follower.id)
          .run();

        // Live claim or a real delivery -- either way, not ours to send.
        if (takeover.meta.changes === 0) {
          return false;
        }
      }

      const unsubUrl = `${publicUrl}/api/bands/${bandProfileId}/unfollow?token=${follower.unsubscribe_token}`;
      const result = await sendEmail(env, {
        to: follower.email,
        subject: `${bandName} just joined the lineup for ${eventName}!`,
        text: `${bandName} is now on the lineup for ${eventName}.\n\nUnfollow: ${unsubUrl}`,
        html: `<p><strong>${escapeHtml(bandName)}</strong> is now on the lineup for <strong>${escapeHtml(eventName)}</strong>.</p><p><a href="${unsubUrl}">Unfollow this band</a></p>`,
      });

      const delivered = result?.delivered === true;
      if (delivered) {
        // Promote the claim to a DELIVERY. Mandatory, not bookkeeping: an
        // undelivered claim past its lease is now retryable, so a successful
        // send left unmarked would be re-mailed CLAIM_LEASE_MINUTES later.
        //
        // The send already happened and cannot be recalled, so a failure HERE
        // is the one window this design trades for: the row stays undelivered,
        // its lease expires, and a later resend mails the person a second time.
        // That is deliberate. The alternative it replaces was a permanent,
        // silent DROP -- and a visible duplicate is recoverable where silence
        // is not. Closing the window properly needs a provider-side
        // idempotency key on sendEmail (#1153), which is a change to every
        // caller, not to this one.
        //
        // Counting it as SENT is the point of the catch: it was sent. Reporting
        // it failed would invite an operator to resend, which is the single
        // action that converts this into the duplicate.
        try {
          await DB.prepare(
            "UPDATE band_follow_notifications SET delivered_at = datetime('now') WHERE performance_id = ? AND band_follow_id = ?",
          )
            .bind(performanceId, follower.id)
            .run();
        } catch (confirmError) {
          logger.error("band follow delivery confirmation failed; email WAS sent, claim may be retried", {
            performanceId,
            bandFollowId: follower.id,
            leaseMinutes: CLAIM_LEASE_MINUTES,
            error: confirmError?.message,
          });
        }
      } else {
        // Email failed -- release the claim so a resend can retry immediately
        // rather than waiting out the lease. If this DELETE itself fails the
        // row survives, but that is no longer permanent: the lease expires and
        // the follower becomes retryable on their own. Prompt, not load-bearing.
        await DB.prepare("DELETE FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?")
          .bind(performanceId, follower.id)
          .run();
      }
      return delivered;
    }),
  );

  let sent = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === true) sent++;
    else failed++;
  }
  if (failed > 0) {
    logger.warn("band follow notifications partially failed", {
      performanceId,
      sent,
      failed,
    });
  }
  return { sent, failed };
}
