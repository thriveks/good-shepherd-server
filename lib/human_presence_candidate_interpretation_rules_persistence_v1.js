"use strict";

const {
  HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION,
  buildHumanPresenceCandidateInterpretationRulesV1
} = require(
  "./human_presence_candidate_interpretation_rules_v1"
);

const PROFILE_VERSION =
  "human_presence_episode_profile_analysis_v1";

const PATTERN_VERSION =
  "human_presence_episode_profile_pattern_analysis_v1";

const TEMPORAL_VERSION =
  "human_presence_episode_profile_temporal_context_analysis_v1";

const HISTORY_DAYS = 30;

const HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_candidate_interpretation_rule_analyses (
      evidence_event_id TEXT NOT NULL,
      candidate_interpretation_rules_version TEXT NOT NULL,

      parent_episode_profile_analysis_version TEXT NOT NULL,
      parent_episode_profile_pattern_analysis_version TEXT NOT NULL,
      parent_temporal_context_analysis_version TEXT,

      authoritative_sensor_id UUID,
      authoritative_resident_id UUID NOT NULL,
      authoritative_resident_name TEXT,
      authoritative_room_or_location TEXT NOT NULL,
      authority_resolution_status TEXT NOT NULL,
      assignment_authority TEXT,

      evidence_received_at TIMESTAMPTZ NOT NULL,

      candidate_interpretation_rules_payload JSONB NOT NULL,
      candidate_interpretation_rules_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        candidate_interpretation_rules_version
      )
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_candidate_interpretation_rules_resident_room_time_idx
  ON human_presence_candidate_interpretation_rule_analyses (
    authoritative_resident_id,
    authoritative_room_or_location,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceCandidateInterpretationRulesTableV1(
  db
) {
  await db.query(
    HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_TABLE_SQL
  );
}

async function loadCurrentCandidateInterpretationParentsV1(
  db,
  evidenceEventId
) {
  if (!evidenceEventId) {
    throw new Error(
      "candidate interpretation evidence event id required"
    );
  }

  const result =
    await db.query(
      `
        SELECT
          p.evidence_event_id,

          p.authoritative_sensor_id,
          p.authoritative_resident_id,
          p.authoritative_resident_name,
          p.authoritative_room_or_location,
          p.authority_resolution_status,
          p.assignment_authority,

          p.evidence_received_at,

          p.episode_profile_analysis_payload
            AS profile_payload,

          q.episode_profile_pattern_analysis_payload
            AS pattern_payload,

          t.episode_profile_temporal_context_analysis_payload
            AS temporal_payload

        FROM human_presence_episode_profile_analyses p

        JOIN human_presence_episode_profile_pattern_analyses q
          ON q.evidence_event_id =
             p.evidence_event_id

         AND q.episode_profile_pattern_analysis_version =
             $2

        LEFT JOIN
          human_presence_episode_profile_temporal_context_analyses t
          ON t.evidence_event_id =
             p.evidence_event_id

         AND
           t.episode_profile_temporal_context_analysis_version =
           $3

        WHERE
          p.evidence_event_id = $1

          AND p.episode_profile_analysis_version =
              $4

          AND p.authority_resolution_status =
              'resolved_assigned_sensor'

        LIMIT 1
      `,
      [
        evidenceEventId,
        PATTERN_VERSION,
        TEMPORAL_VERSION,
        PROFILE_VERSION
      ]
    );

  const row =
    result.rows[0] || null;

  if (!row) {
    throw new Error(
      `Candidate Interpretation Rules v1 parent not found for ${evidenceEventId}`
    );
  }

  return row;
}

async function loadPriorProfileDeltasV1(
  db,
  current
) {
  const result =
    await db.query(
      `
        SELECT
          (
            episode_profile_analysis_payload
              ->>'profileMeanRelativeDelta'
          )::double precision AS profile_delta

        FROM human_presence_episode_profile_analyses

        WHERE
          authoritative_resident_id = $1

          AND authoritative_room_or_location = $2

          AND authority_resolution_status =
              'resolved_assigned_sensor'

          AND episode_profile_analysis_version =
              $3

          AND evidence_received_at < $4

          AND evidence_received_at >=
              (
                $4::timestamptz -
                INTERVAL '${HISTORY_DAYS} days'
              )

          AND jsonb_typeof(
                episode_profile_analysis_payload
                  -> 'profileMeanRelativeDelta'
              ) = 'number'

        ORDER BY
          evidence_received_at ASC,
          evidence_event_id ASC
      `,
      [
        current.authoritative_resident_id,
        current.authoritative_room_or_location,
        PROFILE_VERSION,
        current.evidence_received_at
      ]
    );

  return result.rows.map(
    (row) =>
      Number(row.profile_delta)
  );
}

async function persistHumanPresenceCandidateInterpretationRulesV1(
  db,
  current,
  analysis
) {
  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_candidate_interpretation_rule_analyses (
            evidence_event_id,
            candidate_interpretation_rules_version,

            parent_episode_profile_analysis_version,
            parent_episode_profile_pattern_analysis_version,
            parent_temporal_context_analysis_version,

            authoritative_sensor_id,
            authoritative_resident_id,
            authoritative_resident_name,
            authoritative_room_or_location,
            authority_resolution_status,
            assignment_authority,

            evidence_received_at,

            candidate_interpretation_rules_payload,
            candidate_interpretation_rules_at
          )

        VALUES (
          $1,$2,
          $3,$4,$5,
          $6,$7,$8,$9,$10,$11,
          $12,
          $13::jsonb,
          NOW()
        )

        ON CONFLICT (
          evidence_event_id,
          candidate_interpretation_rules_version
        )
        DO NOTHING

        RETURNING
          candidate_interpretation_rules_at
      `,
      [
        current.evidence_event_id,

        HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION,

        PROFILE_VERSION,
        PATTERN_VERSION,

        current.temporal_payload
          ? TEMPORAL_VERSION
          : null,

        current.authoritative_sensor_id,
        current.authoritative_resident_id,
        current.authoritative_resident_name,
        current.authoritative_room_or_location,
        current.authority_resolution_status,
        current.assignment_authority,

        current.evidence_received_at,

        JSON.stringify(analysis)
      ]
    );

  return {
    inserted:
      result.rowCount === 1,

    candidateInterpretationRulesVersion:
      HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION
  };
}

async function buildAndPersistHumanPresenceCandidateInterpretationRulesV1(
  db,
  evidenceEventId
) {
  const current =
    await loadCurrentCandidateInterpretationParentsV1(
      db,
      evidenceEventId
    );

  const historicalProfileDeltas =
    await loadPriorProfileDeltasV1(
      db,
      current
    );

  const candidateInterpretationRules =
    buildHumanPresenceCandidateInterpretationRulesV1({
      evidenceEventId:
        current.evidence_event_id,

      authoritativeResidentId:
        current.authoritative_resident_id,

      authoritativeRoomOrLocation:
        current.authoritative_room_or_location,

      profilePayload:
        current.profile_payload,

      patternPayload:
        current.pattern_payload,

      temporalPayload:
        current.temporal_payload,

      historicalProfileDeltas
    });

  const persistence =
    await persistHumanPresenceCandidateInterpretationRulesV1(
      db,
      current,
      candidateInterpretationRules
    );

  return {
    candidateInterpretationRules,
    persistence
  };
}

module.exports = {
  HISTORY_DAYS,

  PROFILE_VERSION,
  PATTERN_VERSION,
  TEMPORAL_VERSION,

  HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_TABLE_SQL,

  ensureHumanPresenceCandidateInterpretationRulesTableV1,

  loadCurrentCandidateInterpretationParentsV1,
  loadPriorProfileDeltasV1,

  persistHumanPresenceCandidateInterpretationRulesV1,

  buildAndPersistHumanPresenceCandidateInterpretationRulesV1
};
