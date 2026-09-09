import { getPublicDataGateResponse } from "../../utils/publicGate.js";
import { CACHE_SHOW_CRITICAL } from "../../utils/cacheHeaders.js";
import { normalizeBandName } from "../../utils/bandName.js";
import { safeReflectSocialLinks } from "../../utils/validation.js";
import { eventLocalFestivalToday } from "../../utils/eventDay.js";
import { publicEventStatusSql } from "../../utils/eventVisibility.js";
import { BAND_LINK_FIELD_KEYS } from "../../utils/bandLinkFields.js";
import { isCanonicalPositiveId } from "../../utils/validation/ids.js";

/**
 * Public API: Get band profile by name
 *
 * GET /api/bands/:name
 *
 * Returns band profile with performance history
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

    // Canonical decimal only. The old `!isNaN(x) && parseInt(x) > 0` accepted
    // "1.9" -> band 1, "1e2" -> band 1 and "0x10" -> band 16: paths resolving to
    // records they do not name. See isCanonicalPositiveId's header (#1120).
    if (isCanonicalPositiveId(searchParam)) {
      bandId = Number(searchParam);
    } else {
      // Normalize name: replace hyphens with spaces and trim
      searchName = searchParam.replace(/-/g, " ").trim();
    }

    // Resolve band profile first (v2 schema)
    // #484: explicit column list so future band_profiles columns don't
    // silently join the public payload.
    let bandProfile = null;
    if (bandId) {
      bandProfile = await DB.prepare(
        `
        SELECT id, name, origin, origin_city, origin_region, social_links
        FROM band_profiles WHERE id = ? LIMIT 1
      `,
      )
        .bind(bandId)
        .first();
    } else {
      const normalized = normalizeBandName(searchName);
      bandProfile = await DB.prepare(
        `
        SELECT id, name, origin, origin_city, origin_region, social_links
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

    // Get all publicly visible performances for this band profile. Cancellation
    // is intentionally NOT part of this existence gate -- see the in-memory
    // filter below -- matching the reveal_mode precedent just below: 404 means
    // "this band was never part of a visible lineup," not "nothing to show
    // right now."
    const performances = await DB.prepare(
      `
      SELECT
        p.id as performance_id,
        p.start_time,
        p.end_time,
        p.is_cancelled,
        v.name as venue_name,
        v.address as venue_address,
        v.address_line1,
        v.address_line2,
        v.city,
        v.region,
        v.postal_code,
        v.country,
        e.name as event_name,
        e.slug as event_slug,
        e.date as event_date,
        e.end_date as event_end_date
      FROM performances p
      LEFT JOIN venues v ON p.venue_id = v.id
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.band_profile_id = ?
        AND ${publicEventStatusSql("e")}
        AND (e.reveal_mode = 0 OR p.is_announced = 1)
      ORDER BY e.date DESC, p.start_time
    `,
    )
      .bind(bandProfile.id)
      .all();

    const allHistory = performances.results || [];
    if (allHistory.length === 0) {
      return new Response(JSON.stringify({ error: "Band not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // A cancelled set stays visible while its event is current -- fans need to
    // know the set is off -- and drops out of the band's history once the
    // event has passed, because a cancellation is frequently not the
    // artist's fault (#732). `eventLocalFestivalToday()` (not the plain
    // calendar day) is REQUIRED here, mirroring the identical rule at
    // bands/stats/[name].js: between local midnight and 06:00 the calendar
    // has already rolled to tomorrow while an after-midnight set is still
    // playing, and a plain calendar-day comparison would erase a cancelled
    // set from a fan's view at exactly the moment they check whether it's
    // still on (#732 MAJOR 2, Copilot). Applied AFTER the 404 existence gate
    // above, so a band whose only-ever performance is cancelled-and-past
    // still gets a real profile page with an empty history, not a false
    // "not found".
    const today = eventLocalFestivalToday();
    const history = allHistory.filter((p) => !p.is_cancelled || (p.event_end_date || p.event_date) >= today);

    const socialLinks = safeReflectSocialLinks(bandProfile.social_links);

    // Build the `social` object from the canonical platform list (#779). Every
    // documented platform key is always present, null where absent — the
    // public response contract. Never hand-list the keys here; iterate
    // BAND_LINK_FIELD_KEYS so this endpoint and stats/[name].js cannot diverge
    // again (a source-scanning guard in
    // functions/utils/__tests__/bandLinkFieldsGuard.test.js enforces it).
    const profileData = {
      id: bandProfile.id,
      name: bandProfile.name,
      origin: formatOrigin(bandProfile),
      social: Object.fromEntries(BAND_LINK_FIELD_KEYS.map((key) => [key, socialLinks[key] || null])),
      performances: history.map((p) => ({
        id: p.performance_id,
        event_name: p.event_name,
        event_slug: p.event_slug,
        event_date: p.event_date,
        venue_name: p.venue_name,
        venue_address: p.venue_address || formatVenueAddress(p),
        start_time: p.start_time,
        end_time: p.end_time,
        is_cancelled: p.is_cancelled,
      })),
    };

    return new Response(JSON.stringify(profileData), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CACHE_SHOW_CRITICAL,
      },
    });
  } catch (error) {
    console.error("Error fetching band profile:", error, error.message, error.stack);

    return new Response(
      JSON.stringify({
        error: "Failed to fetch band profile",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
