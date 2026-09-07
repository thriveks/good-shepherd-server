"use strict";

const {
  backfillHumanPresenceEpisodeProfilePatternV1
} = require(
  "../backfill_human_presence_episode_profile_pattern_v1"
);

const VERSION =
  "2026-09-07-human-presence-episode-profile-pattern-backfill-v1";

const DESCRIPTION =
  "Backfill historical Human Presence Episode Profile Pattern Analysis v1 rows";

async function up(client) {
  const summary =
    await backfillHumanPresenceEpisodeProfilePatternV1(
      client
    );

  console.log(
    `Episode Profile Pattern backfill complete: ` +
    `${summary.inserted} inserted, ` +
    `${summary.alreadyExists} already existed, ` +
    `${summary.candidateCount} candidate rows.`
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
