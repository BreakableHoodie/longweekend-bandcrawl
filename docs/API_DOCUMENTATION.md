# SetTimes API Documentation

Current API contract for the Cloudflare Pages Functions implementation in `functions/api`.

## Overview

SetTimes exposes two API surfaces:

- Public read endpoints for published schedules, events, bands, calendar feeds, subscription flows, and privacy-safe telemetry.
- Admin endpoints for invite-based account onboarding, session-backed authentication, MFA, and event/catalog administration.

### Base URLs

- Production: `https://settimes.ca`
- Local Pages development: `http://localhost:8788`
- Branch or preview deployments: the active Cloudflare Pages preview URL

### Common behavior

- JSON is the default response format unless a route explicitly returns HTML or `text/calendar`.
- Dates use `YYYY-MM-DD`; times use `HH:MM`.
- Public schedule and discovery routes fail closed when `PUBLIC_DATA_PUBLISH_ENABLED` is unset or falsey. In that state they return `503` with `Retry-After: 3600`.
- Some older compatibility handlers still exist for admin routes. The inventory below reflects the routes the current frontend and handler set expect.

## Authentication and Security

### Admin session model

SetTimes no longer uses the earlier shared-password admin flow. Admin access is per-user and invite-based:

1. `POST /api/admin/auth/signup` creates an inactive account from a valid invite code.
2. `POST /api/auth/activate` activates the account from the emailed activation token.
3. `POST /api/admin/auth/login` validates credentials.
4. If MFA is enabled, login returns `mfaRequired: true` plus a short-lived `mfaToken`, and the client completes `POST /api/admin/auth/mfa/verify`.
5. On success, the server sets a session cookie and a readable `csrf_token` cookie.

### Cookies and CSRF

- Local development uses `session_token`; deployed environments use `__Host-session_token`.
- Authenticated `POST`, `PUT`, `PATCH`, and `DELETE` admin requests must echo the `csrf_token` cookie value in the `X-CSRF-Token` header.
- Pre-session auth routes (`/api/admin/auth/login`, `/api/admin/auth/signup`, `/api/admin/auth/mfa/verify`) rely on same-origin validation instead of the double-submit token because no session cookie exists yet.
- `POST /api/admin/auth/logout` is fully CSRF-protected.

### Timeouts and roles

- Admin idle timeout: 15 minutes
- Admin absolute timeout: 8 hours
- Role hierarchy: `viewer` < `editor` < `admin`
- Non-production bearer-token header auth is only available when `ALLOW_HEADER_AUTH=true` and `ENVIRONMENT != production`; it is not part of the production contract.

## Public API

### Discovery and read endpoints

