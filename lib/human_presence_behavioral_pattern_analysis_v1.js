"use strict";

const HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION =
  "human_presence_behavioral_pattern_analysis_v1";

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function validDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function parentVersion(row) {
  return (
    row?.behavioral_observation_version ||
    row?.behavioralObservationVersion ||
    row?.behavioral_observation_payload?.behavioralObservationVersion ||
    null
  );
}

function payloadOf(row) {
  return row?.behavioral_observation_payload || row?.behavioralObservationPayload || {};
}

function eventIdOf(row) {
  return row?.evidence_event_id || row?.evidenceEventId || null;
}

function residentIdOf(row) {
  return row?.authoritative_resident_id || row?.authoritativeResidentId || null;
}

function roomOf(row) {
  return (
    row?.authoritative_room_or_location ||
    row?.authoritativeRoomOrLocation ||
    null
  );
}

function timestampOf(row) {
  return row?.behavioral_observation_at || row?.behavioralObservationAt || null;
}

function authorityStatusOf(row) {
  return row?.authority_resolution_status || row?.authorityResolutionStatus || null;
}

function validateCurrent(current) {
  if (!current) {
    throw new Error("behavioral pattern analysis current row required");
  }

  if (
    parentVersion(current) !==
    "human_presence_behavioral_observation_v1"
  ) {
    throw new Error("unsupported behavioral observation parent version");
  }

  if (!eventIdOf(current)) {
    throw new Error("evidence event id required");
  }

  if (!residentIdOf(current) || !roomOf(current)) {
    throw new Error("authoritative resident and room required");
  }

  if (authorityStatusOf(current) !== "resolved_assigned_sensor") {
    throw new Error("resolved assigned sensor authority required");
  }

  if (!validDate(timestampOf(current))) {
    throw new Error("valid behavioral observation timestamp required");
  }

  const payload = payloadOf(current);

  if (payload.descriptiveOnly !== true) {
    throw new Error("parent behavioral observation must be descriptive only");
  }

  const forbidden = [
    "operationalClassification",
    "alertLevel",
    "monitoringAction",
    "interventionRecommendation"
  ];

  for (const key of forbidden) {
    if (payload[key] !== null && payload[key] !== undefined) {
      throw new Error(`parent operational contamination: ${key}`);
    }
  }
}

function normalizeHistory(current, priorRows) {
  const residentId = residentIdOf(current);
  const room = roomOf(current);
  const currentTime = validDate(timestampOf(current)).getTime();

  return (Array.isArray(priorRows) ? priorRows : [])
    .filter((row) => {
      if (
        parentVersion(row) !==
        "human_presence_behavioral_observation_v1"
      ) {
        return false;
      }

      if (residentIdOf(row) !== residentId || roomOf(row) !== room) {
        return false;
      }

      const d = validDate(timestampOf(row));
      return d && d.getTime() < currentTime;
    })
    .sort(
      (a, b) =>
        validDate(timestampOf(a)).getTime() -
        validDate(timestampOf(b)).getTime()
    );
}

function directionSummary(rows, metricName) {
  const comparable = [];

  for (const row of rows) {
    const metric =
      payloadOf(row)?.interpretationMetricSummaries?.[metricName];

    const direction = metric?.directionVsPriorMean;

    if (
      direction === "above_prior_mean" ||
      direction === "below_prior_mean" ||
      direction === "equal_prior_mean"
    ) {
      comparable.push({
        eventId: eventIdOf(row),
        direction
      });
    }
  }

  const counts = {
    above_prior_mean: 0,
    below_prior_mean: 0,
    equal_prior_mean: 0
  };

  for (const item of comparable) {
    counts[item.direction] += 1;
  }

  let changes = 0;
  for (let i = 1; i < comparable.length; i += 1) {
    if (comparable[i].direction !== comparable[i - 1].direction) {
      changes += 1;
    }
  }

  let consecutive = 0;
  const current =
    comparable.length > 0
      ? comparable[comparable.length - 1].direction
      : null;

  if (current) {
    for (let i = comparable.length - 1; i >= 0; i -= 1) {
      if (comparable[i].direction !== current) break;
      consecutive += 1;
    }
  }

  return {
    comparableObservationCount: comparable.length,
    abovePriorMeanCount: counts.above_prior_mean,
    belowPriorMeanCount: counts.below_prior_mean,
    equalPriorMeanCount: counts.equal_prior_mean,
    currentDirection: current,
    previousComparableDirection:
      comparable.length >= 2
        ? comparable[comparable.length - 2].direction
        : null,
    consecutiveSameDirectionCount: consecutive,
    directionChangeCount: changes
  };
}

