"use strict";

const {
  ensureHumanPresenceEngineeringFeatureTableV1
} = require(
  "../../lib/human_presence_engineering_feature_persistence_v1"
);

const VERSION =
  "2026-09-14-human-presence-engineering-feature-v1";

const DESCRIPTION =
  "Create observer-only LD2410 Human Presence Engineering Feature v1 storage";

async function up(client) {
  await ensureHumanPresenceEngineeringFeatureTableV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
