"use strict";

const HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION =
  "human_presence_non_operational_interpretation_v1";

const PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION =
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

  return Number.isFinite(n)
    ? n
    : null;
}

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

function booleanOrNull(value) {
  if (value === true) {
    return true;
  }

  if (value === false) {
    return false;
  }

  return null;
}

function buildHistoricalPositionContext(candidatePayload) {
  const empirical =
    candidatePayload?.empiricalProfilePosition || {};

  const percentileRank =
    finiteNumber(
      empirical.percentileRank
    );

  const quartilePosition =
    cleanText(
      empirical.quartilePosition
    );

  const aboveHistoricalP90 =
    booleanOrNull(
      empirical.aboveHistoricalP90
    );

  let descriptivePosition =
    "unavailable";

  if (aboveHistoricalP90 === true) {
    descriptivePosition =
      "above_historical_p90";
  } else if (quartilePosition) {
    descriptivePosition =
      quartilePosition;
  }

  return {
    available:
      percentileRank !== null ||
      quartilePosition !== null ||
      aboveHistoricalP90 !== null,

    percentileRank,
    quartilePosition,
    aboveHistoricalP90,
    descriptivePosition
  };
}

function buildRecurrenceContext(candidatePayload) {
  const recurrence =
    candidatePayload?.nearestProfileRecurrence || {};

  const nearestPriorProfileDistance =
    finiteNumber(
      recurrence.nearestPriorProfileDistance
    );

  const nearestPriorEvidenceEventId =
    cleanText(
      recurrence.nearestPriorEvidenceEventId
    );

  const comparablePriorProfileCount =
    finiteNumber(
      recurrence.comparablePriorProfileCount
    );

  return {
    available:
      nearestPriorProfileDistance !== null,

    nearestPriorProfileDistance,
    nearestPriorEvidenceEventId,
    comparablePriorProfileCount,

    descriptiveStatus:
      nearestPriorProfileDistance !== null
        ? "nearest_prior_profile_identified"
        : "nearest_prior_profile_unavailable"
  };
}

function buildTrajectoryContext(candidatePayload) {
  const trajectory =
    candidatePayload?.trajectoryDirection || {};

  const versusPriorMean =
    cleanText(
      trajectory.versusPriorMean
    );

  const versusPreviousEpisode =
    cleanText(
      trajectory.versusPreviousEpisode
    );

  const latestMinusPriorMean =
    finiteNumber(
      trajectory.latestMinusPriorMean
    );

  const latestMinusPrevious =
    finiteNumber(
      trajectory.latestMinusPrevious
    );

  let combinedDirection =
    "unavailable";

  if (
    versusPriorMean &&
    versusPreviousEpisode
  ) {
    combinedDirection =
      `${versusPriorMean}_prior_mean__${versusPreviousEpisode}_previous_episode`;
  }

  return {
    available:
      versusPriorMean !== null ||
      versusPreviousEpisode !== null,

    versusPriorMean,
    versusPreviousEpisode,
    latestMinusPriorMean,
    latestMinusPrevious,
    combinedDirection
  };
}

function buildContributorContext(candidatePayload) {
  const source =
    Array.isArray(
      candidatePayload?.topDimensionContributors
    )
      ? candidatePayload.topDimensionContributors
      : [];

  const contributors =
    source
      .slice(0, 3)
      .map((entry, index) => ({
        rank:
          index + 1,

        dimension:
          cleanText(
            entry?.dimension
          ),

        current:
          finiteNumber(
            entry?.current
          ),

        currentVsHistoryMeanRelativeDelta:
          finiteNumber(
            entry?.currentVsHistoryMeanRelativeDelta
          )
      }))
      .filter(
        (entry) =>
          entry.dimension !== null
      );

  return {
    available:
      contributors.length > 0,

    contributors,

    primaryContributor:
      contributors.length
        ? contributors[0].dimension
        : null
  };
}

function buildTemporalContext(candidatePayload) {
  const temporal =
    candidatePayload?.temporalContext || {};

  const daypart =
    cleanText(
      temporal.daypart
    );

  return {
    available:
      daypart !== null,

    daypart
  };
}

function buildObservationCodes({
  historicalPosition,
  recurrenceContext,
  trajectoryContext,
  contributorContext,
  temporalContext
}) {
  const codes = [];

  if (
    historicalPosition.descriptivePosition &&
    historicalPosition.descriptivePosition !==
      "unavailable"
  ) {
    codes.push(
      `historical_position:${historicalPosition.descriptivePosition}`
    );
  }

  if (recurrenceContext.available) {
    codes.push(
      "recurrence:nearest_prior_profile_identified"
    );
  }

  if (
    trajectoryContext.combinedDirection !==
      "unavailable"
  ) {
    codes.push(
      `trajectory:${trajectoryContext.combinedDirection}`
    );
  }

  if (
    contributorContext.primaryContributor
  ) {
    codes.push(
      `primary_contributor:${contributorContext.primaryContributor}`
    );
  }

  if (temporalContext.daypart) {
    codes.push(
      `daypart:${temporalContext.daypart}`
    );
  }

  return codes;
}

function buildHumanPresenceNonOperationalInterpretationV1({
  evidenceEventId,
  authoritativeResidentId,
  authoritativeRoomOrLocation,
  candidatePayload
}) {
  if (!candidatePayload) {
    throw new Error(
      "candidate interpretation rules payload required"
    );
  }

  const historicalPosition =
    buildHistoricalPositionContext(
      candidatePayload
    );

  const recurrenceContext =
    buildRecurrenceContext(
      candidatePayload
    );

  const trajectoryContext =
    buildTrajectoryContext(
      candidatePayload
    );

  const contributorContext =
    buildContributorContext(
      candidatePayload
    );

  const temporalContext =
    buildTemporalContext(
      candidatePayload
    );

  const observationCodes =
    buildObservationCodes({
      historicalPosition,
      recurrenceContext,
      trajectoryContext,
      contributorContext,
      temporalContext
    });

  return {
    nonOperationalInterpretationVersion:
      HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,

    parentCandidateInterpretationRulesVersion:
      PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION,

    evidenceEventId:
      cleanText(
        evidenceEventId
      ),

    authoritativeResidentId:
      authoritativeResidentId || null,

    authoritativeRoomOrLocation:
      cleanText(
        authoritativeRoomOrLocation
      ),

    observerOnly:
      true,

    descriptiveOnly:
      true,

    historicalPosition,
    recurrenceContext,
    trajectoryContext,
    contributorContext,
    temporalContext,
    observationCodes,

    /*
     * HARD SAFETY BOUNDARY
     *
     * This layer describes evidence only.
     *
     * It does NOT infer:
     * - abnormality
     * - danger
     * - deterioration
     * - fall
     * - emergency
     * - medical condition
     * - caregiver need
     * - monitoring-center action
     */

    operationalClassification:
      null,

    anomalyClassification:
      null,

    riskClassification:
      null,

    severityClassification:
      null,

    alertLevel:
      null,

    monitoringAction:
      null,

    interventionRecommendation:
      null,

    caregiverRecommendation:
      null,

    fallInterpretation:
      null,

    emergencyInterpretation:
      null,

    medicalInterpretation:
      null
  };
}

module.exports = {
  HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,
  PARENT_CANDIDATE_INTERPRETATION_RULES_VERSION,

  buildHistoricalPositionContext,
  buildRecurrenceContext,
  buildTrajectoryContext,
  buildContributorContext,
  buildTemporalContext,
  buildObservationCodes,

  buildHumanPresenceNonOperationalInterpretationV1
};
