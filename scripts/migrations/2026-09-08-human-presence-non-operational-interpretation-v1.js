"use strict";

const {
  ensureHumanPresenceNonOperationalInterpretationTableV1
} = require(
  "../../lib/human_presence_non_operational_interpretation_persistence_v1"
);

const {
  backfillHumanPresenceNonOperationalInterpretationV1
} = require(
  "../backfill_human_presence_non_operational_interpretation_v1"
);

const VERSION =
  "2026-09-08-human-presence-non-operational-interpretation-v1";

const DESCRIPTION =
  "Create and backfill observer-only Human Presence Non-Operational Interpretation v1";

async function up(client) {
  await ensureHumanPresenceNonOperationalInterpretationTableV1(
    client
  );

  await backfillHumanPresenceNonOperationalInterpretationV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
