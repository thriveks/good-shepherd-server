"use strict";

const {
  HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,
  PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION,
  buildHumanPresenceNonOperationalInterpretationV1
} = require(
  "./human_presence_non_operational_interpretation_v1"
);

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_non_operational_interpretations (
      evidence_event_id TEXT NOT NULL,
      non_operational_interpretation_version TEXT NOT NULL,

      parent_candidate_interpretation_rules_version TEXT NOT NULL,

      authoritative_sensor_id UUID,
      authoritative_resident_id UUID NOT NULL,
      authoritative_resident_name TEXT,
      authoritative_room_or_location TEXT NOT NULL,
      authority_resolution_status TEXT NOT NULL,
      assignment_authority TEXT,

      evidence_received_at TIMESTAMPTZ NOT NULL,

      non_operational_interpretation_payload JSONB NOT NULL,
      non_operational_interpretation_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        non_operational_interpretation_version
      )
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_non_operational_interpretation_resident_room_time_idx
  ON human_presence_non_operational_interpretations (
    authoritative_resident_id,
    authoritative_room_or_location,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceNonOperationalInterpretationTableV1(
  db
) {
  await db.query(TABLE_SQL);
}

async function loadCandidateInterpretationRulesParentV1(
  db,
  evidenceEventId
) {
  if (!evidenceEventId) {
    throw new Error(
      "non-operational interpretation evidence event id required"
    );
  }

  const result =
    await db.query(
      `
        SELECT
          evidence_event_id,

          authoritative_sensor_id,
          authoritative_resident_id,
          authoritative_resident_name,
          authoritative_room_or_location,
          authority_resolution_status,
          assignment_authority,

          evidence_received_at,

          candidate_interpretation_rules_payload

        FROM human_presence_candidate_interpretation_rule_analyses

        WHERE
          evidence_event_id = $1

          AND candidate_interpretation_rules_version =
              $2

          AND authority_resolution_status =
              'resolved_assigned_sensor'

        LIMIT 1
      `,
      [
        evidenceEventId,
        PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION
      ]
    );

  const row =
    result.rows[0] || null;

  if (!row) {
    throw new Error(
      `Non-Operational Interpretation v1 parent not found for ${evidenceEventId}`
    );
  }

  return row;
}

async function persistHumanPresenceNonOperationalInterpretationV1(
  db,
  parent,
  interpretation
) {
  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_non_operational_interpretations (
            evidence_event_id,
            non_operational_interpretation_version,

            parent_candidate_interpretation_rules_version,

            authoritative_sensor_id,
            authoritative_resident_id,
            authoritative_resident_name,
            authoritative_room_or_location,
            authority_resolution_status,
            assignment_authority,

            evidence_received_at,

            non_operational_interpretation_payload,
            non_operational_interpretation_at
          )

        VALUES (
          $1,$2,
          $3,
          $4,$5,$6,$7,$8,$9,
          $10,
          $11::jsonb,
          NOW()
        )

        ON CONFLICT (
          evidence_event_id,
          non_operational_interpretation_version
        )
        DO NOTHING

        RETURNING
          non_operational_interpretation_at
      `,
      [
        parent.evidence_event_id,

        HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,

        PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION,

        parent.authoritative_sensor_id,
        parent.authoritative_resident_id,
        parent.authoritative_resident_name,
        parent.authoritative_room_or_location,
        parent.authority_resolution_status,
        parent.assignment_authority,

        parent.evidence_received_at,

        JSON.stringify(interpretation)
      ]
    );

  return {
    inserted:
      result.rowCount === 1,

    nonOperationalInterpretationVersion:
      HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION
  };
}

async function buildAndPersistHumanPresenceNonOperationalInterpretationV1(
  db,
  evidenceEventId
) {
  const parent =
    await loadCandidateInterpretationRulesParentV1(
      db,
      evidenceEventId
    );

  const interpretation =
    buildHumanPresenceNonOperationalInterpretationV1({
      evidenceEventId:
        parent.evidence_event_id,

      authoritativeResidentId:
        parent.authoritative_resident_id,

      authoritativeRoomOrLocation:
        parent.authoritative_room_or_location,

      candidatePayload:
        parent.candidate_interpretation_rules_payload
    });

  const persistence =
    await persistHumanPresenceNonOperationalInterpretationV1(
      db,
      parent,
      interpretation
    );

  return {
    nonOperationalInterpretation:
      interpretation,

    persistence
  };
}

module.exports = {
  TABLE_SQL,

  ensureHumanPresenceNonOperationalInterpretationTableV1,

  loadCandidateInterpretationRulesParentV1,

  persistHumanPresenceNonOperationalInterpretationV1,

  buildAndPersistHumanPresenceNonOperationalInterpretationV1
};
