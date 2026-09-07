"use strict";

const assert = require("assert");

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION,
  buildHumanPresenceEpisodeProfilePatternAnalysisV1,
  profileDistance
} = require(
  "../../../../../lib/human_presence_episode_profile_pattern_analysis_v1"
);

const DIMENSIONS = [
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
];

function row({
  id,
  time,
  resident = "resident-1",
  room = "room-1",
  base = 10,
  profileDelta = 0.2
}) {
  const dimensions = {};

  DIMENSIONS.forEach((name, index) => {
    dimensions[name] = {
      current: base + index,
      historyCount: 50,
      historyMin: base + index - 1,
      historyMax: base + index + 1,
      historyMean: base + index - 0.5,
      historyMedian: base + index - 0.5,
      historyRange: 2,
      currentVsHistoryMeanRelativeDelta:
        0.1 + index / 100
    };
  });

  return {
    evidence_event_id: id,
    episode_profile_analysis_version:
      "human_presence_episode_profile_analysis_v1",
    authoritative_resident_id: resident,
    authoritative_room_or_location: room,
    authority_resolution_status:
      "resolved_assigned_sensor",
    evidence_received_at: time,
    episode_profile_analysis_payload: {
      episodeProfileAnalysisVersion:
        "human_presence_episode_profile_analysis_v1",
      observerOnly: true,
      dimensionCount: 12,
      profileMeanRelativeDelta: profileDelta,
      dimensions
    }
  };
}

const prior1 = row({
  id: "e1",
  time: "2026-09-07T10:00:00Z",
  base: 10,
  profileDelta: 0.2
});

const prior2 = row({
  id: "e2",
  time: "2026-09-07T10:10:00Z",
  base: 12,
  profileDelta: 0.3
});

const current = row({
  id: "e3",
  time: "2026-09-07T10:20:00Z",
  base: 13,
  profileDelta: 0.4
});

const crossResident = row({
  id: "bad-resident",
  time: "2026-09-07T10:15:00Z",
  resident: "resident-2",
  base: 13
});

const crossRoom = row({
  id: "bad-room",
  time: "2026-09-07T10:16:00Z",
  room: "room-2",
  base: 13
});

const result =
  buildHumanPresenceEpisodeProfilePatternAnalysisV1({
    currentEpisodeProfileAnalysis: current,
    priorEpisodeProfileAnalyses: [
      prior1,
      crossResident,
      prior2,
      crossRoom
    ]
  });

assert.strictEqual(
  result.episodeProfilePatternAnalysisVersion,
  HUMAN_PRESENCE_EPISODE_PROFILE_PATTERN_ANALYSIS_VERSION
);

assert.strictEqual(result.observerOnly, true);
assert.strictEqual(result.descriptiveOnly, true);
assert.strictEqual(result.operationalClassification, null);
assert.strictEqual(result.alertLevel, null);
assert.strictEqual(result.monitoringAction, null);
assert.strictEqual(result.interventionRecommendation, null);

assert.strictEqual(
  result.observationContinuity.priorObservationCount,
  2
);

assert.strictEqual(
  result.observationContinuity.totalObservationCount,
  3
);

assert.strictEqual(
  result.observationContinuity.secondsSincePriorObservation,
  600
);

assert.strictEqual(
  result.profileDeltaTrajectory.sampleCount,
  3
);

assert.strictEqual(
  result.profileDeltaTrajectory.firstValue,
  0.2
);

assert.strictEqual(
  result.profileDeltaTrajectory.latestValue,
  0.4
);

assert.strictEqual(
  result.dimensionPatterns.movingPctMean
    .currentValueTrajectory.sampleCount,
  3
);

assert.strictEqual(
  result.nearestPriorProfile
    .comparablePriorProfileCount,
  2
);

assert.strictEqual(
  result.nearestPriorProfile
    .nearestPriorEvidenceEventId,
  "e2"
);

assert(
  result.nearestPriorProfile
    .nearestPriorProfileDistance >= 0
);

assert.strictEqual(
  profileDistance(
    Object.fromEntries(
      DIMENSIONS.map((name, index) => [
        name,
        10 + index
      ])
    ),
    Object.fromEntries(
      DIMENSIONS.map((name, index) => [
        name,
        10 + index
      ])
    )
  ),
  0
);

const zeroHistory =
  buildHumanPresenceEpisodeProfilePatternAnalysisV1({
    currentEpisodeProfileAnalysis: current,
    priorEpisodeProfileAnalyses: []
  });

assert.strictEqual(
  zeroHistory.observationContinuity.priorObservationCount,
  0
);

assert.strictEqual(
  zeroHistory.nearestPriorProfile
    .nearestPriorProfileDistance,
  null
);

const contaminatedParent = JSON.parse(
  JSON.stringify(current)
);

contaminatedParent
  .episode_profile_analysis_payload
  .alertLevel = "critical";

assert.throws(
  () =>
    buildHumanPresenceEpisodeProfilePatternAnalysisV1({
      currentEpisodeProfileAnalysis:
        contaminatedParent
    }),
  /operational contamination/
);

const missingDimension = JSON.parse(
  JSON.stringify(current)
);

delete missingDimension
  .episode_profile_analysis_payload
  .dimensions
  .movingPctMean;

assert.throws(
  () =>
    buildHumanPresenceEpisodeProfilePatternAnalysisV1({
      currentEpisodeProfileAnalysis:
        missingDimension
    }),
  /missing finite current episode profile dimension/
);

console.log(
  "PASS: Episode Profile Pattern Analysis v1 deterministic validation"
);
console.log(
  "PASS: resident/location contamination rejected"
);
console.log(
  "PASS: zero-history behavior deterministic"
);
console.log(
  "PASS: operational contamination rejected"
);
console.log(
  "PASS: all 12 physical dimensions required"
);
console.log(
  "PASS: nearest prior profile remains descriptive mathematical similarity"
);
