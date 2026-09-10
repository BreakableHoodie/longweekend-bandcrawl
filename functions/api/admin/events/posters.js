/**
 * Event Poster Upload API
 * POST /api/admin/events/posters
 *
 * Uploads an event poster image, mirroring functions/api/admin/bands/photos.js
 * (#616 design comment): same magic-byte validation (functions/utils/imageUpload.js),
 * same R2 bucket (BAND_PHOTOS) — a dedicated poster bucket would be pure
 * operational overhead for the same storage need — under an event-posters/
 * key prefix instead of band-photos/.
 *
 * event_id is optional (mirrors bandId in photos.js): a poster can be
 * uploaded while creating a brand-new event that has no id yet, in which
 * case the caller only gets the public URL back and includes it in the
 * create payload. When event_id IS provided it is validated (validateId)
 * and must reference a real event; on success the row is updated directly
 * (same immediate-persistence convenience photos.js gives band_profiles),
 * through the same normalizeHttpUrl write-path sanitization as the PATCH
 * /api/admin/events/{id} endpoint (#504 convention).
 */

import { checkPermission, auditLog } from "../_middleware.js";
import { getClientIP } from "../../../utils/request.js";
import { detectImageMimeType, MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES } from "../../../utils/imageUpload.js";
import { normalizeHttpUrl, validateId } from "../../../utils/validation.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const permCheck = await checkPermission(context, "editor");
    if (permCheck.error) {
      return permCheck.response;
    }
    const { user } = permCheck;

    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("poster");
    const eventIdRaw = formData.get("event_id"); // Optional: associate with + persist to an event

    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "No poster file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate event_id when provided — an explicitly-supplied-but-invalid id
    // is a client bug worth surfacing as 400, not silently ignored.
    let eventId = null;
    if (eventIdRaw !== null && eventIdRaw !== "") {
      const { valid, value, error: idError } = validateId(eventIdRaw);
      if (!valid) {
        return new Response(JSON.stringify({ error: "Bad request", message: idError }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(value).first();
      if (!event) {
        return new Response(JSON.stringify({ error: "Not found", message: "Event not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      eventId = value;
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return new Response(
        JSON.stringify({
          error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Validate MIME type via magic bytes — ignores attacker-controlled file.type.
    const detectedType = await detectImageMimeType(file);
    if (!detectedType || !ALLOWED_IMAGE_TYPES.includes(detectedType)) {
      return new Response(
        JSON.stringify({
          error: "Invalid file type. Allowed: JPEG, PNG, WebP, GIF",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_").toLowerCase();
    const filename = `event-posters/${timestamp}-${sanitizedName}`;

    // Upload to R2 bucket — use the server-verified type, not the client-supplied one.
    await env.BAND_PHOTOS.put(filename, file.stream(), {
      httpMetadata: {
        contentType: detectedType,
      },
      customMetadata: {
        uploadedBy: user.email,
        uploadedAt: new Date().toISOString(),
        originalName: file.name,
        ...(eventId && { eventId: String(eventId) }),
      },
    });

    // Generate the public URL for the stored object. Same base as band photos
    // (BAND_PHOTOS_PUBLIC_URL) — the domain is bucket-level, not key-prefix-level.
    const photoBaseUrl = env.BAND_PHOTOS_PUBLIC_URL || "https://band-photos.settimes.ca";
    const publicUrl = `${photoBaseUrl}/${filename}`;

    // If event_id provided, persist immediately (mirrors photos.js's optional
    // bandId write). normalizeHttpUrl on write matches the PATCH endpoint's
    // sanitization so this row can never diverge from that convention.
    if (eventId) {
      await env.DB.prepare("UPDATE events SET poster_url = ? WHERE id = ?")
        .bind(normalizeHttpUrl(publicUrl), eventId)
        .run();

      // Inside the eventId branch on purpose (#1143): an upload with no event_id
      // writes to R2 and no database row, so there is no resource to attribute
      // the change to.
      await auditLog(
        env,
        user.userId,
        "event.poster_updated",
        "event",
        eventId,
        { url: publicUrl },
        getClientIP(request),
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        url: publicUrl,
        filename,
        size: file.size,
        type: detectedType,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Poster upload error:", error);
    return new Response(
      JSON.stringify({
        error: "Poster upload failed",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
