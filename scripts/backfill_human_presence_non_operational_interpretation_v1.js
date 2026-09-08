"use strict";

const {
  HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,
  PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION
} = require(
  "../lib/human_presence_non_operational_interpretation_v1"
);

const {
  buildAndPersistHumanPresenceNonOperationalInterpretationV1
} = require(
  "../lib/human_presence_non_operational_interpretation_persistence_v1"
);

async function backfillHumanPresenceNonOperationalInterpretationV1(
  db,
  { log = console.log } = {}
) {
  const result =
    await db.query(
      `
        SELECT
          c.evidence_event_id

        FROM human_presence_candidate_interpretation_rule_analyses c

        LEFT JOIN
          human_presence_non_operational_interpretations n

          ON n.evidence_event_id =
             c.evidence_event_id

         AND n.non_operational_interpretation_version =
             $1

        WHERE
          c.candidate_interpretation_rules_version =
            $2

          AND c.authority_resolution_status =
              'resolved_assigned_sensor'

          AND n.evidence_event_id IS NULL

        ORDER BY
          c.evidence_received_at ASC,
          c.evidence_event_id ASC
      `,
      [
        HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,
        PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION
      ]
    );

  let inserted = 0;

  for (const row of result.rows) {
    const built =
      await buildAndPersistHumanPresenceNonOperationalInterpretationV1(
        db,
        row.evidence_event_id
      );

    if (!built.persistence.inserted) {
      throw new Error(
        `Non-Operational Interpretation v1 backfill failed for ${row.evidence_event_id}`
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
    "Human Presence Non-Operational Interpretation v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  backfillHumanPresenceNonOperationalInterpretationV1
};
