// Revoke all sessions and issue a fresh one so the caller stays logged in
// POST /api/admin/sessions/revoke-all

import { generateCSRFToken, setCSRFCookie } from "../../../utils/csrf.js";
import { checkPermission, auditLog } from "../_middleware.js";
import { getClientIP } from "../../../utils/request.js";

export async function onRequestPost(context) {
  const { env, data, request } = context;

  // This endpoint MINTS a session, and until now it had no permission check at all --
  // it read `data` and trusted that the middleware had filled it. That made its safety
  // a property of middleware shape rather than of anything stated here, and the API-key
  // branch does not populate `data.lucia`, so a key reaching it crashed on undefined
  // instead of being refused. Keys are blocked by KEY_FORBIDDEN_PREFIXES now; this is
  // the second lock, so the route states its own requirement.
  //
  // "viewer", not "admin": revoking your OWN sessions is legitimate self-service at
  // every role. The check is here to guarantee an authenticated human, not to gate a
  // privilege -- raising the tier would break a viewer logging out everywhere.
  const permCheck = await checkPermission(context, "viewer");
  if (permCheck.error) {
    return permCheck.response;
  }

  const { lucia, user } = data;

  await lucia.invalidateUserSessions(user.userId);

  // Logged BEFORE the replacement session is minted, so the row attributes the
  // revocation to the session that asked for it rather than to the one created
  // a line later (#1143).
  // NOT batched with the revocation, unlike the photo and poster paths.
  // The mutation here goes through lucia, not a D1 statement this file
  // holds, so there is nothing to put in a DB.batch alongside it. The
  // audit row can therefore fail independently, leaving an unattributed
  // revocation -- accepted, because the alternative is reaching around
  // lucia's own session handling to hand-write its SQL.
  await auditLog(env, user.userId, "session.revoked_all", "session", null, {}, getClientIP(request));

  const newSession = await lucia.createSession(user.userId, {});

  await env.DB.prepare(
    `UPDATE lucia_sessions
     SET ip_address = ?, user_agent = ?, remember_me = ?
     WHERE id = ?`,
  )
    .bind(request.headers.get("CF-Connecting-IP"), request.headers.get("User-Agent"), 0, newSession.id)
    .run();

  const csrfToken = generateCSRFToken(request, env, newSession.id);

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", lucia.createSessionCookie(newSession.id).serialize());
  headers.append("Set-Cookie", setCSRFCookie(csrfToken, request, env));

  return new Response(
    JSON.stringify({
      success: true,
      message: "All other sessions revoked",
    }),
    { headers },
  );
}
