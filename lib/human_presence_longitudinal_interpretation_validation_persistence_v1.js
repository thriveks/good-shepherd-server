"use strict";

const {
  VERSION,
  PARENT_VERSION,
  buildHumanPresenceLongitudinalInterpretationValidationV1
} = require(
  "./human_presence_longitudinal_interpretation_validation_v1"
);

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_longitudinal_interpretation_validations (
      evidence_event_id TEXT NOT NULL,

      longitudinal_interpretation_validation_version TEXT NOT NULL,

      parent_non_operational_interpretation_version TEXT NOT NULL,

      authoritative_sensor_id UUID,
      authoritative_resident_id UUID NOT NULL,
      authoritative_resident_name TEXT,
      authoritative_room_or_location TEXT NOT NULL,
      authority_resolution_status TEXT NOT NULL,
      assignment_authority TEXT,

      evidence_received_at TIMESTAMPTZ NOT NULL,

      longitudinal_interpretation_validation_payload
        JSONB NOT NULL,

      longitudinal_interpretation_validation_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        longitudinal_interpretation_validation_version
      )
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_longitudinal_interpretation_validation_resident_room_time_idx

  ON human_presence_longitudinal_interpretation_validations (
    authoritative_resident_id,
    authoritative_room_or_location,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceLongitudinalInterpretationValidationTableV1(
  db
) {
  await db.query(TABLE_SQL);
}

async function loadCurrentNonOperationalInterpretationV1(
  db,
  evidenceEventId
) {
  if (!evidenceEventId) {
    throw new Error(
      "Longitudinal Interpretation Validation v1 evidence event id required"
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

          non_operational_interpretation_payload

        FROM human_presence_non_operational_interpretations

        WHERE
          evidence_event_id = $1

          AND non_operational_interpretation_version =
              $2

          AND authority_resolution_status =
              'resolved_assigned_sensor'

        LIMIT 1
      `,
      [
        evidenceEventId,
        PARENT_VERSION
      ]
    );

  const row =
    result.rows[0] || null;

  if (!row) {
    throw new Error(
      `Longitudinal Interpretation Validation v1 parent not found for ${evidenceEventId}`
    );
  }

  return row;
}

async function loadPriorNonOperationalInterpretationsV1(
  db,
  parent
) {
  const result =
    await db.query(
      `
        SELECT
          evidence_event_id,
          evidence_received_at,
          non_operational_interpretation_payload

        FROM human_presence_non_operational_interpretations

        WHERE
          non_operational_interpretation_version =
            $1

          AND authoritative_resident_id =
            $2

          AND authoritative_room_or_location =
            $3

          AND authority_resolution_status =
            'resolved_assigned_sensor'

          AND (
            evidence_received_at < $4

            OR (
              evidence_received_at = $4
              AND evidence_event_id < $5
            )
          )

        ORDER BY
          evidence_received_at ASC,
          evidence_event_id ASC
      `,
      [
        PARENT_VERSION,
        parent.authoritative_resident_id,
        parent.authoritative_room_or_location,
        parent.evidence_received_at,
        parent.evidence_event_id
      ]
    );

  return result.rows.map(row => ({
    ...row.non_operational_interpretation_payload,

    evidenceEventId:
      row.non_operational_interpretation_payload
        ?.evidenceEventId ||
      row.evidence_event_id
  }));
}

async function persistHumanPresenceLongitudinalInterpretationValidationV1(
  db,
  parent,
  payload
) {
  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_longitudinal_interpretation_validations (
            evidence_event_id,

            longitudinal_interpretation_validation_version,

            parent_non_operational_interpretation_version,

            authoritative_sensor_id,
            authoritative_resident_id,
            authoritative_resident_name,
            authoritative_room_or_location,
            authority_resolution_status,
            assignment_authority,

            evidence_received_at,

            longitudinal_interpretation_validation_payload,

            longitudinal_interpretation_validation_at
          )

        VALUES (
          $1,
          $2,
          $3,

          $4,
          $5,
          $6,
          $7,
          $8,
          $9,

          $10,

          $11::jsonb,

          NOW()
        )

        ON CONFLICT (
          evidence_event_id,
          longitudinal_interpretation_validation_version
        )
        DO NOTHING

        RETURNING
          longitudinal_interpretation_validation_at
      `,
      [
        parent.evidence_event_id,

        VERSION,

        PARENT_VERSION,

        parent.authoritative_sensor_id,
        parent.authoritative_resident_id,
        parent.authoritative_resident_name,
        parent.authoritative_room_or_location,
        parent.authority_resolution_status,
        parent.assignment_authority,

        parent.evidence_received_at,

        JSON.stringify(payload)
      ]
    );

  return {
    inserted:
      result.rowCount === 1,

    longitudinalInterpretationValidationVersion:
      VERSION
  };
}

async function buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1(
  db,
  evidenceEventId
) {
  const parent =
    await loadCurrentNonOperationalInterpretationV1(
      db,
      evidenceEventId
    );

  const priorRows =
    await loadPriorNonOperationalInterpretationsV1(
      db,
      parent
    );

  const current = {
    ...parent.non_operational_interpretation_payload,

    evidenceEventId:
      parent.non_operational_interpretation_payload
        ?.evidenceEventId ||
      parent.evidence_event_id
  };

  const payload =
    buildHumanPresenceLongitudinalInterpretationValidationV1({
      current,
      priorRows
    });

  const persistence =
    await persistHumanPresenceLongitudinalInterpretationValidationV1(
      db,
      parent,
      payload
    );

  return {
    longitudinalInterpretationValidation:
      payload,

    persistence
  };
}

module.exports = {
  TABLE_SQL,

  ensureHumanPresenceLongitudinalInterpretationValidationTableV1,

  loadCurrentNonOperationalInterpretationV1,

  loadPriorNonOperationalInterpretationsV1,

  persistHumanPresenceLongitudinalInterpretationValidationV1,

  buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1
};
