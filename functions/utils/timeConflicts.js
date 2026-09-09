// Shared time-conflict utilities for scheduling operations.
// Handles sets that cross midnight by building mirrored intervals.

export function toMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

/**
 * A set whose end time is before its start crosses midnight, so its end belongs
 * to the next day. Strict `<`, matching `normalizeEndMinutes` in
 * `frontend/src/admin/utils/timeUtils.js`.
 *
 * This used `<=`, which also swept up the equal case and turned a zero-length
 * set into a 24-hour interval conflicting with everything at its venue, while
 * the frontend's `<` left a zero-width interval that `intervalsOverlap`
 * (strict `<`) matched against nothing. Server and admin UI disagreed about the
 * same row. `validateSetTimes` now rejects `start === end` on every write path,
 * so the equal case cannot reach here; the two comparisons are aligned anyway
 * so they cannot drift apart again.
 */
export function normalizeEndMinutes(startMinutes, endMinutes) {
  return endMinutes < startMinutes ? endMinutes + 24 * 60 : endMinutes;
}

export function buildIntervals(start, end) {
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  const normalizedEnd = normalizeEndMinutes(startMinutes, endMinutes);
  return [
    [startMinutes, normalizedEnd],
    [startMinutes + 24 * 60, normalizedEnd + 24 * 60],
  ];
}

export function intervalsOverlap(a, b) {
  return a[0] < b[1] && b[0] < a[1];
}

// Shifts start_time while preserving set duration. Handles midnight crossing.
export function computeNewEndTime(oldStart, oldEnd, newStart) {
  const fromMins = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  let dur = toMinutes(oldEnd) - toMinutes(oldStart);
  if (dur < 0) dur += 24 * 60;
  return fromMins((toMinutes(newStart) + dur) % (24 * 60));
}

/**
 * Check a single performance's proposed time against existing sets at the same
 * venue and festival day. Used by the admin create and update write paths
 * (bands.js and bands/[id].js); callers return a 409 when it finds anything.
 *
 * @param {Object} DB - Cloudflare env DB binding
 * @param {Object} opts
 * @param {number} opts.eventId
 * @param {number} opts.venueId
 * @param {string} opts.startTime - "HH:MM"
 * @param {string} opts.endTime - "HH:MM"
 * @param {number|null} [opts.excludePerformanceId] - performance to ignore (the set being updated)
 * @param {string|null} [opts.performanceDate] - candidate festival day ("YYYY-MM-DD")
 * @param {string|null} [opts.eventDate] - event date fallback for NULL performance_date
 * @returns {Promise<Array>} Conflicts as { id, name, startTime, endTime, type: "conflict" | "overlap" }
 */
export async function checkConflicts(
  DB,
  { eventId, venueId, startTime, endTime, excludePerformanceId = null, performanceDate = null, eventDate = null },
) {
  let query = `
    SELECT p.id, p.start_time, p.end_time, p.performance_date, bp.name
    FROM performances p
    JOIN band_profiles bp ON p.band_profile_id = bp.id
    WHERE p.event_id = ? AND p.venue_id = ?
  `;
  const bindings = [eventId, venueId];
  if (excludePerformanceId) {
    query += ` AND p.id != ?`;
    bindings.push(excludePerformanceId);
  }

  const { results: existingPerformances } = await DB.prepare(query)
    .bind(...bindings)
    .all();
  const newIntervals = buildIntervals(startTime, endTime);
  // Festival-day scoping (#540): two sets on different festival days never
  // conflict, even at the same venue and clock time (a Day-1 8 PM and a Day-2
  // 8 PM set at the same venue are distinct slots). Falls back to eventDate for
  // NULL performance_date, so single-day events (both sides NULL → same day)
  // keep conflicting exactly as before. Mirrors detectConflicts in
  // frontend/src/admin/utils/timeUtils.js (#538).
  const candidateDay = performanceDate || eventDate;
  const conflicts = [];

  for (const perf of existingPerformances) {
    if (!perf.start_time || !perf.end_time) continue;
    const otherDay = perf.performance_date || eventDate;
    if (candidateDay && otherDay && candidateDay !== otherDay) continue;
    const perfIntervals = buildIntervals(perf.start_time, perf.end_time);
    const hasOverlap = perfIntervals.some((b) => newIntervals.some((a) => intervalsOverlap(a, b)));
    if (hasOverlap) {
      conflicts.push({
        id: perf.id,
        name: perf.name,
        startTime: perf.start_time,
        endTime: perf.end_time,
        type: perf.start_time === startTime && perf.end_time === endTime ? "conflict" : "overlap",
      });
    }
  }

  return conflicts;
}

