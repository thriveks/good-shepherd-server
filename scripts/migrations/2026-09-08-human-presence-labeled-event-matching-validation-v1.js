"use strict";

const {
  run: runBackfill
} = require("../backfill_human_presence_labeled_event_matching_validation_v1");

const VERSION =
  "2026-09-08-human-presence-labeled-event-matching-validation-v1";

const DESCRIPTION =
  "Persist descriptive human presence labeled-event matching validation v1";

async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS
      human_presence_labeled_event_matching_validations (
        labeled_event_id TEXT NOT NULL,

        matching_validation_version TEXT NOT NULL,
        parent_analytics_version TEXT NOT NULL,

        event_type TEXT NOT NULL,
        capture_source TEXT,

        test_session_id TEXT,

        resident_id UUID NOT NULL,
        resident_name TEXT,

        room_or_location TEXT NOT NULL,
        observer_name TEXT,

        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ NOT NULL,
        duration_ms BIGINT NOT NULL,

        analytical_event_count INTEGER NOT NULL,
        inside_interval_count INTEGER NOT NULL,

        nearest_before_evidence_event_id TEXT,
        nearest_before_seconds DOUBLE PRECISION,

        nearest_after_evidence_event_id TEXT,
        nearest_after_seconds DOUBLE PRECISION,

        nearest_start_evidence_event_id TEXT,
        nearest_start_seconds DOUBLE PRECISION,

        nearest_end_evidence_event_id TEXT,
        nearest_end_seconds DOUBLE PRECISION,

        matching_validation_payload JSONB NOT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (
          labeled_event_id,
          matching_validation_version
        ),

        FOREIGN KEY (labeled_event_id)
          REFERENCES human_presence_labeled_events (
            labeled_event_id
          )
      )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS
      idx_hp_labeled_event_matching_resident_room_start
    ON human_presence_labeled_event_matching_validations (
      resident_id,
      room_or_location,
      started_at
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS
      idx_hp_labeled_event_matching_session_start
    ON human_presence_labeled_event_matching_validations (
      test_session_id,
      started_at
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS
      idx_hp_labeled_event_matching_type_start
    ON human_presence_labeled_event_matching_validations (
      event_type,
      started_at
    )
  `);

  await runBackfill(client);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
