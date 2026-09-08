// Admin bands endpoint
// GET /api/admin/bands?event_id={id} - List bands for an event
// POST /api/admin/bands - Create new band (and performance)

import { checkPermission } from "./_middleware.js";
import {
  FIELD_LIMITS,
  isValidEmail,
  isValidTime,
  safeReflectSocialLinks,
  safeReflectSocialLinksString,
  sanitizeBandSocialLinks,
  sanitizeOptionalHttpUrl,
  sanitizeOptionalText,
  sanitizeString,
  validatePerformanceDate,
  validateSetTimes,
} from "../../utils/validation.js";
import { checkConflicts } from "../../utils/timeConflicts.js";
import { parseOrigin } from "../../utils/parseOrigin.js";
import { normalizeBandName } from "../../utils/bandName.js";
import { sortableName } from "../../utils/sortableName.js";
import { eventLocalFestivalToday } from "../../utils/eventDay.js";
import { parseJsonObjectBody } from "../../utils/request.js";

// SQLite `ORDER BY` can't strip a leading article inline (#587), so the SQL
// in onRequestGet below is a coarse pre-sort (correct on start_time, raw-byte
// on name) and the exact ordering is re-derived in JS afterward, swapping the
// name comparison for the article-stripped `sortableName` key. This mirrors
// the NULL-ordering SQLite applies by default: ASC puts NULLs first, DESC
// puts NULLs last. Only used by the eventId branch below — the no-eventId
// (roster) branch sorts on name alone (#710 removed its per-performance
// bare columns).
function compareStartTimeNullsLast(a, b) {
  if (a.start_time == null && b.start_time == null) return 0;
  if (a.start_time == null) return 1;
  if (b.start_time == null) return -1;
  return a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0;
}

async function getEventStatus(DB, eventId) {
  if (!eventId) return null;

  const event = await DB.prepare(`SELECT id, status, date, end_date FROM events WHERE id = ?`).bind(eventId).first();

  return event || null;
}

// Helper to unpack social links
function unpackSocialLinks(band) {
  if (!band) return null;
  // Read-path sanitize (#493): `band.social_links` may be a pre-#483 (or
  // otherwise legacy) DB value that was never routed through
  // sanitizeBandSocialLinks on write. Never reflect it verbatim.
  const social = safeReflectSocialLinks(band.social_links || "{}");
  const origin = [band.origin_city, band.origin_region].filter(Boolean).join(", ") || band.origin || "";
  return {
    ...band,
    // Preserve the raw string/null shape — RosterTab.jsx JSON.parses this
    // field directly — while sanitizing its contents.
    social_links: safeReflectSocialLinksString(band.social_links),
    origin,
    url: social.website || "",
    instagram: social.instagram || "",
    bandcamp: social.bandcamp || "",
    facebook: social.facebook || "",
    youtube: social.youtube || "",
    spotify: social.spotify || "",
    apple_music: social.apple_music || "",
    linktree: social.linktree || "",
  };
}

