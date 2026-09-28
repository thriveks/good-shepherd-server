"use strict";

const VERSION =
  "2026-09-28-staff-app-sessions-v1";

const DESCRIPTION =
  "Add expiring hashed staff application sessions";

async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS
      staff_app_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ
          NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ
          NOT NULL
      );

    CREATE INDEX IF NOT EXISTS
      staff_app_sessions_expires_at_idx
    ON staff_app_sessions (
      expires_at
    );
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
