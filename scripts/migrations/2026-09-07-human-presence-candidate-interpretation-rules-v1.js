"use strict";

const {
  ensureHumanPresenceCandidateInterpretationRulesTableV1
} = require(
  "../../lib/human_presence_candidate_interpretation_rules_persistence_v1"
);

const {
  backfillHumanPresenceCandidateInterpretationRulesV1
} = require(
  "../backfill_human_presence_candidate_interpretation_rules_v1"
);

const VERSION =
  "2026-09-07-human-presence-candidate-interpretation-rules-v1";

const DESCRIPTION =
  "Create and backfill observer-only Human Presence Candidate Interpretation Rules v1";

async function up(client) {
  await ensureHumanPresenceCandidateInterpretationRulesTableV1(
    client
  );

  await backfillHumanPresenceCandidateInterpretationRulesV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
