"use strict";

const crypto =
  require("crypto");

const {
  VERSION,
  validateHumanPresenceLabeledEventCaptureV1
} = require(
  "./human_presence_labeled_event_capture_v1"
);

const TABLE_NAME =
  "human_presence_labeled_events";

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS
    human_presence_labeled_events (
      labeled_event_id TEXT PRIMARY KEY,

      labeled_event_capture_version TEXT NOT NULL,

      event_type TEXT NOT NULL,
      capture_source TEXT NOT NULL,

      resident_id UUID NOT NULL,
      resident_name TEXT,

      room_or_location TEXT NOT NULL,

      observer_name TEXT NOT NULL,
      test_session_id TEXT,

      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      duration_ms BIGINT NOT NULL,

      notes TEXT,

      ground_truth_only BOOLEAN NOT NULL
        DEFAULT TRUE,

      sensor_derived BOOLEAN NOT NULL
        DEFAULT FALSE,

      labeled_event_payload JSONB NOT NULL,

      created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_labeled_events_resident_room_start_idx

  ON human_presence_labeled_events (
    resident_id,
    room_or_location,
    started_at DESC
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_labeled_events_session_idx

  ON human_presence_labeled_events (
    test_session_id,
    started_at ASC
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_labeled_events_type_idx

  ON human_presence_labeled_events (
    event_type,
    started_at DESC
  );
`;

async function ensureHumanPresenceLabeledEventCaptureTableV1(
  db
) {
  await db.query(TABLE_SQL);
}

async function persistHumanPresenceLabeledEventCaptureV1(
  db,
  input
) {
  const validated =
    validateHumanPresenceLabeledEventCaptureV1(
      input
    );

  if (!validated.valid) {
    throw new Error(
      `Invalid Human Presence labeled event: ${validated.errors.join("; ")}`
    );
  }

  const value =
    validated.value;

  const labeledEventId =
    `hp-label-${crypto.randomUUID()}`;

  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_labeled_events (
            labeled_event_id,

            labeled_event_capture_version,

            event_type,
            capture_source,

            resident_id,
            resident_name,

            room_or_location,

            observer_name,
            test_session_id,

            started_at,
            ended_at,
            duration_ms,

            notes,

            ground_truth_only,
            sensor_derived,

            labeled_event_payload
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
          $11,
          $12,

          $13,

          TRUE,
          FALSE,

          $14::jsonb
        )

        RETURNING
          labeled_event_id,
          created_at
      `,
      [
        labeledEventId,

        VERSION,

        value.eventType,
        value.captureSource,

        value.residentId,
        value.residentName,

        value.roomOrLocation,

        value.observerName,
        value.testSessionId,

        value.startedAt,
        value.endedAt,
        value.durationMs,

        value.notes,

        JSON.stringify(value)
      ]
    );

  return {
    labeledEventId:
      result.rows[0].labeled_event_id,

    createdAt:
      result.rows[0].created_at,

    value
  };
}

module.exports = {
  TABLE_NAME,
  TABLE_SQL,

  ensureHumanPresenceLabeledEventCaptureTableV1,

  persistHumanPresenceLabeledEventCaptureV1
};
