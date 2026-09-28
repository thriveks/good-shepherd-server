"use strict";

const {
  createHash,
  randomBytes
} = require("crypto");

const DEFAULT_STAFF_SESSION_HOURS = 12;

function hashStaffAppSessionToken(token) {
  const cleanToken =
    String(token || "").trim();

  if (!cleanToken) {
    return null;
  }

  return createHash("sha256")
    .update(cleanToken)
    .digest("hex");
}

function normalizedSessionHours(value) {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > 168
  ) {
    return DEFAULT_STAFF_SESSION_HOURS;
  }

  return parsed;
}

async function createStaffAppSession(
  pool,
  {
    sessionHours =
      DEFAULT_STAFF_SESSION_HOURS
  } = {}
) {
  if (
    !pool ||
    typeof pool.query !== "function"
  ) {
    throw new Error(
      "A PostgreSQL pool is required"
    );
  }

  const token =
    randomBytes(32).toString("base64url");

  const tokenHash =
    hashStaffAppSessionToken(token);

  const hours =
    normalizedSessionHours(
      sessionHours
    );

  const expiresAt =
    new Date(
      Date.now() +
      hours * 60 * 60 * 1000
    );

  await pool.query(
    `
      DELETE FROM staff_app_sessions
      WHERE expires_at <= NOW()
    `
  );

  await pool.query(
    `
      INSERT INTO staff_app_sessions (
        token_hash,
        expires_at
      )
      VALUES ($1, $2)
    `,
    [
      tokenHash,
      expiresAt.toISOString()
    ]
  );

  return {
    token,
    expiresAt
  };
}

async function authenticateStaffAppSession(
  pool,
  token
) {
  if (
    !pool ||
    typeof pool.query !== "function"
  ) {
    throw new Error(
      "A PostgreSQL pool is required"
    );
  }

  const tokenHash =
    hashStaffAppSessionToken(token);

  if (!tokenHash) {
    return null;
  }

  const result =
    await pool.query(
      `
        SELECT
          expires_at AS "expiresAt"
        FROM staff_app_sessions
        WHERE token_hash = $1
          AND expires_at > NOW()
        LIMIT 1
      `,
      [tokenHash]
    );

  return result.rows[0] || null;
}

async function revokeStaffAppSession(
  pool,
  token
) {
  if (
    !pool ||
    typeof pool.query !== "function"
  ) {
    throw new Error(
      "A PostgreSQL pool is required"
    );
  }

  const tokenHash =
    hashStaffAppSessionToken(token);

  if (!tokenHash) {
    return;
  }

  await pool.query(
    `
      DELETE FROM staff_app_sessions
      WHERE token_hash = $1
    `,
    [tokenHash]
  );
}

module.exports = {
  DEFAULT_STAFF_SESSION_HOURS,
  hashStaffAppSessionToken,
  createStaffAppSession,
  authenticateStaffAppSession,
  revokeStaffAppSession
};
