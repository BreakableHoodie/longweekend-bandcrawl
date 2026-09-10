// Public API: Track schedule builds
// POST /api/schedule/build
// Body: { event_id: number, band_ids?: number[], performance_ids?: number[], user_session: string }

import { parseJsonObjectBody } from "../../utils/request.js";
import { publicEventStatusSql } from "../../utils/eventVisibility.js";

const MAX_USER_SESSION_LENGTH = 128;
const MAX_PERFORMANCE_IDS = 50;

function isSafeSessionId(value) {
  if (!value || typeof value !== "string") return false;
  return /^[A-Za-z0-9_-]+$/.test(value);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { DB } = env;

  try {
    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const eventId = Number(body.event_id);
    const userSession = typeof body.user_session === "string" ? body.user_session.trim() : "";
    const performanceIdsInput = Array.isArray(body.performance_ids)
      ? body.performance_ids
      : Array.isArray(body.band_ids)
        ? body.band_ids
        : body.band_ids != null
          ? [body.band_ids]
          : [];

    if (!Number.isFinite(eventId)) {
      return new Response(JSON.stringify({ error: "Invalid event_id" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!userSession || userSession.length > MAX_USER_SESSION_LENGTH || !isSafeSessionId(userSession)) {
      return new Response(JSON.stringify({ error: "Invalid user_session" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (performanceIdsInput.length > MAX_PERFORMANCE_IDS) {
      return new Response(JSON.stringify({ error: "Too many performance_ids provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const performanceIds = performanceIdsInput.map((id) => Number(id)).filter((id) => Number.isFinite(id));

    if (performanceIds.length === 0) {
      return new Response(JSON.stringify({ error: "No performance_ids provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Resolve the caller's ids down to the ones that actually belong to THIS
    // event and are publicly visible, then silently drop the rest (#1135).
    //
    // Two defects, one fix:
    //
    // 1. NO EXISTENCE ORACLE. Unknown, foreign and non-public ids must be
    //    indistinguishable from each other and from a valid one, so they are
    //    dropped rather than reported. A refusal that fires only for real rows
    //    is itself the disclosure -- the reasoning behind #983's /band/<slug>
    //    gate, and behind follow-batch.js dropping unknown ids silently.
    //
    //    Reporting is the easy mistake here: the catch below tests an error
    //    message for "performance_id", which a raw `FOREIGN KEY constraint
    //    failed` does not contain, so an unfiltered bad id becomes a 500 while
    //    a good one returns 200. This endpoint is unauthenticated and its rate
    //    limiter fails open, so that difference is worth removing at source.
    //
    // 2. WRONG ROWS WRITTEN. Without `p.event_id = ?` it recorded builds for
    //    performances belonging to some OTHER event, under whatever event_id
    //    the caller sent. Those rows feed `schedule_count` in the admin event
    //    metrics, so this was an integrity bug as much as a disclosure one --
    //    any event's build count could be inflated with unrelated ids.
    //
    // 50 ids max (MAX_PERFORMANCE_IDS) + 1 for event_id = 51 binds, inside
    // D1's ceiling of 100.
    const idPlaceholders = performanceIds.map(() => "?").join(",");
    const visible = await DB.prepare(
      `SELECT p.id
       FROM performances p
       JOIN events e ON e.id = p.event_id
       WHERE p.id IN (${idPlaceholders})
         AND p.event_id = ?
         AND ${publicEventStatusSql("e")}
         AND (e.reveal_mode = 0 OR p.is_announced = 1)`,
    )
      .bind(...performanceIds, eventId)
      .all();

    const allowedIds = (visible.results || []).map((r) => r.id);

    // Nothing resolved: succeed anyway, identically to the case where
    // everything did. Returning a different status here would rebuild the
    // oracle this filter just removed.
    if (allowedIds.length === 0) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const statements = allowedIds.map((performanceId) =>
      DB.prepare(
        `
        INSERT OR IGNORE INTO schedule_builds (event_id, performance_id, user_session)
        VALUES (?, ?, ?)
      `,
      ).bind(eventId, performanceId, userSession),
    );

    try {
      await DB.batch(statements);
    } catch (error) {
      if (!String(error).includes("performance_id")) {
        throw error;
      }

      const legacyStatements = allowedIds.map((performanceId) =>
        DB.prepare(
          `
          INSERT OR IGNORE INTO schedule_builds (event_id, band_id, user_session)
          VALUES (?, ?, ?)
        `,
        ).bind(eventId, performanceId, userSession),
      );

      await DB.batch(legacyStatements);
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Schedule build tracking error:", error);
    return new Response(JSON.stringify({ error: "Failed to record schedule build" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
