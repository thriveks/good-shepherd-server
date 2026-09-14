"use strict";

const {
  ensureHumanPresenceSpatialSignatureTableV1
} = require(
  "../../lib/human_presence_spatial_signature_persistence_v1"
);

const VERSION =
  "2026-09-14-human-presence-spatial-signature-v1";

const DESCRIPTION =
  "Create observer-only Human Presence Spatial Signature v1 storage";

async function up(client) {
  await ensureHumanPresenceSpatialSignatureTableV1(client);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
