// Session management endpoints
// GET /api/admin/sessions
// DELETE /api/admin/sessions

import { parseJsonObjectBody } from "../../utils/request.js";
import { auditLog } from "./_middleware.js";
import { getClientIP } from "../../utils/request.js";

// Derive a stable, opaque revocation handle from a raw Lucia session id.
// The raw id is an auth credential and must never leave the server; returning
// SHA-256(id) lets clients target a specific session for deletion without
// being able to forge or replay the underlying credential.
async function sessionRevocationToken(sessionId) {
  const data = new TextEncoder().encode(sessionId);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestGet(context) {
  const { env, data } = context;
  const { user, session } = data;
  const currentSessionId = session?.id || session?.session_token || null;

  try {
    const result = await env.DB.prepare(
      `
      SELECT
        id,
        ip_address,
        user_agent,
        created_at,
        last_activity_at,
        expires_at
      FROM lucia_sessions
      WHERE user_id = ?
      ORDER BY last_activity_at DESC
    `,
    )
      .bind(user.userId)
      .all();

    const sessions = await Promise.all(
      (result.results || []).map(async (row) => ({
        revocationToken: await sessionRevocationToken(row.id),
        ip_address: row.ip_address,
        user_agent: row.user_agent,
        created_at: row.created_at,
        last_activity_at: row.last_activity_at,
        expires_at: row.expires_at ? new Date(row.expires_at * 1000).toISOString() : null,
        current: currentSessionId ? row.id === currentSessionId : false,
      })),
    );

    return new Response(
      JSON.stringify({
        sessions,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Failed to load sessions:", error);
    return new Response(JSON.stringify({ error: "Failed to load sessions" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function onRequestDelete(context) {
  const { request, env, data } = context;
  const { lucia, user } = data;

  try {
    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return new Response(JSON.stringify({ error: "Revocation token is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const revocationToken = body.revocationToken;

    if (!revocationToken) {
      return new Response(JSON.stringify({ error: "Revocation token is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Resolve the opaque token back to a real session id. Compute all hashes
    // in parallel first so no extra round-trips are needed per session.
    const { results: userSessions } = await env.DB.prepare("SELECT id FROM lucia_sessions WHERE user_id = ?")
      .bind(user.userId)
      .all();

    const tokenMap = new Map(
      await Promise.all((userSessions || []).map(async (s) => [await sessionRevocationToken(s.id), s.id])),
    );
    const targetSessionId = tokenMap.get(revocationToken) ?? null;

    if (!targetSessionId) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await lucia.invalidateSession(targetSessionId);

    // Revoking a session is a security state change, so it is logged (#1143)
    // even though the session tables are themselves a record -- they show what
    // EXISTS now, not who removed what. The session id is deliberately not in
    // the details: it is a live credential identifier, and knowing a revocation
    // happened is the point.
    // NOT batched with the revocation, unlike the photo and poster paths.
    // The mutation here goes through lucia, not a D1 statement this file
    // holds, so there is nothing to put in a DB.batch alongside it. The
    // audit row can therefore fail independently, leaving an unattributed
    // revocation -- accepted, because the alternative is reaching around
    // lucia's own session handling to hand-write its SQL.
    await auditLog(env, user.userId, "session.revoked", "session", null, {}, getClientIP(request));

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to delete session:", error);
    return new Response(JSON.stringify({ error: "Failed to delete session" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
