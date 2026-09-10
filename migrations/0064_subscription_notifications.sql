-- Per-subscriber delivery tracking for event notices (#1149).
--
-- email_subscriptions has existed since January with a working double opt-in
-- and an unsubscribe token, and NOTHING has ever sent to it -- /subscribe
-- promised "Never Miss a Show" and delivered nothing. This table is what makes
-- a send path recoverable.
--
-- Per-recipient, NOT a flag on the event. CLAUDE.md records why, from the band
-- follow path: "Do not reintroduce a fire-once latch without per-follower
-- tracking -- it silently drops fans whose first send failed." A boolean on
-- events would mark the whole send done the moment one address bounced.
--
-- `kind` is part of the key so one event can carry more than one notice over
-- its life -- a lineup announcement and a schedule announcement are different
-- messages to the same list about the same event.
CREATE TABLE IF NOT EXISTS subscription_notifications (
  id              INTEGER PRIMARY KEY,
  subscription_id INTEGER NOT NULL REFERENCES email_subscriptions(id) ON DELETE CASCADE,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,
  sent_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  -- The claim. INSERT OR IGNORE against this returns changes=0 when another
  -- request already claimed this recipient, which is what stops two concurrent
  -- sends mailing the same person twice.
  UNIQUE (subscription_id, event_id, kind)
);

-- The send query reads "who has NOT been notified for this event+kind".
CREATE INDEX IF NOT EXISTS idx_subscription_notifications_lookup
  ON subscription_notifications(event_id, kind, subscription_id);
