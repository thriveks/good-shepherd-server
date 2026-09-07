"use strict";

const {
  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION,
  HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION
} = require(
  "../lib/human_presence_temporal_context_data_sufficiency_v1"
);

const {
  buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1
} = require(
  "../lib/human_presence_temporal_context_data_sufficiency_persistence_v1"
);

async function loadMissingTemporalContextSufficiencyParentsV1(
  db
) {
  const result =
    await db.query(
      `
        SELECT
          evidence_event_id

        FROM
          human_presence_episode_profile_temporal_context_analyses t

        WHERE
          t.episode_profile_temporal_context_analysis_version =
          $1

          AND NOT EXISTS (
            SELECT 1

            FROM
              human_presence_temporal_context_data_sufficiency_analyses s

            WHERE
              s.evidence_event_id =
              t.evidence_event_id

              AND
              s.temporal_context_data_sufficiency_version =
              $2
          )

        ORDER BY
          t.evidence_received_at ASC,
          t.evidence_event_id ASC
      `,
      [
        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_PARENT_VERSION,
        HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION
      ]
    );

  return result.rows;
}

async function backfillHumanPresenceTemporalContextDataSufficiencyV1(
  db,
  { log = console.log } = {}
) {
  const candidates =
    await loadMissingTemporalContextSufficiencyParentsV1(
      db
    );

  let inserted = 0;
  let alreadyExists = 0;

  for (const row of candidates) {
    const result =
      await buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1(
        db,
        row.evidence_event_id
      );

    if (result.persistence.inserted) {
      inserted += 1;
    } else {
      alreadyExists += 1;
    }
  }

  const summary = {
    candidateCount:
      candidates.length,

    inserted,
    alreadyExists,

    version:
      HUMAN_PRESENCE_TEMPORAL_CONTEXT_DATA_SUFFICIENCY_VERSION
  };

  log(
    "Human Presence Temporal Context Data Sufficiency v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  loadMissingTemporalContextSufficiencyParentsV1,
  backfillHumanPresenceTemporalContextDataSufficiencyV1
};
