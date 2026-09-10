import { hashPassword } from "../../../utils/crypto.js";
import { isValidEmail, validatePassword, FIELD_LIMITS } from "../../../utils/validation.js";
import { getClientIP, parseJsonObjectBody } from "../../../utils/request.js";
import { isEmailConfigured, sendEmail } from "../../../utils/email.js";
import { buildActivationEmail } from "../../../utils/emailTemplates.js";
import {
  AUTH_ATTEMPT_TYPES,
  checkAuthRateLimit,
  toSqliteDateTime,
  writeAuthAttempt,
} from "../../../utils/authAttempts.js";
import { logger } from "../../../utils/logger.js";
import { getPublicBaseUrl } from "../../../utils/publicUrl.js";
import { auditLog } from "../_middleware.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const { DB } = env;
  const ipAddress = getClientIP(request);

  try {
    const body = await parseJsonObjectBody(request);
    if (body === null) {
      return new Response(
        JSON.stringify({ error: "Validation error", message: "Invite code is required for signup" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const { email, password, name, firstName, lastName, role, inviteCode } = body;

    // SECURITY: Require invite code for all signups
    if (!inviteCode) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Invite code is required for signup",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Validation
    if (!email || !password) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Email and password are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Email format validation
    if (!isValidEmail(email)) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "Invalid email format",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Check rate limit
    const rateCheck = await checkAuthRateLimit(DB, {
      attemptType: AUTH_ATTEMPT_TYPES.signup,
      email,
      ipAddress,
      scope: "email-or-ip",
    });
    if (!rateCheck.allowed) {
      return new Response(
        JSON.stringify({
          error: "Too many attempts",
          message: `Too many failed signup attempts. Please try again in ${rateCheck.remainingMinutes} minutes.`,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Password strength validation
    const passwordCheck = validatePassword(password, {
      minLength: FIELD_LIMITS.password.min,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSpecial: true,
    });
    if (!passwordCheck.valid) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: passwordCheck.errors[0],
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // SECURITY: Validate invite code
    const invite = await DB.prepare(
      `
      SELECT * FROM invite_codes
      WHERE code = ?
      AND is_active = 1
      AND expires_at > datetime('now')
      AND used_by_user_id IS NULL
    `,
    )
      .bind(inviteCode)
      .first();

    if (!invite) {
      // Log failed signup attempt
      await writeAuthAttempt(DB, {
        attemptType: AUTH_ATTEMPT_TYPES.signup,
        email,
        failureReason: "invalid_invite_code",
        ipAddress,
        success: false,
        userAgent: request.headers.get("User-Agent") || "unknown",
      });

      return new Response(
        JSON.stringify({
          error: "Invalid invite code",
          message: "The invite code is invalid, expired, or has already been used",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // If invite is email-restricted, verify email matches
    if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
      await writeAuthAttempt(DB, {
        attemptType: AUTH_ATTEMPT_TYPES.signup,
        email,
        failureReason: "email_mismatch",
        ipAddress,
        success: false,
        userAgent: request.headers.get("User-Agent") || "unknown",
      });

      return new Response(
        JSON.stringify({
          error: "Email mismatch",
          message: "This invite code is restricted to a different email address",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // SECURITY: Use role from invite code, not from request
    // This prevents privilege escalation
    const userRole = invite.role;

    // Ignore any role parameter passed by client to prevent privilege escalation
    if (role === "admin") {
      console.warn(`Signup attempt with admin role blocked for email: ${email}`);
    }

    // Check if user already exists
    const existingUser = await DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();

    if (existingUser) {
      return new Response(
        JSON.stringify({
          error: "Conflict",
          message: "Email already registered",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const fallbackName = name !== undefined && name !== null ? String(name).trim() : "";
    let resolvedFirstName = firstName !== undefined && firstName !== null ? String(firstName).trim() : "";
    let resolvedLastName = lastName !== undefined && lastName !== null ? String(lastName).trim() : "";

    if ((!resolvedFirstName || !resolvedLastName) && fallbackName) {
      const parts = fallbackName.split(/\s+/).filter(Boolean);
      if (!resolvedFirstName) {
        resolvedFirstName = parts[0] || "";
      }
      if (!resolvedLastName) {
        resolvedLastName = parts.slice(1).join(" ");
      }
    }

    if (!resolvedFirstName || !resolvedLastName) {
      return new Response(
        JSON.stringify({
          error: "Validation error",
          message: "First name and last name are required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const resolvedName = `${resolvedFirstName} ${resolvedLastName}`.trim();

    // Hash password
    const passwordHash = await hashPassword(password);

    const activationToken = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
    // SEC-F1 class (#670): must be space-separated to compare correctly
    // against D1's datetime('now') in activate.js's SQL expiry guard.
    const activationExpires = toSqliteDateTime(new Date(Date.now() + 24 * 60 * 60 * 1000));

    // Create user (inactive until activation)
    const user = await DB.prepare(
      "INSERT INTO users (email, password_hash, name, first_name, last_name, role, is_active, activation_token, activation_token_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, email, name, first_name, last_name, role",
    )
      .bind(
        email,
        passwordHash,
        resolvedName || null,
        resolvedFirstName || null,
        resolvedLastName || null,
        userRole,
        0,
        activationToken,
        activationExpires,
      )
      .first();

    // Mark invite code as used
    await DB.prepare("UPDATE invite_codes SET used_by_user_id = ?, used_at = datetime('now') WHERE code = ?")
      .bind(user.id, inviteCode)
      .run();

    // Also an audit row, not just an auth attempt (#1143). An admin creating a
    // user via users.js writes `user.created`; a self-signup through an invite
    // code wrote only to auth_attempts, so the same event was recorded in two
    // different places depending on the route taken. Attributed to the new user
    // themselves -- they are the actor; there is no session yet.
    await auditLog(env, user.id, "user.created", "user", user.id, { email, via: "invite_signup" }, ipAddress);

    // Log successful signup
    await writeAuthAttempt(DB, {
      attemptType: AUTH_ATTEMPT_TYPES.signup,
      email,
      ipAddress,
      success: true,
      userAgent: request.headers.get("User-Agent") || "unknown",
      userId: user.id,
    });

    const baseUrl = getPublicBaseUrl(env);
    const activationUrl = new URL("/activate", baseUrl);
    activationUrl.searchParams.set("token", activationToken);

    let emailResult = { delivered: false, reason: "not_configured" };
    logger.debug("checking email configuration for activation email", {
      userId: user.id,
    });

    if (isEmailConfigured(env)) {
      logger.debug("email configured, sending activation email", {
        userId: user.id,
      });
      const emailPayload = buildActivationEmail({
        activationUrl: activationUrl.toString(),
        recipientName: resolvedName || null,
      });

      emailResult = await sendEmail(env, {
        to: email,
        subject: emailPayload.subject,
        text: emailPayload.text,
        html: emailPayload.html,
      });
      logger.debug("activation email delivery attempted", { userId: user.id });
    } else {
      console.warn("[Signup] Email not configured; activation email was not sent.");
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Account created. Please check your email to activate your account.",
        requiresActivation: true,
        email: { delivered: !!emailResult?.delivered },
      }),
      {
        status: 201,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("Signup error:", error);
    return new Response(
      JSON.stringify({
        error: "Server error",
        message: "Failed to create account",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
