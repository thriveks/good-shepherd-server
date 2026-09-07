"use strict";

const VERSION =
  "2026-09-07-human-presence-episode-profile-pattern-analysis-v1";

const DESCRIPTION =
  "Add Human Presence Episode Profile Pattern Analysis v1 persistence";

async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS
      human_presence_episode_profile_pattern_analyses (
        evidence_event_id TEXT NOT NULL,
        episode_profile_analysis_version TEXT NOT NULL,
        episode_profile_pattern_analysis_version TEXT NOT NULL,

        authoritative_sensor_id UUID,
        authoritative_resident_id UUID NOT NULL,
        authoritative_resident_name TEXT,
        authoritative_room_or_location TEXT NOT NULL,
        authority_resolution_status TEXT NOT NULL,
        assignment_authority TEXT,

        evidence_received_at TIMESTAMPTZ NOT NULL,
        episode_profile_analysis_at TIMESTAMPTZ NOT NULL,

        episode_profile_pattern_analysis_payload JSONB NOT NULL,
        episode_profile_pattern_analysis_at
          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        PRIMARY KEY (
          evidence_event_id,
          episode_profile_analysis_version,
          episode_profile_pattern_analysis_version
        )
      )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS
      human_presence_episode_profile_pattern_resident_room_time_idx
    ON human_presence_episode_profile_pattern_analyses (
      authoritative_resident_id,
      authoritative_room_or_location,
      evidence_received_at DESC
    )
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
