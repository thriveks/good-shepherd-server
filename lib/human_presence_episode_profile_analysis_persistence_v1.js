"use strict";

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION,
  analyzeEpisodeProfile,
  parseProfile
} = require("./human_presence_episode_profile_analysis_v1");

const HISTORY_LIMIT = 50;
const HISTORY_DAYS = 30;

const HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS human_presence_episode_profile_analyses (
    evidence_event_id TEXT NOT NULL,
    episode_profile_analysis_version TEXT NOT NULL,

    authoritative_sensor_id UUID,
    authoritative_resident_id UUID NOT NULL,
    authoritative_resident_name TEXT,
    authoritative_room_or_location TEXT NOT NULL,
    authority_resolution_status TEXT NOT NULL,
    assignment_authority TEXT,

    evidence_schema_version TEXT NOT NULL,
    episode_profile_analysis_payload JSONB NOT NULL,

    evidence_received_at TIMESTAMPTZ NOT NULL,
    episode_profile_analysis_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
      evidence_event_id,
      episode_profile_analysis_version
    )
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_episode_profile_resident_room_time_idx
  ON human_presence_episode_profile_analyses (
    authoritative_resident_id,
    authoritative_room_or_location,
    evidence_received_at DESC
  );
`;

function requireCurrent(current) {
  if (!current) {
    throw new Error("episode profile current evidence row required");
  }

  if (
    !current.authoritative_resident_id ||
    !current.authoritative_room_or_location
  ) {
    throw new Error("authoritative resident and room required");
  }

  if (current.authority_resolution_status !== "resolved_assigned_sensor") {
    throw new Error("resolved assigned sensor authority required");
  }

  if (String(current.evidence_schema_version) !== "1.1") {
    throw new Error("episode profile analysis requires evidence schema 1.1");
  }

  if (!current.event_payload?.episodeProfile) {
    throw new Error("episodeProfile required");
  }
}

async function ensureHumanPresenceEpisodeProfileAnalysisTableV1(db) {
  await db.query(HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_TABLE_SQL);
}

async function loadPriorEpisodeProfileEvidenceRowsV1(db, current) {
  requireCurrent(current);

  const result = await db.query(
    `
      SELECT
        e.event_id,
        e.node_id,
        e.evidence_schema_version,
        e.event_payload,
        e.received_at
      FROM candidate_history_evidence_events e
      JOIN human_presence_candidate_interpretations i
        ON i.evidence_event_id = e.event_id
       AND i.interpretation_version =
           'human_presence_candidate_interpretation_v1'
      WHERE i.authoritative_resident_id = $1
        AND i.authoritative_room_or_location = $2
        AND i.authority_resolution_status = 'resolved_assigned_sensor'
        AND e.evidence_schema_version = '1.1'
        AND e.event_payload ? 'episodeProfile'
        AND e.received_at < $3
        AND e.received_at >=
            ($3::timestamptz - INTERVAL '${HISTORY_DAYS} days')
      ORDER BY e.received_at DESC
      LIMIT ${HISTORY_LIMIT}
    `,
    [
      current.authoritative_resident_id,
      current.authoritative_room_or_location,
      current.evidence_received_at
    ]
  );

  return [...result.rows].reverse();
}

async function persistHumanPresenceEpisodeProfileAnalysisV1(
  db,
  current,
  analysis
) {
  requireCurrent(current);

  const result = await db.query(
    `
      INSERT INTO human_presence_episode_profile_analyses (
        evidence_event_id,
        episode_profile_analysis_version,

        authoritative_sensor_id,
        authoritative_resident_id,
        authoritative_resident_name,
        authoritative_room_or_location,
        authority_resolution_status,
        assignment_authority,

        evidence_schema_version,
        episode_profile_analysis_payload,

        evidence_received_at,
        episode_profile_analysis_at
      )
      VALUES (
        $1,$2,
        $3,$4,$5,$6,$7,$8,
        $9,$10::jsonb,
        $11,NOW()
      )
      ON CONFLICT (
        evidence_event_id,
        episode_profile_analysis_version
      )
      DO NOTHING
      RETURNING episode_profile_analysis_at
    `,
    [
      current.evidence_event_id,
      HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION,

      current.authoritative_sensor_id,
      current.authoritative_resident_id,
      current.authoritative_resident_name,
      current.authoritative_room_or_location,
      current.authority_resolution_status,
      current.assignment_authority,

      current.evidence_schema_version,
      JSON.stringify(analysis),

      current.evidence_received_at
    ]
  );

  return {
    inserted: result.rowCount === 1,
    episodeProfileAnalysisVersion:
      HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION
  };
}

async function buildAndPersistHumanPresenceEpisodeProfileAnalysisV1(
  db,
  current
) {
  requireCurrent(current);

  const priorEpisodeProfileEvidence =
    await loadPriorEpisodeProfileEvidenceRowsV1(db, current);

  const episodeProfileAnalysis =
    analyzeEpisodeProfile({
      evidenceEventId: current.evidence_event_id,
      evidenceSchemaVersion: current.evidence_schema_version,
      episodeProfile: current.event_payload.episodeProfile,
      evidenceReceivedAt: current.evidence_received_at,
      history: priorEpisodeProfileEvidence
        .filter((row) => {
          try {
            parseProfile(row?.event_payload?.episodeProfile);
            return true;
          } catch {
            return false;
          }
        })
        .map((row) => ({
          evidenceEventId: row.evidence_event_id,
          evidenceSchemaVersion: row.evidence_schema_version,
          episodeProfile: row.event_payload.episodeProfile,
          evidenceReceivedAt: row.received_at
        }))
    });

  const persistence =
    await persistHumanPresenceEpisodeProfileAnalysisV1(
      db,
      current,
      episodeProfileAnalysis
    );

  return {
    episodeProfileAnalysis,
    persistence
  };
}

module.exports = {
  HISTORY_LIMIT,
  HISTORY_DAYS,
  HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_TABLE_SQL,
  ensureHumanPresenceEpisodeProfileAnalysisTableV1,
  loadPriorEpisodeProfileEvidenceRowsV1,
  persistHumanPresenceEpisodeProfileAnalysisV1,
  buildAndPersistHumanPresenceEpisodeProfileAnalysisV1
};
