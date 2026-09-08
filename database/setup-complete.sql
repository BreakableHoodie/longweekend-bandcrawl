-- Complete Local Development Database Setup
-- Usage: sqlite3 <database-file> < database/setup-complete.sql
--
-- GENERATED FILE — do not hand-edit the schema section.
-- Regenerate with:  node scripts/regenerate-setup-complete.mjs
-- Verified in CI by: node scripts/check-schema-drift.mjs (quality.yml)
--
-- Schema below is the exact cumulative result of migrations/0001..N replayed
-- in order (#506). To change the schema, add a migration and regenerate.
-- The SEED DATA section at the bottom is carried forward as-is.

-- ============================================
-- SCHEMA (generated from migrations/)
-- ============================================

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- e.g., "Summer Music Festival 2025"
  date TEXT NOT NULL,                    -- Event date in YYYY-MM-DD format
  slug TEXT NOT NULL UNIQUE,             -- URL-friendly identifier, e.g., "vol-5"
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, created_by_user_id INTEGER REFERENCES users(id), updated_by_user_id INTEGER REFERENCES users(id), updated_at TEXT DEFAULT (datetime('now')), status TEXT DEFAULT 'draft', archived_at TEXT, ticket_url TEXT, theme_colors TEXT, venue_info TEXT, social_links TEXT, city TEXT, description TEXT, reveal_mode INTEGER NOT NULL DEFAULT 0, end_date TEXT, doors_json TEXT, poster_url TEXT, age_restriction TEXT, presented_by TEXT);

CREATE TABLE IF NOT EXISTS venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,             -- Venue name, e.g., "Room 47"
  address TEXT                           -- Optional venue address
, created_by_user_id INTEGER REFERENCES users(id), updated_by_user_id INTEGER REFERENCES users(id), updated_at TEXT DEFAULT (datetime('now')), website TEXT, instagram TEXT, facebook TEXT, created_at TEXT DEFAULT (datetime('now')), address_line1 TEXT, address_line2 TEXT, region TEXT, postal_code TEXT, country TEXT, phone TEXT, contact_email TEXT, city TEXT, latitude REAL, longitude REAL);

CREATE TABLE IF NOT EXISTS band_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                    -- Display name (preserves artistic capitalization)
  name_normalized TEXT NOT NULL UNIQUE,  -- Lowercase + trimmed for duplicate detection
  description TEXT,                      -- Band bio/description (markdown supported)
  photo_url TEXT,                        -- Hero image URL (uploaded or external)
  genre TEXT,                            -- Genre tags (comma-separated for MVP)
  social_links TEXT,                     -- JSON: {"bandcamp": "url", "instagram": "@handle", ...}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, created_by_user_id INTEGER REFERENCES users(id), origin TEXT, origin_city TEXT, origin_region TEXT, contact_email TEXT, is_active INTEGER NOT NULL DEFAULT 1, total_views INTEGER DEFAULT 0, total_social_clicks INTEGER DEFAULT 0, popularity_score REAL DEFAULT 0, photo_alt_text TEXT, members TEXT, for_fans_of TEXT);

CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);

CREATE UNIQUE INDEX IF NOT EXISTS idx_band_profiles_normalized ON band_profiles(name_normalized);

CREATE INDEX IF NOT EXISTS idx_band_profiles_genre ON band_profiles(genre);

CREATE INDEX IF NOT EXISTS idx_band_profiles_name ON band_profiles(name);

CREATE TRIGGER IF NOT EXISTS update_band_profile_timestamp
AFTER UPDATE ON band_profiles
BEGIN
  UPDATE band_profiles SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor', -- 'admin' or 'editor'
  name TEXT,                            -- Optional display name
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
, totp_secret TEXT, totp_enabled INTEGER DEFAULT 0, webauthn_enabled INTEGER DEFAULT 0, email_otp_enabled INTEGER DEFAULT 0, backup_codes TEXT, require_2fa INTEGER DEFAULT 1, is_active INTEGER DEFAULT 1, deactivated_at TEXT, deactivated_by INTEGER REFERENCES users(id), updated_at TEXT DEFAULT (datetime('now')), first_name TEXT, last_name TEXT, activation_token TEXT, activation_token_expires_at TEXT, activated_at TEXT);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,     -- Base64 encoded credential ID
  public_key TEXT NOT NULL,               -- Base64 encoded public key
  counter INTEGER NOT NULL DEFAULT 0,     -- Signature counter for replay protection
  device_name TEXT,                       -- User-friendly name (e.g., "iPhone 15", "YubiKey")
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id);

