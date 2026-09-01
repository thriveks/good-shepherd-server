"use strict";

const {
  VERSION: BEHAVIORAL_VERSION,
  buildBehavioralObservationV1
} = require("./human_presence_behavioral_observation_v1");

const DECISION_VERSION = "human_presence_decision_readiness_v1";
const INTERPRETATION_VERSION = "human_presence_candidate_interpretation_v1";
const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;

async function ensureHumanPresenceBehavioralObservationTableV1(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS human_presence_behavioral_observations (
      evidence_event_id TEXT NOT NULL,
      interpretation_version TEXT NOT NULL,
      decision_readiness_version TEXT NOT NULL,
      behavioral_observation_version TEXT NOT NULL,
      authoritative_sensor_id UUID NOT NULL,
      authoritative_resident_id UUID NOT NULL,
      authoritative_resident_name TEXT,
      authoritative_room_or_location TEXT NOT NULL,
      authority_resolution_status TEXT NOT NULL,
      assignment_authority TEXT,
      behavioral_observation_payload JSONB NOT NULL,
      evidence_received_at TIMESTAMPTZ,
      interpreted_at TIMESTAMPTZ,
      decision_readiness_at TIMESTAMPTZ NOT NULL,
      behavioral_observation_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (
        evidence_event_id,
        interpretation_version,
        decision_readiness_version,
        behavioral_observation_version
      )
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_hp_behavioral_observations_resident_room_time
    ON human_presence_behavioral_observations (
      authoritative_resident_id,
      authoritative_room_or_location,
      decision_readiness_at DESC
    )
  `);
}

async function loadPriorDecisionReadinessRowsV1(db, current) {
  if (!current || !current.authoritative_resident_id || !current.authoritative_room_or_location) {
    throw new Error("authoritative resident and room required for history retrieval");
  }
  const result = await db.query(`
    SELECT
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
      interpreted_at,
      decision_readiness_at
    FROM human_presence_decision_readiness
    WHERE authoritative_resident_id = $1
      AND authoritative_room_or_location = $2
      AND decision_readiness_version = $3
      AND interpretation_version = $4
      AND decision_readiness_at < $5
      AND decision_readiness_at >= ($5::timestamptz - INTERVAL '30 days')
    ORDER BY decision_readiness_at DESC
    LIMIT 50
  `, [
    current.authoritative_resident_id,
    current.authoritative_room_or_location,
    DECISION_VERSION,
    INTERPRETATION_VERSION,
    current.decision_readiness_at
  ]);

  return [...result.rows].reverse();
}

async function persistBehavioralObservationV1(db, current, payload) {
  const result = await db.query(`
    INSERT INTO human_presence_behavioral_observations (
      evidence_event_id,
      interpretation_version,
      decision_readiness_version,
      behavioral_observation_version,
      authoritative_sensor_id,
      authoritative_resident_id,
      authoritative_resident_name,
      authoritative_room_or_location,
      authority_resolution_status,
      assignment_authority,
      behavioral_observation_payload,
      evidence_received_at,
      interpreted_at,
      decision_readiness_at,
      behavioral_observation_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,NOW()
    )
    ON CONFLICT (
      evidence_event_id,
      interpretation_version,
      decision_readiness_version,
      behavioral_observation_version
    ) DO NOTHING
    RETURNING *
  `, [
    current.evidence_event_id,
    current.interpretation_version,
    current.decision_readiness_version,
    BEHAVIORAL_VERSION,
    current.authoritative_sensor_id,
    current.authoritative_resident_id,
    current.authoritative_resident_name || null,
    current.authoritative_room_or_location,
    current.authority_resolution_status,
    current.assignment_authority || null,
    JSON.stringify(payload),
    current.evidence_received_at || null,
    current.interpreted_at || null,
    current.decision_readiness_at
  ]);

  return {
    inserted: result.rowCount === 1,
    row: result.rows[0] || null
  };
}

async function buildAndPersistHumanPresenceBehavioralObservationV1(db, current) {
  const priorRows = await loadPriorDecisionReadinessRowsV1(db, current);
  const payload = buildBehavioralObservationV1(current, priorRows);
  const persistence = await persistBehavioralObservationV1(db, current, payload);
  return { priorRows, payload, persistence };
}

module.exports = {
  BEHAVIORAL_VERSION,
  HISTORY_LIMIT,
  HISTORY_DAYS,
  ensureHumanPresenceBehavioralObservationTableV1,
  loadPriorDecisionReadinessRowsV1,
  persistBehavioralObservationV1,
  buildAndPersistHumanPresenceBehavioralObservationV1
};
