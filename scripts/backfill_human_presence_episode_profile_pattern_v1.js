"use strict";

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION
} = require("../lib/human_presence_episode_profile_pattern_analysis_v1");

const {
  buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1
} = require("../lib/human_presence_episode_profile_pattern_analysis_persistence_v1");

const PARENT_VERSION =
  "human_presence_episode_profile_analysis_v1";

async function loadMissingEpisodeProfilePatternParentsV1(db) {
  const result = await db.query(
    `
      SELECT
        p.evidence_event_id
      FROM human_presence_episode_profile_analyses p
      WHERE p.episode_profile_analysis_version = $1
        AND NOT EXISTS (
          SELECT 1
          FROM human_presence_episode_profile_pattern_analyses q
          WHERE q.evidence_event_id =
                p.evidence_event_id
            AND q.episode_profile_analysis_version =
                p.episode_profile_analysis_version
            AND q.episode_profile_pattern_analysis_version =
                $2
        )
      ORDER BY
        p.evidence_received_at ASC,
        p.evidence_event_id ASC
    `,
    [
      PARENT_VERSION,
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION
    ]
  );

  return result.rows;
}

async function backfillHumanPresenceEpisodeProfilePatternV1(
  db,
  { log = console.log } = {}
) {
  const missing =
    await loadMissingEpisodeProfilePatternParentsV1(db);

  let inserted = 0;
  let alreadyExists = 0;

  for (const row of missing) {
    const result =
      await buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1(
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
    candidateCount: missing.length,
    inserted,
    alreadyExists,
    version:
      HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION
  };

  log(
    "Human Presence Episode Profile Pattern Analysis v1 backfill:",
    JSON.stringify(summary)
  );

  return summary;
}

module.exports = {
  PARENT_VERSION,
  loadMissingEpisodeProfilePatternParentsV1,
  backfillHumanPresenceEpisodeProfilePatternV1
};