| Route                        | Method | Notes                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/schedule`              | `GET`  | Returns `{ event, bands }` for `event=current` or a specific event slug. Archived events are readable by slug. When `event=current` has no published current or upcoming event, the route returns `404` with `{ error: "Event not found", message: "No published events available" }`. Cache TTL comes from `SCHEDULE_CACHE_TTL_SECONDS` and defaults to 60 seconds. |
| `/api/events/public`         | `GET`  | Public event listing with filters for `city`, `genre`, `limit` (max 100), and `upcoming` (defaults to true). Returns `{ events, filters, count, generated_at }`.                                                                                                                                                                                                     |
| `/api/events/timeline`       | `GET`  | Grouped timeline response with `now`, `upcoming`, and `past`. Supports `now`, `upcoming`, `past`, `includeBands`, and `pastLimit` (1-100, default 10).                                                                                                                                                                                                               |
| `/api/events/{id}/details`   | `GET`  | Returns one published or archived event with `bands`, `venues`, `band_count`, and `venue_count`. `{id}` must be numeric.                                                                                                                                                                                                                                             |
| `/api/bands/{name}`          | `GET`  | Returns a public band profile plus published performance history. `{name}` may be a numeric band ID or a normalized band name.                                                                                                                                                                                                                                       |
| `/api/events/{id}/recap`     | `GET`  | Returns `{ event, stats, bands }` for an **archived** event. `{id}` may be numeric or a slug. `stats` aggregates `total_sets`, `venue_count`, `first_timers`, and `returning_acts`. Gated by `PUBLIC_DATA_PUBLISH_ENABLED`; cacheable for 1 hour.                                                                                                                    |
| `/api/bands/stats/{name}`    | `GET`  | Extended band profile endpoint with aggregate stats, upcoming shows, and history across published and archived events.                                                                                                                                                                                                                                               |
| `/api/artists/shuffle`       | `GET`  | Five randomly chosen artists from the public roster, for the `/artists` showcase. Sends `Cache-Control: no-store` rather than the shared browse tier, because a 300s cache would serve everyone the same five for five minutes. Gated by `PUBLIC_DATA_PUBLISH_ENABLED`.                                                                                              |
| `/api/artists/one-of-one`    | `GET`  | Genres represented by exactly one artist across published or archived events. Gated by `PUBLIC_DATA_PUBLISH_ENABLED`; cached 5 minutes.                                                                                                                                                                                                                             |
| `/api/bands/{name}/stage-mates` | `GET` | Co-performers on shared events, most-shared first, capped at 20. `{name}` is spelled that way because sibling follow routes already bind the parameter and Pages cannot host `[name]/` and `[id]/` at one level; the VALUE is the canonical `band_profiles.id`, and a slug is also accepted. On a staged-reveal event both sides of the join must be announced. |
| `/api/feeds/ical`            | `GET`  | Returns `text/calendar` content. Supports `city` and `genre`; both default to `all`.                                                                                                                                                                                                                                                                                 |
| `/api/metrics`               | `POST` | Privacy-safe metrics ingestion. Accepts up to 50 events per batch and always answers `200 OK` on malformed or rejected payloads.                                                                                                                                                                                                                                     |
| `/api/schedule/build`        | `POST` | Records schedule-build analytics. Requires `event_id`, `user_session`, and `performance_ids` or the legacy `band_ids` alias.                                                                                                                                                                                                                                         |
| `/api/schedule/share`        | `POST` | Persists a selected lineup and returns `{ slug }` reachable at `/s/{slug}`. Body: `{ event_id, event_slug, performance_ids[], band_names[] }` (`band_names` same length as `performance_ids`, up to 50). Snapshots expire after 30 days.                                                                                                                             |
| `/api/schedule/share/{slug}` | `GET`  | Returns a stored share snapshot `{ slug, event_slug, event_name, performance_ids, band_names }` if unexpired. Increments a best-effort view counter unless `?import=1`.                                                                                                                                                                                              |
| `/api/stats/public`          | `GET`  | Privacy-safe aggregate platform stats: counts/sums for bands, venues, published events, performances, shared routes + views, verified band-follow count, and page views, plus up to 8 top bands by popularity. Aggregate-only — never PII. Gated by `PUBLIC_DATA_PUBLISH_ENABLED`; cached 5 minutes.                                                              |

### Subscriptions and account recovery

| Route                               | Method | Notes                                                                                                                                                     |
| ----------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/subscriptions/subscribe`      | `POST` | Body: `{ email, city, genre, frequency, turnstileToken? }`. `frequency` must be `daily`, `weekly`, or `monthly`.                                          |
| `/api/subscriptions/verify`         | `GET`  | Verifies a subscription via `?token=` and redirects to `/subscribe?verified=true` on success.                                                             |
| `/api/subscriptions/unsubscribe`    | `GET`  | Removes a subscription via `?token=` and returns an HTML confirmation page.                                                                               |
| `/api/auth/activate`                | `POST` | Body: `{ token }`. Activates an invited user account.                                                                                                     |
| `/api/auth/resend-activation`       | `POST` | Body: `{ email }`. Always returns a generic success payload to avoid account enumeration.                                                                 |
| `/api/auth/reset-password/validate` | `POST` | Body: `{ token }`. Validates a reset token without placing it in the URL.                                                                                 |
| `/api/auth/reset-password`          | `POST` | Body: `{ token, newPassword }`. Consumes the token, rotates the password, revokes sessions, and clears trusted devices.                                   |
| `/api/auth/reset-password`          | `GET`  | Intentionally unsupported. Returns `405` so reset tokens are never validated through query strings.                                                       |
| `/api/auth/reset-password-complete` | `POST` | Canonical reset-completion handler. `/api/auth/reset-password` (POST) re-exports it, so both URLs accept `{ token, newPassword }` and behave identically. |

### Band follows (double opt-in)

Following a band is **double opt-in**: a follow is created unverified and only a confirmation email is sent. Announcement emails reach verified followers only, so an address the submitter does not control can never be enrolled. `{name}` may be a numeric band ID or a normalized band name.

