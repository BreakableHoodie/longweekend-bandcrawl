// Admin events endpoint
// GET /api/admin/events - List all events
// POST /api/admin/events - Create new event

import { checkPermission, auditLog } from "./_middleware.js";
import {
  validateEntity,
  VALIDATION_SCHEMAS,
  validationErrorResponse,
  normalizeHttpUrl,
  safeReflectSocialLinksString,
  sanitizeEventSocialLinks,
  sanitizeVenueInfo,
  validateDoorsJson,
} from "../../utils/validation.js";
import { getClientIP, parseJsonObjectBody } from "../../utils/request.js";
import { eventLocalToday } from "../../utils/eventDay.js";

// GET - List all events (all authenticated users can view)
export async function onRequestGet(context) {
  const { request, env } = context;
  const { DB } = env;

  try {
    // Check permission (viewer and above)
    const permCheck = await checkPermission(context, "viewer");
    if (permCheck.error) {
      return permCheck.response;
    }

    // Parse query parameters
    const url = new URL(request.url);
    const showArchived = url.searchParams.get("archived") === "true";
    const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "1000", 10);
    const requestedOffset = Number.parseInt(url.searchParams.get("offset") || "0", 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 1000) : 1000;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;

    // Build query based on archived filter
    let query = `
      SELECT
        e.*,
        COUNT(DISTINCT p.band_profile_id) as band_count,
        -- "Is the schedule out?" -- the state the subscriber notice turns on
        -- (#1150). A published event whose sets are all announced but none
        -- placed is the "lineup up, schedule TBA" state; once any set has a
        -- start_time the news is the schedule rather than the lineup.
        --
        -- Counted over performances rather than distinct profiles: a band with
        -- two sets, one placed, has a schedule that has started appearing.
        SUM(CASE WHEN p.start_time IS NOT NULL AND p.start_time != '' THEN 1 ELSE 0 END) as scheduled_count
      FROM events e
      LEFT JOIN performances p ON e.id = p.event_id
    `;
    const queryParams = [];

    // Filter by archived status
    if (!showArchived) {
      query += ` WHERE (e.status != 'archived' OR e.status IS NULL)`;
    }

    query += `
      GROUP BY e.id
      ORDER BY e.date DESC
      LIMIT ?
      OFFSET ?
    `;
    queryParams.push(limit, offset);

    const result = await DB.prepare(query)
      .bind(...queryParams)
      .all();

    // Read-path sanitize (#493): `e.*` pulls in the raw social_links column,
    // which may hold a pre-#483 (or otherwise legacy) value never routed
    // through sanitizeEventSocialLinks on write. poster_url gets the same
    // #504-style treatment as ticket_url (#616).
    const events = (result.results || []).map((event) => ({
      ...event,
      social_links: safeReflectSocialLinksString(event.social_links, ["instagram", "x", "tiktok"]),
      poster_url: normalizeHttpUrl(event.poster_url),
    }));

    return new Response(
      JSON.stringify({
        events,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error fetching events:", error);

    return new Response(
      JSON.stringify({
        error: "Database error",
        message: "Failed to fetch events",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// POST - Create new event (editor and admin only)
export async function onRequestPost(context) {
  const { request, env } = context;
  const { DB } = env;
  const ipAddress = getClientIP(request);

  try {
    // Check permission (editor and above)
    const permCheck = await checkPermission(context, "editor");
    if (permCheck.error) {
      return permCheck.response;
    }

    const currentUser = permCheck.user;

    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return validationErrorResponse("Request body must be a JSON object");
    }
    if (body.ticketLink && !body.ticket_url) {
      body.ticket_url = body.ticketLink;
    }

    // Validate input using schema
    const validation = validateEntity(body, VALIDATION_SCHEMAS.event);
    if (!validation.valid) {
      const firstError = Object.values(validation.errors)[0];
      return validationErrorResponse(firstError, { fields: validation.errors });
    }

    const {
      name,
      date,
      end_date,
      slug,
      status,
      description,
      city,
      ticket_url,
      poster_url,
      venue_info,
      social_links,
      theme_colors,
      doors_json,
      age_restriction,
      presented_by,
    } = validation.sanitized;

    let sanitizedVenueInfo;
    let sanitizedSocialLinks;
    try {
      sanitizedVenueInfo = sanitizeVenueInfo(venue_info);
      sanitizedSocialLinks = sanitizeEventSocialLinks(social_links);
    } catch (error) {
      return validationErrorResponse(error.message);
    }

    // Cross-field check (needs date/end_date, so it can't live in the
    // schema-level `validate` above) — mirrors validatePerformanceDate.
    const doorsCheck = validateDoorsJson(doors_json, { date, end_date });
    if (!doorsCheck.valid) {
      return validationErrorResponse(doorsCheck.error);
    }
    const sanitizedDoorsJson = doorsCheck.value;
    if (status === "archived" && currentUser.role !== "admin") {
      return new Response(
        JSON.stringify({
          error: "Forbidden",
          message: "Only admins can create archived events directly",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Publication must go through POST /api/admin/events/:id/publish, which is
    // the only route that asks before putting a lineup-less event in front of
    // the public (400 EMPTY_LINEUP, overridable with an explicit
    // `allowEmptyLineup: true` -- the supported "Lineup TBA" publish).
    //
    // Creating straight into `published` is the one path where that prompt can
    // never fire: the row is born with zero performances, so a create-as-
    // published is ALWAYS an empty-lineup publish, silently. The admin create
    // form offered `Published` in a dropdown next to `Draft`, so one mis-click
    // put a half-configured event on the public site and in the sitemap (#804).
    //
    // This is deliberately NOT the same as the "tighten every status writer"
    // fix that `events/[id].js` rejects in its PUT-toggle comment. That comment
    // argues against making the toggle STRICTER than its guarded sibling; this
    // routes creation TOWARD that sibling. `draft` and `archived` stay allowed
    // -- archived is historical back-fill (HistoricalImportModal) and carries
    // no live-lineup requirement.
    if (status === "published") {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Create the event as a draft, then publish it. Publishing checks the lineup first.",
          code: "CREATE_AS_PUBLISHED",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Validate date is not in past (unless status is archived for retroactive
    // events). "Today" must be the events' Toronto-local day, not the Worker's
    // UTC day: new Date() components on Cloudflare are UTC, which roll to
    // tomorrow at 8 PM Eastern and would reject an event dated the admin's
    // actual local today all evening (the #568 bug class — see the
    // "Toronto-local, never UTC-sliced" invariant in CLAUDE.md). String
    // comparison is safe: both sides are zero-padded YYYY-MM-DD.
    const eventDateStr = String(date).slice(0, 10);
    const todayStr = eventLocalToday();
    if (eventDateStr < todayStr && status !== "archived") {
      return validationErrorResponse(
        currentUser.role === "admin"
          ? "Date cannot be in the past unless you are intentionally creating an archived historical event"
          : "Date cannot be in the past. Ask an admin to create an archived historical event if needed",
      );
    }

    if (end_date && end_date < date) {
      return validationErrorResponse("End date must be on or after the event start date");
    }

    // Check if slug already exists
    const existingEvent = await DB.prepare(
      `
      SELECT id FROM events WHERE slug = ?
    `,
    )
      .bind(slug)
      .first();

    if (existingEvent) {
      return new Response(
        JSON.stringify({
          error: "Conflict",
          message: "An event with this slug already exists",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Create event with creator tracking
    const result = await DB.prepare(
      `
      INSERT INTO events (
        name,
        date,
        end_date,
        slug,
        status,
        description,
        city,
        ticket_url,
        poster_url,
        venue_info,
        social_links,
        theme_colors,
        doors_json,
        age_restriction,
        presented_by,
        created_by_user_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `,
    )
      .bind(
        name,
        date,
        end_date,
        slug,
        status,
        description,
        city,
        ticket_url,
        normalizeHttpUrl(poster_url),
        sanitizedVenueInfo,
        sanitizedSocialLinks,
        theme_colors,
        sanitizedDoorsJson,
        age_restriction,
        presented_by,
        currentUser.userId,
      )
      .first();

    // Read-path sanitize (#504 convention): defense-in-depth alongside the
    // write-path normalizeHttpUrl above.
    result.poster_url = normalizeHttpUrl(result.poster_url);

    // Audit log
    await auditLog(
      env,
      currentUser.userId,
      "event.created",
      "event",
      result.id,
      {
        name,
        slug,
        status,
        city,
        ticket_url,
      },
      ipAddress,
    );

    return new Response(
      JSON.stringify({
        success: true,
        event: result,
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Error creating event:", error);

    return new Response(
      JSON.stringify({
        error: "Database error",
        message: "Failed to create event",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
