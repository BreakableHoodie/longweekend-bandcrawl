// Admin API: resend a band's "joined the lineup" announcement to followers who
// were not yet notified for this performance — recovers partial-send failures
// from the initial announce without ever double-sending.
// POST /api/admin/bands/[id]/resend-announcement   ([id] = performance id)
import { checkPermission, auditLog } from "../../_middleware.js";
import { getClientIP } from "../../../../utils/request.js";
import { isEmailConfigured } from "../../../../utils/email.js";
import { validateId } from "../../../../utils/validation.js";
import { claimIsLiveSql, notifyBandFollowers } from "../../../../utils/bandFollowNotify.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost(context) {
  const { request, env, params } = context;
  const { DB } = env;

  const { valid, value: performanceId, error } = validateId(params.id);
  if (!valid) return json({ error: "Bad request", message: error }, 400);

  // RBAC: editor or higher
  const perm = await checkPermission(context, "editor");
  if (perm.error) return perm.response;
  const user = perm.user;
  const ipAddress = getClientIP(request);

  if (!isEmailConfigured(env)) {
    return json({ error: "Email not configured", message: "Email is not configured" }, 400);
  }

  const perf = await DB.prepare(
    `SELECT p.id, p.is_announced, p.band_profile_id, bp.name AS band_name, e.name AS event_name
     FROM performances p
     JOIN band_profiles bp ON p.band_profile_id = bp.id
     JOIN events e ON p.event_id = e.id
     WHERE p.id = ?`,
  )
    .bind(performanceId)
    .first();

  if (!perf) {
    return json({ error: "Not found", message: "Performance not found" }, 404);
  }

  if (!perf.is_announced) {
    return json({ error: "Bad request", message: "Performance has not been announced" }, 400);
  }

  // Verified followers who still need this notice.
  //
  // NOT simply "has no ledger row" (#1152): a row can exist and mean nothing
  // was delivered, if a Worker died between claiming and sending. Matching on
  // row existence alone filtered those followers out of the very resend that
  // exists to recover them.
  //
  // claimIsLiveSql is shared with the sender so the two cannot drift -- a
  // resend that skips someone the sender would still mail is the same bug in
  // different clothes.
  const { results: followers = [] } = await DB.prepare(
    `SELECT bf.id, bf.email, bf.unsubscribe_token
     FROM band_follows bf
     LEFT JOIN band_follow_notifications bfn
       ON bfn.band_follow_id = bf.id AND bfn.performance_id = ?
     WHERE bf.band_profile_id = ? AND bf.verified = 1
       AND (bfn.id IS NULL OR NOT ${claimIsLiveSql("bfn")})`,
  )
    .bind(performanceId, perf.band_profile_id)
    .all();

  const { sent, failed } = await notifyBandFollowers(env, DB, {
    performanceId,
    bandProfileId: perf.band_profile_id,
    bandName: perf.band_name,
    eventName: perf.event_name,
    followers,
  });

  await auditLog(
    env,
    user.userId,
    "performance.announcement_resent",
    "performance",
    performanceId,
    { sent, failed, band_name: perf.band_name },
    ipAddress,
  );

  return json({ success: true, sent, failed });
}