| Route                              | Method | Notes                                                                                                                                                                                  |
| ---------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/bands/{name}/follow`         | `POST` | Body: `{ email, turnstileToken? }`. Bot-protected by Turnstile. Always returns `200` for valid input (no enumeration). `confirmUrl` is returned only when email is unconfigured (dev). |
| `/api/bands/{name}/confirm-follow` | `GET`  | Verifies a pending follow via `?token=` and renders an HTML page. Idempotent; messaging is generic to avoid leaking token validity.                                                    |
| `/api/bands/{name}/unfollow`       | `GET`  | Deletes the follow tied to the unsubscribe `?token=` and renders an HTML page. Returns `200` whether or not the token existed.                                                         |
| `/api/bands/follow-batch`          | `POST` | Body: `{ email, performance_ids: number[], turnstileToken? }`. Resolves performance IDs to bands; inserts one `verified=0` row per band (INSERT OR IGNORE), all sharing a `batch_token`. Sends **exactly one** combined confirmation email (amplification mitigation). Always returns `200` for valid input; `confirmUrl` only in dev. |
| `/api/bands/confirm-follow-batch`  | `GET`  | `?token=<batch_token>` — flips all rows sharing that token to `verified=1` and clears the token (idempotent). Generic HTML page; no enumeration of token validity.                    |

### Public request notes

- `POST /api/metrics` only persists allow-listed analytics events: `page_view`, `event_view`, `artist_profile_view`, `social_link_click`, `ticket_click`, `share_event`, and `filter_use`.
- `POST /api/schedule/build` accepts at most 50 performance IDs and validates `user_session` against a restricted `[A-Za-z0-9_-]+` pattern.
- All public discovery routes listed in the first table are gated by `PUBLIC_DATA_PUBLISH_ENABLED`.

### Example: current schedule

```bash
curl "https://settimes.ca/api/schedule?event=current"
```

```json
{
  "event": {
    "id": 12,
    "name": "Winter Crawl 2026",
    "date": "2026-01-17",
    "slug": "winter-crawl-2026",
    "ticket_url": "https://tickets.example.com/winter-crawl-2026",
    "is_archived": false,
    "theme_colors": "{\"accent\":\"#f97316\"}",
    "venue_info": null,
    "social_links": null
  },
  "bands": [
    {
      "id": "the-sunset-trio-41",
      "performance_id": 41,
      "band_profile_id": 7,
      "name": "The Sunset Trio",
      "venue": "The Analog Cafe",
      "date": "2026-01-17",
      "startTime": "19:00",
      "endTime": "20:00",
      "url": "https://thesunsettrio.com"
    }
  ]
}
```

## Admin API

All admin routes require a valid session cookie. State-changing routes also require `X-CSRF-Token` after the session is established.

### Authentication and self-service

| Route                            | Method   | Minimum role | Notes                                                                                                        |
| -------------------------------- | -------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `/api/admin/auth/signup`         | `POST`   | none         | Invite-only signup. The request role is ignored; the invite code determines the role.                        |
| `/api/admin/auth/login`          | `POST`   | none         | Body: `{ email, password }`. Returns either a session success response or `{ mfaRequired, mfaToken, user }`. |
| `/api/admin/auth/mfa/verify`     | `POST`   | none         | Body: `{ mfaToken, code, rememberDevice? }`. Completes login and can create a trusted-device cookie.         |
| `/api/admin/auth/logout`         | `POST`   | viewer       | Invalidates the current session and clears session and CSRF cookies.                                         |
| `/api/admin/me`                  | `GET`    | viewer       | Returns `{ user, session, authenticated: true }` with safe session metadata only.                            |
| `/api/admin/sessions`            | `GET`    | viewer       | Lists the current user's active sessions.                                                                    |
| `/api/admin/sessions`            | `DELETE` | viewer       | Body: `{ sessionId }`. Revokes one of the current user's sessions.                                           |
| `/api/admin/sessions/revoke-all` | `POST`   | viewer       | Revokes all sessions for the current user and issues a fresh current-session cookie.                         |
| `/api/admin/trusted-devices`     | `GET`    | viewer       | Lists active trusted devices for the current user.                                                           |
| `/api/admin/trusted-devices`     | `DELETE` | viewer       | Body: `{ deviceId }`. Revokes one trusted device.                                                            |
| `/api/admin/mfa/status`          | `GET`    | viewer       | Returns `totpEnabled`, `setupPending`, and `hasBackupCodes`.                                                 |
| `/api/admin/mfa/setup`           | `POST`   | viewer       | Generates a new TOTP secret and returns `{ secret, otpauthUrl }`.                                            |
| `/api/admin/mfa/enable`          | `POST`   | viewer       | Body: `{ code }`. Verifies the code, enables TOTP, and returns new backup codes.                             |
| `/api/admin/mfa/backup-codes`    | `POST`   | viewer       | Body: `{ code }`. Regenerates backup codes after verifying a TOTP code.                                      |
| `/api/admin/mfa/disable`         | `POST`   | viewer       | Body: `{ code }`. Accepts a TOTP or backup code and disables MFA.                                            |

### Content, roster, and media

| Route                                | Method   | Minimum role | Notes                                                                                                                                                                  |
| ------------------------------------ | -------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/admin/events`                  | `GET`    | viewer       | Lists events. Supports `archived=true`, `limit`, and `offset`.                                                                                                         |
| `/api/admin/events`                  | `POST`   | editor       | Creates an event from the validated event schema. Admins may create archived events directly; editors may not.                                                         |
| `/api/admin/events/{id}`             | `PATCH`  | editor       | General event update route used by the current frontend. `slug` cannot be changed here.                                                                                |
| `/api/admin/events/{id}`             | `DELETE` | admin        | Deletes an event. If performances exist, repeat with `confirmCascade=true` in the body or query string.                                                                |
| `/api/admin/events/{id}/edit`        | `PUT`    | editor       | Narrow event-edit route for `{ name, date, slug, ticket_url }`.                                                                                                        |
| `/api/admin/events/{id}/publish`     | `POST`   | editor       | Body: `{ publish: boolean }`. Refuses to publish an event with no performances.                                                                                        |
| `/api/admin/events/{id}/archive`     | `POST`   | admin        | Sets `status = 'archived'` and stamps `archived_at`. One-way: no route un-archives an event. 409 if it was archived concurrently.                                       |
| `/api/admin/events/{id}/metrics`     | `GET`    | viewer       | Schedule-build analytics for one event.                                                                                                                                |
| `/api/admin/events/{id}/duplicate`   | `POST`   | editor       | Body: `{ name, date, slug }`. Copies the event's performances into a new unpublished draft.                                                                            |
| `/api/admin/events/wizard`           | `POST`   | admin        | One-shot creation of a draft event, its venues (find-or-create by name), and lineup. Body: `{ event, venues[], bands[] }`; each `bands[].venueIndex` indexes `venues`. |
| `/api/admin/events/{id}/reveal-mode` | `POST`   | editor       | Body: `{ reveal_mode: boolean }`. Toggles the lineup embargo flag for the event.                                                                                       |
| `/api/admin/venues`                  | `GET`    | viewer       | Lists venues with band counts. Contact details are redacted for viewers.                                                                                               |
| `/api/admin/venues`                  | `POST`   | admin        | Creates a new venue.                                                                                                                                                   |
| `/api/admin/venues/{id}`             | `PUT`    | admin        | Updates a venue.                                                                                                                                                       |
| `/api/admin/venues/{id}`             | `DELETE` | admin        | Deletes a venue.                                                                                                                                                       |
| `/api/admin/bands`                   | `GET`    | viewer       | Lists performances. Supports `event_id`, `limit`, and `offset`. Without `event_id`, profile-only rows are returned as synthetic IDs like `profile_123`.                |
| `/api/admin/bands`                   | `POST`   | editor       | Creates a performance plus band profile data, or a profile-only record when `eventId` is omitted.                                                                      |
| `/api/admin/bands/{id}`              | `PUT`    | editor       | Updates a performance or a profile-only row. `{id}` may be a performance ID or a `profile_{id}` synthetic identifier.                                                  |
| `/api/admin/bands/{id}`              | `DELETE` | editor       | Deletes one performance or one profile-only row, subject to archived-event protections.                                                                                |
| `/api/admin/bands/bulk-preview`      | `POST`   | editor       | Preview bulk venue moves, time changes, or deletions before applying them.                                                                                             |
| `/api/admin/bands/bulk`              | `POST`   | editor       | Adds existing band profiles to an event lineup. Body: `{ band_profile_ids, event_id, venue_id, start_time?, end_time? }`.                                              |
| `/api/admin/bands/bulk`              | `DELETE` | editor       | Bulk deletes performances or profile-only rows. Body: `{ band_ids }`.                                                                                                  |
| `/api/admin/bands/photos`            | `POST`   | editor       | `multipart/form-data` upload with `photo` and optional `band_id`. Stores assets in R2 and can update `photo_url`.                                                      |
| `/api/admin/bands/stats/{name}`      | `GET`    | viewer       | Internal stats and history view for a band profile.                                                                                                                    |

