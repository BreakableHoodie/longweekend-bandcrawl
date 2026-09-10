// Digest flush for band-lineup announcements.
//
// Groups pending band_announce_queue entries by (email, event_id) and sends
// one email per fan per event. Fans following a single announced band on the
// event get the standard per-band email; fans following multiple get a digest.
//
// band_follow_notifications remains the idempotency ledger: each entry is
// claimed (INSERT OR IGNORE) immediately before sending. A send failure
// releases the claim so resend-announcement can retry. A concurrent flush or
// resend that already claimed a slot simply skips that entry.
//
// The claim itself re-checks is_cancelled at execution time (WHERE NOT
// EXISTS, see flushAnnounceDigest below) rather than trusting the top-level
// SELECT's one-time snapshot. Phase A claims sequentially, group by group,
// so a performance can be cancelled by an editor in the gap between that
// snapshot and a later group's turn in the loop. A re-read immediately
// before sendEmail() would only narrow that window, not close it — a DB
// read and a network send can never be atomic — so the claim's own WRITE is
// made conditional instead: it either lands zero rows (no email, no ledger
// row) or it claims and sends, with nothing in between.
//
// Sends are dispatched in bounded-concurrency chunks (SEND_CONCURRENCY) so
// a large queue does not exhaust the Worker subrequest cap or wall-clock limit.

import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import { escapeHtml } from "./html.js";
import { getPublicBaseUrl } from "./publicUrl.js";

const SEND_CONCURRENCY = 8;

