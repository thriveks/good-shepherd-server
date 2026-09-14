"use strict";

const {
  VERSION,
  SOURCE_STATE_VERSION,
  buildSpatialRhythmLearningV1
} = require(
  "./human_presence_spatial_rhythm_learning_v1"
);

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_spatial_rhythm_snapshots (
      evidence_event_id TEXT NOT NULL,
      spatial_rhythm_learning_version TEXT NOT NULL,
      spatial_state_learning_version TEXT NOT NULL,
      node_id TEXT NOT NULL,
      rhythm_learning_payload JSONB NOT NULL,
      evidence_received_at TIMESTAMPTZ NOT NULL,
      rhythm_snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        spatial_rhythm_learning_version
      )
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_spatial_rhythm_snapshots_node_time_idx
  ON human_presence_spatial_rhythm_snapshots (
    node_id,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceSpatialRhythmLearningV1(
  db
) {
  await db.query(
    TABLE_SQL
  );
}

function requireCurrent(current) {
  if (
    !current?.evidence_event_id ||
    !current?.node_id ||
    !current?.evidence_received_at
  ) {
    throw new Error(
      "Spatial Rhythm Learning evidence identity required"
    );
  }
}

async function loadStateObservations(
  db,
  nodeId
) {
  const result =
    await db.query(
      `
        SELECT
          evidence_event_id,
          state_id,
          evidence_received_at
        FROM human_presence_spatial_state_assignments
        WHERE node_id = $1
          AND spatial_state_learning_version = $2
        ORDER BY
          evidence_received_at ASC,
          evidence_event_id ASC
      `,
      [
        nodeId,
        SOURCE_STATE_VERSION
      ]
    );

  return result.rows.map(
    (row) => ({
      evidenceEventId:
        row.evidence_event_id,

      stateId:
        row.state_id,

      evidenceReceivedAt:
        row.evidence_received_at
    })
  );
}

async function buildAndPersistHumanPresenceSpatialRhythmLearningV1(
  db,
  current
) {
  requireCurrent(
    current
  );

  const observations =
    await loadStateObservations(
      db,
      current.node_id
    );

  const rhythm =
    buildSpatialRhythmLearningV1(
      observations
    );

  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_spatial_rhythm_snapshots (
            evidence_event_id,
            spatial_rhythm_learning_version,
            spatial_state_learning_version,
            node_id,
            rhythm_learning_payload,
            evidence_received_at,
            rhythm_snapshot_at
          )
        VALUES (
          $1,$2,$3,$4,$5::jsonb,$6,NOW()
        )
        ON CONFLICT (
          evidence_event_id,
          spatial_rhythm_learning_version
        )
        DO NOTHING
        RETURNING rhythm_snapshot_at
      `,
      [
        current.evidence_event_id,
        VERSION,
        SOURCE_STATE_VERSION,
        current.node_id,
        JSON.stringify(
          rhythm
        ),
        current.evidence_received_at
      ]
    );

  return {
    rhythm,

    persistence: {
      inserted:
        result.rowCount === 1,

      spatialRhythmLearningVersion:
        VERSION
    }
  };
}

module.exports = {
  VERSION,
  TABLE_SQL,
  ensureHumanPresenceSpatialRhythmLearningV1,
  buildAndPersistHumanPresenceSpatialRhythmLearningV1
};
