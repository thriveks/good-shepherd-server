"use strict";

const {
  VERSION,
  buildSpatialSignatureV1
} = require("./human_presence_spatial_signature_v1");

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS human_presence_spatial_signatures (
    evidence_event_id TEXT NOT NULL,
    spatial_signature_version TEXT NOT NULL,
    engineering_feature_version TEXT NOT NULL,
    node_id TEXT NOT NULL,
    spatial_signature_payload JSONB NOT NULL,
    evidence_received_at TIMESTAMPTZ NOT NULL,
    spatial_signature_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
      evidence_event_id,
      spatial_signature_version
    )
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_spatial_signatures_node_time_idx
  ON human_presence_spatial_signatures (
    node_id,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceSpatialSignatureTableV1(db) {
  await db.query(TABLE_SQL);
}

async function buildAndPersistHumanPresenceSpatialSignatureV1(
  db,
  current,
  engineeringFeature
) {
  if (!current?.evidence_event_id || !current?.node_id) {
    throw new Error("spatial signature evidence identity required");
  }

  if (!current.evidence_received_at) {
    throw new Error("spatial signature evidence timestamp required");
  }

  const signature =
    buildSpatialSignatureV1(engineeringFeature);

  const result = await db.query(
    `
      INSERT INTO human_presence_spatial_signatures (
        evidence_event_id,
        spatial_signature_version,
        engineering_feature_version,
        node_id,
        spatial_signature_payload,
        evidence_received_at,
        spatial_signature_at
      )
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,NOW())
      ON CONFLICT (
        evidence_event_id,
        spatial_signature_version
      )
      DO NOTHING
      RETURNING spatial_signature_at
    `,
    [
      current.evidence_event_id,
      VERSION,
      engineeringFeature.version,
      current.node_id,
      JSON.stringify(signature),
      current.evidence_received_at
    ]
  );

  return {
    signature,
    persistence: {
      inserted: result.rowCount === 1,
      spatialSignatureVersion: VERSION
    }
  };
}

module.exports = {
  VERSION,
  TABLE_SQL,
  ensureHumanPresenceSpatialSignatureTableV1,
  buildAndPersistHumanPresenceSpatialSignatureV1
};
