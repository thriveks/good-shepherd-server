"use strict";

const {
  ensureHumanPresenceSpatialStateLearningV1
} = require(
  "../../lib/human_presence_spatial_state_learning_persistence_v1"
);

const VERSION =
  "2026-09-14-human-presence-spatial-state-learning-v1";

const DESCRIPTION =
  "Create observer-only Human Presence Spatial State Learning v1 storage";

async function up(client) {
  await ensureHumanPresenceSpatialStateLearningV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
