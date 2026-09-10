// Audit log endpoint for admin panel
// GET /api/admin/audit-log
// Query params: ?user_id=1&limit=50&offset=0&action=user.created

import { checkPermission } from "./_middleware.js";

// GET - Retrieve audit log entries (admin only)
export async function onRequestGet(context) {
  const { request, env } = context;
  const { DB } = env;

  try {
    // Check permission (admin only)
    const permCheck = await checkPermission(context, "admin");
    if (permCheck.error) {
      return permCheck.response;
    }

    // Parse query parameters
    const url = new URL(request.url);
    const userIdParam = url.searchParams.get("user_id");
    const action = url.searchParams.get("action");
    const resourceType = url.searchParams.get("resource_type");
    const limitRaw = Number.parseInt(url.searchParams.get("limit"), 10);
    const offsetRaw = Number.parseInt(url.searchParams.get("offset"), 10);
    const limit = !Number.isNaN(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const offset = !Number.isNaN(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    let userId = null;

    // Validate limit (prevent excessive queries)
    if (limit > 100) {
      return new Response(
        JSON.stringify({
          error: "Bad request",
          message: "Limit cannot exceed 100",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (userIdParam !== null) {
      userId = Number.parseInt(userIdParam, 10);
      if (!Number.isInteger(userId) || userId <= 0) {
        return new Response(
          JSON.stringify({
            error: "Bad request",
            message: "user_id must be a positive integer",
          }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
    }

    // Build WHERE clause based on filters
    const conditions = [];
    const params = [];

    if (userId !== null) {
      conditions.push("a.user_id = ?");
      params.push(userId);
    }

    if (action) {
      conditions.push("a.action = ?");
      params.push(action);
    }

    if (resourceType) {
      conditions.push("a.resource_type = ?");
      params.push(resourceType);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM audit_log a
      ${whereClause}
    `;

    const countResult = await DB.prepare(countQuery)
      .bind(...params)
      .first();
    const total = countResult.total;

    // Get log entries with user information
    const logsQuery = `
      SELECT
        a.id,
        a.user_id,
        u.email as user_email,
        u.name as user_name,
        a.action,
        a.resource_type,
        a.resource_id,
        a.details,
        a.ip_address,
        a.created_at,
        a.api_key_id
      FROM audit_log a
      LEFT JOIN users u ON a.user_id = u.id
      ${whereClause}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const { results: logs } = await DB.prepare(logsQuery)
      .bind(...params, limit, offset)
      .all();

    // Parse JSON details field
    const parsedLogs = logs.map((log) => ({
      id: log.id,
      userId: log.user_id,
      userEmail: log.user_email || "Unknown",
      userName: log.user_name || "Unknown",
      action: log.action,
      resourceType: log.resource_type,
      resourceId: log.resource_id,
      details: log.details ? JSON.parse(log.details) : null,
      ipAddress: log.ip_address,
      createdAt: log.created_at,
      // Projected so the UI can distinguish a key-authenticated action from a
      // cookie one. The column exists for exactly that question (migration
      // 0061); NULL means a browser session. Exposed as a BOOLEAN, not the id:
      // a viewer needs to know a key acted, and leaking which credential it was
      // buys nothing.
      viaApiKey: log.api_key_id !== null && log.api_key_id !== undefined,
    }));

    // Facets, not derived from the page. The UI's action filter used to be built
    // from whatever happened to be in the current 50 rows, so a valid but less
    // frequent action simply could not be selected -- and the older the action,
    // the less selectable it was, which is backwards for an audit log.
    //
    // Unfiltered on purpose: these are the choices AVAILABLE, so narrowing them
    // by the active filter would let one selection erase the others.
    const { results: actionRows } = await DB.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all();

    return new Response(
      JSON.stringify({
        logs: parsedLogs,
        availableActions: (actionRows || []).map((r) => r.action),
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Get audit log error:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch audit log" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
