/**
 * Band Photo Upload API
 * POST /api/admin/bands/photos
 *
 * Handles photo uploads to R2 bucket for band profiles.
 * Supports image validation, optimization, and secure file storage.
 */

import { checkPermission, auditLog } from "../_middleware.js";
import { getClientIP } from "../../../utils/request.js";
import { detectImageMimeType, MAX_FILE_SIZE, ALLOWED_IMAGE_TYPES } from "../../../utils/imageUpload.js";

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
    const file = formData.get("photo");
    const bandId = formData.get("band_id"); // Optional: associate with band

    if (!file || !(file instanceof File)) {
      return new Response(JSON.stringify({ error: "No photo file provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
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

    // Resolve band_id BEFORE uploading. Two reasons it has to be this order:
    //
    //  1. An unresolvable id used to leave an orphaned R2 object behind, because
    //     the upload had already happened by the time the lookup failed (#1035).
    //  2. The `profile_<id>` branch previously did no lookup at all — it parsed
    //     the number and trusted it, so `profile_99999` produced an UPDATE
    //     matching zero rows and the handler still answered 200 {success:true}.
    //     An admin saw "uploaded", reloaded, and the photo was simply absent,
    //     with nothing logged. The numeric branch always verified; the two are
    //     now symmetric.
    let bandProfileId;
    if (bandId) {
      const bandIdValue = bandId.toString();

      if (bandIdValue.startsWith("profile_")) {
        const parsed = Number(bandIdValue.replace("profile_", ""));
        if (Number.isInteger(parsed) && parsed > 0) {
          const profile = await env.DB.prepare("SELECT id FROM band_profiles WHERE id = ?").bind(parsed).first();
          bandProfileId = profile?.id;
        }
      } else if (!Number.isNaN(Number(bandIdValue))) {
        const performance = await env.DB.prepare("SELECT band_profile_id FROM performances WHERE id = ?")
          .bind(Number(bandIdValue))
          .first();

        bandProfileId = performance?.band_profile_id;
        if (!bandProfileId) {
          const profile = await env.DB.prepare("SELECT id FROM band_profiles WHERE id = ?")
            .bind(Number(bandIdValue))
            .first();
          bandProfileId = profile?.id;
        }
      }

      // A caller that names a band and gets no match asked for something that
      // does not exist — that is a 404, not a silent success. Note this fires
      // only when band_id was SUPPLIED; omitting it remains a valid
      // upload-without-association and still returns 200.
      if (!bandProfileId) {
        return new Response(JSON.stringify({ error: "Band profile not found", code: "BAND_NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Generate unique filename with timestamp
    const timestamp = Date.now();
    const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_").toLowerCase();
    const filename = `band-photos/${timestamp}-${sanitizedName}`;

    // Upload to R2 bucket — use the server-verified type, not the client-supplied one.
    await env.BAND_PHOTOS.put(filename, file.stream(), {
      httpMetadata: {
        contentType: detectedType,
      },
      customMetadata: {
        uploadedBy: user.email,
        uploadedAt: new Date().toISOString(),
        originalName: file.name,
        ...(bandId && { bandId: bandId.toString() }),
      },
    });

    // Generate the public URL for the stored object. The base is configurable via
    // BAND_PHOTOS_PUBLIC_URL so dev/staging/prod can point at different R2 public
    // buckets / custom domains; falls back to the production custom domain.
    const photoBaseUrl = env.BAND_PHOTOS_PUBLIC_URL || "https://band-photos.settimes.ca";
    const publicUrl = `${photoBaseUrl}/${filename}`;

    if (bandProfileId) {
      const updateResult = await env.DB.prepare("UPDATE band_profiles SET photo_url = ? WHERE id = ?")
        .bind(publicUrl, bandProfileId)
        .run();

      // The profile existed when we looked it up, but it can be deleted between
      // that read and this write — another admin tab, a concurrent cleanup. The
      // pre-upload check narrows that window; it cannot close it. Without this,
      // the race lands on exactly the bug this file was fixing: 200
      // {success:true}, no photo, and an orphaned R2 object.
      //
      // ONLY an explicit 0 counts as failure. If `meta` is absent we cannot tell
      // what happened, and schedule/share/[slug].js documents that D1's meta
      // shape is not safe to depend on. Failing closed there would DELETE a
      // successful upload and report "not found" — strictly worse than the rare
      // orphan this guards against, so the ambiguous case keeps the upload.
      // A deliberate departure from the fail-closed `!result?.meta?.changes`
      // pattern in reset-password-complete.js and activate.js, where the safe
      // direction is the opposite one.
      if (updateResult?.meta?.changes === 0) {
        await env.BAND_PHOTOS.delete(filename);
        return new Response(JSON.stringify({ error: "Band profile not found", code: "BAND_NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // A photo is content, so a change to it belongs in the log (#1143). Only
    // logged when it was actually attached to a profile -- an upload with no
    // bandProfileId writes to R2 and no database row, so there is no resource
    // to attribute it to.
    if (bandProfileId) {
      await auditLog(
        env,
        user.userId,
        "band.photo_updated",
        "band",
        bandProfileId,
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
    console.error("Photo upload error:", error);
    return new Response(
      JSON.stringify({
        error: "Photo upload failed",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * DELETE /api/admin/bands/photos/:filename
 * Delete a photo from R2 bucket
 */
export async function onRequestDelete(context) {
  const { request, env } = context;

  try {
    const permCheck = await checkPermission(context, "editor");
    if (permCheck.error) {
      return permCheck.response;
    }
    const { user } = permCheck;

    // Extract filename from URL path
    const url = new URL(request.url);
    const pathParts = url.pathname.split("/");
    const encodedSegment = pathParts[pathParts.length - 1];
    if (!encodedSegment || encodedSegment === "photos") {
      return new Response(JSON.stringify({ error: "Filename required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const objectKey = decodeURIComponent(encodedSegment);
    if (!objectKey.startsWith("band-photos/")) {
      return new Response(JSON.stringify({ error: "Invalid key" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Delete from R2 bucket
    await env.BAND_PHOTOS.delete(objectKey);

    // Destroying a photo is a change, and unlike the upload path there is no
    // band_profile row to point at -- this route takes an object key, not a
    // profile id. Logged against the key so the deletion is still attributable.
    await auditLog(env, user.userId, "band.photo_deleted", "band_photo", null, { objectKey }, getClientIP(request));

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Photo deletion error:", error);
    return new Response(
      JSON.stringify({
        error: "Photo deletion failed",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
