import { getPublicDataGateResponse } from "../../../utils/publicGate.js";
import { CACHE_SHOW_CRITICAL } from "../../../utils/cacheHeaders.js";
import { normalizeBandName } from "../../../utils/bandName.js";
import { safeReflectSocialLinks } from "../../../utils/validation.js";
import { eventLocalFestivalToday } from "../../../utils/eventDay.js";
import { publicEventStatusSql } from "../../../utils/eventVisibility.js";
import { BAND_LINK_FIELD_KEYS } from "../../../utils/bandLinkFields.js";

/**
 * Public API: Get band profile with rich stats
 *
 * GET /api/bands/stats/:name
 *
 * Returns band profile with performance statistics, upcoming shows, and history
 * Supports both numeric IDs and band names (URL-encoded)
 */

function formatOrigin(profile) {
  if (!profile) return null;
  const parts = [profile.origin_city, profile.origin_region].filter(Boolean);
  return parts.length ? parts.join(", ") : profile.origin || null;
}

function formatVenueAddress(venue) {
  if (!venue) return null;
  const line1 = [venue.address_line1, venue.address_line2].filter(Boolean).join(", ");
  const line2 = [venue.city, venue.region].filter(Boolean).join(", ");
  const line3 = [venue.postal_code, venue.country].filter(Boolean).join(" ").trim();
  return [line1, line2, line3].filter(Boolean).join(", ");
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const gate = getPublicDataGateResponse(env);
  if (gate) {
    return gate;
  }
  const { DB } = env;

  try {
    const url = new URL(request.url);
    const parts = url.pathname.split("/");
    const searchParam = decodeURIComponent(parts[parts.length - 1]);

    if (!searchParam) {
      return new Response(JSON.stringify({ error: "Band identifier is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Check if it's a numeric ID or a name
    let bandId = null;
    let searchName = null;

    if (!isNaN(searchParam) && parseInt(searchParam) > 0) {
      bandId = parseInt(searchParam);
    } else {
      // Normalize name: replace hyphens with spaces
      searchName = searchParam.replace(/-/g, " ").trim();
    }

    // Resolve band profile first (v2 schema)
    // #484: explicit column list so future band_profiles columns don't
    // silently join the public payload.
    let bandProfile = null;
    if (bandId) {
      bandProfile = await DB.prepare(
        `
        SELECT id, name, origin, origin_city, origin_region, social_links,
               photo_url, photo_alt_text, description, genre, members, for_fans_of
        FROM band_profiles WHERE id = ? LIMIT 1
      `,
      )
        .bind(bandId)
        .first();
    } else {
      const normalized = normalizeBandName(searchName);
      bandProfile = await DB.prepare(
        `
        SELECT id, name, origin, origin_city, origin_region, social_links,
               photo_url, photo_alt_text, description, genre, members, for_fans_of
        FROM band_profiles
        WHERE name_normalized = ?
           OR LOWER(TRIM(name)) = LOWER(?)
        LIMIT 1
      `,
      )
        .bind(normalized, searchName)
        .first();
    }

    if (!bandProfile) {
      return new Response(JSON.stringify({ error: "Band not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Get all performances for this band profile. Cancellation is NOT part of
    // the SQL gate -- see the two derived lists just below -- because this
    // endpoint has to satisfy two different rules for the SAME cancelled row
    // at once (#732): it must still appear in upcoming/past (struck through,
    // is_cancelled: 1) while its event is current, but must never contribute
    // to the aggregate stats math regardless of currency.
    const performances = await DB.prepare(
      `
      SELECT
        p.id as performance_id,
        p.start_time,
        p.end_time,
        p.performance_date,
        p.notes,
        p.is_cancelled,
        v.id as venue_id,
        v.name as venue_name,
        v.address as venue_address,
        v.address_line1,
        v.address_line2,
        v.city,
        v.region,
        v.postal_code,
        v.country,
        e.id as event_id,
        e.name as event_name,
        e.slug as event_slug,
        e.date as event_date,
        e.end_date as event_end_date,
        e.status as event_status
      FROM performances p
      LEFT JOIN venues v ON p.venue_id = v.id
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.band_profile_id = ?
        AND ${publicEventStatusSql("e")}
        AND (e.reveal_mode = 0 OR p.is_announced = 1)
      ORDER BY e.date DESC, COALESCE(p.performance_date, e.date) ASC, p.start_time
    `,
    )
      .bind(bandProfile.id)
      .all();

    const allPerformances = performances.results || [];

    // A cancelled set stays visible on this band's page while its EVENT is
    // still current -- fans need to know the set is off -- and drops out of
    // both upcoming and past entirely once the event has passed, mirroring
    // the identical rule at bands/[name].js:148-149 (#732). This is keyed on
    // the EVENT's own end date, not the per-performance date used for the
    // upcoming/past SPLIT below (#603): a cancelled day-1 set of an ongoing
    // multi-day event still belongs on the page while day 2/3 are still to
    // come, so it stays in the "past" bucket (its own day has elapsed) rather
    // than disappearing.
    // Currency is keyed on the FESTIVAL day, not the calendar day (#732): at
    // 00:15 on show night the calendar has rolled over while after-midnight
    // sets are still playing, and a cancelled set must not vanish from this
    // page at exactly the moment a fan checks whether it is still on.
    const festivalToday = eventLocalFestivalToday();
    const isEventPast = (p) => (p.event_end_date || p.event_date) < festivalToday || p.event_status === "archived";
    const visiblePerformances = allPerformances.filter((p) => !p.is_cancelled || !isEventPast(p));

    // A cancelled set must never inflate the stats block, regardless of
    // whether its event is current -- this endpoint's one cancellation job is
    // to not count a set that never happened (#732).
    const statsPerformances = allPerformances.filter((p) => !p.is_cancelled);

    // Separate upcoming and past performances — per-performance (#603), not
    // per-event: on a multi-day event, each set's OWN day decides its bucket,
    // so a band's day-1 set can already be "past" while its day-3 set is
    // still "upcoming" mid-festival. NULL performance_date inherits the
    // event's start date (the #543 convention: day-1 sets and single-day
    // events store NULL). Archived events always go to past regardless of date.
    //
    // Compared against the FESTIVAL day for the same reason as isEventPast:
    // performance_date stores the EVENING a set belongs to, so a 00:35 set is
    // filed under the previous date. Against the calendar day it would be
    // classified "past" the moment the clock passed midnight -- twenty minutes
    // BEFORE it played. Outside 00:00-06:00 the two are identical.
    const upcomingPerformances = visiblePerformances.filter(
      (p) => (p.performance_date || p.event_date) >= festivalToday && p.event_status !== "archived",
    );
    const pastPerformances = visiblePerformances.filter(
      (p) => (p.performance_date || p.event_date) < festivalToday || p.event_status === "archived",
    );

    // Get unique venues
    const venueMap = new Map();
    statsPerformances.forEach((p) => {
      if (p.venue_id) {
        const count = venueMap.get(p.venue_id) || { ...p, count: 0 };
        count.count++;
        venueMap.set(p.venue_id, count);
      }
    });
    const uniqueVenues = Array.from(venueMap.values());

    // Find signature venue (most played)
    const signatureVenue =
      uniqueVenues.length > 0
        ? uniqueVenues.reduce((max, venue) => (venue.count > max.count ? venue : max), uniqueVenues[0])
        : null;

    // Get unique events
    const uniqueEvents = new Set(statsPerformances.map((p) => p.event_id).filter(Boolean));

    // Calculate average set time in minutes
    const setTimes = statsPerformances
      .filter((p) => p.start_time && p.end_time)
      .map((p) => {
        const [startH, startM] = p.start_time.split(":").map(Number);
        const [endH, endM] = p.end_time.split(":").map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        return endMinutes >= startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;
      })
      .filter((t) => t > 0);

    const averageSetMinutes =
      setTimes.length > 0 ? Math.round(setTimes.reduce((sum, t) => sum + t, 0) / setTimes.length) : null;

    // Get debut and latest dates
    const sortedDates = statsPerformances
      .map((p) => p.event_date)
      .filter(Boolean)
      .sort();

    const debutDate = sortedDates.length > 0 ? sortedDates[0] : null;
    const latestDate = sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : null;

    const socialLinks = safeReflectSocialLinks(bandProfile.social_links);

    // Build response
    const responseData = {
      id: bandProfile.id,
      name: bandProfile.name,
      photo_url: bandProfile.photo_url,
      photo_alt_text: bandProfile.photo_alt_text,
      description: bandProfile.description,
      genre: bandProfile.genre,
      members: bandProfile.members || null,
      for_fans_of: bandProfile.for_fans_of || null,
      origin: formatOrigin(bandProfile),
      // Built from the canonical platform list (#779): every documented key is
      // always present, null where absent — that stable key set IS the public
      // response contract. Never hand-list the keys here; iterate
      // BAND_LINK_FIELD_KEYS so this endpoint and bands/[name].js cannot
      // diverge again (functions/utils/__tests__/bandLinkFieldsGuard.test.js
      // enforces it).
      social: Object.fromEntries(BAND_LINK_FIELD_KEYS.map((key) => [key, socialLinks[key] || null])),
      stats: {
        total_performances: statsPerformances.length,
        unique_venues: uniqueVenues.length,
        unique_events: uniqueEvents.size,
        debut_date: debutDate,
        latest_date: latestDate,
        signature_venue: signatureVenue
          ? {
              id: signatureVenue.venue_id,
              name: signatureVenue.venue_name,
              count: signatureVenue.count,
            }
          : null,
        average_set_minutes: averageSetMinutes,
      },
      upcoming: upcomingPerformances.map((p) => ({
        id: p.performance_id,
        event_id: p.event_id,
        event_name: p.event_name,
        event_slug: p.event_slug,
        event_date: p.event_date,
        // NULL for single-day events. Clients key schedule stale-detection
        // on event_end_date || event_date (#542 PR-1) so a multi-day
        // event's saved schedule isn't wiped as stale on day 2.
        event_end_date: p.event_end_date || null,
        event_status: p.event_status,
        // The evening this SET belongs to (#739) — distinct from event_date
        // on day 2+ of a multi-day event. NULL for day-1 sets and
        // single-day events (the #543 convention); clients fall back to
        // event_date themselves.
        performance_date: p.performance_date || null,
        notes: p.notes || null,
        venue_id: p.venue_id,
        venue_name: p.venue_name,
        venue_address: p.venue_address || formatVenueAddress(p),
        start_time: p.start_time,
        end_time: p.end_time,
        is_cancelled: p.is_cancelled,
      })),
      past: pastPerformances.map((p) => ({
        id: p.performance_id,
        event_id: p.event_id,
        event_name: p.event_name,
        event_slug: p.event_slug,
        event_date: p.event_date,
        event_end_date: p.event_end_date || null,
        event_status: p.event_status,
        performance_date: p.performance_date || null,
        notes: p.notes || null,
        venue_id: p.venue_id,
        venue_name: p.venue_name,
        venue_address: p.venue_address || formatVenueAddress(p),
        is_cancelled: p.is_cancelled,
        start_time: p.start_time,
        end_time: p.end_time,
      })),
    };

    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_SHOW_CRITICAL,
      },
    });
  } catch (error) {
    console.error("Error fetching band stats:", error, error.message, error.stack);

    return new Response(
      JSON.stringify({
        error: "Failed to fetch band stats",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