function valueTrajectory(rows, metricName) {
  const values = [];

  for (const row of rows) {
    const metric =
      payloadOf(row)?.interpretationMetricSummaries?.[metricName];

    const value = finiteNumber(metric?.currentValue);
    if (value !== null) values.push(value);
  }

  const latest = values.length ? values[values.length - 1] : null;
  const previous = values.length >= 2 ? values[values.length - 2] : null;

  const priorValues =
    values.length >= 2 ? values.slice(0, values.length - 1) : [];

  const historyMean = mean(priorValues);

  return {
    sampleCount: values.length,
    firstValue: values.length ? values[0] : null,
    latestValue: latest,
    minimum: values.length ? Math.min(...values) : null,
    maximum: values.length ? Math.max(...values) : null,
    mean: mean(values),
    median: median(values),
    latestMinusPrevious:
      latest !== null && previous !== null ? latest - previous : null,
    latestMinusHistoryMean:
      latest !== null && historyMean !== null ? latest - historyMean : null
  };
}

function cadenceTrajectory(rows) {
  const values = [];

  for (const row of rows) {
    const value = finiteNumber(
      payloadOf(row)?.cadence?.meanInterObservationSeconds
    );

    if (value !== null) values.push(value);
  }

  const latest = values.length ? values[values.length - 1] : null;
  const previous = values.length >= 2 ? values[values.length - 2] : null;
  const priorValues =
    values.length >= 2 ? values.slice(0, values.length - 1) : [];
  const historyMean = mean(priorValues);

  return {
    sampleCount: values.length,
    firstMeanInterObservationSeconds:
      values.length ? values[0] : null,
    latestMeanInterObservationSeconds: latest,
    minimumMeanInterObservationSeconds:
      values.length ? Math.min(...values) : null,
    maximumMeanInterObservationSeconds:
      values.length ? Math.max(...values) : null,
    meanInterObservationSeconds: mean(values),
    medianInterObservationSeconds: median(values),
    latestMinusPreviousSeconds:
      latest !== null && previous !== null ? latest - previous : null,
    latestMinusHistoryMeanSeconds:
      latest !== null && historyMean !== null ? latest - historyMean : null
  };
}

function buildHumanPresenceBehavioralPatternAnalysisV1({
  currentBehavioralObservation,
  priorBehavioralObservations = []
}) {
  validateCurrent(currentBehavioralObservation);

  const prior = normalizeHistory(
    currentBehavioralObservation,
    priorBehavioralObservations
  );

  const all = [...prior, currentBehavioralObservation];

  const metricNames = [
    "historyMeanRelativeDelta",
    "historyRange",
    "nearestVsHistoryRatio",
    "nearestAdvantage",
    "absoluteSeparation",
    "relativeSeparation",
    "historyMaxRelativeDelta",
    "historyMinRelativeDelta",
    "relativeNearestAdvantage"
  ];

  const metricPatterns = {};
  const validMetricSampleCounts = {};
  const metricsWithoutComparableHistory = [];

  for (const metricName of metricNames) {
    const direction = directionSummary(all, metricName);
    const trajectory = valueTrajectory(all, metricName);

    metricPatterns[metricName] = {
      direction,
      trajectory
    };

    validMetricSampleCounts[metricName] = trajectory.sampleCount;

    if (direction.comparableObservationCount === 0) {
      metricsWithoutComparableHistory.push(metricName);
    }
  }

  const first = all.length ? validDate(timestampOf(all[0])) : null;
  const currentTime = validDate(timestampOf(currentBehavioralObservation));
  const latestPrior =
    prior.length > 0
      ? validDate(timestampOf(prior[prior.length - 1]))
      : null;

  return {
    behavioralPatternAnalysisVersion:
      HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION,

    identity: {
      evidenceEventId: eventIdOf(currentBehavioralObservation),
      sensorId:
        currentBehavioralObservation.authoritative_sensor_id ||
        currentBehavioralObservation.authoritativeSensorId ||
        null,
      residentId: residentIdOf(currentBehavioralObservation),
      residentName:
        currentBehavioralObservation.authoritative_resident_name ||
        currentBehavioralObservation.authoritativeResidentName ||
        null,
      roomOrLocation: roomOf(currentBehavioralObservation)
    },

    provenance: {
      parentBehavioralObservationVersion:
        parentVersion(currentBehavioralObservation),
      authorityResolutionStatus:
        authorityStatusOf(currentBehavioralObservation),
      assignmentAuthority:
        currentBehavioralObservation.assignment_authority ||
        currentBehavioralObservation.assignmentAuthority ||
        null
    },

    patternHistory: {
      priorPersistedObservationCount: prior.length,
      totalObservationCountIncludingCurrent: all.length,
      historyAvailable: prior.length > 0,
      firstBehavioralObservationAt:
        first ? first.toISOString() : null,
      latestPriorBehavioralObservationAt:
        latestPrior ? latestPrior.toISOString() : null,
      secondsSincePriorBehavioralObservation:
        latestPrior && currentTime
          ? (currentTime.getTime() - latestPrior.getTime()) / 1000
          : null
    },

    cadenceTrajectory: cadenceTrajectory(all),
    metricPatterns,

    dataSufficiency: {
      validMetricSampleCounts,
      metricsWithoutComparableHistory
    },

    descriptiveOnly: true,
    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_BEHAVIORAL_PATTERN_ANALYSIS_VERSION,
  buildHumanPresenceBehavioralPatternAnalysisV1
};