CREATE INDEX IF NOT EXISTS idx_webauthn_credential_id ON webauthn_credentials(credential_id);

CREATE TABLE IF NOT EXISTS email_otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,                -- Hash of the 6-digit code
  expires_at TEXT NOT NULL,               -- Codes expire after 10 minutes
  verified INTEGER DEFAULT 0,             -- 1 if code was used successfully
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_otp_user_id ON email_otp_codes(user_id);

CREATE INDEX IF NOT EXISTS idx_email_otp_expires ON email_otp_codes(expires_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,                             -- Store email even if user doesn't exist
  ip_address TEXT,
  user_agent TEXT,
  attempt_type TEXT NOT NULL,             -- 'login', 'totp', 'webauthn', 'email_otp'
  success INTEGER NOT NULL,               -- 1 for success, 0 for failure
  failure_reason TEXT,                    -- Why it failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_user ON auth_attempts(user_id);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_email ON auth_attempts(email);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip ON auth_attempts(ip_address);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_created ON auth_attempts(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token TEXT UNIQUE NOT NULL,     -- UUID session token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  remember_me INTEGER DEFAULT 0,          -- Long-lived session if 1
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL                -- Session expiry time
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,              -- UUID token for reset link
  created_by INTEGER NOT NULL REFERENCES users(id), -- Admin who initiated reset
  expires_at TEXT NOT NULL,                -- Tokens expire after 24 hours
  used INTEGER DEFAULT 0,                  -- 1 if token was used
  used_at TEXT,                           -- When token was used
  ip_address TEXT,                        -- IP that used the token
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, reason TEXT);

CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token);

CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,                    -- e.g., 'user.created', 'event.updated', 'band.deleted'
  resource_type TEXT,                      -- e.g., 'user', 'event', 'band', 'venue'
  resource_id INTEGER,                     -- ID of the affected resource
  details TEXT,                            -- JSON string with additional context
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now')), api_key_id INTEGER REFERENCES api_keys(id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);

CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);

CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id);

CREATE TRIGGER IF NOT EXISTS update_events_timestamp
AFTER UPDATE ON events
BEGIN
  UPDATE events SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_venues_timestamp
AFTER UPDATE ON venues
BEGIN
  UPDATE venues SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_users_timestamp
AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived_at);

CREATE TABLE IF NOT EXISTS email_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  city TEXT NOT NULL,                    -- "portland", "seattle", "all"
  genre TEXT NOT NULL,                   -- "punk", "indie", "all"
  frequency TEXT NOT NULL DEFAULT 'weekly', -- "daily", "weekly", "monthly"
  verified BOOLEAN NOT NULL DEFAULT 0,   -- Email verified via confirmation link
  verification_token TEXT UNIQUE,        -- Token for email verification
  unsubscribe_token TEXT UNIQUE NOT NULL, -- Token for unsubscribe link
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_email_sent TEXT, consent_ip TEXT, consent_method TEXT NOT NULL DEFAULT 'web_form',                  -- When was last email sent

  UNIQUE(email, city, genre)             -- Prevent duplicate subscriptions
);

CREATE TABLE IF NOT EXISTS subscription_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),                       -- For spam prevention

  FOREIGN KEY (subscription_id) REFERENCES email_subscriptions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscription_unsubscribes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id INTEGER NOT NULL,
  unsubscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT,                           -- Optional feedback

  FOREIGN KEY (subscription_id) REFERENCES email_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_email ON email_subscriptions(email);

CREATE INDEX IF NOT EXISTS idx_subscriptions_city_genre ON email_subscriptions(city, genre);

CREATE INDEX IF NOT EXISTS idx_subscriptions_verified ON email_subscriptions(verified);

CREATE INDEX IF NOT EXISTS idx_subscriptions_verification_token ON email_subscriptions(verification_token);

CREATE INDEX IF NOT EXISTS idx_subscriptions_unsubscribe_token ON email_subscriptions(unsubscribe_token);

CREATE TABLE IF NOT EXISTS schedule_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  performance_id INTEGER NOT NULL,
  user_session TEXT NOT NULL,              -- Session identifier (no PII)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (performance_id) REFERENCES performances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_schedule_builds_event ON schedule_builds(event_id);

CREATE INDEX IF NOT EXISTS idx_schedule_builds_session ON schedule_builds(user_session);

