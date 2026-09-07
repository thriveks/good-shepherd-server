"use strict";

const assert = require("assert");

const {
  buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1,
  daypartForHour
} = require(
  "../../../../../lib/human_presence_episode_profile_temporal_context_analysis_v1"
);

function row({
  id,
  time,
  profileDelta,
  nearestDistance,
  resident = "resident-1",
  room = "room-1"
}) {
  return {
    evidence_event_id: id,

    episode_profile_analysis_version:
      "human_presence_episode_profile_analysis_v1",

    episode_profile_pattern_analysis_version:
      "human_presence_episode_profile_pattern_analysis_v1",

    authoritative_resident_id:
      resident,

    authoritative_room_or_location:
      room,

    authority_resolution_status:
      "resolved_assigned_sensor",

    evidence_received_at:
      time,

    episode_profile_analysis_payload: {
      observerOnly: true,
      profileMeanRelativeDelta:
        profileDelta
    },

    episode_profile_pattern_analysis_payload: {
      observerOnly: true,
      descriptiveOnly: true,

      nearestPriorProfile: {
        nearestPriorProfileDistance:
          nearestDistance
      },

      operationalClassification: null,
      alertLevel: null,
      monitoringAction: null,
      interventionRecommendation: null
    }
  };
}

assert.strictEqual(
  daypartForHour(2),
  "overnight"
);

assert.strictEqual(
  daypartForHour(8),
  "morning"
);

assert.strictEqual(
  daypartForHour(13),
  "afternoon"
);

assert.strictEqual(
  daypartForHour(20),
  "evening"
);

const priorMorning =
  row({
    id: "morning",
    time: "2026-09-06T13:00:00Z",
    profileDelta: 0.20,
    nearestDistance: 0.10
  });

const priorAfternoon =
  row({
    id: "afternoon",
    time: "2026-09-06T18:00:00Z",
    profileDelta: 0.40,
    nearestDistance: 0.25
  });

const crossRoom =
  row({
    id: "cross-room",
    time: "2026-09-06T13:10:00Z",
    profileDelta: 0.99,
    nearestDistance: 0.99,
    room: "other-room"
  });

const current =
  row({
    id: "current",
    time: "2026-09-07T13:15:00Z",
    profileDelta: 0.30,
    nearestDistance: 0.15
  });

const result =
  buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1({
    current,
    prior: [
      priorMorning,
      priorAfternoon,
      crossRoom
    ],
    timeZone: "America/Chicago"
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
  result.temporalContext.daypart,
  "morning"
);

assert.strictEqual(
  result.historyContext.allPriorObservationCount,
  2
);

assert.strictEqual(
  result.historyContext.sameDaypartPriorObservationCount,
  1
);

assert.strictEqual(
  result.profileDeltaContext
    .sameDaypartPrior
    .sampleCount,
  1
);

assert.strictEqual(
  result.nearestProfileDistanceContext
    .sameDaypartPrior
    .sampleCount,
  1
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
  result.interventionRecommendation,
  null
);

console.log(
  "PASS: Temporal Context Analysis v1 deterministic validation"
);

console.log(
  "PASS: same resident/location isolation"
);

console.log(
  "PASS: fixed clock-context segmentation"
);

console.log(
  "PASS: same-daypart history remains descriptive"
);

console.log(
  "PASS: operational boundary preserved"
);
