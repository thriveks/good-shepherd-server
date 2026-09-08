"use strict";

const VERSION =
  "human_presence_longitudinal_interpretation_validation_v1";

const PARENT_VERSION =
  "human_presence_non_operational_interpretation_v1";

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

function sameText(a, b) {
  const x = cleanText(a);
  const y = cleanText(b);

  return (
    x !== null &&
    y !== null &&
    x === y
  );
}

function numericDirection(current, previous) {
  const c = finiteNumber(current);
  const p = finiteNumber(previous);

  if (
    c === null ||
    p === null
  ) {
    return null;
  }

  if (c > p) {
    return "increased";
  }

  if (c < p) {
    return "decreased";
  }

  return "equal";
}

function currentRunLength(
  currentValue,
  priorRows,
  extractor
) {
  const current =
    extractor(currentValue);

  if (
    current === null ||
    current === undefined
  ) {
    return null;
  }

  let run = 1;

  for (
    let i = priorRows.length - 1;
    i >= 0;
    i -= 1
  ) {
    const prior =
      extractor(priorRows[i]);

    if (prior !== current) {
      break;
    }

    run += 1;
  }

  return run;
}

function buildHumanPresenceLongitudinalInterpretationValidationV1({
  current,
  priorRows = []
}) {
  if (!current) {
    throw new Error(
      "current non-operational interpretation required"
    );
  }

  if (!Array.isArray(priorRows)) {
    throw new Error(
      "priorRows must be an array"
    );
  }

  const previous =
    priorRows.length
      ? priorRows[priorRows.length - 1]
      : null;

  const currentPosition =
    cleanText(
      current?.historicalPosition
        ?.descriptivePosition
    );

  const previousPosition =
    cleanText(
      previous?.historicalPosition
        ?.descriptivePosition
    );

  const currentAboveP90 =
    current?.historicalPosition
      ?.aboveHistoricalP90 === true;

  const previousAboveP90 =
    previous?.historicalPosition
      ?.aboveHistoricalP90 === true;

  const currentContributor =
    cleanText(
      current?.contributorContext
        ?.primaryContributor
    );

  const previousContributor =
    cleanText(
      previous?.contributorContext
        ?.primaryContributor
    );

  const currentTrajectory =
    cleanText(
      current?.trajectoryContext
        ?.combinedDirection
    );

  const previousTrajectory =
    cleanText(
      previous?.trajectoryContext
        ?.combinedDirection
    );

  const currentDistance =
    finiteNumber(
      current?.recurrenceContext
        ?.nearestPriorProfileDistance
    );

  const previousDistance =
    finiteNumber(
      previous?.recurrenceContext
        ?.nearestPriorProfileDistance
    );

  const positionRunLength =
    currentRunLength(
      current,
      priorRows,
      row =>
        cleanText(
          row?.historicalPosition
            ?.descriptivePosition
        )
    );

  const aboveP90RunLength =
    currentAboveP90
      ? currentRunLength(
          current,
          priorRows,
          row =>
            row?.historicalPosition
              ?.aboveHistoricalP90 === true
        )
      : 0;

  const contributorRunLength =
    currentContributor
      ? currentRunLength(
          current,
          priorRows,
          row =>
            cleanText(
              row?.contributorContext
                ?.primaryContributor
            )
        )
      : null;

  const trajectoryRunLength =
    currentTrajectory
      ? currentRunLength(
          current,
          priorRows,
          row =>
            cleanText(
              row?.trajectoryContext
                ?.combinedDirection
            )
        )
      : null;

  return {
    longitudinalInterpretationValidationVersion:
      VERSION,

    parentNonOperationalInterpretationVersion:
      PARENT_VERSION,

    evidenceEventId:
      cleanText(
        current.evidenceEventId
      ),

    observerOnly:
      true,

    descriptiveOnly:
      true,

    sequenceContext: {
      priorObservationCount:
        priorRows.length,

      previousEvidenceEventId:
        cleanText(
          previous?.evidenceEventId
        ),

      previousObservationAvailable:
        previous !== null
    },

    historicalPositionSequence: {
      current:
        currentPosition,

      previous:
        previousPosition,

      sameAsPrevious:
        sameText(
          currentPosition,
          previousPosition
        ),

      currentRunLength:
        positionRunLength,

      currentAboveHistoricalP90:
        currentAboveP90,

      previousAboveHistoricalP90:
        previous
          ? previousAboveP90
          : null,

      aboveHistoricalP90RunLength:
        aboveP90RunLength
    },

    contributorSequence: {
      current:
        currentContributor,

      previous:
        previousContributor,

      sameAsPrevious:
        sameText(
          currentContributor,
          previousContributor
        ),

      currentRunLength:
        contributorRunLength
    },

    trajectorySequence: {
      current:
        currentTrajectory,

      previous:
        previousTrajectory,

      sameAsPrevious:
        sameText(
          currentTrajectory,
          previousTrajectory
        ),

      currentRunLength:
        trajectoryRunLength
    },

    recurrenceSequence: {
      currentNearestPriorProfileDistance:
        currentDistance,

      previousNearestPriorProfileDistance:
        previousDistance,

      changeDirection:
        numericDirection(
          currentDistance,
          previousDistance
        ),

      difference:
        (
          currentDistance !== null &&
          previousDistance !== null
        )
          ? currentDistance -
            previousDistance
          : null
    },

    interpretationStatus:
      "DESCRIPTIVE_LONGITUDINAL_OBSERVATION_ONLY",

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
  VERSION,
  PARENT_VERSION,
  finiteNumber,
  cleanText,
  numericDirection,
  currentRunLength,
  buildHumanPresenceLongitudinalInterpretationValidationV1
};
