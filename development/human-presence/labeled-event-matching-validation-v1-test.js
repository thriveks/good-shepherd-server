"use strict";

const assert = require("assert");

const {
  VERSION,
  buildLabeledEventMatch
} = require("../../lib/human_presence_labeled_event_matching_validation_v1");

const residentId = "resident-1";
const room = "mmWave prototype";

const label = {
  labeledEventId: "label-1",
  eventType: "stand_up",
  captureSource: "controlled_test",
  testSessionId: "session-1",
  residentId,
  residentName: "Test Resident",
  roomOrLocation: room,
  observerName: "Observer",
  startedAt: "2026-09-08T12:46:53.882Z",
  endedAt: "2026-09-08T12:47:04.681Z",
  durationMs: 10799
};

const result = buildLabeledEventMatch({
  label,
  analyticalEvents: [
    {
      evidenceEventId: "prior",
      evidenceReceivedAt: "2026-09-08T12:46:50.250Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: room,
      payload: { source: "test" }
    },
    {
      evidenceEventId: "inside",
      evidenceReceivedAt: "2026-09-08T12:47:00.000Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: room,
      payload: { source: "test" }
    },
    {
      evidenceEventId: "after",
      evidenceReceivedAt: "2026-09-08T12:47:19.112Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: room,
      payload: { source: "test" }
    },
    {
      evidenceEventId: "wrong-room",
      evidenceReceivedAt: "2026-09-08T12:47:00.500Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: "another room"
    }
  ]
});

assert.strictEqual(
  result.version,
  VERSION
);

assert.strictEqual(
  result.observerOnly,
  true
);

assert.strictEqual(
  result.descriptiveOnly,
  true
);

assert.strictEqual(
  result.analyticalContext.authoritativeAnalyticalEventCount,
  3
);

assert.strictEqual(
  result.analyticalContext.insideInterval.count,
  1
);

assert.strictEqual(
  result.analyticalContext.insideInterval.events[0].evidenceEventId,
  "inside"
);

assert.strictEqual(
  result.analyticalContext.nearestBefore.evidenceEventId,
  "prior"
);

assert.strictEqual(
  result.analyticalContext.nearestAfter.evidenceEventId,
  "after"
);

assert.strictEqual(
  result.matchThresholdSeconds,
  null
);

assert.strictEqual(
  result.matchClassification,
  null
);

for (const field of [
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
]) {
  assert.strictEqual(
    result[field],
    null,
    `${field} must remain null`
  );
}

/*
 * Important cadence case:
 * no analytical point occurs inside the physical event,
 * but nearest before/after context is still retained.
 */
const sparse = buildLabeledEventMatch({
  label: {
    ...label,
    labeledEventId: "label-sparse",
    eventType: "exit_room",
    startedAt: "2026-09-08T12:51:07.890Z",
    endedAt: "2026-09-08T12:51:30.390Z",
    durationMs: 22500
  },
  analyticalEvents: [
    {
      evidenceEventId: "before-exit",
      evidenceReceivedAt: "2026-09-08T12:50:50.000Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: room
    },
    {
      evidenceEventId: "after-exit",
      evidenceReceivedAt: "2026-09-08T12:51:31.248Z",
      authoritativeResidentId: residentId,
      authoritativeRoomOrLocation: room
    }
  ]
});

assert.strictEqual(
  sparse.analyticalContext.insideInterval.count,
  0
);

assert.strictEqual(
  sparse.analyticalContext.nearestAfter.evidenceEventId,
  "after-exit"
);

assert.strictEqual(
  sparse.analyticalContext.nearestAfter.secondsAfterLabelEnd,
  0.858
);

assert.strictEqual(
  sparse.matchClassification,
  null
);

assert.throws(
  () =>
    buildLabeledEventMatch({
      label: {
        ...label,
        endedAt: "2026-09-08T12:40:00.000Z"
      },
      analyticalEvents: []
    }),
  /cannot precede/
);

console.log("LABELED_EVENT_MATCHING_VALIDATION_V1_TEST=PASS");
console.log(`VERSION=${VERSION}`);
console.log("AUTHORITY_FILTERING=PASS");
console.log("INSIDE_INTERVAL_CONTEXT=PASS");
console.log("NEAREST_BEFORE_CONTEXT=PASS");
console.log("NEAREST_AFTER_CONTEXT=PASS");
console.log("SPARSE_CADENCE_HANDLING=PASS");
console.log("ARBITRARY_MATCH_THRESHOLD=NONE");
console.log("OPERATIONAL_CLASSIFICATION=NONE");
console.log("RISK_SEVERITY_ALERT_POLICY=NONE");
console.log("FALL_EMERGENCY_MEDICAL_INFERENCE=NONE");