### User administration, invites, analytics, and maintenance

| Route                                     | Method   | Minimum role | Notes                                                                                                                                                                                                       |
| ----------------------------------------- | -------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/admin/users`                        | `GET`    | admin        | Lists all users, excluding password hashes.                                                                                                                                                                 |
| `/api/admin/users`                        | `POST`   | admin        | Creates an invite-backed user invitation and optionally emails the signup URL.                                                                                                                              |
| `/api/admin/users/{id}`                   | `PATCH`  | admin        | Updates role and display-name fields. Prevents demoting the last active admin.                                                                                                                              |
| `/api/admin/users/{id}`                   | `DELETE` | admin        | Removes a user.                                                                                                                                                                                             |
| `/api/admin/users/{id}/reset-password`    | `POST`   | admin        | Body: `{ reason? }`. Creates a reset token, revokes sessions, clears trusted devices, and emails the reset URL.                                                                                             |
| `/api/admin/users/{id}/toggle-status`     | `POST`   | admin        | Activates or deactivates a user account. Deactivation revokes sessions.                                                                                                                                     |
| `/api/admin/invite-codes`                 | `GET`    | admin        | Lists invite codes.                                                                                                                                                                                         |
| `/api/admin/invite-codes`                 | `POST`   | admin        | Body: `{ email?, role = "editor", expiresInDays = 7 }`. Creates an open or email-restricted invite.                                                                                                         |
| `/api/admin/invite-codes/{code}`          | `DELETE` | admin        | Revokes an invite code.                                                                                                                                                                                     |
| `/api/admin/audit-log`                    | `GET`    | admin        | Query: `user_id`, `action`, `resource_type`, `limit` (max 100), and `offset`.                                                                                                                               |
| `/api/admin/analytics/subscriptions`      | `GET`    | admin        | Aggregate subscription analytics only; no subscriber PII is exposed.                                                                                                                                        |
| `/api/admin/flush-announce-digest`        | `POST`   | editor       | Groups the pending `band_announce_queue` by `(email, event)` and sends one digest email per fan per event, recording each successful send in the per-follower ledger. Requires a configured email provider. |
| `/api/admin/maintenance/cleanup-sessions` | `POST`   | admin        | Runs the retention cleanup for expired sessions, MFA challenges, reset tokens, trusted devices, and security telemetry.                                                                                     |

## Error handling

Common status codes used across the API:

- `400 Bad Request`: validation failure, missing required fields, or malformed path, query, or body data
- `401 Unauthorized`: missing or invalid credentials, invalid MFA code, expired challenge token
- `403 Forbidden`: authenticated but insufficient role, failed CSRF validation, or origin validation failure
- `404 Not Found`: missing record or unknown route segment
- `409 Conflict`: uniqueness conflicts, invalid state transitions, or confirmation-required destructive actions
- `429 Too Many Requests`: login or MFA rate limit exceeded
- `503 Service Unavailable`: public data publishing is disabled for gated read routes

## Example: admin login with optional MFA

```bash
curl -X POST "https://settimes.ca/api/admin/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"editor@example.com","password":"correct horse battery staple"}'
```

A successful direct login returns `success: true` and sets the session and CSRF cookies. If MFA is enabled for the account, the same endpoint returns:

```json
{
  "mfaRequired": true,
  "mfaToken": "8e8d0f1e-....",
  "user": {
    "email": "editor@example.com",
    "name": "Editor Example",
    "firstName": "Editor",
    "lastName": "Example",
    "role": "editor"
  }
}
```

The client then completes `POST /api/admin/auth/mfa/verify` with `{ mfaToken, code, rememberDevice? }`.
