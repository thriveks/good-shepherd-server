const HUMAN_PRESENCE_INTERPRETATION_VERSION =
  "human_presence_candidate_interpretation_v1";

const HUMAN_PRESENCE_INTERPRETATION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS human_presence_candidate_interpretations (
  evidence_event_id TEXT NOT NULL,
  interpretation_version TEXT NOT NULL,

  node_id TEXT NOT NULL,
  source_key TEXT,

  authoritative_sensor_id UUID,
  authoritative_resident_id UUID,
  authoritative_resident_name TEXT,
  authoritative_room_or_location TEXT,
  assignment_authority TEXT,
  authority_resolution_status TEXT NOT NULL,

  interpretation_payload JSONB NOT NULL,

  evidence_received_at TIMESTAMPTZ,
  interpreted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (evidence_event_id, interpretation_version)
);

CREATE INDEX IF NOT EXISTS
  human_presence_candidate_interpretations_node_time_idx
ON human_presence_candidate_interpretations
  (node_id, interpreted_at DESC);

CREATE INDEX IF NOT EXISTS
  human_presence_candidate_interpretations_resident_time_idx
ON human_presence_candidate_interpretations
  (authoritative_resident_id, interpreted_at DESC);
`;

const HUMAN_PRESENCE_INTERPRETATION_INSERT_SQL = `
INSERT INTO human_presence_candidate_interpretations (
  evidence_event_id,
  interpretation_version,
  node_id,
  source_key,
  authoritative_sensor_id,
  authoritative_resident_id,
  authoritative_resident_name,
  authoritative_room_or_location,
  assignment_authority,
  authority_resolution_status,
  interpretation_payload,
  evidence_received_at
)
VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12
)
ON CONFLICT (evidence_event_id, interpretation_version)
DO NOTHING
RETURNING evidence_event_id, interpretation_version
`;

module.exports = {
  HUMAN_PRESENCE_INTERPRETATION_VERSION,
  HUMAN_PRESENCE_INTERPRETATION_TABLE_SQL,
  HUMAN_PRESENCE_INTERPRETATION_INSERT_SQL
};
