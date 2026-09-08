"use strict";

const assert =
  require("assert");

const {
  VERSION,
  ALLOWED_EVENT_TYPES,
  validateHumanPresenceLabeledEventCaptureV1
} = require(
  "../../lib/human_presence_labeled_event_capture_v1"
);

assert.strictEqual(
  VERSION,
  "human_presence_labeled_event_capture_v1"
);

assert(
  ALLOWED_EVENT_TYPES.includes(
    "enter_room"
  )
);

assert(
  ALLOWED_EVENT_TYPES.includes(
    "seated_stationary"
  )
);

assert(
  ALLOWED_EVENT_TYPES.includes(
    "intentional_lie_down"
  )
);

const valid =
  validateHumanPresenceLabeledEventCaptureV1({
    eventType:
      "walk_within_room",

    captureSource:
      "controlled_test",

    residentId:
      "test-resident-1",

    residentName:
      "Controlled Test Resident",

    roomOrLocation:
      "mmWave prototype",

    observerName:
      "Test Observer",

    testSessionId:
      "session-001",

    startedAt:
      "2026-09-08T12:00:00-05:00",

    endedAt:
      "2026-09-08T12:00:30-05:00",

    notes:
      "Walked across monitored area."
  });

assert.strictEqual(
  valid.valid,
  true
);

assert.strictEqual(
  valid.errors.length,
  0
);

assert.strictEqual(
  valid.value.groundTruthOnly,
  true
);

assert.strictEqual(
  valid.value.sensorDerived,
  false
);

assert.strictEqual(
  valid.value.durationMs,
  30000
);

assert.strictEqual(
  valid.value.startedAt,
  "2026-09-08T17:00:00.000Z"
);

assert.strictEqual(
  valid.value.endedAt,
  "2026-09-08T17:00:30.000Z"
);

const prohibited = [
  "analyticalInterpretation",
  "anomalyClassification",
  "operationalClassification",
  "riskClassification",
  "severityClassification",
  "fallInterpretation",
  "emergencyInterpretation",
  "medicalInterpretation",
  "alertLevel",
  "monitoringAction",
  "caregiverRecommendation"
];

for (const field of prohibited) {
  assert.strictEqual(
    valid.value[field],
    null,
    `${field} must remain null`
  );
}

const badType =
  validateHumanPresenceLabeledEventCaptureV1({
    eventType:
      "detected_fall",

    captureSource:
      "controlled_test",

    residentId:
      "x",

    roomOrLocation:
      "room",

    observerName:
      "observer",

    startedAt:
      "2026-09-08T12:00:00Z",

    endedAt:
      "2026-09-08T12:00:05Z"
  });

assert.strictEqual(
  badType.valid,
  false
);

assert(
  badType.errors.includes(
    "eventType must be an allowed v1 label"
  )
);

const reversed =
  validateHumanPresenceLabeledEventCaptureV1({
    eventType:
      "sit_down",

    captureSource:
      "manual_observer",

    residentId:
      "x",

    roomOrLocation:
      "room",

    observerName:
      "observer",

    startedAt:
      "2026-09-08T12:01:00Z",

    endedAt:
      "2026-09-08T12:00:00Z"
  });

assert.strictEqual(
  reversed.valid,
  false
);

assert(
  reversed.errors.includes(
    "endedAt cannot occur before startedAt"
  )
);

const missingObserver =
  validateHumanPresenceLabeledEventCaptureV1({
    eventType:
      "stand_up",

    captureSource:
      "controlled_test",

    residentId:
      "x",

    roomOrLocation:
      "room",

    startedAt:
      "2026-09-08T12:00:00Z",

    endedAt:
      "2026-09-08T12:00:05Z"
  });

assert.strictEqual(
  missingObserver.valid,
  false
);

console.log(
  "LABELED_EVENT_CAPTURE_V1_TEST=PASS"
);
