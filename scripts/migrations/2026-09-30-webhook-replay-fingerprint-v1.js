"use strict";

const VERSION =
  "2026-09-30-webhook-replay-fingerprint-v1";

const DESCRIPTION =
  "Prevent duplicate processing of replayed signed webhook requests";

async function up(client) {
  await client.query(`
    ALTER TABLE webhook_events
      ADD COLUMN IF NOT EXISTS
        request_fingerprint TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS
      webhook_events_request_fingerprint_unique_idx
    ON webhook_events (
      request_fingerprint
    )
    WHERE request_fingerprint IS NOT NULL;
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
