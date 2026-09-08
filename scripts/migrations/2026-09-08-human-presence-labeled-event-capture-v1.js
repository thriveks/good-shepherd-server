"use strict";

const {
  ensureHumanPresenceLabeledEventCaptureTableV1
} = require(
  "../../lib/human_presence_labeled_event_capture_persistence_v1"
);

const VERSION =
  "2026-09-08-human-presence-labeled-event-capture-v1";

const DESCRIPTION =
  "Create ground-truth-only Human Presence Labeled Event Capture v1 storage";

async function up(client) {
  await ensureHumanPresenceLabeledEventCaptureTableV1(
    client
  );
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
