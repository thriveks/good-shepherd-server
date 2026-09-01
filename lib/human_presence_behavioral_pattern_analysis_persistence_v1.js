"use strict";

const {
  HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION,
  buildHumanPresenceBehavioralPatternAnalysisV1
} = require("./human_presence_behavioral_pattern_analysis_v1");

const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;

const HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS human_presence_behavioral_pattern_analyses (
    evidence_event_id TEXT NOT NULL,
    interpretation_version TEXT NOT NULL,
    decision_readiness_version TEXT NOT NULL,
    behavioral_observation_version TEXT NOT NULL,
    behavioral_pattern_analysis_version TEXT NOT NULL,

    authoritative_sensor_id UUID,
    authoritative_resident_id UUID NOT NULL,
    authoritative_resident_name TEXT,
    authoritative_room_or_location TEXT NOT NULL,
    authority_resolution_status TEXT NOT NULL,
    assignment_authority TEXT,

    behavioral_pattern_analysis_payload JSONB NOT NULL,

    evidence_received_at TIMESTAMPTZ,
    interpreted_at TIMESTAMPTZ,
    decision_readiness_at TIMESTAMPTZ,
    behavioral_observation_at TIMESTAMPTZ NOT NULL,
    behavioral_pattern_analysis_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
      evidence_event_id,
      interpretation_version,
      decision_readiness_version,
      behavioral_observation_version,
      behavioral_pattern_analysis_version
    )
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_behavioral_pattern_resident_room_time_idx
  ON human_presence_behavioral_pattern_analyses (
    authoritative_resident_id,
    authoritative_room_or_location,
    behavioral_observation_at DESC
  );
`;

function requireCurrent(current) {
  if (!current) {
    throw new Error("behavioral observation current row required");
  }

  if (!current.authoritative_resident_id ||
      !current.authoritative_room_or_location) {
    throw new Error("authoritative resident and room required");
  }

  if (
    current.behavioral_observation_version !==
    "human_presence_behavioral_observation_v1"
  ) {
    throw new Error("unsupported behavioral observation parent version");
  }

  if (current.authority_resolution_status !== "resolved_assigned_sensor") {
    throw new Error("resolved assigned sensor authority required");
  }
}

async function ensureHumanPresenceBehavioralPatternAnalysisTableV1(db) {
  await db.query(HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_TABLE_SQL);
}

async function loadPriorBehavioralObservationRowsV1(db, current) {
  requireCurrent(current);

  const result = await db.query(
    `
      SELECT *
      FROM human_presence_behavioral_observations
      WHERE authoritative_resident_id = $1
        AND authoritative_room_or_location = $2
        AND behavioral_observation_version =
            'human_presence_behavioral_observation_v1'
        AND behavioral_observation_at < $3
        AND behavioral_observation_at >=
            ($3::timestamptz - INTERVAL '${HISTORY_DAYS} days')
      ORDER BY behavioral_observation_at DESC
      LIMIT ${HISTORY_LIMIT}
    `,
    [
      current.authoritative_resident_id,
      current.authoritative_room_or_location,
      current.behavioral_observation_at
    ]
  );

  return [...result.rows].reverse();
}

async function persistHumanPresenceBehavioralPatternAnalysisV1(
  db,
  current,
  analysis
) {
  requireCurrent(current);

  const result = await db.query(
    `
      INSERT INTO human_presence_behavioral_pattern_analyses (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version,
        behavioral_observation_version,
        behavioral_pattern_analysis_version,

        authoritative_sensor_id,
        authoritative_resident_id,
        authoritative_resident_name,
        authoritative_room_or_location,
        authority_resolution_status,
        assignment_authority,

        behavioral_pattern_analysis_payload,

        evidence_received_at,
        interpreted_at,
        decision_readiness_at,
        behavioral_observation_at,
        behavioral_pattern_analysis_at
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,$10,$11,
        $12::jsonb,
        $13,$14,$15,$16,NOW()
      )
      ON CONFLICT (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version,
        behavioral_observation_version,
        behavioral_pattern_analysis_version
      )
      DO NOTHING
      RETURNING behavioral_pattern_analysis_at
    `,
    [
      current.evidence_event_id,
      current.interpretation_version,
      current.decision_readiness_version,
      current.behavioral_observation_version,
      HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION,

      current.authoritative_sensor_id,
      current.authoritative_resident_id,
      current.authoritative_resident_name,
      current.authoritative_room_or_location,
      current.authority_resolution_status,
      current.assignment_authority,

      JSON.stringify(analysis),

      current.evidence_received_at,
      current.interpreted_at,
      current.decision_readiness_at,
      current.behavioral_observation_at
    ]
  );

  return {
    inserted: result.rowCount === 1,
    behavioralPatternAnalysisVersion:
      HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION
  };
}

async function buildAndPersistHumanPresenceBehavioralPatternAnalysisV1(
  db,
  current
) {
  const priorBehavioralObservations =
    await loadPriorBehavioralObservationRowsV1(db, current);

  const behavioralPatternAnalysis =
    buildHumanPresenceBehavioralPatternAnalysisV1({
      currentBehavioralObservation: current,
      priorBehavioralObservations
    });

  const persistence =
    await persistHumanPresenceBehavioralPatternAnalysisV1(
      db,
      current,
      behavioralPatternAnalysis
    );

  return {
    behavioralPatternAnalysis,
    persistence
  };
}

module.exports = {
  HISTORY_LIMIT,
  HISTORY_DAYS,
  HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_TABLE_SQL,
  ensureHumanPresenceBehavioralPatternAnalysisTableV1,
  loadPriorBehavioralObservationRowsV1,
  persistHumanPresenceBehavioralPatternAnalysisV1,
  buildAndPersistHumanPresenceBehavioralPatternAnalysisV1
};
