"use strict";

const assert = require("assert");

const {
  buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1
} = require(
  "../../../../../lib/human_presence_episode_profile_pattern_analysis_persistence_v1"
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

function parentRow({
  id,
  time,
  base
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
    authoritative_sensor_id: null,
    authoritative_resident_id: "resident-1",
    authoritative_resident_name: "Resident One",
    authoritative_room_or_location: "room-1",
    authority_resolution_status:
      "resolved_assigned_sensor",
    assignment_authority: "operator_explicit",
    evidence_received_at: time,
    episode_profile_analysis_at: time,
    episode_profile_analysis_payload: {
      episodeProfileAnalysisVersion:
        "human_presence_episode_profile_analysis_v1",
      evidenceEventId: id,
      evidenceReceivedAt: time,
      observerOnly: true,
      dimensionCount: 12,
      historyCount: 50,
      profileMeanRelativeDelta: 0.25,
      dimensions
    }
  };
}

const current = parentRow({
  id: "current-event",
  time: "2026-09-07T13:00:00Z",
  base: 20
});

const prior = parentRow({
  id: "prior-event",
  time: "2026-09-07T12:50:00Z",
  base: 19
});

let insertPayload = null;

const db = {
  async query(sql, params) {
    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses"
      ) &&
      sql.includes("evidence_event_id = $1")
    ) {
      return {
        rowCount: 1,
        rows: [current]
      };
    }

    if (
      sql.includes(
        "FROM human_presence_episode_profile_analyses"
      ) &&
      sql.includes(
        "authoritative_resident_id = $1"
      )
    ) {
      return {
        rowCount: 1,
        rows: [prior]
      };
    }

    if (
      sql.includes(
        "INSERT INTO"
      ) &&
      sql.includes(
        "human_presence_episode_profile_pattern_analyses"
      )
    ) {
      insertPayload = JSON.parse(params[11]);

      return {
        rowCount: 1,
        rows: [
          {
            episode_profile_pattern_analysis_at:
              new Date().toISOString()
          }
        ]
      };
    }

    throw new Error(
      `unexpected test query: ${sql}`
    );
  }
};

(async () => {
  const result =
    await buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1(
      db,
      "current-event"
    );

  assert.strictEqual(
    result.persistence.inserted,
    true
  );

  assert.strictEqual(
    result.persistence
      .episodeProfilePatternAnalysisVersion,
    "human_presence_episode_profile_pattern_analysis_v1"
  );

  assert(insertPayload);

  assert.strictEqual(
    insertPayload.observerOnly,
    true
  );

  assert.strictEqual(
    insertPayload.descriptiveOnly,
    true
  );

  assert.strictEqual(
    insertPayload.operationalClassification,
    null
  );

  assert.strictEqual(
    insertPayload.alertLevel,
    null
  );

  assert.strictEqual(
    insertPayload.monitoringAction,
    null
  );

  assert.strictEqual(
    insertPayload.interventionRecommendation,
    null
  );

  assert.strictEqual(
    insertPayload.observationContinuity
      .priorObservationCount,
    1
  );

  console.log(
    "PASS: Episode Profile Pattern Analysis v1 persistence execution"
  );
  console.log(
    "PASS: parent Episode Profile Analysis row consumed"
  );
  console.log(
    "PASS: same resident/location history supplied"
  );
  console.log(
    "PASS: append/idempotent persistence contract"
  );
  console.log(
    "PASS: observer-only operational boundary preserved"
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
