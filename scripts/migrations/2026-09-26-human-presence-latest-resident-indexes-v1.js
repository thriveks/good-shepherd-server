"use strict";

const VERSION =
  "2026-09-26-human-presence-latest-resident-indexes-v1";

const DESCRIPTION =
  "Index latest Human Presence interpretation lookups by resident";

async function up(client) {
  await client.query(`
    CREATE INDEX IF NOT EXISTS
      human_presence_non_operational_latest_resident_idx
    ON human_presence_non_operational_interpretations (
      authoritative_resident_id,
      non_operational_interpretation_at DESC
    );

    CREATE INDEX IF NOT EXISTS
      human_presence_longitudinal_latest_resident_idx
    ON human_presence_longitudinal_interpretation_validations (
      authoritative_resident_id,
      longitudinal_interpretation_validation_at DESC
    );
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
