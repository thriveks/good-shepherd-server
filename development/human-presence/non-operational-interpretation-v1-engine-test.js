"use strict";

const assert =
  require("assert");

const {
  HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION,
  buildHumanPresenceNonOperationalInterpretationV1
} = require(
  "../../lib/human_presence_non_operational_interpretation_v1"
);

const result =
  buildHumanPresenceNonOperationalInterpretationV1({
    evidenceEventId:
      "test-event-1",

    authoritativeResidentId:
      "resident-1",

    authoritativeRoomOrLocation:
      "mmWave prototype",

    candidatePayload: {
      empiricalProfilePosition: {
        percentileRank:
          0.93,

        quartilePosition:
          "at_or_above_p75",

        aboveHistoricalP90:
          true
      },

      nearestProfileRecurrence: {
        nearestPriorProfileDistance:
          0.14,

        nearestPriorEvidenceEventId:
          "prior-event-1",

        comparablePriorProfileCount:
          50
      },

      trajectoryDirection: {
        versusPriorMean:
          "above",

        versusPreviousEpisode:
          "below",

        latestMinusPriorMean:
          0.08,

        latestMinusPrevious:
          -0.03
      },

      topDimensionContributors: [
        {
          dimension:
            "movingEnergyWindowMedianMean",

          current:
            60.2,

          currentVsHistoryMeanRelativeDelta:
            0.51
        },
        {
          dimension:
            "movingDistanceWindowIqrMeanCm",

          current:
            194.7,

          currentVsHistoryMeanRelativeDelta:
            0.49
        },
        {
          dimension:
            "stationaryDistanceWindowIqrMeanCm",

          current:
            190.5,

          currentVsHistoryMeanRelativeDelta:
            0.47
        }
      ],

      temporalContext: {
        daypart:
          "morning"
      }
    }
  });

assert.strictEqual(
  result.nonOperationalInterpretationVersion,
  HUMAN_PRESENCE_NON_OPERATIONAL_INTERPRETATION_VERSION
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
  result.historicalPosition.descriptivePosition,
  "above_historical_p90"
);

assert.strictEqual(
  result.historicalPosition.percentileRank,
  0.93
);

assert.strictEqual(
  result.recurrenceContext.nearestPriorProfileDistance,
  0.14
);

assert.strictEqual(
  result.trajectoryContext.combinedDirection,
  "above_prior_mean__below_previous_episode"
);

assert.strictEqual(
  result.contributorContext.primaryContributor,
  "movingEnergyWindowMedianMean"
);

assert.strictEqual(
  result.temporalContext.daypart,
  "morning"
);

assert(
  result.observationCodes.includes(
    "historical_position:above_historical_p90"
  )
);

assert(
  result.observationCodes.includes(
    "recurrence:nearest_prior_profile_identified"
  )
);

assert(
  result.observationCodes.includes(
    "trajectory:above_prior_mean__below_previous_episode"
  )
);

assert(
  result.observationCodes.includes(
    "primary_contributor:movingEnergyWindowMedianMean"
  )
);

assert(
  result.observationCodes.includes(
    "daypart:morning"
  )
);

const prohibited =
  [
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

/*
 * Null semantics regression.
 */

const missing =
  buildHumanPresenceNonOperationalInterpretationV1({
    evidenceEventId:
      "test-event-null",

    authoritativeResidentId:
      "resident-1",

    authoritativeRoomOrLocation:
      "mmWave prototype",

    candidatePayload: {
      empiricalProfilePosition: {
        percentileRank:
          null,

        quartilePosition:
          null,

        aboveHistoricalP90:
          null
      },

      nearestProfileRecurrence: {
        nearestPriorProfileDistance:
          null
      },

      trajectoryDirection: {
        versusPriorMean:
          null,

        versusPreviousEpisode:
          null
      },

      topDimensionContributors:
        [],

      temporalContext: {
        daypart:
          null
      }
    }
  });

assert.strictEqual(
  missing.historicalPosition.percentileRank,
  null
);

assert.strictEqual(
  missing.historicalPosition.descriptivePosition,
  "unavailable"
);

assert.strictEqual(
  missing.recurrenceContext.nearestPriorProfileDistance,
  null
);

assert.strictEqual(
  missing.recurrenceContext.descriptiveStatus,
  "nearest_prior_profile_unavailable"
);

assert.strictEqual(
  missing.trajectoryContext.combinedDirection,
  "unavailable"
);

assert.deepStrictEqual(
  missing.observationCodes,
  []
);

console.log(
  "NON_OPERATIONAL_INTERPRETATION_V1_ENGINE=PASS"
);
