const HUMAN_PRESENCE_INTERPRETATION_VERSION =
  "human_presence_interpretation_v1";

const HUMAN_PRESENCE_HISTORY_CAPACITY = 8;

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return number;
}

function integerValue(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return number;
}

function safeRatio(numerator, denominator) {
  if (!Number.isFinite(numerator) ||
      !Number.isFinite(denominator) ||
      denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function relativeOrdering(first, second, lowerLabel, equalLabel, higherLabel) {
  if (first < second) return lowerLabel;
  if (first > second) return higherLabel;
  return equalLabel;
}

function interpretHumanPresenceCandidateEvidenceV1(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Evidence payload is required");
  }

  if (String(payload.eventType || "") !== "candidate_history_evidence") {
    throw new Error("Unsupported eventType");
  }

  if (String(payload.protocolVersion || "") !== "2.0") {
    throw new Error("Unsupported protocolVersion");
  }

  if (String(payload.evidenceSchemaVersion || "") !== "1.0") {
    throw new Error("Unsupported evidenceSchemaVersion");
  }

  const dimensions = integerValue(payload.dimensions, "dimensions");
  if (dimensions !== 10) {
    throw new Error("dimensions must equal 10");
  }

  const historyCount = integerValue(payload.historyCount, "historyCount");
  const priorCount = integerValue(payload.priorCount, "priorCount");

  if (historyCount < 3 || historyCount > HUMAN_PRESENCE_HISTORY_CAPACITY) {
    throw new Error("historyCount outside Interpretation v1 contract");
  }

  if (priorCount < 2 || priorCount !== historyCount - 1) {
    throw new Error("priorCount inconsistent with historyCount");
  }

  const nearest = finiteNumber(
    payload.nearestMeanRelativeDelta,
    "nearestMeanRelativeDelta"
  );

  const secondNearest = finiteNumber(
    payload.secondNearestMeanRelativeDelta,
    "secondNearestMeanRelativeDelta"
  );

  const historyMean = finiteNumber(
    payload.historyMeanRelativeDelta,
    "historyMeanRelativeDelta"
  );

  const historyMin = finiteNumber(
    payload.historyMinRelativeDelta,
    "historyMinRelativeDelta"
  );

  const historyMax = finiteNumber(
    payload.historyMaxRelativeDelta,
    "historyMaxRelativeDelta"
  );

  const historyRange = finiteNumber(
    payload.historyRange,
    "historyRange"
  );

  const absoluteSeparation = finiteNumber(
    payload.absoluteSeparation,
    "absoluteSeparation"
  );

  const relativeSeparation = finiteNumber(
    payload.relativeSeparation,
    "relativeSeparation"
  );

  const nearestAdvantage = finiteNumber(
    payload.nearestAdvantage,
    "nearestAdvantage"
  );

  const relativeNearestAdvantage = finiteNumber(
    payload.relativeNearestAdvantage,
    "relativeNearestAdvantage"
  );

  const historyMaturityStage =
    historyCount === HUMAN_PRESENCE_HISTORY_CAPACITY
      ? "full_local_history"
      : "collecting_local_history";

  return {
    interpretationVersion: HUMAN_PRESENCE_INTERPRETATION_VERSION,

    historyCapacity: HUMAN_PRESENCE_HISTORY_CAPACITY,
    historyCount,
    priorCount,
    historyCapacityRatio:
      historyCount / HUMAN_PRESENCE_HISTORY_CAPACITY,
    historyMaturityStage,

    nearestRelativeDelta: nearest,
    secondNearestRelativeDelta: secondNearest,
    historyMeanRelativeDelta: historyMean,
    historyMinRelativeDelta: historyMin,
    historyMaxRelativeDelta: historyMax,
    historyRange,

    nearestVsHistoryRatio:
      safeRatio(nearest, historyMean),

    nearestVsSecondRatio:
      safeRatio(nearest, secondNearest),

    historySpreadVsMeanRatio:
      safeRatio(historyRange, historyMean),

    similarityObservation:
      relativeOrdering(
        nearest,
        historyMean,
        "nearest_below_history_mean",
        "nearest_equals_history_mean",
        "nearest_above_history_mean"
      ),

    absoluteSeparation,
    relativeSeparation,
    nearestAdvantage,
    relativeNearestAdvantage,

    distinctivenessObservation:
      relativeOrdering(
        nearest,
        secondNearest,
        "nearest_closer_than_second",
        "nearest_equals_second",
        "nearest_farther_than_second"
      ),

    evidenceStabilityObservation:
      "descriptive_metrics_only",

    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null
  };
}

module.exports = {
  HUMAN_PRESENCE_INTERPRETATION_VERSION,
  HUMAN_PRESENCE_HISTORY_CAPACITY,
  interpretHumanPresenceCandidateEvidenceV1
};