/**
 * Detect scheduling conflicts for a bulk move_venue or change_time operation.
 *
 * Encapsulates the DB queries, existing-performance checks, and within-batch
 * pair checks. Handles after-midnight sets correctly via buildIntervals.
 * Archived-event conflicts are NOT included — callers handle those separately.
 *
 * @param {Object} env - Cloudflare env with DB binding
 * @param {Object} opts
 * @param {string} opts.action - "move_venue" or "change_time"
 * @param {number[]} opts.bandIds - Validated integer performance IDs (non-empty)
 * @param {Object} opts.params - { venue_id } for move_venue, { start_time } for change_time
 * @returns {Promise<Array>} Array of conflict objects ({ band_id, type, message, severity })
 */
export async function detectBulkConflicts(env, { action, bandIds, params }) {
  if (!bandIds || bandIds.length === 0) return [];

  const conflicts = [];
  const placeholders = bandIds.map(() => "?").join(",");

  // Fetch all performance data for the batch (including archived events), then
  // filter out archived-event rows before scheduling-conflict checks. Callers
  // that need archived-event error messages (bulk-preview) handle those separately.
  const bands = await env.DB.prepare(
    `SELECT p.id, p.start_time, p.end_time, p.venue_id, p.event_id, p.performance_date, bp.name, e.status AS event_status, e.date AS event_date
     FROM performances p
     JOIN band_profiles bp ON p.band_profile_id = bp.id
     JOIN events e ON p.event_id = e.id
     WHERE p.id IN (${placeholders})`,
  )
    .bind(...bandIds)
    .all();

  const bandResults = (bands.results || []).filter((b) => b.event_status !== "archived");

  // Festival-day scoping (#551): two sets on different festival days never
  // conflict, even at the same venue and clock time (mirrors checkConflicts in
  // this file, #540). Falls back to the event's date for a
  // NULL performance_date, so single-day events (both sides NULL → same day)
  // conflict exactly as before. move_venue/change_time never mutate
  // performance_date, so a batch member's festival day is just its stored value.
  const festivalDayOf = (row) => row.performance_date || row.event_date;

  // Shared by both action branches: each excludes the batch's own members in
  // JS rather than with a SQL `p.id NOT IN (...)`, because binding every band
  // id put both queries at 2 + N parameters and D1's ceiling is 100.
  const batchIds = new Set(bandIds);

  if (action === "move_venue") {
    const { venue_id } = params;

    const venue = await env.DB.prepare("SELECT name FROM venues WHERE id = ?").bind(venue_id).first();
    // Venue existence is validated by callers before this function runs; if
    // somehow absent just return no conflicts rather than throwing.
    if (!venue) return [];

    // Fetch existing performances at the target venue per event, excluding all
    // batch members so they are invisible to the per-band check below (they are
    // handled pairwise instead to avoid double-reporting).
    // Batched, chunked, and with the exclusion done in JS -- all three matter.
    //
    // BATCHED because `band_ids` on the bulk PATCH/DELETE path is validated only
    // as an id array capped at MAX_BULK_BAND_IDS (200) with NO event_id
    // constraint, so a selection spanning many events is legal and the original
    // code issued one sequential awaited query per distinct event (#1130).
    //
    // CHUNKED, and the exclusion moved OUT of SQL, because of D1's 100-parameter
    // ceiling. Binding `venue_id` + every event id + every band id is 1 + 2N
    // parameters: a legal batch of 50 performances across 50 events is 101 and
    // D1 rejects the query, so bulk.js answers 500 before touching anything.
    //
    // The pre-batched code had the same ceiling one step further out -- it bound
    // all band ids per query, so 99 bands was already 101 parameters. Batching
    // lowered the threshold; it did not create it. Both are fixed here.
    //
    // Dropping `p.id NOT IN (...)` removes the band ids from the bind list
    // entirely, leaving 1 + chunk. Filtering the batch's own rows out in JS is
    // equivalent: they are excluded so batch members are invisible to the
    // per-band check below and get compared pairwise instead.
    const EVENT_ID_CHUNK = 99; // + venue_id = 100, D1's limit exactly
    const eventIds = [...new Set(bandResults.map((b) => b.event_id))];
    const venuePerformancesByEvent = new Map();
    for (const id of eventIds) venuePerformancesByEvent.set(id, []);

    for (let i = 0; i < eventIds.length; i += EVENT_ID_CHUNK) {
      const chunk = eventIds.slice(i, i + EVENT_ID_CHUNK);
      const eventPh = chunk.map(() => "?").join(", ");
      const rows = await env.DB.prepare(
        `SELECT p.id, p.event_id, p.start_time, p.end_time, p.performance_date, bp.name, e.date AS event_date
         FROM performances p
         JOIN band_profiles bp ON p.band_profile_id = bp.id
         JOIN events e ON p.event_id = e.id
         WHERE p.venue_id = ? AND p.event_id IN (${eventPh})`,
      )
        .bind(venue_id, ...chunk)
        .all();
      for (const row of rows.results || []) {
        if (batchIds.has(row.id)) continue; // the batch's own members
        venuePerformancesByEvent.get(row.event_id)?.push(row);
      }
    }

    // Check each batch member against existing performances at the target venue.
    for (const band of bandResults) {
      if (!band.start_time || !band.end_time) continue;
      const bandIntervals = buildIntervals(band.start_time, band.end_time);
      const bandDay = festivalDayOf(band);
      const existing = venuePerformancesByEvent.get(band.event_id) || [];
      for (const other of existing) {
        if (!other.start_time || !other.end_time) continue;
        const otherDay = festivalDayOf(other);
        if (bandDay && otherDay && bandDay !== otherDay) continue;
        const otherIntervals = buildIntervals(other.start_time, other.end_time);
        if (bandIntervals.some((a) => otherIntervals.some((b) => intervalsOverlap(a, b)))) {
          const isExact = other.start_time === band.start_time && other.end_time === band.end_time;
          conflicts.push({
            band_id: band.id,
            type: isExact ? "conflict" : "overlap",
            message: isExact
              ? `"${band.name}" has the exact same time as "${other.name}" at the new venue (${other.start_time}-${other.end_time})`
              : `"${band.name}" overlaps with "${other.name}" at new venue (${other.start_time}-${other.end_time})`,
            severity: "error",
          });
        }
      }
    }

    // Pairwise check within the batch (same event). Batch members are excluded
    // from the existing-performances query above, so they are invisible to each
    // other there; we must compare them here. One entry per pair to avoid
    // duplicates.
    for (let i = 0; i < bandResults.length; i++) {
      const bandA = bandResults[i];
      if (!bandA.start_time || !bandA.end_time) continue;
      const intervalsA = buildIntervals(bandA.start_time, bandA.end_time);
      const dayA = festivalDayOf(bandA);

      for (let j = i + 1; j < bandResults.length; j++) {
        const bandB = bandResults[j];
        if (!bandB.start_time || !bandB.end_time) continue;
        if (bandA.event_id !== bandB.event_id) continue;
        const dayB = festivalDayOf(bandB);
        if (dayA && dayB && dayA !== dayB) continue;

        const intervalsB = buildIntervals(bandB.start_time, bandB.end_time);
        if (!intervalsA.some((a) => intervalsB.some((b) => intervalsOverlap(a, b)))) continue;

        const isExact = bandA.start_time === bandB.start_time && bandA.end_time === bandB.end_time;
        conflicts.push({
          band_id: bandA.id,
          type: isExact ? "conflict" : "overlap",
          message: isExact
            ? `"${bandA.name}" and "${bandB.name}" have the exact same time (both being moved to ${venue.name})`
            : `"${bandA.name}" and "${bandB.name}" overlap (both being moved to ${venue.name})`,
          severity: "error",
        });
      }
    }
  } else if (action === "change_time") {
    const { start_time } = params;

    // Cache existing performances per (venue, event) pair so we query each
    // unique combination at most once.
    const changeTimeVenueKey = (venueId, eventId) => `${venueId}:${eventId}`;
    const changeTimeCache = new Map();

    for (const band of bandResults) {
      if (!band.start_time || !band.end_time || !band.venue_id) continue;

      const newEndTime = computeNewEndTime(band.start_time, band.end_time, start_time);
      const cacheKey = changeTimeVenueKey(band.venue_id, band.event_id);

      if (!changeTimeCache.has(cacheKey)) {
        const rows = await env.DB.prepare(
          `SELECT p.id, p.start_time, p.end_time, p.performance_date, bp.name, e.date AS event_date
           FROM performances p
           JOIN band_profiles bp ON p.band_profile_id = bp.id
           JOIN events e ON p.event_id = e.id
           WHERE p.venue_id = ? AND p.event_id = ?`,
        )
          .bind(band.venue_id, band.event_id)
          .all();
        // Exclude the batch's own members in JS, not SQL -- same reason as the
        // move_venue path above: binding every band id put this query at 2 + N
        // parameters, so 99 bands exceeded D1's ceiling of 100 and the route
        // 500'd. CodeRabbit flagged move_venue; this is its sibling.
        changeTimeCache.set(
          cacheKey,
          (rows.results || []).filter((r) => !batchIds.has(r.id)),
        );
      }

      const existing = changeTimeCache.get(cacheKey);
      const bandIntervals = buildIntervals(start_time, newEndTime);
      const bandDay = festivalDayOf(band);

      for (const other of existing) {
        if (!other.start_time || !other.end_time) continue;
        const otherDay = festivalDayOf(other);
        if (bandDay && otherDay && bandDay !== otherDay) continue;
        const otherIntervals = buildIntervals(other.start_time, other.end_time);
        if (bandIntervals.some((a) => otherIntervals.some((b) => intervalsOverlap(a, b)))) {
          const isExact = other.start_time === start_time && other.end_time === newEndTime;
          conflicts.push({
            band_id: band.id,
            type: isExact ? "conflict" : "overlap",
            message: isExact
              ? `"${band.name}" has the exact same time as "${other.name}" at venue (${other.start_time}-${other.end_time})`
              : `"${band.name}" overlaps with "${other.name}" at venue (${other.start_time}-${other.end_time})`,
            severity: "error",
          });
        }
      }
    }

    // Pairwise check for batch members that share venue + event. All receive the
    // same new start_time so any pair at the same venue/event will overlap at
    // minimum. One entry per pair to avoid duplicates.
    for (let i = 0; i < bandResults.length; i++) {
      const bandA = bandResults[i];
      if (!bandA.start_time || !bandA.end_time || !bandA.venue_id) continue;
      const dayA = festivalDayOf(bandA);

      for (let j = i + 1; j < bandResults.length; j++) {
        const bandB = bandResults[j];
        if (!bandB.start_time || !bandB.end_time || !bandB.venue_id) continue;
        if (bandA.venue_id !== bandB.venue_id || bandA.event_id !== bandB.event_id) continue;
        const dayB = festivalDayOf(bandB);
        if (dayA && dayB && dayA !== dayB) continue;

        const newEndA = computeNewEndTime(bandA.start_time, bandA.end_time, start_time);
        const newEndB = computeNewEndTime(bandB.start_time, bandB.end_time, start_time);
        const intervalsA = buildIntervals(start_time, newEndA);
        const intervalsB = buildIntervals(start_time, newEndB);
        if (!intervalsA.some((a) => intervalsB.some((b) => intervalsOverlap(a, b)))) continue;

        const isExact = newEndA === newEndB;
        conflicts.push({
          band_id: bandA.id,
          type: isExact ? "conflict" : "overlap",
          message: isExact
            ? `"${bandA.name}" and "${bandB.name}" have the exact same time at venue after time change`
            : `"${bandA.name}" and "${bandB.name}" overlap at venue after time change`,
          severity: "error",
        });
      }
    }
  }

  return conflicts;
}
