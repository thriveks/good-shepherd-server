"use strict";

const {
  VERSION,
  PARENT_VERSION
} = require(
  "../lib/human_presence_longitudinal_interpretation_validation_v1"
);

const {
  buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1
} = require(
  "../lib/human_presence_longitudinal_interpretation_validation_persistence_v1"
);

async function backfillHumanPresenceLongitudinalInterpretationValidationV1(
  db,
  { log = console.log } = {}
) {
  const result =
    await db.query(
      `
        SELECT
          p.evidence_event_id

        FROM human_presence_non_operational_interpretations p

        LEFT JOIN
          human_presence_longitudinal_interpretation_validations l

          ON l.evidence_event_id =
             p.evidence_event_id

         AND l.longitudinal_interpretation_validation_version =
             $1

        WHERE
          p.non_operational_interpretation_version =
            $2

          AND p.authority_resolution_status =
            'resolved_assigned_sensor'

          AND l.evidence_event_id IS NULL

        ORDER BY
          p.evidence_received_at ASC,
          p.evidence_event_id ASC
      `,
      [
        VERSION,
        PARENT_VERSION
      ]
    );

  let inserted = 0;

  for (const row of result.rows) {
    const built =
      await buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1(
        db,
        row.evidence_event_id
      );

    if (!built.persistence.inserted) {
      throw new Error(
        `Longitudinal Interpretation Validation v1 backfill failed for ${row.evidence_event_id}`
      );
    }

    inserted += 1;
  }

  const summary = {
    eligible:
      result.rowCount,

    inserted
  };

  log(
    "Human Presence Longitudinal Interpretation Validation v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  backfillHumanPresenceLongitudinalInterpretationValidationV1
};
