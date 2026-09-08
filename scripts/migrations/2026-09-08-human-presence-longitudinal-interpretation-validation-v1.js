"use strict";

const {
  ensureHumanPresenceLongitudinalInterpretationValidationTableV1
} = require(
  "../../lib/human_presence_longitudinal_interpretation_validation_persistence_v1"
);

const {
  backfillHumanPresenceLongitudinalInterpretationValidationV1
} = require(
  "../backfill_human_presence_longitudinal_interpretation_validation_v1"
);

const VERSION =
  "2026-09-08-human-presence-longitudinal-interpretation-validation-v1";

const DESCRIPTION =
  "Create and backfill observer-only Human Presence Longitudinal Interpretation Validation v1";

async function up(client) {
  await ensureHumanPresenceLongitudinalInterpretationValidationTableV1(
    client
  );

  await backfillHumanPresenceLongitudinalInterpretationValidationV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
