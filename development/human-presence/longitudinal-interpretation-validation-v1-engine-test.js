"use strict";

const assert =
  require("assert");

const {
  buildHumanPresenceLongitudinalInterpretationValidationV1
} = require(
  "../../lib/human_presence_longitudinal_interpretation_validation_v1"
);

function row({
  id,
  position,
  aboveP90,
  contributor,
  trajectory,
  distance
}) {
  return {
    evidenceEventId:
      id,

    historicalPosition: {
      descriptivePosition:
        position,

      aboveHistoricalP90:
        aboveP90
    },

    contributorContext: {
      primaryContributor:
        contributor
    },

    trajectoryContext: {
      combinedDirection:
        trajectory
    },

    recurrenceContext: {
      nearestPriorProfileDistance:
        distance
    }
  };
}

const priorRows = [
  row({
    id: "e1",
    position: "median_to_p75",
    aboveP90: false,
    contributor: "movingEnergyWindowMedianMean",
    trajectory: "above_prior_mean__above_previous_episode",
    distance: 0.18
  }),

  row({
    id: "e2",
    position: "above_historical_p90",
    aboveP90: true,
    contributor: "movingEnergyWindowMedianMean",
    trajectory: "above_prior_mean__above_previous_episode",
    distance: 0.22
  }),

  row({
    id: "e3",
    position: "above_historical_p90",
    aboveP90: true,
    contributor: "movingEnergyWindowMedianMean",
    trajectory: "above_prior_mean__above_previous_episode",
    distance: 0.25
  })
];

const current =
  row({
    id: "e4",
    position: "above_historical_p90",
    aboveP90: true,
    contributor: "movingEnergyWindowMedianMean",
    trajectory: "above_prior_mean__above_previous_episode",
    distance: 0.31
  });

const result =
  buildHumanPresenceLongitudinalInterpretationValidationV1({
    current,
    priorRows
  });

assert.strictEqual(
  result.observerOnly,
  true
);

assert.strictEqual(
  result.descriptiveOnly,
  true
);

assert.strictEqual(
  result.sequenceContext.priorObservationCount,
  3
);

assert.strictEqual(
  result.sequenceContext.previousEvidenceEventId,
  "e3"
);

assert.strictEqual(
  result.historicalPositionSequence.currentRunLength,
  3
);

assert.strictEqual(
  result.historicalPositionSequence.aboveHistoricalP90RunLength,
  3
);

assert.strictEqual(
  result.contributorSequence.currentRunLength,
  4
);

assert.strictEqual(
  result.trajectorySequence.currentRunLength,
  4
);

assert.strictEqual(
  result.recurrenceSequence.changeDirection,
  "increased"
);

assert(
  Math.abs(
    result.recurrenceSequence.difference -
    0.06
  ) < 1e-12
);

const prohibited = [
  "operationalClassification",
  "anomalyClassification",
  "riskClassification",
  "severityClassification",
  "alertLevel",
  "monitoringAction",
  "interventionRecommendation",
  "caregiverRecommendation",
  "fallInterpretation",
  "emergencyInterpretation",
  "medicalInterpretation"
];

for (const key of prohibited) {
  assert.strictEqual(
    result[key],
    null,
    `${key} must remain null`
  );
}

const first =
  buildHumanPresenceLongitudinalInterpretationValidationV1({
    current:
      row({
        id: "first",
        position: "below_p25",
        aboveP90: false,
        contributor: "transitionsMean",
        trajectory: "below_prior_mean__below_previous_episode",
        distance: null
      }),

    priorRows:
      []
  });

assert.strictEqual(
  first.sequenceContext.previousObservationAvailable,
  false
);

assert.strictEqual(
  first.sequenceContext.priorObservationCount,
  0
);

assert.strictEqual(
  first.historicalPositionSequence.currentRunLength,
  1
);

assert.strictEqual(
  first.historicalPositionSequence.aboveHistoricalP90RunLength,
  0
);

assert.strictEqual(
  first.recurrenceSequence.changeDirection,
  null
);

console.log(
  "LONGITUDINAL_INTERPRETATION_VALIDATION_V1_ENGINE=PASS"
);
