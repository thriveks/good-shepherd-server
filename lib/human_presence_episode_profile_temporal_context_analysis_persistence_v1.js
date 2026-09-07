"use strict";

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PROFILE_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PATTERN_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_DEFAULT_TIME_ZONE,
  buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1
} = require(
  "./human_presence_episode_profile_temporal_context_analysis_v1"
);

const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;

async function loadCurrentTemporalContextParentV1(
  db,
  evidenceEventId
) {
  const result =
    await db.query(
      `
        SELECT
          p.evidence_event_id,

          p.episode_profile_analysis_version,
          q.episode_profile_pattern_analysis_version,

          p.authoritative_sensor_id,
          p.authoritative_resident_id,
          p.authoritative_resident_name,
          p.authoritative_room_or_location,
          p.authority_resolution_status,
          p.assignment_authority,

          p.evidence_received_at,
          p.episode_profile_analysis_at,
          q.episode_profile_pattern_analysis_at,

          p.episode_profile_analysis_payload,
          q.episode_profile_pattern_analysis_payload

        FROM human_presence_episode_profile_analyses p

        JOIN human_presence_episode_profile_pattern_analyses q
          ON q.evidence_event_id =
             p.evidence_event_id
         AND q.episode_profile_analysis_version =
             p.episode_profile_analysis_version
         AND q.episode_profile_pattern_analysis_version =
             $2

        WHERE p.evidence_event_id = $1
          AND p.episode_profile_analysis_version =
              $3

        LIMIT 1
      `,
      [
        evidenceEventId,
        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PATTERN_VERSION,
        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PROFILE_VERSION
      ]
    );

  const row =
    result.rows[0] || null;

  if (!row) {
    throw new Error(
      `Temporal Context Analysis parent not found for ${evidenceEventId}`
    );
  }

  return row;
}

async function loadPriorTemporalContextParentsV1(
  db,
  current
) {
  const result =
    await db.query(
      `
        SELECT
          p.evidence_event_id,

          p.episode_profile_analysis_version,
          q.episode_profile_pattern_analysis_version,

          p.authoritative_sensor_id,
          p.authoritative_resident_id,
          p.authoritative_resident_name,
          p.authoritative_room_or_location,
          p.authority_resolution_status,
          p.assignment_authority,

          p.evidence_received_at,
          p.episode_profile_analysis_at,
          q.episode_profile_pattern_analysis_at,

          p.episode_profile_analysis_payload,
          q.episode_profile_pattern_analysis_payload

        FROM human_presence_episode_profile_analyses p

        JOIN human_presence_episode_profile_pattern_analyses q
          ON q.evidence_event_id =
             p.evidence_event_id
         AND q.episode_profile_analysis_version =
             p.episode_profile_analysis_version
         AND q.episode_profile_pattern_analysis_version =
             $3

        WHERE p.authoritative_resident_id = $1
          AND p.authoritative_room_or_location = $2
          AND p.authority_resolution_status =
              'resolved_assigned_sensor'

          AND p.episode_profile_analysis_version =
              $4

          AND p.evidence_received_at < $5

          AND p.evidence_received_at >=
              (
                $5::timestamptz -
                INTERVAL '${HISTORY_DAYS} days'
              )

        ORDER BY
          p.evidence_received_at DESC

        LIMIT ${HISTORY_LIMIT}
      `,
      [
        current.authoritative_resident_id,
        current.authoritative_room_or_location,
        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PATTERN_VERSION,
        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PROFILE_VERSION,
        current.evidence_received_at
      ]
    );

  return [...result.rows].reverse();
}

async function persistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
  db,
  current,
  analysis
) {
  const result =
    await db.query(
      `
        INSERT INTO
          human_presence_episode_profile_temporal_context_analyses (
            evidence_event_id,
            episode_profile_analysis_version,
            episode_profile_pattern_analysis_version,
            episode_profile_temporal_context_analysis_version,

            authoritative_sensor_id,
            authoritative_resident_id,
            authoritative_resident_name,
            authoritative_room_or_location,
            authority_resolution_status,
            assignment_authority,

            evidence_received_at,

            episode_profile_temporal_context_analysis_payload,
            episode_profile_temporal_context_analysis_at
          )

        VALUES (
          $1,$2,$3,$4,
          $5,$6,$7,$8,$9,$10,
          $11,
          $12::jsonb,
          NOW()
        )

        ON CONFLICT (
          evidence_event_id,
          episode_profile_temporal_context_analysis_version
        )
        DO NOTHING

        RETURNING
          episode_profile_temporal_context_analysis_at
      `,
      [
        current.evidence_event_id,

        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PROFILE_VERSION,

        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PATTERN_VERSION,

        HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION,

        current.authoritative_sensor_id,
        current.authoritative_resident_id,
        current.authoritative_resident_name,
        current.authoritative_room_or_location,
        current.authority_resolution_status,
        current.assignment_authority,

        current.evidence_received_at,

        JSON.stringify(analysis)
      ]
    );

  return {
    inserted:
      result.rowCount === 1,

    episodeProfileTemporalContextAnalysisVersion:
      HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION
  };
}

async function buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
  db,
  evidenceEventId,
  {
    timeZone =
      HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_DEFAULT_TIME_ZONE
  } = {}
) {
  const current =
    await loadCurrentTemporalContextParentV1(
      db,
      evidenceEventId
    );

  const prior =
    await loadPriorTemporalContextParentsV1(
      db,
      current
    );

  const episodeProfileTemporalContextAnalysis =
    buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1({
      current,
      prior,
      timeZone
    });

  const persistence =
    await persistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
      db,
      current,
      episodeProfileTemporalContextAnalysis
    );

  return {
    episodeProfileTemporalContextAnalysis,
    persistence
  };
}

module.exports = {
  HISTORY_LIMIT,
  HISTORY_DAYS,

  loadCurrentTemporalContextParentV1,
  loadPriorTemporalContextParentsV1,

  persistHumanPresenceEpisodeProfileTemporalContextAnalysisV1,

  buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1
};
