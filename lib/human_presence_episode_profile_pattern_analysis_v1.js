"use strict";

const VERSION =
  "human_presence_episode_profile_pattern_analysis_v1";

const PARENT_VERSION =
  "human_presence_episode_profile_analysis_v1";

const DIMENSIONS = Object.freeze([
  "movingPctMean",
  "stationaryPctMean",
  "target2PctMean",
  "target3PctMean",
  "transitionsMean",
  "movingDistanceWindowMedianMeanCm",
  "movingDistanceWindowIqrMeanCm",
  "stationaryDistanceWindowMedianMeanCm",
  "stationaryDistanceWindowIqrMeanCm",
  "detectionDistanceWindowMedianMeanCm",
  "movingEnergyWindowMedianMean",
  "stationaryEnergyWindowMedianMean"
]);

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

function validDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function relativeDistance(a, b) {
  const denominator =
    Math.max(Math.abs(a), Math.abs(b), 0.00001);

  return Math.abs(a - b) / denominator;
}

function payloadOf(row) {
  return (
    row?.episode_profile_analysis_payload ||
    row?.episodeProfileAnalysisPayload ||
    {}
  );
}

function eventIdOf(row) {
  return row?.evidence_event_id || row?.evidenceEventId || null;
}

function residentIdOf(row) {
  return (
    row?.authoritative_resident_id ||
    row?.authoritativeResidentId ||
    null
  );
}

function roomOf(row) {
  return (
    row?.authoritative_room_or_location ||
    row?.authoritativeRoomOrLocation ||
    null
  );
}

function authorityStatusOf(row) {
  return (
    row?.authority_resolution_status ||
    row?.authorityResolutionStatus ||
    null
  );
}

function parentVersionOf(row) {
  return (
    row?.episode_profile_analysis_version ||
    row?.episodeProfileAnalysisVersion ||
    payloadOf(row)?.episodeProfileAnalysisVersion ||
    null
  );
}

function timestampOf(row) {
  return (
    row?.evidence_received_at ||
    row?.evidenceReceivedAt ||
    payloadOf(row)?.evidenceReceivedAt ||
    null
  );
}

function extractPhysicalProfile(row) {
  const payload = payloadOf(row);
  const profile = {};

  for (const dimension of DIMENSIONS) {
    const value =
      finiteNumber(payload?.dimensions?.[dimension]?.current);

    if (value === null) {
      throw new Error(
        `missing finite current episode profile dimension: ${dimension}`
      );
    }

    profile[dimension] = value;
  }

  return profile;
}

function validateParent(row) {
  if (!row) {
    throw new Error("episode profile analysis row required");
  }

  if (parentVersionOf(row) !== PARENT_VERSION) {
    throw new Error("unsupported episode profile analysis parent version");
  }

  if (!eventIdOf(row)) {
    throw new Error("evidence event id required");
  }

  if (!residentIdOf(row) || !roomOf(row)) {
    throw new Error("authoritative resident and room required");
  }

  if (
    authorityStatusOf(row) !==
    "resolved_assigned_sensor"
  ) {
    throw new Error(
      "resolved assigned sensor authority required"
    );
  }

  const timestamp = validDate(timestampOf(row));

  if (!timestamp) {
    throw new Error("valid evidence timestamp required");
  }

  const payload = payloadOf(row);

  if (payload.observerOnly !== true) {
    throw new Error(
      "parent episode profile analysis must be observer only"
    );
  }

  if (
    finiteNumber(payload.dimensionCount) !==
    DIMENSIONS.length
  ) {
    throw new Error("parent dimension count must equal 12");
  }

  const forbidden = [
    "operationalClassification",
    "alertLevel",
    "monitoringAction",
    "interventionRecommendation"
  ];

  for (const key of forbidden) {
    if (
      payload[key] !== null &&
      payload[key] !== undefined
    ) {
      throw new Error(
        `parent operational contamination: ${key}`
      );
    }
  }

  extractPhysicalProfile(row);
}

