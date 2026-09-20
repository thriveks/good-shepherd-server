"use strict";

const VERSION =
  "2026-09-20-customer-bootstrap-resident-event-index-v1";

const DESCRIPTION =
  "Add normalized resident and timestamp index for customer bootstrap webhook event lookup";

async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS
      webhook_events_resident_norm_timestamp_idx
    ON public.webhook_events (
      LOWER(TRIM(BOTH FROM resident_name)),
      "timestamp" DESC
    )
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