// GET - List bands for an event
export async function onRequestGet(context) {
  const { request, env } = context;
  const { DB } = env;

  // RBAC: Require viewer role or higher
  const permCheck = await checkPermission(context, "viewer");
  if (permCheck.error) {
    return permCheck.response;
  }

  const url = new URL(request.url);
  const eventId = url.searchParams.get("event_id");
  // limit/offset only apply to the no-event_id (roster) branch below — the
  // event_id branch returns a single event's full lineup, unpaginated.
  // Default is 500 (the existing cap), not 200: since #618, this branch
  // returns one row per band_profile (active and inactive, #619), and prod
  // already has ~218 active profiles plus a handful of inactive ones — a 200
  // default would silently truncate the roster again. Callers (RosterTab,
  // LineupTab's ArtistPicker) request no limit, so they get whatever the
  // default is.
  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "500", 10);
  const requestedOffset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 500;
  const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

  try {
    let result;

    if (eventId) {
      // Get bands (performances) for specific event
      result = await DB.prepare(
        `
        SELECT
          p.id,
          p.event_id,
          p.venue_id,
          p.start_time,
          p.end_time,
          p.performance_date,
          p.notes,
          p.is_announced,
          p.is_cancelled,
          bp.id as band_profile_id,
          bp.name,
          bp.genre,
          bp.origin,
          bp.origin_city,
          bp.origin_region,
          bp.contact_email,
          bp.is_active,
          bp.description,
          bp.photo_url,
          bp.photo_alt_text,
          bp.social_links,
          bp.members,
          bp.for_fans_of,
          (SELECT COUNT(*) FROM band_follows bf WHERE bf.band_profile_id = bp.id AND bf.verified = 1) AS follower_count,
          v.name as venue_name,
          e.name as event_name
        FROM performances p
        JOIN band_profiles bp ON p.band_profile_id = bp.id
        LEFT JOIN venues v ON p.venue_id = v.id
        JOIN events e ON p.event_id = e.id
        WHERE p.event_id = ?
        ORDER BY p.start_time NULLS LAST, bp.name
      `,
      )
        .bind(eventId)
        .all();
    } else {
      // List ALL band PROFILES — active and inactive (#619) — one row per
      // profile (#618), guaranteed STRUCTURALLY: the base table below is
      // `FROM band_profiles bp` with no top-level join to `performances`, so
      // there is no row-fan-out to collapse with GROUP BY in the first place
      // (the old query LEFT JOINed to performances with no GROUP BY, so a
      // band with N performances produced N rows; combined with
      // `ORDER BY e.date DESC` + `LIMIT`, a profile whose only performances
      // were on older events could sort past the limit and vanish entirely —
      // #618, Adelleda). This query is deliberately UNPAGINATED as of #756:
      // it returns every profile (~218 active plus a handful of inactive in
      // prod), and limit/offset are applied in JS below, after the
      // article-stripped sort. Re-adding SQL LIMIT/OFFSET here would restore
      // the bug: SQLite orders by raw `bp.name`, so "The Alpha" sorts after
      // "Bravo" and a page boundary drawn in SQL disagrees with the order the
      // client is shown — duplicating or dropping profiles across pages.
      //
      // Deliberately no `WHERE bp.is_active = 1` here (#619): the admin
      // roster is the tool that manages profiles, so it must be able to see
      // and edit retired ones too — filtering them out made them completely
      // uneditable through the UI. The row already selects bp.is_active, so
      // the client (RosterTab) badges and filters on it instead of the
      // server hiding rows. The public /artists archive was already correct
      // (it never filtered on is_active); this brings the admin roster in
      // line with it.
      //
      // #710 — next_event_*/last_event_* replace the old MAX(e.date) +
      // bare-column trick, which had no date predicate at all: MAX() picked
      // the furthest-out event in EITHER direction, so a not-yet-happened
      // event (e.g. Buddies Fest 2, still weeks away) was reported as the
      // band's "most recent performance". Nothing in frontend/src/admin/
      // rendered event_name/event_date either (dead weight on the wire) — both
      // are replaced outright, along with the rest of the per-performance
      // bare columns (venue_name, start_time, end_time, performance_date,
      // notes) that rode along with the same broken trick and also have no
      // consumer in this branch (RosterTab and LineupTab's ArtistPicker only
      // read profile-level fields + band_profile_id from this branch).
      //
      // "Today" is `eventLocalFestivalToday()` (America/Toronto, after-
      // midnight-aware — see functions/utils/eventDay.js), bound as a
      // parameter — never SQLite's `date('now')` (UTC) and never the plain
      // calendar-day `eventLocalToday()`. Between local midnight and 6 AM the
      // calendar day has rolled but the festival night has not; an event
      // still running (after-midnight sets) must not jump from "next" to
      // "past" while doors are open. Multi-day events compare against
      // COALESCE(e.end_date, e.date) so a 3-day event stays "next" through
      // its final day rather than moving to "past" on day 2 — same
      // COALESCE(end_date, date) convention as saveSelectedBands.
      //
      // event_ids (GROUP_CONCAT DISTINCT) exposes every event the profile has
      // ever played. The roster's Next/Past event FILTERABLE_COLUMNS entries
      // (frontend/src/admin/utils/rosterColumns.js) currently filter on
      // next_event_name/last_event_name only, so event_ids and the *_id/*_date
      // siblings (next_event_id, next_event_date, last_event_id,
      // last_event_date) have no wired-up consumer yet — they're returned per
      // #710's spec as the exact-id/date building blocks for a future
      // name-collision-proof filter (two different events sharing a display
      // name would otherwise be indistinguishable by name alone).
      //
      // We construct a synthetic ID: 'profile_' || bp.id (unique per profile —
      // no consumer in this branch reads `id` as a real performance id; both
      // RosterTab and LineupTab's ArtistPicker key off `band_profile_id`).
      {
        const today = eventLocalFestivalToday();
        // #907 — next_event_*/last_event_* used to be six correlated
        // subqueries (three identical trios differing only in the projected
        // column), each building its own TEMP B-TREE FOR ORDER BY per row —
        // up to ~4,000 subquery executions at the 500-row cap. Rewritten as
        // two window-function passes: next_ev/last_ev each rank a band's
        // events once (ROW_NUMBER() OVER PARTITION BY band_profile_id), and
        // the outer query just LEFT JOINs the rn = 1 row per side. Same
        // predicates, same tie-break ordering, same NULL-when-absent
        // behaviour (LEFT JOIN with no match leaves every next_ev.*/last_ev.*
        // column NULL) — only the execution shape changed, not the result.
        // `today` is now bound twice (once per CTE) instead of six times.
        result = await DB.prepare(
          `
        WITH next_ev AS (
          SELECT
            perf.band_profile_id AS band_profile_id,
            e.id AS event_id,
            e.name AS event_name,
            e.date AS event_date,
            ROW_NUMBER() OVER (
              PARTITION BY perf.band_profile_id
              ORDER BY e.date ASC, e.id ASC
            ) AS rn
          FROM performances perf
          JOIN events e ON perf.event_id = e.id
          WHERE COALESCE(e.end_date, e.date) >= ?
        ),
        last_ev AS (
          SELECT
            perf.band_profile_id AS band_profile_id,
            e.id AS event_id,
            e.name AS event_name,
            e.date AS event_date,
            ROW_NUMBER() OVER (
              PARTITION BY perf.band_profile_id
              ORDER BY COALESCE(e.end_date, e.date) DESC, e.id DESC
            ) AS rn
          FROM performances perf
          JOIN events e ON perf.event_id = e.id
          WHERE COALESCE(e.end_date, e.date) < ?
        )
        SELECT
          'profile_' || bp.id as id,
          bp.id as band_profile_id,
          bp.name,
          bp.genre,
          bp.origin,
          bp.origin_city,
          bp.origin_region,
          bp.contact_email,
          bp.is_active,
          bp.description,
          bp.photo_url,
          bp.photo_alt_text,
          bp.social_links,
          bp.members,
          bp.for_fans_of,
          (SELECT COUNT(*) FROM band_follows bf WHERE bf.band_profile_id = bp.id AND bf.verified = 1) AS follower_count,
          (SELECT GROUP_CONCAT(DISTINCT perf.event_id) FROM performances perf WHERE perf.band_profile_id = bp.id) AS event_ids,
          next_ev.event_id AS next_event_id,
          next_ev.event_name AS next_event_name,
          next_ev.event_date AS next_event_date,
          last_ev.event_id AS last_event_id,
          last_ev.event_name AS last_event_name,
          last_ev.event_date AS last_event_date
        FROM band_profiles bp
        LEFT JOIN next_ev ON next_ev.band_profile_id = bp.id AND next_ev.rn = 1
        LEFT JOIN last_ev ON last_ev.band_profile_id = bp.id AND last_ev.rn = 1
        ORDER BY bp.name
      `,
        )
          .bind(today, today)
          .all();
      }
    }

    let bands = (result.results || []).map(unpackSocialLinks);

    // Re-derive the exact ordering in JS with the article-stripped sort key
    // (#587) — see the compareStartTimeNullsLast comment above. Pagination-
    // boundary guarantee: the eventId branch has no LIMIT/OFFSET (one event's
    // full lineup). The no-eventId branch has no join to `performances` at
    // its top level (#618/#710) — exactly one row per band_profile,
    // structurally. Sorting the full set in JS before applying LIMIT/OFFSET
    // (#756) guarantees that pagination boundaries and presentation ordering
    // agree on the article-stripped sortableName() collation, avoiding profile
    // duplicates or omissions across page boundaries.
    if (eventId) {
      bands.sort((a, b) => compareStartTimeNullsLast(a, b) || sortableName(a.name).localeCompare(sortableName(b.name)));
    } else {
      bands.sort((a, b) => sortableName(a.name).localeCompare(sortableName(b.name)));
      bands = bands.slice(offset, offset + limit);
    }

    return new Response(JSON.stringify({ success: true, bands }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to fetch bands:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch bands" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// POST - Create new band (performance + profile)
export async function onRequestPost(context) {
  const { request, env } = context;
  const { DB } = env;

  // RBAC: Require editor role or higher
  const permCheck = await checkPermission(context, "editor");
  if (permCheck.error) {
    return permCheck.response;
  }

  try {
    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const {
      eventId,
      venueId,
      name,
      startTime,
      endTime,
      performanceDate,
      url,
      description,
      photo_url,
      genre,
      origin,
      origin_city,
      origin_region,
      contact_email,
      is_active,
      social_links, // JSON string from frontend
      notes,
      members,
      for_fans_of,
    } = body;

    const resolvedName = sanitizeString(name || "");
    const resolvedVenueId = venueId ? Number(venueId) : null;
    const resolvedDescription = description !== undefined ? sanitizeString(description) || null : null;
    const resolvedGenre = genre !== undefined ? sanitizeString(genre) || null : null;
    let resolvedPhotoUrl;
    let resolvedWebsite;
    let resolvedNotes;
    let resolvedMembers;
    let resolvedForFansOf;

    try {
      resolvedPhotoUrl = sanitizeOptionalHttpUrl(photo_url, FIELD_LIMITS.bandUrl.max, "Photo URL");
      resolvedWebsite = sanitizeOptionalHttpUrl(url, FIELD_LIMITS.bandUrl.max, "Website URL");
      resolvedNotes = sanitizeOptionalText(notes, FIELD_LIMITS.performanceNotes.max, "Notes");
      resolvedMembers = sanitizeOptionalText(members, FIELD_LIMITS.bandMembers.max, "Members");
      resolvedForFansOf = sanitizeOptionalText(for_fans_of, FIELD_LIMITS.bandForFansOf.max, "For fans of");
    } catch (error) {
      return new Response(JSON.stringify({ error: "Validation error", message: error.message }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (contact_email && !isValidEmail(contact_email)) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Contact email must be a valid email address",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // If we are in global view (no eventId), we just create/update the profile
    const isGlobalAdd = !eventId;
    let event = null;

    if (isGlobalAdd) {
      if (!resolvedName) {
        return new Response(
          JSON.stringify({
            error: "Missing required fields",
            message: "Band Name is required",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    } else {
      if (!resolvedName) {
        return new Response(
          JSON.stringify({
            error: "Missing required fields",
            message: "Band Name is required",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }

      event = await getEventStatus(DB, eventId);
      if (!event) {
        return new Response(JSON.stringify({ error: "Not found", message: "Event not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (event.status === "archived") {
        return new Response(
          JSON.stringify({
            error: "Validation error",
            message: "Cannot add performances to an archived event. Copy it as a template instead.",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // Validate performance_date (#540): must fall within the event's festival-day
    // span [event.date, event.end_date]. Only applies when scheduling into an
    // event — global-add (profile-only) rows have no performance to date.
    let resolvedPerformanceDate = null;
    if (!isGlobalAdd) {
      const performanceDateCheck = validatePerformanceDate(performanceDate, event);
      if (!performanceDateCheck.valid) {
        return new Response(JSON.stringify({ error: "Validation error", message: performanceDateCheck.error }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      resolvedPerformanceDate = performanceDateCheck.value;
    }

    // Validate time format (only if schedule is provided)
    // isValidTime, not a local regex: the shape test alone accepts "25:99" and
    // "12:60", which then reach the database as set times that do not exist
    // (#1089). The canonical validator has bounded hours and minutes all
    // along; four write paths already call it and this one re-implemented
    // half of it.
    if ((startTime && !isValidTime(startTime).valid) || (endTime && !isValidTime(endTime).valid)) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Time must be in HH:MM format",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Validate time order (only if schedule is provided)
    const setTimesCheck = validateSetTimes(startTime, endTime);
    if (!setTimesCheck.valid) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: setTimesCheck.error,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    if (startTime && endTime) {
      const [startH, startM] = startTime.split(":").map(Number);
      const [endH, endM] = endTime.split(":").map(Number);
      const startMinutes = startH * 60 + startM;
      const endMinutes = endH * 60 + endM;

      if (endMinutes < startMinutes) {
        // Allow midnight crossover for reasonable set lengths only.
        const duration = 24 * 60 - startMinutes + endMinutes;
        const maxDurationMinutes = 8 * 60;
        if (duration > maxDurationMinutes) {
          return new Response(
            JSON.stringify({
              error: "Validation error",
              message: "End time must be after start time",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
      }
    }

    // Check for conflicts (only if times are provided)
    if (!isGlobalAdd && resolvedVenueId && startTime && endTime) {
      const conflicts = await checkConflicts(DB, {
        eventId,
        venueId: resolvedVenueId,
        startTime,
        endTime,
        performanceDate: resolvedPerformanceDate,
        eventDate: event.date,
      });
      if (conflicts.length > 0) {
        return new Response(
          JSON.stringify({
            error: "Time conflict detected",
            message: "This time overlaps another set at the same venue.",
            conflicts,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }

    // 1. Find or Create Band Profile
    const nameNormalized = normalizeBandName(resolvedName);
    const parsedOrigin = parseOrigin(origin?.trim());
    const trimmedOriginCity = origin_city ? origin_city.trim() : parsedOrigin.city;
    const trimmedOriginRegion = origin_region ? origin_region.trim() : parsedOrigin.region;
    const computedOrigin =
      origin?.trim() || [trimmedOriginCity, trimmedOriginRegion].filter(Boolean).join(", ") || null;
    const resolvedIsActive = is_active === undefined ? 1 : Number(is_active) === 1 ? 1 : 0;
    const existingProfile = await DB.prepare("SELECT id FROM band_profiles WHERE name_normalized = ?")
      .bind(nameNormalized)
      .first();

    let bandProfile = existingProfile;
    const createdNewProfile = !existingProfile;

    if (!bandProfile) {
      // Create new profile
      let socialLinksJson;
      try {
        socialLinksJson = sanitizeBandSocialLinks(
          social_links || (resolvedWebsite ? { website: resolvedWebsite } : null),
        );
      } catch (error) {
        return new Response(JSON.stringify({ error: "Validation error", message: error.message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      bandProfile = await DB.prepare(
        `INSERT INTO band_profiles (
          name,
          name_normalized,
          genre,
          origin,
          origin_city,
          origin_region,
          contact_email,
          is_active,
          description,
          photo_url,
          social_links,
          members,
          for_fans_of
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
        .bind(
          resolvedName,
          nameNormalized,
          resolvedGenre,
          computedOrigin,
          trimmedOriginCity,
          trimmedOriginRegion,
          contact_email || null,
          resolvedIsActive,
          resolvedDescription,
          resolvedPhotoUrl,
          socialLinksJson || null,
          resolvedMembers,
          resolvedForFansOf,
        )
        .first();

      if (!bandProfile) {
        throw new Error("band_profiles INSERT returned null");
      }
    }

    // 2. Create Performance (only if eventId is provided)
    let result = { id: `profile_${bandProfile.id}` };

    if (!isGlobalAdd) {
      let perfResult;
      try {
        perfResult = await DB.prepare(
          `INSERT INTO performances (event_id, venue_id, band_profile_id, start_time, end_time, performance_date, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id`,
        )
          .bind(
            eventId,
            resolvedVenueId,
            bandProfile.id,
            startTime || null,
            endTime || null,
            resolvedPerformanceDate,
            resolvedNotes,
          )
          .first();
      } catch (perfError) {
        // Compensating delete: only undo profiles we just created, not pre-existing ones
        if (createdNewProfile) {
          await DB.prepare("DELETE FROM band_profiles WHERE id = ?").bind(bandProfile.id).run();
        }
        throw perfError;
      }

      if (!perfResult) {
        if (createdNewProfile) {
          await DB.prepare("DELETE FROM band_profiles WHERE id = ?").bind(bandProfile.id).run();
        }
        throw new Error("performances INSERT returned null");
      }

      result = perfResult;
    }

    return new Response(
      JSON.stringify({
        success: true,
        band: { id: result.id, ...body },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Failed to create band:", error);
    return new Response(JSON.stringify({ success: false, error: "Failed to create band" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// PUT and DELETE handlers removed as they are handled by [id].js
