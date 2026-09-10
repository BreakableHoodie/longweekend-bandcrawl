-- Separate "claimed" from "delivered" on the band-follow ledger (#1152).
--
-- band_follow_notifications carried a single `notified_at`, and the row was
-- inserted BEFORE sending. So the row meant two different things at once:
-- "a run is working on this" and "this was delivered". Only the second should
-- be permanent.
--
-- If a Worker stopped between the claim and the send -- CPU limit, eviction, an
-- unhandled throw -- the row survived with no email delivered, and every later
-- run including resend-announcement filtered that follower out. They were
-- dropped permanently, silently, having received nothing. That is the
-- fire-once failure per-follower tracking was introduced to prevent, reached
-- through a different door.
--
-- Same shape as subscription_notifications (#1151): an undelivered claim past
-- its lease is abandoned and retryable; a delivered row is permanent.
--
-- Rebuilt rather than ALTERed because `notified_at` has to GO. Leaving a
-- redundant timestamp beside `delivered_at` is exactly the ambiguity this
-- migration removes, and nothing reads it -- verified by grep across
-- functions/. The table held ZERO rows when this was written, so the rebuild
-- carries no data risk; the INSERT ... SELECT below is correct regardless and
-- treats every pre-existing row as delivered, which is what notified_at meant.
--
-- PRAGMA foreign_keys OFF/ON around the recreation, per migration 0032: D1
-- rejects the DROP otherwise.
PRAGMA foreign_keys = OFF;

CREATE TABLE band_follow_notifications_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  band_follow_id INTEGER NOT NULL REFERENCES band_follows(id) ON DELETE CASCADE,
  -- A run took ownership. Not proof of anything having been sent.
  claimed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- NULL until the provider confirms. Only this makes the row permanent.
  delivered_at   TEXT,
  UNIQUE (performance_id, band_follow_id)
);

-- Backfill: every surviving row is treated as DELIVERED.
--
-- This is the safe direction, and the opposite one is a live hazard. Under the
-- old code a row was deleted when a send failed, so a row that still exists is
-- almost certainly a real delivery. Marking these rows unconfirmed instead
-- would make the ENTIRE history retryable the moment its lease expired, and the
-- next resend would re-mail all of it -- the exact catastrophe the
-- "a delivered row is never retried" rule exists to prevent. A permanent claim
-- costs at most one missed retry for a row that predates the fix; the
-- alternative costs everyone an inbox.
--
-- Note `notified_at` recorded the CLAIM, not a provider confirmation, so this
-- is an inference rather than a reconciliation. Reconciling against provider
-- delivery records would be the rigorous version and is not possible here:
-- Resend/Postmark retention does not reach back over this table's lifetime, and
-- there is nothing to reconcile anyway -- verified against production D1 on
-- 2026-09-10, band_follow_notifications holds 0 rows, so this backfill moves
-- nothing. It is written to be correct if some other environment has rows.
INSERT INTO band_follow_notifications_new (id, performance_id, band_follow_id, claimed_at, delivered_at)
SELECT id, performance_id, band_follow_id, notified_at, notified_at
FROM band_follow_notifications;

DROP TABLE band_follow_notifications;
ALTER TABLE band_follow_notifications_new RENAME TO band_follow_notifications;

-- The hot query is "which verified followers still need this performance",
-- which reads (performance_id, band_follow_id) and then the two timestamps.
CREATE INDEX IF NOT EXISTS idx_band_follow_notifications_lookup
  ON band_follow_notifications(performance_id, band_follow_id, delivered_at, claimed_at);

PRAGMA foreign_keys = ON;