function normalizeHistory(current, priorRows) {
  validateParent(current);

  const residentId = residentIdOf(current);
  const room = roomOf(current);
  const currentTime =
    validDate(timestampOf(current)).getTime();

  return (Array.isArray(priorRows) ? priorRows : [])
    .filter((row) => {
      try {
        validateParent(row);
      } catch {
        return false;
      }

      if (
        residentIdOf(row) !== residentId ||
        roomOf(row) !== room
      ) {
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

function trajectory(values) {
  const finite = values
    .map(finiteNumber)
    .filter((value) => value !== null);

  const latest =
    finite.length ? finite[finite.length - 1] : null;

  const previous =
    finite.length >= 2
      ? finite[finite.length - 2]
      : null;

  const prior =
    finite.length >= 2
      ? finite.slice(0, finite.length - 1)
      : [];

  const priorMean = mean(prior);

  return {
    sampleCount: finite.length,
    firstValue: finite.length ? finite[0] : null,
    latestValue: latest,
    minimum: finite.length ? Math.min(...finite) : null,
    maximum: finite.length ? Math.max(...finite) : null,
    mean: mean(finite),
    median: median(finite),
    latestMinusPrevious:
      latest !== null && previous !== null
        ? latest - previous
        : null,
    latestMinusPriorMean:
      latest !== null && priorMean !== null
        ? latest - priorMean
        : null
  };
}

function profileDistance(profileA, profileB) {
  const distances = DIMENSIONS.map((dimension) =>
    relativeDistance(
      profileA[dimension],
      profileB[dimension]
    )
  );

  return mean(distances);
}

function nearestPriorProfile(current, prior) {
  if (!prior.length) {
    return {
      comparablePriorProfileCount: 0,
      nearestPriorEvidenceEventId: null,
      nearestPriorEvidenceReceivedAt: null,
      nearestPriorProfileDistance: null
    };
  }

  const currentProfile = extractPhysicalProfile(current);

  const comparable = prior.map((row) => ({
    row,
    distance: profileDistance(
      currentProfile,
      extractPhysicalProfile(row)
    )
  }));

  comparable.sort((a, b) => a.distance - b.distance);

  const nearest = comparable[0];

  return {
    comparablePriorProfileCount: comparable.length,
    nearestPriorEvidenceEventId:
      eventIdOf(nearest.row),
    nearestPriorEvidenceReceivedAt:
      validDate(timestampOf(nearest.row)).toISOString(),
    nearestPriorProfileDistance:
      nearest.distance
  };
}

function buildHumanPresenceEpisodeProfilePatternAnalysisV1({
  currentEpisodeProfileAnalysis,
  priorEpisodeProfileAnalyses = []
}) {
  validateParent(currentEpisodeProfileAnalysis);

  const prior = normalizeHistory(
    currentEpisodeProfileAnalysis,
    priorEpisodeProfileAnalyses
  );

  const all = [
    ...prior,
    currentEpisodeProfileAnalysis
  ];

  const profileDeltaTrajectory = trajectory(
    all.map((row) =>
      payloadOf(row)?.profileMeanRelativeDelta
    )
  );

  const dimensionPatterns = {};

  for (const dimension of DIMENSIONS) {
    dimensionPatterns[dimension] = {
      currentValueTrajectory: trajectory(
        all.map(
          (row) =>
            payloadOf(row)
              ?.dimensions
              ?.[dimension]
              ?.current
        )
      ),

      relativeDeltaTrajectory: trajectory(
        all.map(
          (row) =>
            payloadOf(row)
              ?.dimensions
              ?.[dimension]
              ?.currentVsHistoryMeanRelativeDelta
        )
      )
    };
  }

  const currentAt =
    validDate(
      timestampOf(currentEpisodeProfileAnalysis)
    );

  const latestPrior =
    prior.length ? prior[prior.length - 1] : null;

  const latestPriorAt =
    latestPrior
      ? validDate(timestampOf(latestPrior))
      : null;

  const firstAt =
    prior.length
      ? validDate(timestampOf(prior[0]))
      : currentAt;

  return {
    episodeProfilePatternAnalysisVersion: VERSION,
    parentEpisodeProfileAnalysisVersion:
      PARENT_VERSION,

    evidenceEventId:
      eventIdOf(currentEpisodeProfileAnalysis),

    observerOnly: true,
    descriptiveOnly: true,

    authoritativeResidentId:
      residentIdOf(currentEpisodeProfileAnalysis),

    authoritativeRoomOrLocation:
      roomOf(currentEpisodeProfileAnalysis),

    dimensionCount: DIMENSIONS.length,

    profileDeltaTrajectory,
    dimensionPatterns,

    nearestPriorProfile:
      nearestPriorProfile(
        currentEpisodeProfileAnalysis,
        prior
      ),

    observationContinuity: {
      priorObservationCount: prior.length,
      totalObservationCount: prior.length + 1,
      firstObservationAt:
        firstAt ? firstAt.toISOString() : null,
      latestPriorObservationAt:
        latestPriorAt
          ? latestPriorAt.toISOString()
          : null,
      currentObservationAt:
        currentAt.toISOString(),
      secondsSincePriorObservation:
        latestPriorAt
          ? (
              currentAt.getTime() -
              latestPriorAt.getTime()
            ) / 1000
          : null
    },

    dataSufficiency: {
      hasPriorHistory: prior.length > 0,
      priorObservationCount: prior.length
    },

    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION:
    VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_PARENT_VERSION:
    PARENT_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_DIMENSIONS:
    DIMENSIONS,
  buildHumanPresenceEpisodeProfilePatternAnalysisV1,
  extractPhysicalProfile,
  normalizeHistory,
  profileDistance,
  relativeDistance,
  trajectory
};
