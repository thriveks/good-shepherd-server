"use strict";

const {
  HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION
} = require(
  "../lib/human_presence_candidate_interpretation_rules_v1"
);

const {
  PROFILE_VERSION,
  PATTERN_VERSION,
  buildAndPersistHumanPresenceCandidateInterpretationRulesV1
} = require(
  "../lib/human_presence_candidate_interpretation_rules_persistence_v1"
);

async function backfillHumanPresenceCandidateInterpretationRulesV1(
  db,
  { log = console.log } = {}
) {
  const result =
    await db.query(
      `
        SELECT
          p.evidence_event_id

        FROM human_presence_episode_profile_analyses p

        JOIN human_presence_episode_profile_pattern_analyses q
          ON q.evidence_event_id =
             p.evidence_event_id

         AND q.episode_profile_pattern_analysis_version =
             $1

        LEFT JOIN
          human_presence_candidate_interpretation_rule_analyses c
          ON c.evidence_event_id =
             p.evidence_event_id

         AND c.candidate_interpretation_rules_version =
             $2

        WHERE
          p.episode_profile_analysis_version =
            $3

          AND p.authority_resolution_status =
              'resolved_assigned_sensor'

          AND c.evidence_event_id IS NULL

        ORDER BY
          p.evidence_received_at ASC,
          p.evidence_event_id ASC
      `,
      [
        PATTERN_VERSION,
        HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION,
        PROFILE_VERSION
      ]
    );

  let inserted = 0;

  for (const row of result.rows) {
    const built =
      await buildAndPersistHumanPresenceCandidateInterpretationRulesV1(
        db,
        row.evidence_event_id
      );

    if (!built.persistence.inserted) {
      throw new Error(
        `Candidate Interpretation Rules backfill failed for ${row.evidence_event_id}`
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
    "Human Presence Candidate Interpretation Rules v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  backfillHumanPresenceCandidateInterpretationRulesV1
};
