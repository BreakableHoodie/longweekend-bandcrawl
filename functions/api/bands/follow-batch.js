// POST /api/bands/follow-batch
// Batch double opt-in band follow.
//
// Body: { email, performance_ids: number[], turnstileToken? }
//
// Resolves performance_ids → unique band_profile_ids, inserts one band_follows
// row per band (verified=0, INSERT OR IGNORE), all sharing a single batch_token.
// Sends EXACTLY ONE combined confirmation email regardless of how many bands are
// in the batch — this is the amplification mitigation: one Turnstile solve → one
// email to the submitted address, not N emails.
//
// Security invariants:
//   • All rows inserted with verified=0 — announcement emails reach verified=1
//     followers only, so an unconfirmed address is never enrolled in the stream.
//   • INSERT OR IGNORE: idempotent — re-submitting the same email returns 200
//     without leaking follow state.
//   • One email per submit, not per band.
//   • N capped at MAX_BATCH_SIZE to limit per-request DB write overhead.
//   • Turnstile verified before any DB write.
//   • Rate-limited fail-closed via D1 (BATCH_FOLLOW_RE in rateLimit.js) by the
//     global middleware — no explicit call needed here.

import { isValidEmail } from "../../utils/validation.js";
import { generateToken } from "../../utils/tokens.js";
import { sendEmail, isEmailConfigured } from "../../utils/email.js";
import { verifyTurnstile } from "../../utils/turnstile.js";
import { escapeHtml } from "../../utils/html.js";
import { getPublicBaseUrl } from "../../utils/publicUrl.js";
import { parseJsonObjectBody } from "../../utils/request.js";
import { publicEventStatusSql } from "../../utils/eventVisibility.js";

const MAX_EMAIL_LENGTH = 320;
const MAX_BATCH_SIZE = 30;

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const { DB } = env;

  try {
    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const turnstileToken = body.turnstileToken;
    const performanceIds = body.performance_ids;

    if (!email || email.length > MAX_EMAIL_LENGTH || !isValidEmail(email)) {
      return new Response(JSON.stringify({ error: "Invalid email address" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      !Array.isArray(performanceIds) ||
      performanceIds.length === 0 ||
      performanceIds.length > MAX_BATCH_SIZE ||
      !performanceIds.every((id) => Number.isInteger(id) && id > 0)
    ) {
      return new Response(
        JSON.stringify({
          error: `performance_ids must be a non-empty array of up to ${MAX_BATCH_SIZE} positive integers`,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const turnstileValid = await verifyTurnstile(request, env, turnstileToken);
    if (!turnstileValid) {
      return new Response(JSON.stringify({ error: "Bot verification failed" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Resolve performance_ids → distinct band_profile_ids + band names.
    // Unknown performance IDs are silently dropped. If none resolve, return
    // success anyway (no enumeration of which IDs are valid).
    // Gated like every other path that resolves CALLER-SUPPLIED performance ids
    // (#1133). The HTTP response deliberately reveals nothing -- see the comment
    // above -- but the confirmation email BELOW LISTS THE BAND NAMES, so an
    // ungated resolve enumerated exactly what this endpoint refuses to
    // enumerate over HTTP: post arbitrary ids with an address you control and
    // read the names out of your inbox, including unannounced sets and bands on
    // draft events.
    //
    // No event scoping here, unlike the two share-link routes: the body carries
    // no event context, so there is nothing to scope TO. The status and reveal
    // gates are the load-bearing pair regardless -- they are what withholds
    // non-public bands; the event_id predicate there is a tightening, not the
    // control.
    const placeholders = performanceIds.map(() => "?").join(",");
    const bands = await DB.prepare(
      `SELECT DISTINCT p.band_profile_id, bp.name AS band_name
       FROM performances p
       JOIN band_profiles bp ON bp.id = p.band_profile_id
       JOIN events e ON e.id = p.event_id
       WHERE p.id IN (${placeholders})
         AND ${publicEventStatusSql("e")}
         AND (e.reveal_mode = 0 OR p.is_announced = 1)`,
    )
      .bind(...performanceIds)
      .all();

    if (!bands.results || bands.results.length === 0) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const consentIp = request.headers.get("CF-Connecting-IP") ?? null;
    // One shared batch_token ties all the rows together so a single confirm link
    // can flip all of them to verified=1.
    const batchToken = generateToken();
    const publicUrl = getPublicBaseUrl(env);
    const confirmUrl = `${publicUrl}/api/bands/confirm-follow-batch?token=${batchToken}`;

    // Build one INSERT OR IGNORE per band. Each row gets a unique per-row
    // verification_token and unsubscribe_token (both have UNIQUE constraints),
    // plus the shared batch_token. DB.batch() is atomic: if any write fails, all
    // are rolled back.
    //
    // Known edge (fails safe): a pre-existing *pending* single-follow for a band
    // (verified=0, batch_token=NULL, from /api/bands/:name/follow) is left untouched
    // by INSERT OR IGNORE, so it is NOT adopted into this batch_token — it stays
    // confirmable via its own earlier email. This errs toward not-verifying, never
    // toward over-verifying, so it carries no email-amplification or consent risk.
    const stmts = bands.results.map(({ band_profile_id }) => {
      const verificationToken = generateToken();
      const unsubscribeToken = generateToken();
      return DB.prepare(
        `INSERT OR IGNORE INTO band_follows
           (email, band_profile_id, verified, verification_token, unsubscribe_token,
            consent_ip, consent_method, batch_token)
         VALUES (?, ?, 0, ?, ?, ?, 'web_form', ?)`,
      ).bind(email, band_profile_id, verificationToken, unsubscribeToken, consentIp, batchToken);
    });

    const results = await DB.batch(stmts);
    // True when at least one new follow row was inserted (not an existing duplicate).
    const isNewBatch = results.some((r) => r.meta.changes > 0);

    if (isNewBatch && isEmailConfigured(env)) {
      const bandListText = bands.results.map((b) => `• ${b.band_name}`).join("\n");
      const bandListHtml = bands.results.map((b) => `<li>${escapeHtml(b.band_name)}</li>`).join("");

      // ONE email for the whole batch — the core amplification mitigation.
      waitUntil(
        sendEmail(env, {
          to: email,
          subject: "Confirm your lineup — SetTimes",
          text: [
            "Someone (hopefully you) asked to follow this lineup on SetTimes:",
            "",
            bandListText,
            "",
            `Confirm to get an email the moment set times drop:\n${confirmUrl}`,
            "",
            "If this wasn't you, ignore this email — you won't be subscribed.",
          ].join("\n"),
          html: [
            "<p>Someone (hopefully you) asked to follow this lineup on SetTimes:</p>",
            `<ul>${bandListHtml}</ul>`,
            `<p><a href="${confirmUrl}">Confirm your lineup</a> to get an email the moment set times drop.</p>`,
            "<p>If this wasn't you, just ignore this email — you won't be subscribed.</p>",
          ].join(""),
        })
          .then((emailResult) => {
            if (!emailResult?.delivered) {
              console.warn("[band-follow-batch] Confirmation email not delivered:", emailResult?.reason);
            }
          })
          .catch((err) => {
            console.error("[band-follow-batch] Failed to send confirmation email:", err);
          }),
      );
    }

    const responseBody = { success: true };
    // In local/dev (email unconfigured), surface the confirmUrl inline so the
    // follow can still be completed — mirrors follow.js behaviour.
    if (isNewBatch && !isEmailConfigured(env)) {
      responseBody.confirmUrl = confirmUrl;
    }

    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[band-follow-batch] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
