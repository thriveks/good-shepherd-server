"use strict";

const assert =
  require("assert");

const {
  buildHumanPresenceCandidateInterpretationRulesV1
} = require(
  "../../lib/human_presence_candidate_interpretation_rules_v1"
);

/*
 * Missing profile values must remain missing.
 * JavaScript Number(null) === 0, so this is an explicit
 * regression gate against accidental zero coercion.
 */
const missingProfileResult =
  buildHumanPresenceCandidateInterpretationRulesV1({
    evidenceEventId:
      "candidate-rule-null-profile-test",

    authoritativeResidentId:
      "resident-1",

    authoritativeRoomOrLocation:
      "room-1",

    historicalProfileDeltas: [
      0.2,
      0.3,
      0.4
    ],

    profilePayload: {
      profileMeanRelativeDelta:
        null,

      dimensions: {}
    },

    patternPayload: {
      nearestPriorProfile: {},
      profileDeltaTrajectory: {}
    }
  });

assert.strictEqual(
  missingProfileResult
    .empiricalProfilePosition
    .current,
  null
);

assert.strictEqual(
  missingProfileResult
    .empiricalProfilePosition
    .percentileRank,
  null
);

const result =
  buildHumanPresenceCandidateInterpretationRulesV1({
    evidenceEventId:
      "candidate-rule-test-1",

    authoritativeResidentId:
      "resident-1",

    authoritativeRoomOrLocation:
      "room-1",

    historicalProfileDeltas: [
      0.20,
      0.25,
      0.30,
      0.35,
      0.40,
      0.45,
      0.50,
      0.55
    ],

    profilePayload: {
      profileMeanRelativeDelta:
        0.52,

      dimensions: {
        movingPctMean: {
          current: 60,
          currentVsHistoryMeanRelativeDelta:
            0.35
        },

        transitionsMean: {
          current: 9,
          currentVsHistoryMeanRelativeDelta:
            0.60
        },

        detectionDistanceWindowMedianMeanCm: {
          current: 85,
          currentVsHistoryMeanRelativeDelta:
            0
        }
      }
    },

    patternPayload: {
      nearestPriorProfile: {
        comparablePriorProfileCount:
          50,

        nearestPriorProfileDistance:
          0.14,

        nearestPriorEvidenceEventId:
          "prior-1"
      },

      profileDeltaTrajectory: {
        latestMinusPriorMean:
          0.08,

        latestMinusPrevious:
          -0.03
      }
    },

    temporalPayload: {
      temporalContext: {
        daypart:
          "afternoon"
      }
    }
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
  result.operationalClassification,
  null
);

assert.strictEqual(
  result.alertLevel,
  null
);

assert.strictEqual(
  result.monitoringAction,
  null
);

assert.strictEqual(
  result.fallInterpretation,
  null
);

assert.strictEqual(
  result.emergencyInterpretation,
  null
);

assert.strictEqual(
  result.trajectoryDirection
    .versusPriorMean,
  "above"
);

assert.strictEqual(
  result.trajectoryDirection
    .versusPreviousEpisode,
  "below"
);

assert.strictEqual(
  result.topDimensionContributors[0]
    .dimension,
  "transitionsMean"
);

assert.strictEqual(
  result.temporalContext.daypart,
  "afternoon"
);

console.log(
  "CANDIDATE_INTERPRETATION_RULES_V1_ENGINE=PASS"
);
