// Trusted device management endpoints
// GET  /api/admin/trusted-devices — list current user's trusted devices
// DELETE /api/admin/trusted-devices — revoke a specific device by ID (body: { deviceId })

import { parseJsonObjectBodyStrict } from "../../utils/request.js";
import { auditLog } from "./_middleware.js";
import { getClientIP } from "../../utils/request.js";

export async function onRequestGet(context) {
  const { env, data } = context;
  const { user } = data;

  try {
    const result = await env.DB.prepare(
      `
      SELECT
        id,
        ip_address,
        user_agent,
        created_at,
        last_used_at,
        expires_at
      FROM trusted_devices
      WHERE user_id = ? AND expires_at > datetime('now')
      ORDER BY last_used_at DESC, created_at DESC
    `,
    )
      .bind(user.userId)
      .all();

    return new Response(JSON.stringify({ devices: result.results || [] }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to load trusted devices:", error);
    return new Response(JSON.stringify({ error: "Failed to load trusted devices" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function onRequestDelete(context) {
  const { request, env, data } = context;
  const { user } = data;

  // Strict: this endpoint answered a malformed body with its own "Invalid request
  // body" 400 before the shared helper existed. The lenient helper turns a parse
  // failure into {}, which fell through to "deviceId is required" -- same status, wrong
  // reason. Strict restores it and covers null/array/scalar in the same branch.
  const body = await parseJsonObjectBodyStrict(request);
  if (body === null) {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const deviceId = body.deviceId;

  if (!deviceId || !Number.isInteger(Number(deviceId))) {
    return new Response(JSON.stringify({ error: "deviceId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Verify the device belongs to the requesting user before deleting
    const device = await env.DB.prepare("SELECT user_id FROM trusted_devices WHERE id = ?")
      .bind(Number(deviceId))
      .first();

    if (!device || Number(device.user_id) !== Number(user.userId)) {
      return new Response(JSON.stringify({ error: "Device not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    await env.DB.prepare("DELETE FROM trusted_devices WHERE id = ? AND user_id = ?")
      .bind(Number(deviceId), user.userId)
      .run();

    // A trusted device skips MFA, so removing one changes the account's
    // security posture -- exactly the kind of change the log exists for (#1143).
    await auditLog(
      env,
      user.userId,
      "trusted_device.revoked",
      "trusted_device",
      Number(deviceId),
      {},
      getClientIP(request),
    );

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Failed to revoke trusted device:", error);
    return new Response(JSON.stringify({ error: "Failed to revoke device" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
