"use strict";

const assert = require("assert");

const {
  buildHumanPresenceTemporalContextDataSufficiencyV1
} = require(
  "../../../../../lib/human_presence_temporal_context_data_sufficiency_v1"
);

function build(overrides = {}) {
  return buildHumanPresenceTemporalContextDataSufficiencyV1({
    evidenceEventId:
      "event-1",

    authoritativeResidentId:
      "resident-1",

    authoritativeRoomOrLocation:
      "room-1",

    daypart:
      "afternoon",

    firstObservationAt:
      "2026-09-01T12:00:00Z",

    latestObservationAt:
      "2026-09-03T12:00:00Z",

    observationCount:
      30,

    distinctCalendarDays:
      3,

    contaminatedRows:
      0,

    duplicateCompositeKeyGroups:
      0,

    ...overrides
  });
}

const pass =
  build();

assert.strictEqual(
  pass.gates.rowCountGate,
  true
);

assert.strictEqual(
  pass.gates.spanGate,
  true
);

assert.strictEqual(
  pass.gates.calendarDayGate,
  true
);

assert.strictEqual(
  pass.passesDataSufficiencyGate,
  true
);

assert.strictEqual(
  pass.empiricalCalibrationStatus,
  "CANDIDATE_INTERPRETATION_RULE_DEVELOPMENT_MAY_BEGIN"
);

assert.strictEqual(
  pass.behavioralThresholdCreated,
  false
);

assert.strictEqual(
  pass.operationalClassification,
  null
);

const insufficientRows =
  build({
    observationCount: 29
  });

assert.strictEqual(
  insufficientRows
    .passesDataSufficiencyGate,
  false
);

const insufficientSpan =
  build({
    latestObservationAt:
      "2026-09-03T11:59:59Z"
  });

assert.strictEqual(
  insufficientSpan
    .passesDataSufficiencyGate,
  false
);

const insufficientDays =
  build({
    distinctCalendarDays: 2
  });

assert.strictEqual(
  insufficientDays
    .passesDataSufficiencyGate,
  false
);

const contaminated =
  build({
    contaminatedRows: 1
  });

assert.strictEqual(
  contaminated
    .passesDataSufficiencyGate,
  false
);

const duplicated =
  build({
    duplicateCompositeKeyGroups: 1
  });

assert.strictEqual(
  duplicated
    .passesDataSufficiencyGate,
  false
);

console.log(
  "PASS: Temporal Context Data Sufficiency v1 deterministic validation"
);

console.log(
  "PASS: inherited minimum observations = 30"
);

console.log(
  "PASS: inherited minimum span = 48 hours"
);

console.log(
  "PASS: inherited minimum calendar dates = 3"
);

console.log(
  "PASS: contamination gate preserved"
);

console.log(
  "PASS: duplicate gate preserved"
);

console.log(
  "PASS: no behavioral threshold created"
);
