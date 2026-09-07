"use strict";

const VERSION =
  "2026-09-07-human-presence-temporal-context-data-sufficiency-v1";

const DESCRIPTION =
  "Add Human Presence Temporal Context Data Sufficiency v1 persistence";

async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS
      human_presence_temporal_context_data_sufficiency_analyses (

        evidence_event_id TEXT NOT NULL,

        temporal_context_analysis_version TEXT NOT NULL,

        temporal_context_data_sufficiency_version TEXT NOT NULL,

        authoritative_sensor_id UUID,

        authoritative_resident_id UUID NOT NULL,

        authoritative_resident_name TEXT,

        authoritative_room_or_location TEXT NOT NULL,

        authority_resolution_status TEXT NOT NULL,

        assignment_authority TEXT,

        daypart TEXT NOT NULL,

        evidence_received_at TIMESTAMPTZ NOT NULL,

        temporal_context_data_sufficiency_payload JSONB NOT NULL,

        temporal_context_data_sufficiency_at
          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (
          evidence_event_id,
          temporal_context_data_sufficiency_version
        )
      )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS
      human_presence_temporal_context_sufficiency_resident_room_daypart_time_idx

    ON
      human_presence_temporal_context_data_sufficiency_analyses (
        authoritative_resident_id,
        authoritative_room_or_location,
        daypart,
        evidence_received_at DESC
      )
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
