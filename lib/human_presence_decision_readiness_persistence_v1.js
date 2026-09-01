'use strict';

const {
  HUMAN_PRESENCE_DECISION_READINESS_VERSION,
  buildHumanPresenceDecisionReadinessV1
} = require('./human_presence_decision_readiness_v1');

const HUMAN_PRESENCE_DECISION_READINESS_PERSISTENCE_VERSION =
  'human_presence_decision_readiness_v1';

const DAILY_CONTEXT_LIMIT = 30;
const MOTION_CONTEXT_LIMIT_PER_DIRECTION = 25;

async function ensureHumanPresenceDecisionReadinessTableV1(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS human_presence_decision_readiness (
      evidence_event_id TEXT NOT NULL,
      interpretation_version TEXT NOT NULL,
      decision_readiness_version TEXT NOT NULL,

      authoritative_sensor_id UUID NOT NULL,
      authoritative_resident_id UUID NOT NULL,
      authoritative_resident_name TEXT,
      authoritative_room_or_location TEXT,

      authority_resolution_status TEXT NOT NULL,
      assignment_authority TEXT,

      decision_readiness_payload JSONB NOT NULL,

      evidence_received_at TIMESTAMPTZ NOT NULL,
      interpreted_at TIMESTAMPTZ NOT NULL,
      decision_readiness_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version
      )
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      human_presence_decision_readiness_resident_time_idx
    ON human_presence_decision_readiness
      (authoritative_resident_id, evidence_received_at DESC)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS
      human_presence_decision_readiness_sensor_time_idx
    ON human_presence_decision_readiness
      (authoritative_sensor_id, evidence_received_at DESC)
  `);
}

async function loadHumanPresenceDecisionReadinessContextV1(
  db,
  interpretation
) {
  if (!interpretation || !interpretation.authoritative_resident_id) {
    throw new Error(
      'authoritative resident identity required for context query'
    );
  }

  if (!interpretation.evidence_received_at) {
    throw new Error(
      'evidence_received_at required for context query'
    );
  }

  const residentId =
    interpretation.authoritative_resident_id;

  const episodeTimestamp =
    interpretation.evidence_received_at;

  const dailyResult = await db.query(
    `
      SELECT
        resident_id,
        activity_date,
        motion_count,
        first_motion_at,
        last_motion_at,
        room_counts,
        hourly_counts
      FROM resident_activity_daily
      WHERE resident_id = $1
        AND activity_date <=
          ($2::timestamptz AT TIME ZONE 'America/Chicago')::date
      ORDER BY activity_date DESC
      LIMIT $3
    `,
    [
      residentId,
      episodeTimestamp,
      DAILY_CONTEXT_LIMIT
    ]
  );

  const priorMotionResult = await db.query(
    `
      SELECT
        resident_id,
        sensor_id,
        node_id,
        source_key,
        source_name,
        location_name,
        room_name,
        event_timestamp,
        created_at
      FROM motion_events
      WHERE resident_id = $1
        AND event_timestamp <= $2::timestamptz
      ORDER BY event_timestamp DESC
      LIMIT $3
    `,
    [
      residentId,
      episodeTimestamp,
      MOTION_CONTEXT_LIMIT_PER_DIRECTION
    ]
  );

  const followingMotionResult = await db.query(
    `
      SELECT
        resident_id,
        sensor_id,
        node_id,
        source_key,
        source_name,
        location_name,
        room_name,
        event_timestamp,
        created_at
      FROM motion_events
      WHERE resident_id = $1
        AND event_timestamp > $2::timestamptz
      ORDER BY event_timestamp ASC
      LIMIT $3
    `,
    [
      residentId,
      episodeTimestamp,
      MOTION_CONTEXT_LIMIT_PER_DIRECTION
    ]
  );

  const dailyActivityRows =
    Array.isArray(dailyResult.rows)
      ? dailyResult.rows
      : [];

  const priorRows =
    Array.isArray(priorMotionResult.rows)
      ? priorMotionResult.rows.slice().reverse()
      : [];

  const followingRows =
    Array.isArray(followingMotionResult.rows)
      ? followingMotionResult.rows
      : [];

  return {
    dailyActivityRows,
    motionEvents: [
      ...priorRows,
      ...followingRows
    ],
    queryProvenance: {
      dailyContextLimit: DAILY_CONTEXT_LIMIT,
      motionContextLimitPerDirection:
        MOTION_CONTEXT_LIMIT_PER_DIRECTION,
      residentAuthority:
        'authoritative_resident_id',
      episodeTimestampAuthority:
        'evidence_received_at',
      dailySource:
        'resident_activity_daily',
      motionSource:
        'motion_events'
    }
  };
}

async function persistHumanPresenceDecisionReadinessV1(
  db,
  interpretation,
  decisionReadiness
) {
  if (
    decisionReadiness.decisionReadinessVersion !==
    HUMAN_PRESENCE_DECISION_READINESS_VERSION
  ) {
    throw new Error(
      'unsupported decision-readiness version'
    );
  }

  if (decisionReadiness.descriptiveOnly !== true) {
    throw new Error(
      'decision-readiness result must remain descriptive-only'
    );
  }

  if (
    decisionReadiness.operationalClassification !== null ||
    decisionReadiness.alertLevel !== null ||
    decisionReadiness.monitoringAction !== null ||
    decisionReadiness.interventionRecommendation !== null
  ) {
    throw new Error(
      'decision-readiness result contains operational output'
    );
  }

  const result = await db.query(
    `
      INSERT INTO human_presence_decision_readiness (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version,

        authoritative_sensor_id,
        authoritative_resident_id,
        authoritative_resident_name,
        authoritative_room_or_location,

        authority_resolution_status,
        assignment_authority,

        decision_readiness_payload,

        evidence_received_at,
        interpreted_at
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6, $7,
        $8, $9,
        $10::jsonb,
        $11, $12
      )
      ON CONFLICT (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version
      )
      DO NOTHING
      RETURNING
        evidence_event_id,
        interpretation_version,
        decision_readiness_version
    `,
    [
      interpretation.evidence_event_id,
      interpretation.interpretation_version,
      HUMAN_PRESENCE_DECISION_READINESS_PERSISTENCE_VERSION,

      interpretation.authoritative_sensor_id,
      interpretation.authoritative_resident_id,
      interpretation.authoritative_resident_name,
      interpretation.authoritative_room_or_location,

      interpretation.authority_resolution_status,
      interpretation.assignment_authority,

      JSON.stringify(decisionReadiness),

      interpretation.evidence_received_at,
      interpretation.interpreted_at
    ]
  );

  return {
    inserted: result.rowCount === 1,
    evidenceEventId:
      interpretation.evidence_event_id,
    interpretationVersion:
      interpretation.interpretation_version,
    decisionReadinessVersion:
      HUMAN_PRESENCE_DECISION_READINESS_PERSISTENCE_VERSION
  };
}

async function buildAndPersistHumanPresenceDecisionReadinessV1(
  db,
  interpretation
) {
  const context =
    await loadHumanPresenceDecisionReadinessContextV1(
      db,
      interpretation
    );

  const decisionReadiness =
    buildHumanPresenceDecisionReadinessV1({
      interpretation,
      dailyActivityRows:
        context.dailyActivityRows,
      motionEvents:
        context.motionEvents
    });

  decisionReadiness.contextQueryProvenance =
    context.queryProvenance;

  const persistence =
    await persistHumanPresenceDecisionReadinessV1(
      db,
      interpretation,
      decisionReadiness
    );

  return {
    decisionReadiness,
    persistence
  };
}

module.exports = {
  HUMAN_PRESENCE_DECISION_READINESS_PERSISTENCE_VERSION,
  DAILY_CONTEXT_LIMIT,
  MOTION_CONTEXT_LIMIT_PER_DIRECTION,
  ensureHumanPresenceDecisionReadinessTableV1,
  loadHumanPresenceDecisionReadinessContextV1,
  persistHumanPresenceDecisionReadinessV1,
  buildAndPersistHumanPresenceDecisionReadinessV1
};
