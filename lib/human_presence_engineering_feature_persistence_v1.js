"use strict";

const {
  VERSION,
  buildEngineeringFeatureV1
} = require("./human_presence_engineering_feature_v1");

const HUMAN_PRESENCE_ENGINEERING_FEATURE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS human_presence_engineering_features (
    evidence_event_id TEXT NOT NULL,
    engineering_feature_version TEXT NOT NULL,

    node_id TEXT NOT NULL,
    evidence_schema_version TEXT NOT NULL,

    observer_only BOOLEAN NOT NULL,
    development_only BOOLEAN NOT NULL,

    engineering_feature_payload JSONB NOT NULL,

    evidence_received_at TIMESTAMPTZ NOT NULL,
    engineering_feature_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
      evidence_event_id,
      engineering_feature_version
    )
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_engineering_features_node_time_idx
  ON human_presence_engineering_features (
    node_id,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceEngineeringFeatureTableV1(db) {
  await db.query(
    HUMAN_PRESENCE_ENGINEERING_FEATURE_TABLE_SQL
  );
}

function requireCurrent(current) {
  if (!current) {
    throw new Error(
      "engineering feature current evidence required"
    );
  }

  if (!current.evidence_event_id) {
    throw new Error(
      "engineering feature evidence_event_id required"
    );
  }

  if (!current.node_id) {
    throw new Error(
      "engineering feature node_id required"
    );
  }

  if (String(current.evidence_schema_version) !== "2.0") {
    throw new Error(
      "engineering feature persistence requires schema 2.0"
    );
  }

  if (current.observer_only !== true) {
    throw new Error(
      "engineering feature persistence requires observer_only=true"
    );
  }

  if (current.development_only !== true) {
    throw new Error(
      "engineering feature persistence requires development_only=true"
    );
  }

  if (!current.event_payload) {
    throw new Error(
      "engineering feature event_payload required"
    );
  }

  if (!current.evidence_received_at) {
    throw new Error(
      "engineering feature evidence_received_at required"
    );
  }
}

async function persistHumanPresenceEngineeringFeatureV1(
  db,
  current,
  feature
) {
  requireCurrent(current);

  const result = await db.query(
    `
      INSERT INTO human_presence_engineering_features (
        evidence_event_id,
        engineering_feature_version,
        node_id,
        evidence_schema_version,
        observer_only,
        development_only,
        engineering_feature_payload,
        evidence_received_at,
        engineering_feature_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,NOW()
      )
      ON CONFLICT (
        evidence_event_id,
        engineering_feature_version
      )
      DO NOTHING
      RETURNING engineering_feature_at
    `,
    [
      current.evidence_event_id,
      VERSION,
      current.node_id,
      current.evidence_schema_version,
      current.observer_only,
      current.development_only,
      JSON.stringify(feature),
      current.evidence_received_at
    ]
  );

  return {
    inserted: result.rowCount === 1,
    engineeringFeatureVersion: VERSION
  };
}

async function buildAndPersistHumanPresenceEngineeringFeatureV1(
  db,
  current
) {
  requireCurrent(current);

  const feature =
    buildEngineeringFeatureV1({
      evidenceSchemaVersion:
        current.evidence_schema_version,
      observerOnly:
        current.observer_only,
      developmentOnly:
        current.development_only,
      sampleEncoding:
        current.event_payload.sampleEncoding,
      samples:
        current.event_payload.samples
    });

  const persistence =
    await persistHumanPresenceEngineeringFeatureV1(
      db,
      current,
      feature
    );

  return {
    feature,
    persistence
  };
}

module.exports = {
  VERSION,
  HUMAN_PRESENCE_ENGINEERING_FEATURE_TABLE_SQL,
  ensureHumanPresenceEngineeringFeatureTableV1,
  persistHumanPresenceEngineeringFeatureV1,
  buildAndPersistHumanPresenceEngineeringFeatureV1
};
