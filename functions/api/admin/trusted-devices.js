// Trusted device management endpoints
// GET  /api/admin/trusted-devices — list current user's trusted devices
// DELETE /api/admin/trusted-devices — revoke a specific device by ID (body: { deviceId })

import { parseJsonObjectBodyStrict } from "../../utils/request.js";
import { auditLogStatementForInsertedRow } from "../../utils/auditLogStatement.js";
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
    // One batch, and the ORDER is load-bearing: the audit statement is an
    // INSERT ... SELECT FROM trusted_devices, so it must run while the row
    // still exists. After the DELETE it would match nothing and record
    // nothing.
    //
    // Batched at all because -- unlike sessions.js and revoke-all.js, which
    // mutate through lucia -- this is a plain D1 statement, so there IS
    // something to put in a batch alongside the audit row. I had grouped it
    // with those two by mistake.
    //
    // The conditional form also makes a no-op delete honest: revoking a device
    // that is already gone writes neither the deletion nor a claim about it.
    await env.DB.batch([
      auditLogStatementForInsertedRow(
        env,
        user.userId,
        "trusted_device.revoked",
        "trusted_device",
        { table: "trusted_devices", where: { id: Number(deviceId), user_id: user.userId } },
        {},
        getClientIP(request),
      ),
      env.DB.prepare("DELETE FROM trusted_devices WHERE id = ? AND user_id = ?").bind(Number(deviceId), user.userId),
    ]);

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
