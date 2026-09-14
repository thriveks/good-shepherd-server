"use strict";

const {
  ensureHumanPresenceSpatialTemporalLearningV1
} = require(
  "../../lib/human_presence_spatial_temporal_learning_persistence_v1"
);

const VERSION =
  "2026-09-14-human-presence-spatial-temporal-learning-v1";

const DESCRIPTION =
  "Create observer-only Human Presence Spatial Temporal Learning v1 storage";

async function up(client) {
  await ensureHumanPresenceSpatialTemporalLearningV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
