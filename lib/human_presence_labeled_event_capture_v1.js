"use strict";

const VERSION =
  "human_presence_labeled_event_capture_v1";

/*
 * Ground-truth activity labels only.
 *
 * These labels describe what a human observer knows
 * physically occurred.
 *
 * They are NOT sensor interpretations,
 * safety conclusions,
 * medical conclusions,
 * or alert classifications.
 */
const ALLOWED_EVENT_TYPES =
  Object.freeze([
    "enter_room",
    "exit_room",
    "walk_through_room",
    "walk_within_room",
    "sit_down",
    "stand_up",
    "seated_stationary",
    "standing_stationary",
    "intentional_lie_down",
    "intentional_rise_from_lying",
    "other_observed_activity"
  ]);

const ALLOWED_CAPTURE_SOURCES =
  Object.freeze([
    "manual_observer",
    "controlled_test"
  ]);

function cleanText(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }

  const text =
    String(value).trim();

  return text.length
    ? text
    : null;
}

function parseIsoTimestamp(value) {
  const text =
    cleanText(value);

  if (!text) {
    return null;
  }

  const ms =
    Date.parse(text);

  if (!Number.isFinite(ms)) {
    return null;
  }

  return {
    iso:
      new Date(ms).toISOString(),

    epochMs:
      ms
  };
}

function validateHumanPresenceLabeledEventCaptureV1(
  input
) {
  const errors = [];

  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return {
      valid: false,
      errors: [
        "input must be an object"
      ],
      value: null
    };
  }

  const eventType =
    cleanText(
      input.eventType
    );

  const captureSource =
    cleanText(
      input.captureSource
    );

  const residentId =
    cleanText(
      input.residentId
    );

  const residentName =
    cleanText(
      input.residentName
    );

  const roomOrLocation =
    cleanText(
      input.roomOrLocation
    );

  const observerName =
    cleanText(
      input.observerName
    );

  const notes =
    cleanText(
      input.notes
    );

  const testSessionId =
    cleanText(
      input.testSessionId
    );

  if (
    !eventType ||
    !ALLOWED_EVENT_TYPES.includes(
      eventType
    )
  ) {
    errors.push(
      "eventType must be an allowed v1 label"
    );
  }

  if (
    !captureSource ||
    !ALLOWED_CAPTURE_SOURCES.includes(
      captureSource
    )
  ) {
    errors.push(
      "captureSource must be manual_observer or controlled_test"
    );
  }

  if (!residentId) {
    errors.push(
      "residentId is required"
    );
  }

  if (!roomOrLocation) {
    errors.push(
      "roomOrLocation is required"
    );
  }

  if (!observerName) {
    errors.push(
      "observerName is required"
    );
  }

  const start =
    parseIsoTimestamp(
      input.startedAt
    );

  const end =
    parseIsoTimestamp(
      input.endedAt
    );

  if (!start) {
    errors.push(
      "startedAt must be a valid ISO timestamp"
    );
  }

  if (!end) {
    errors.push(
      "endedAt must be a valid ISO timestamp"
    );
  }

  if (
    start &&
    end &&
    end.epochMs < start.epochMs
  ) {
    errors.push(
      "endedAt cannot occur before startedAt"
    );
  }

  const durationMs =
    (
      start &&
      end
    )
      ? end.epochMs -
        start.epochMs
      : null;

  return {
    valid:
      errors.length === 0,

    errors,

    value:
      errors.length
        ? null
        : {
            labeledEventCaptureVersion:
              VERSION,

            eventType,

            captureSource,

            residentId,

            residentName,

            roomOrLocation,

            observerName,

            testSessionId,

            startedAt:
              start.iso,

            endedAt:
              end.iso,

            durationMs,

            notes,

            groundTruthOnly:
              true,

            observerSupplied:
              true,

            sensorDerived:
              false,

            analyticalInterpretation:
              null,

            anomalyClassification:
              null,

            operationalClassification:
              null,

            riskClassification:
              null,

            severityClassification:
              null,

            fallInterpretation:
              null,

            emergencyInterpretation:
              null,

            medicalInterpretation:
              null,

            alertLevel:
              null,

            monitoringAction:
              null,

            caregiverRecommendation:
              null
          }
  };
}

module.exports = {
  VERSION,
  ALLOWED_EVENT_TYPES,
  ALLOWED_CAPTURE_SOURCES,
  cleanText,
  parseIsoTimestamp,
  validateHumanPresenceLabeledEventCaptureV1
};
