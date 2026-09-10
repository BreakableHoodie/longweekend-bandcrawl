// Admin API: mail the general subscriber list about this event (#1149).
// POST /api/admin/events/[id]/notify-subscribers   body: { kind }
//
// ADMIN-TRIGGERED, not automatic, and that is deliberate for a first version.
// Firing on a data change would mean an accidental edit mails the whole list
// with no undo -- email is the one side effect you cannot take back. This
// mirrors resend-announcement.js, which is manual for the same reason.
//
// Idempotent by construction: subscribers already notified for this
// (event, kind) are skipped, so calling it twice mails nobody twice, and
// calling it after a partial failure retries only the gaps.
import { checkPermission, auditLog } from "../../_middleware.js";
import { getClientIP, parseJsonObjectBody } from "../../../../utils/request.js";
import { validateId } from "../../../../utils/validation.js";
import { notifySubscribers, pendingSubscribers } from "../../../../utils/subscriberNotify.js";
import { publishedEventStatusSql } from "../../../../utils/eventVisibility.js";

/**
 * The notices this endpoint can send.
 *
 * An allowlist, not free text: `kind` is part of the delivery-tracking key, so
 * a typo would not fail -- it would silently mail everyone again under a new
 * key. The subject and body live here rather than in the request so the same
 * notice cannot be sent with two different wordings.
 */
const KINDS = {
  lineup_announced: {
    subject: (name) => `The lineup for ${name} is live`,
    lead: (name) => `The full lineup for ${name} has been announced.`,
  },
  schedule_announced: {
    subject: (name) => `Set times for ${name} are up`,
    lead: (name) => `Set times and venues for ${name} are now published.`,
  },
};

export async function onRequestPost(context) {
  const { request, env } = context;
  const { DB } = env;

  const permCheck = await checkPermission(context, "editor");
  if (permCheck.error) {
    return permCheck.response;
  }
  const { user } = permCheck;

  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // validateId returns { valid, value, error } -- an OBJECT, which is always
  // truthy. Testing it directly rejects every request, valid ids included.
  const id = validateId(context.params?.id);
  if (!id.valid) {
    return json({ error: "Bad request", message: id.error }, 400);
  }
  const eventId = id.value;

  const body = await parseJsonObjectBody(request);
  if (body === null) {
    return json({ error: "Invalid request body" }, 400);
  }

  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!Object.hasOwn(KINDS, kind)) {
    return json({ error: "Bad request", message: `kind must be one of: ${Object.keys(KINDS).join(", ")}` }, 400);
  }

  // publishedEventStatusSql, not the broader public gate: mailing a list about
  // a draft would announce something nobody can open, and about an ARCHIVED
  // event would announce something already over.
  const event = await DB.prepare(
    `SELECT id, name, slug FROM events e WHERE e.id = ? AND ${publishedEventStatusSql("e")}`,
  )
    .bind(eventId)
    .first();

  if (!event) {
    return json({ error: "Not found", message: "No published event with that id", code: "EVENT_NOT_PUBLISHED" }, 404);
  }

  const subscribers = await pendingSubscribers(DB, { eventId, kind });
  if (subscribers.length === 0) {
    // 200, not an error: "everyone already has it" is a success, and it is what
    // a second call after a complete send looks like.
    return json({ success: true, sent: 0, failed: 0, pending: 0 });
  }

  const { sent, failed } = await notifySubscribers(env, DB, {
    eventId,
    kind,
    eventName: event.name,
    eventSlug: event.slug,
    subject: KINDS[kind].subject(event.name),
    lead: KINDS[kind].lead(event.name),
    subscribers,
  });

  await auditLog(
    env,
    user.userId,
    "event.subscribers_notified",
    "event",
    eventId,
    { kind, sent, failed },
    getClientIP(request),
  );

  return json({ success: true, sent, failed, pending: subscribers.length });
}
