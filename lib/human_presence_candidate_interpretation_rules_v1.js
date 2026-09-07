"use strict";

const HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION =
  "human_presence_candidate_interpretation_rules_v1";

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  if (!values.length) return null;

  return (
    values.reduce((sum, value) => sum + value, 0) /
    values.length
  );
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (
    sorted[middle - 1] +
    sorted[middle]
  ) / 2;
}

function percentile(sortedValues, fraction) {
  if (!sortedValues.length) return null;

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const position =
    (sortedValues.length - 1) * fraction;

  const lower =
    Math.floor(position);

  const upper =
    Math.ceil(position);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight =
    position - lower;

  return (
    sortedValues[lower] * (1 - weight) +
    sortedValues[upper] * weight
  );
}

function percentileRank(values, current) {
  if (!values.length || current === null) {
    return null;
  }

  let below = 0;
  let equal = 0;

  for (const value of values) {
    if (value < current) {
      below += 1;
    } else if (value === current) {
      equal += 1;
    }
  }

  return (
    (below + (equal * 0.5)) /
    values.length
  );
}

function empiricalDistribution(values) {
  const finite =
    values
      .map(finiteNumber)
      .filter((value) => value !== null)
      .sort((a, b) => a - b);

  return {
    sampleCount: finite.length,
    minimum:
      finite.length ? finite[0] : null,
    p10:
      percentile(finite, 0.10),
    p25:
      percentile(finite, 0.25),
    median:
      percentile(finite, 0.50),
    p75:
      percentile(finite, 0.75),
    p90:
      percentile(finite, 0.90),
    maximum:
      finite.length
        ? finite[finite.length - 1]
        : null,
    mean:
      mean(finite)
  };
}

function empiricalPosition(
  current,
  history
) {
  const currentValue =
    finiteNumber(current);

  const finiteHistory =
    history
      .map(finiteNumber)
      .filter((value) => value !== null)
      .sort((a, b) => a - b);

  const distribution =
    empiricalDistribution(finiteHistory);

  if (
    currentValue === null ||
    finiteHistory.length === 0
  ) {
    return {
      current: currentValue,
      percentileRank: null,
      quartilePosition: null,
      aboveHistoricalP90: null,
      distribution
    };
  }

  let quartilePosition;

  if (currentValue < distribution.p25) {
    quartilePosition = "below_p25";
  } else if (currentValue < distribution.median) {
    quartilePosition = "p25_to_median";
  } else if (currentValue < distribution.p75) {
    quartilePosition = "median_to_p75";
  } else {
    quartilePosition = "at_or_above_p75";
  }

  return {
    current:
      currentValue,

    percentileRank:
      percentileRank(
        finiteHistory,
        currentValue
      ),

    quartilePosition,

    aboveHistoricalP90:
      currentValue >
      distribution.p90,

    distribution
  };
}

function direction(value) {
  const finite =
    finiteNumber(value);

  if (finite === null) {
    return null;
  }

  if (finite > 0) {
    return "above";
  }

  if (finite < 0) {
    return "below";
  }

  return "equal";
}

function extractDimensionContributions(
  profilePayload
) {
  const dimensions =
    profilePayload?.dimensions || {};

  return Object.entries(dimensions)
    .map(([dimension, payload]) => ({
      dimension,
      current:
        finiteNumber(payload?.current),
      currentVsHistoryMeanRelativeDelta:
        finiteNumber(
          payload
            ?.currentVsHistoryMeanRelativeDelta
        )
    }))
    .filter(
      (row) =>
        row.currentVsHistoryMeanRelativeDelta !== null
    )
    .sort(
      (a, b) =>
        b.currentVsHistoryMeanRelativeDelta -
        a.currentVsHistoryMeanRelativeDelta
    );
}

function buildHumanPresenceCandidateInterpretationRulesV1({
  evidenceEventId,
  authoritativeResidentId,
  authoritativeRoomOrLocation,

  profilePayload,
  patternPayload,
  temporalPayload = null,

  historicalProfileDeltas = []
}) {
  if (!evidenceEventId) {
    throw new Error(
      "evidence event id required"
    );
  }

  if (
    !authoritativeResidentId ||
    !authoritativeRoomOrLocation
  ) {
    throw new Error(
      "authoritative resident and room required"
    );
  }

  if (!profilePayload) {
    throw new Error(
      "episode profile analysis payload required"
    );
  }

  if (!patternPayload) {
    throw new Error(
      "episode profile pattern payload required"
    );
  }

  const currentProfileDelta =
    finiteNumber(
      profilePayload.profileMeanRelativeDelta
    );

  const profileDeltaPosition =
    empiricalPosition(
      currentProfileDelta,
      historicalProfileDeltas
    );

  const nearestPriorProfileDistance =
    finiteNumber(
      patternPayload
        ?.nearestPriorProfile
        ?.nearestPriorProfileDistance
    );

  const profileTrajectory =
    patternPayload
      ?.profileDeltaTrajectory ||
    {};

  const dimensionContributions =
    extractDimensionContributions(
      profilePayload
    );

  const temporalContext =
    temporalPayload
      ?.temporalContext ||
    null;

  return {
    candidateInterpretationRulesVersion:
      HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION,

    evidenceEventId,

    authoritativeResidentId,
    authoritativeRoomOrLocation,

    observerOnly: true,
    descriptiveOnly: true,

    empiricalProfilePosition:
      profileDeltaPosition,

    nearestProfileRecurrence: {
      nearestPriorProfileDistance,

      nearestPriorEvidenceEventId:
        patternPayload
          ?.nearestPriorProfile
          ?.nearestPriorEvidenceEventId ||
        null,

      comparablePriorProfileCount:
        finiteNumber(
          patternPayload
            ?.nearestPriorProfile
            ?.comparablePriorProfileCount
        )
    },

    trajectoryDirection: {
      versusPriorMean:
        direction(
          profileTrajectory
            ?.latestMinusPriorMean
        ),

      versusPreviousEpisode:
        direction(
          profileTrajectory
            ?.latestMinusPrevious
        ),

      latestMinusPriorMean:
        finiteNumber(
          profileTrajectory
            ?.latestMinusPriorMean
        ),

      latestMinusPrevious:
        finiteNumber(
          profileTrajectory
            ?.latestMinusPrevious
        )
    },

    dimensionContributionRanking:
      dimensionContributions,

    topDimensionContributors:
      dimensionContributions.slice(0, 3),

    temporalContext: {
      daypart:
        temporalContext?.daypart ||
        null,

      available:
        Boolean(temporalContext)
    },

    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null,

    fallInterpretation: null,
    emergencyInterpretation: null,
    medicalInterpretation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_CANDIDATE_INTERPRETATION_RULES_VERSION,
  empiricalDistribution,
  empiricalPosition,
  extractDimensionContributions,
  buildHumanPresenceCandidateInterpretationRulesV1
};