export async function flushAnnounceDigest(env, DB) {
  const publicUrl = getPublicBaseUrl(env);

  // Fetch every pending entry, joining band_follows for email + unsubscribe_token
  // and performances for a fresh is_cancelled read. The performance can be
  // cancelled AFTER it was queued but BEFORE this flush runs — admin/bands/[id].js
  // sweeps its own queue rows on cancel, but that's a separate request from
  // this one, so a row queued moments earlier can still be sitting here when
  // the cancellation lands. Joining performances (not trusting the queue
  // row's stale snapshot) closes that race (#732 MAJOR 1). ON DELETE CASCADE
  // on performance_id (migration 0046) means a hard-deleted performance's
  // queue rows are already gone by the time this runs, so an INNER JOIN never
  // silently strands one.
  const { results: queue } = await DB.prepare(
    `SELECT q.id, q.band_follow_id, q.performance_id, q.event_id,
            q.band_name, q.event_name, q.event_slug, q.band_profile_id,
            bf.email, bf.unsubscribe_token, p.is_cancelled
     FROM band_announce_queue q
     JOIN band_follows bf ON bf.id = q.band_follow_id
     JOIN performances p ON p.id = q.performance_id
     ORDER BY q.event_id, bf.email, q.queued_at`,
  ).all();

  if (!queue.length) return { sent: 0, failed: 0, skipped: 0 };

  // Group by (email, event_id) — one digest per fan per event.
  const groups = new Map();
  for (const item of queue) {
    const key = `${item.email}::${item.event_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  let skipped = 0;
  let sent = 0;
  let failed = 0;

  // ── Phase A (sequential) ─────────────────────────────────────────────────
  // For each group: claim slots, delete queue rows, build the email payload.
  // Ordering is preserved: claim-before-send is the idempotency contract.
  const sendTasks = [];

  for (const items of groups.values()) {
    const { email, event_name, event_slug } = items[0];
    const eventUrl = `${publicUrl}/event/${event_slug}`;

    // A performance cancelled between queuing and this flush (#732 MAJOR 1)
    // must never be claimed or sent — excluded up front, before the claim
    // loop even runs, so it can never consume a band_follow_notifications
    // row. Leaving that row unclaimed is what lets a later restore + fresh
    // announce still reach this fan; claiming it here (even without sending)
    // would permanently hide them from resend-announcement's recovery query.
    const liveItems = items.filter((item) => !item.is_cancelled);
    const cancelledCount = items.length - liveItems.length;

    // Claim each (performance_id, band_follow_id) atomically before sending,
    // batched together with this group's queue-row deletes into ONE
    // DB.batch() call. D1's batch() is all-or-nothing (CLAUDE.md), so a
    // failure here can never leave a partial claim behind: either every
    // claim + delete in this group commits, or none of it does.
    //
    // Previously the claims ran as a per-item loop with no error handling
    // (bare awaited .run() calls) and the deletes ran as a separate,
    // unrelated DB.batch() call. If a later item's claim threw, the throw
    // propagated straight out of flushAnnounceDigest — Phase B (delivery)
    // never ran, so EARLIER groups, which had already had their claims
    // written and their queue rows deleted by this same loop, never got
    // emailed either. Their fans were stranded: the ledger said "already
    // notified," the queue row was gone, and resend-announcement's recovery
    // query (which only looks for followers WITHOUT a notification row)
    // would never find them again (#732 MAJOR).
    //
    // The INSERT is conditioned on a fresh is_cancelled read (WHERE NOT
    // EXISTS), not just the row's absence (OR IGNORE alone). Phase A
    // processes groups sequentially, each awaiting a real DB.batch()
    // round-trip, so a performance can be cancelled after the top-level
    // SELECT above already read is_cancelled=0 for it but before THIS
    // group's claim runs — liveItems was filtered from that now-stale
    // snapshot. Re-reading the table inside the same statement that
    // performs the claim closes the window instead of narrowing it: the
    // claim either lands zero rows or it lands the row, with no gap in
    // between for sendEmail() to observe a state that has already changed.
    const claimStatements = liveItems.map((item) =>
      DB.prepare(
        `INSERT OR IGNORE INTO band_follow_notifications (performance_id, band_follow_id)
         SELECT ?, ? WHERE NOT EXISTS (
           SELECT 1 FROM performances WHERE id = ? AND is_cancelled = 1
         )`,
      ).bind(item.performance_id, item.band_follow_id, item.performance_id),
    );
    // Delete every queue entry for this group — whether claimed now,
    // cancelled, or already handled by a concurrent path. A cancelled entry
    // must not accumulate as a dead row forever.
    const deleteStatements = items.map((item) =>
      DB.prepare("DELETE FROM band_announce_queue WHERE id = ?").bind(item.id),
    );

    let batchResults;
    try {
      batchResults = await DB.batch([...claimStatements, ...deleteStatements]);
    } catch (batchError) {
      // Handle this group's failure locally: leave its band_announce_queue
      // rows exactly as they were (nothing in this group was claimed or
      // deleted) so the next flush retries them from scratch, and move on to
      // the next group. One group's D1 failure must never block delivery of
      // groups already prepared ahead of it, nor abort the whole flush.
      logger.error("announce digest claim batch failed; queue rows left in place for retry", {
        event_id: items[0].event_id,
        item_count: items.length,
        error: batchError,
      });
      failed += liveItems.length;
      continue;
    }

    // The first liveItems.length results correspond 1:1 to the claim INSERTs
    // above — DB.batch() preserves statement order. changes=0 now means one
    // of TWO things, both of which must skip rather than send: (a) already
    // claimed by a concurrent flush or by the resend-announcement endpoint
    // (the UNIQUE constraint made OR IGNORE drop the row), or (b) the
    // performance was cancelled after the top-level SELECT's snapshot but
    // before this claim ran (the WHERE NOT EXISTS made the INSERT's SELECT
    // yield nothing). Either way the item is correctly excluded from
    // `claimed` below, and — critically for (b) — no ledger row was written,
    // so a later restore-and-announce still reaches this follower.
    const claimed = liveItems.filter((_, i) => batchResults[i]?.meta?.changes > 0);

    skipped += cancelledCount;

    if (!claimed.length) {
      skipped += liveItems.length;
      continue;
    }

    // Build the email payload.
    const bands = claimed.map((item) => item.band_name);
    const subject =
      bands.length === 1
        ? `${bands[0]} just joined the lineup for ${event_name}!`
        : `${bands.length} bands you follow are playing ${event_name}!`;

    const bandListText = bands.map((b) => `• ${b}`).join("\n");
    const bandListHtml = bands.map((b) => `<li>${escapeHtml(b)}</li>`).join("");
    const unsubText = claimed
      .map(
        (item) =>
          `Unfollow ${item.band_name}: ${publicUrl}/api/bands/${item.band_profile_id}/unfollow?token=${item.unsubscribe_token}`,
      )
      .join("\n");
    const unsubHtml = claimed
      .map(
        (item) =>
          `<a href="${publicUrl}/api/bands/${item.band_profile_id}/unfollow?token=${item.unsubscribe_token}">Unfollow ${escapeHtml(item.band_name)}</a>`,
      )
      .join(" · ");

    const text =
      bands.length === 1
        ? `${bands[0]} is now on the lineup for ${event_name}.\n\nView the schedule: ${eventUrl}\n\n${unsubText}`
        : `${bands.length} bands you follow just joined the lineup for ${event_name}:\n\n${bandListText}\n\nView the schedule: ${eventUrl}\n\n${unsubText}`;

    const html =
      bands.length === 1
        ? `<p><strong>${escapeHtml(bands[0])}</strong> is now on the lineup for <strong>${escapeHtml(event_name)}</strong>.</p><p><a href="${eventUrl}">View the schedule</a></p><p style="font-size:0.85em">${unsubHtml}</p>`
        : `<p><strong>${bands.length} bands you follow</strong> just joined the lineup for <strong>${escapeHtml(event_name)}</strong>:</p><ul>${bandListHtml}</ul><p><a href="${eventUrl}">View the schedule</a></p><p style="font-size:0.85em">${unsubHtml}</p>`;

    sendTasks.push({ email, subject, text, html, claimed });
  }

  // ── Phase B (bounded concurrency) ────────────────────────────────────────
  // Send the collected tasks in chunks of SEND_CONCURRENCY. On send failure,
  // release that task's claims so resend-announcement can recover.

  // Logs every claimed id so a stranded row can be found and cleared by hand.
  function logStrandedClaims(task, message, error) {
    for (const item of task.claimed) {
      logger.error(message, {
        performance_id: item.performance_id,
        band_follow_id: item.band_follow_id,
        error,
      });
    }
  }

  async function sendOne(task) {
    let result;
    try {
      result = await sendEmail(env, {
        to: task.email,
        subject: task.subject,
        text: task.text,
        html: task.html,
      });
    } catch (sendError) {
      // A throw from sendEmail is a delivery failure like any other and must
      // take the same claim-release path. Left unguarded it skipped the release
      // entirely, so the notification row survived and resend-announcement
      // would never recover this fan (#672).
      logStrandedClaims(task, "announce digest sendEmail threw; releasing claims", sendError);
      result = { delivered: false };
    }
    if (result?.delivered) {
      // Mark DELIVERED, not merely claimed (#1152). This is mandatory, not
      // bookkeeping: an undelivered claim past its lease is now treated as
      // abandoned and retryable, so a successful send left unmarked would be
      // RE-MAILED fifteen minutes later -- strictly worse than the stranding
      // this change fixes.
      //
      // The batch is caught locally for the same reason its sibling in
      // bandFollowNotify.js is: the mail has already gone out and cannot be
      // recalled. Letting a rejection escape sendOne would hand it to
      // Promise.allSettled, which counts it as a FAILED send -- reporting a
      // delivered email as failed, and inviting the resend that turns a lost
      // write into a duplicate. The row does stay retryable until #1153 adds a
      // provider idempotency key; the log is what makes that visible.
      try {
        await DB.batch(
          task.claimed.map((item) =>
            DB.prepare(
              "UPDATE band_follow_notifications SET delivered_at = datetime('now') WHERE performance_id = ? AND band_follow_id = ?",
            ).bind(item.performance_id, item.band_follow_id),
          ),
        );
      } catch (confirmError) {
        logStrandedClaims(
          task,
          "announce digest delivery confirmation failed; email WAS sent, claims may be retried",
          confirmError,
        );
      }
      // Outside the try on purpose: it was sent.
      sent++;
    } else {
      // Release claims so resend-announcement can recover this fan.
      //
      // A FAILED RELEASE IS NO LONGER PERMANENT (#1152). This used to read:
      // if the release itself fails the rows survive, and resend-announcement
      // -- which only recovered followers with NO notification row -- would
      // skip this fan forever unless someone deleted the row by hand. The
      // ledger now separates claimed_at from delivered_at, and every reader
      // ignores an undelivered claim past its lease, so a stranded row heals
      // itself within CLAIM_LEASE_MINUTES. Releasing promptly is still worth
      // doing -- it makes recovery immediate instead of delayed -- but it is
      // no longer the only thing standing between a fan and silence.
      //
      // We deliberately do not retry the
      // DELETE here: D1 failures inside a Worker are rarely transient, and a
      // retry adds its own failure mode. Instead we count the fan as failed
      // (so the returned counts stay accurate and the `failed > 0` warning
      // below still fires) and log every claimed id so the row can be found
      // and cleared by hand (#672).
      try {
        await DB.batch(
          task.claimed.map((item) =>
            DB.prepare("DELETE FROM band_follow_notifications WHERE performance_id = ? AND band_follow_id = ?").bind(
              item.performance_id,
              item.band_follow_id,
            ),
          ),
        );
      } catch (releaseError) {
        logStrandedClaims(task, "announce digest claim release failed; fan requires manual recovery", releaseError);
      }
      failed++;
    }
  }

  for (let i = 0; i < sendTasks.length; i += SEND_CONCURRENCY) {
    const chunk = sendTasks.slice(i, i + SEND_CONCURRENCY);
    const results = await Promise.allSettled(chunk.map(sendOne));
    // Backstop for anything sendOne did not catch. The index maps back to the
    // originating task, so a rejection still logs which fan was stranded —
    // without that the count is right but nobody can find the surviving rows.
    results.forEach((result, i) => {
      if (result.status === "rejected") {
        logStrandedClaims(chunk[i], "announce digest sendOne rejected; claim release may not have run", result.reason);
        failed++;
      }
    });
  }

  if (failed > 0) {
    logger.warn("announce digest partially failed", { sent, failed, skipped });
  }
  return { sent, failed, skipped };
}