CREATE INDEX IF NOT EXISTS idx_schedule_builds_created ON schedule_builds(created_at);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,              -- Random invite code (UUID)
  email TEXT,                             -- Optional: restrict to specific email
  role TEXT NOT NULL DEFAULT 'editor',    -- Role for new account (viewer, editor, admin)
  created_by_user_id INTEGER,             -- Admin who created the invite
  used_by_user_id INTEGER,                -- User who used the invite (NULL if unused)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at TEXT,                           -- When the invite was used
  expires_at TEXT NOT NULL,               -- Expiration timestamp
  is_active INTEGER NOT NULL DEFAULT 1,   -- 0 = disabled, 1 = active

  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_code ON invite_codes(code);

CREATE INDEX IF NOT EXISTS idx_invite_codes_active ON invite_codes(is_active, expires_at);

CREATE INDEX IF NOT EXISTS idx_invite_codes_email ON invite_codes(email);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_builds_unique
  ON schedule_builds(event_id, performance_id, user_session);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_id ON mfa_challenges(user_id);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_token ON mfa_challenges(token);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires_at ON mfa_challenges(expires_at);

CREATE INDEX IF NOT EXISTS idx_users_activation_token ON users(activation_token);

CREATE TABLE IF NOT EXISTS artist_daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  band_profile_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  page_views INTEGER DEFAULT 0,
  social_clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(band_profile_id, date),
  FOREIGN KEY (band_profile_id) REFERENCES band_profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_artist_stats_date ON artist_daily_stats(date);

CREATE INDEX IF NOT EXISTS idx_artist_stats_band ON artist_daily_stats(band_profile_id);

CREATE TABLE IF NOT EXISTS lucia_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  remember_me INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_activity_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_lucia_sessions_user_id ON lucia_sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_lucia_sessions_expires_at ON lucia_sessions(expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_updated_at ON rate_limits (updated_at);

CREATE TABLE IF NOT EXISTS trusted_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token TEXT UNIQUE NOT NULL,
  device_fingerprint TEXT,
  ua_hash TEXT,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_token ON trusted_devices(token);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_expires ON trusted_devices(expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mfa_challenges_active_user
  ON mfa_challenges(user_id)
  WHERE used = 0;

CREATE TABLE IF NOT EXISTS "performances" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  band_profile_id INTEGER NOT NULL,
  venue_id INTEGER,
  start_time TEXT,
  end_time TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by_user_id INTEGER,
  updated_by_user_id INTEGER,
  updated_at TEXT DEFAULT (datetime('now')), is_announced INTEGER NOT NULL DEFAULT 1, band_follow_notified INTEGER NOT NULL DEFAULT 0, performance_date TEXT, is_cancelled INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  FOREIGN KEY (band_profile_id) REFERENCES band_profiles(id) ON DELETE RESTRICT,
  FOREIGN KEY (venue_id) REFERENCES venues(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id),
  FOREIGN KEY (updated_by_user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_performances_event ON performances(event_id);

CREATE INDEX IF NOT EXISTS idx_performances_band ON performances(band_profile_id);

CREATE INDEX IF NOT EXISTS idx_performances_venue ON performances(venue_id);

CREATE INDEX IF NOT EXISTS idx_performances_event_time ON performances(event_id, start_time);

CREATE TRIGGER IF NOT EXISTS update_performances_timestamp
AFTER UPDATE ON performances
BEGIN
  UPDATE performances SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE INDEX IF NOT EXISTS idx_performances_announced
  ON performances(event_id, is_announced);

CREATE TABLE IF NOT EXISTS band_follows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  band_profile_id INTEGER NOT NULL REFERENCES band_profiles(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT UNIQUE,
  unsubscribe_token TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), consent_ip TEXT, consent_method TEXT NOT NULL DEFAULT 'web_form', batch_token TEXT,
  UNIQUE(email, band_profile_id)
);

CREATE INDEX IF NOT EXISTS idx_band_follows_band ON band_follows(band_profile_id);

CREATE INDEX IF NOT EXISTS idx_band_follows_email ON band_follows(email);

CREATE TABLE IF NOT EXISTS share_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  event_slug      TEXT    NOT NULL,
  performance_ids TEXT    NOT NULL,
  band_names      TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at      TEXT    NOT NULL
, view_count INTEGER NOT NULL DEFAULT 0, import_count INTEGER NOT NULL DEFAULT 0, view_count_legacy INTEGER);

CREATE INDEX IF NOT EXISTS idx_share_links_slug ON share_links(slug);

CREATE INDEX IF NOT EXISTS idx_share_links_expires_at ON share_links(expires_at);

CREATE TABLE IF NOT EXISTS page_views_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page TEXT NOT NULL,
  date TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  UNIQUE(page, date)
);

CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views_daily(date);

CREATE TABLE IF NOT EXISTS band_follow_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  band_follow_id INTEGER NOT NULL REFERENCES band_follows(id) ON DELETE CASCADE,
  notified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(performance_id, band_follow_id)
);

CREATE INDEX IF NOT EXISTS idx_band_follow_notifications_performance
  ON band_follow_notifications(performance_id);

CREATE TABLE IF NOT EXISTS band_announce_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  band_follow_id INTEGER NOT NULL REFERENCES band_follows(id) ON DELETE CASCADE,
  performance_id INTEGER NOT NULL REFERENCES performances(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL,
  band_name TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_slug TEXT NOT NULL,
  band_profile_id INTEGER NOT NULL,
  queued_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(band_follow_id, performance_id)
);

CREATE INDEX IF NOT EXISTS idx_band_announce_queue_event ON band_announce_queue(event_id);

CREATE INDEX IF NOT EXISTS idx_band_announce_queue_follow ON band_announce_queue(band_follow_id);

CREATE INDEX IF NOT EXISTS idx_band_follows_batch_token ON band_follows(batch_token);

CREATE TABLE IF NOT EXISTS auth_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,
  success INTEGER NOT NULL,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_audit_timestamp ON auth_audit(timestamp);

CREATE INDEX IF NOT EXISTS idx_auth_audit_ip ON auth_audit(ip_address);

CREATE TABLE IF NOT EXISTS event_daily_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  event_views INTEGER DEFAULT 0,
  ticket_clicks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(event_id, date),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_daily_stats_date ON event_daily_stats(date);

CREATE TABLE IF NOT EXISTS share_link_views (
  slug         TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  -- datetime('now') yields 'YYYY-MM-DD HH:MM:SS' (space separator). Do not
  -- store a JS toISOString() value here — the T separator breaks string
  -- comparisons against datetime('now'), the SEC-F1 bug class in CLAUDE.md.
  first_seen   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (slug, visitor_hash),
  FOREIGN KEY (slug) REFERENCES share_links(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_share_link_views_slug ON share_link_views(slug);

CREATE INDEX IF NOT EXISTS idx_events_status_date ON events (status, date);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK(role IN ('viewer','editor','admin')),
  -- RESTRICT, not CASCADE: deleting the row would destroy the attribution an
  -- incident needs. Deleting a user who still holds keys must fail loudly so
  -- the revoke step cannot be silently skipped. Part 2 adds that step to the
  -- user-delete path; until an endpoint exists no key can be created, so
  -- nothing can hit this yet.
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- SEC-F1 made unstorable rather than merely handled. A T-separated value
  -- ('2026-01-01T00:00:00Z') is what turned a string comparison into a
  -- production expiry bypass; this makes the shape illegal at the layer it
  -- would have to originate from. Write with toSqliteDateTime().
  expires_at TEXT NOT NULL CHECK(expires_at LIKE '____-__-__ __:__:__'),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON api_keys (created_by);

CREATE INDEX IF NOT EXISTS idx_audit_log_api_key ON audit_log (api_key_id);

-- ============================================
-- TEST ACCOUNTS (passwords set by scripts/setup-local-db.sh)
-- ============================================

INSERT OR REPLACE INTO users (id, email, name, password_hash, role, is_active, activated_at) VALUES
(1, 'admin@settimes.ca', 'Admin', 'LMdE99cXULbK/0Sljsj5Ew==:URyOncHwAcdAfHWrHilKVm/wqh1990VFLF2esF7uFNM=', 'admin', 1, datetime('now')),
(2, 'editor@settimes.ca', 'Editor', '6xX0ohzMf1PumBFMY2Z+/w==:EKlNs262pgHEwd3JLrg0Q7fuUea+gNU+LxmXVsQPUZY=', 'editor', 1, datetime('now')),
(3, 'viewer@settimes.ca', 'Viewer', 'xVcJyrdL5oF4cB9J9iFxZA==:84JeF551+ZCfXsEb+g9d+btTs8hPxdiPZ7yunFbVfYM=', 'viewer', 1, datetime('now'));
