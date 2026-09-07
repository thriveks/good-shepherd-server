"use strict";

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION
} = require(
  "../lib/human_presence_episode_profile_temporal_context_analysis_v1"
);

const {
  buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1
} = require(
  "../lib/human_presence_episode_profile_temporal_context_analysis_persistence_v1"
);

const PROFILE_VERSION =
  "human_presence_episode_profile_analysis_v1";

const PATTERN_VERSION =
  "human_presence_episode_profile_pattern_analysis_v1";

async function loadMissingTemporalContextParentsV1(db) {
  const result = await db.query(
    `
      SELECT
        p.evidence_event_id
      FROM human_presence_episode_profile_analyses p

      JOIN human_presence_episode_profile_pattern_analyses q
        ON q.evidence_event_id = p.evidence_event_id
       AND q.episode_profile_analysis_version =
           p.episode_profile_analysis_version
       AND q.episode_profile_pattern_analysis_version = $2

      WHERE p.episode_profile_analysis_version = $1

        AND p.authority_resolution_status =
            'resolved_assigned_sensor'

        AND NOT EXISTS (
          SELECT 1
          FROM human_presence_episode_profile_temporal_context_analyses t
          WHERE t.evidence_event_id = p.evidence_event_id
            AND t.episode_profile_temporal_context_analysis_version = $3
        )

      ORDER BY
        p.evidence_received_at ASC,
        p.evidence_event_id ASC
    `,
    [
      PROFILE_VERSION,
      PATTERN_VERSION,
      HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION
    ]
  );

  return result.rows;
}

async function backfillHumanPresenceEpisodeProfileTemporalContextV1(
  db,
  { log = console.log } = {}
) {
  const candidates =
    await loadMissingTemporalContextParentsV1(db);

  let inserted = 0;
  let alreadyExists = 0;

  for (const row of candidates) {
    const result =
      await buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
        db,
        row.evidence_event_id
      );

    if (result.persistence.inserted) {
      inserted += 1;
    } else {
      alreadyExists += 1;
    }
  }

  const summary = {
    candidateCount: candidates.length,
    inserted,
    alreadyExists,
    version:
      HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION
  };

  log(
    "Human Presence Temporal Context Analysis v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  PROFILE_VERSION,
  PATTERN_VERSION,
  loadMissingTemporalContextParentsV1,
  backfillHumanPresenceEpisodeProfileTemporalContextV1
};
