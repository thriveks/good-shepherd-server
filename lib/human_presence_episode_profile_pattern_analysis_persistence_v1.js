"use strict";

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_PARENT_VERSION,
  buildHumanPresenceEpisodeProfilePatternAnalysisV1
} = require("./human_presence_episode_profile_pattern_analysis_v1");

const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;

async function loadCurrentEpisodeProfileAnalysisV1(
  db,
  evidenceEventId
) {
  if (!evidenceEventId) {
    throw new Error("evidence event id required");
  }

  const result = await db.query(
    `
      SELECT *
      FROM human_presence_episode_profile_analyses
      WHERE evidence_event_id = $1
        AND episode_profile_analysis_version = $2
      LIMIT 1
    `,
    [
      evidenceEventId,
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_PARENT_VERSION
    ]
  );

  const current = result.rows[0] || null;

  if (!current) {
    throw new Error(
      `Episode Profile Pattern Analysis v1 cannot locate parent ${evidenceEventId}`
    );
  }

  return current;
}

async function loadPriorEpisodeProfileAnalysesV1(
  db,
  current
) {
  if (
    !current?.authoritative_resident_id ||
    !current?.authoritative_room_or_location ||
    !current?.evidence_received_at
  ) {
    throw new Error(
      "authoritative resident, room, and evidence timestamp required"
    );
  }

  const result = await db.query(
    `
      SELECT *
      FROM human_presence_episode_profile_analyses
      WHERE authoritative_resident_id = $1
        AND authoritative_room_or_location = $2
        AND authority_resolution_status =
            'resolved_assigned_sensor'
        AND episode_profile_analysis_version = $3
        AND evidence_received_at < $4
        AND evidence_received_at >=
            ($4::timestamptz - INTERVAL '${HISTORY_DAYS} days')
      ORDER BY evidence_received_at DESC
      LIMIT ${HISTORY_LIMIT}
    `,
    [
      current.authoritative_resident_id,
      current.authoritative_room_or_location,
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_PARENT_VERSION,
      current.evidence_received_at
    ]
  );

  return [...result.rows].reverse();
}

async function persistHumanPresenceEpisodeProfilePatternAnalysisV1(
  db,
  current,
  analysis
) {
  const result = await db.query(
    `
      INSERT INTO
        human_presence_episode_profile_pattern_analyses (
          evidence_event_id,
          episode_profile_analysis_version,
          episode_profile_pattern_analysis_version,

          authoritative_sensor_id,
          authoritative_resident_id,
          authoritative_resident_name,
          authoritative_room_or_location,
          authority_resolution_status,
          assignment_authority,

          evidence_received_at,
          episode_profile_analysis_at,

          episode_profile_pattern_analysis_payload,
          episode_profile_pattern_analysis_at
        )
      VALUES (
        $1,$2,$3,
        $4,$5,$6,$7,$8,$9,
        $10,$11,
        $12::jsonb,NOW()
      )
      ON CONFLICT (
        evidence_event_id,
        episode_profile_analysis_version,
        episode_profile_pattern_analysis_version
      )
      DO NOTHING
      RETURNING episode_profile_pattern_analysis_at
    `,
    [
      current.evidence_event_id,
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_PARENT_VERSION,
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION,

      current.authoritative_sensor_id,
      current.authoritative_resident_id,
      current.authoritative_resident_name,
      current.authoritative_room_or_location,
      current.authority_resolution_status,
      current.assignment_authority,

      current.evidence_received_at,
      current.episode_profile_analysis_at,

      JSON.stringify(analysis)
    ]
  );

  return {
    inserted: result.rowCount === 1,
    episodeProfilePatternAnalysisVersion:
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION
  };
}

async function buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1(
  db,
  evidenceEventId
) {
  const current =
    await loadCurrentEpisodeProfileAnalysisV1(
      db,
      evidenceEventId
    );

  const prior =
    await loadPriorEpisodeProfileAnalysesV1(
      db,
      current
    );

  const episodeProfilePatternAnalysis =
    buildHumanPresenceEpisodeProfilePatternAnalysisV1({
      currentEpisodeProfileAnalysis: current,
      priorEpisodeProfileAnalyses: prior
    });

  const persistence =
    await persistHumanPresenceEpisodeProfilePatternAnalysisV1(
      db,
      current,
      episodeProfilePatternAnalysis
    );

  return {
    episodeProfilePatternAnalysis,
    persistence
  };
}

module.exports = {
  HISTORY_LIMIT,
  HISTORY_DAYS,
  loadCurrentEpisodeProfileAnalysisV1,
  loadPriorEpisodeProfileAnalysesV1,
  persistHumanPresenceEpisodeProfilePatternAnalysisV1,
  buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1
};
