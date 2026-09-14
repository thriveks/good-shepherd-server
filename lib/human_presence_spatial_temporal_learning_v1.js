"use strict";

const VERSION =
  "human_presence_spatial_temporal_learning_v1";

const SOURCE_STATE_VERSION =
  "human_presence_spatial_state_learning_v1";

function requireObservation(observation) {
  if (
    !observation ||
    typeof observation.evidenceEventId !== "string" ||
    typeof observation.stateId !== "string" ||
    !observation.evidenceReceivedAt
  ) {
    throw new Error(
      "valid spatial-state observation required"
    );
  }

  const timestamp =
    new Date(
      observation.evidenceReceivedAt
    ).getTime();

  if (!Number.isFinite(timestamp)) {
    throw new Error(
      "valid evidence timestamp required"
    );
  }

  return {
    evidenceEventId:
      observation.evidenceEventId,

    stateId:
      observation.stateId,

    evidenceReceivedAt:
      new Date(timestamp).toISOString(),

    timestamp
  };
}

function sortObservations(observations) {
  if (!Array.isArray(observations)) {
    throw new Error(
      "spatial-state observations required"
    );
  }

  return observations
    .map(requireObservation)
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }

      return left.evidenceEventId.localeCompare(
        right.evidenceEventId
      );
    });
}

function buildStateSummaries(ordered) {
  const stateMap = new Map();

  for (const observation of ordered) {
    let state =
      stateMap.get(
        observation.stateId
      );

    if (!state) {
      state = {
        stateId:
          observation.stateId,

        observationCount: 0,

        firstObservedAt:
          observation.evidenceReceivedAt,

        lastObservedAt:
          observation.evidenceReceivedAt,

        runCount: 0,

        longestRunObservations: 0
      };

      stateMap.set(
        observation.stateId,
        state
      );
    }

    state.observationCount += 1;

    if (
      observation.timestamp <
      new Date(
        state.firstObservedAt
      ).getTime()
    ) {
      state.firstObservedAt =
        observation.evidenceReceivedAt;
    }

    if (
      observation.timestamp >
      new Date(
        state.lastObservedAt
      ).getTime()
    ) {
      state.lastObservedAt =
        observation.evidenceReceivedAt;
    }
  }

  let currentRunState = null;
  let currentRunLength = 0;

  function finishRun() {
    if (
      currentRunState === null ||
      currentRunLength === 0
    ) {
      return;
    }

    const state =
      stateMap.get(
        currentRunState
      );

    state.runCount += 1;

    state.longestRunObservations =
      Math.max(
        state.longestRunObservations,
        currentRunLength
      );
  }

  for (const observation of ordered) {
    if (
      observation.stateId ===
      currentRunState
    ) {
      currentRunLength += 1;
      continue;
    }

    finishRun();

    currentRunState =
      observation.stateId;

    currentRunLength = 1;
  }

  finishRun();

  const total =
    ordered.length;

  return Array.from(
    stateMap.values()
  )
    .map((state) => ({
      ...state,

      observationShare:
        total > 0
          ? Math.round(
              (
                state.observationCount /
                total
              ) * 10000
            ) / 10000
          : 0
    }))
    .sort(
      (left, right) =>
        left.stateId.localeCompare(
          right.stateId
        )
    );
}

function buildTransitions(ordered) {
  const transitions =
    new Map();

  let orderingAmbiguousPairCount = 0;
  let sameStateAdjacentPairCount = 0;
  let transitionPairCount = 0;

  for (
    let index = 1;
    index < ordered.length;
    index += 1
  ) {
    const previous =
      ordered[index - 1];

    const current =
      ordered[index];

    /*
     * Equal evidence timestamps do not provide
     * enough evidence to claim temporal order.
     */
    if (
      previous.timestamp ===
      current.timestamp
    ) {
      orderingAmbiguousPairCount += 1;
      continue;
    }

    if (
      previous.stateId ===
      current.stateId
    ) {
      sameStateAdjacentPairCount += 1;
      continue;
    }

    transitionPairCount += 1;

    const key =
      `${previous.stateId}->${current.stateId}`;

    const existing =
      transitions.get(key) || {
        fromStateId:
          previous.stateId,

        toStateId:
          current.stateId,

        count: 0,

        firstObservedAt:
          current.evidenceReceivedAt,

        lastObservedAt:
          current.evidenceReceivedAt
      };

    existing.count += 1;

    if (
      current.timestamp <
      new Date(
        existing.firstObservedAt
      ).getTime()
    ) {
      existing.firstObservedAt =
        current.evidenceReceivedAt;
    }

    if (
      current.timestamp >
      new Date(
        existing.lastObservedAt
      ).getTime()
    ) {
      existing.lastObservedAt =
        current.evidenceReceivedAt;
    }

    transitions.set(
      key,
      existing
    );
  }

  return {
    transitionPairCount,
    sameStateAdjacentPairCount,
    orderingAmbiguousPairCount,

    transitions:
      Array.from(
        transitions.values()
      )
        .map((transition) => ({
          ...transition,

          shareOfTransitions:
            transitionPairCount > 0
              ? Math.round(
                  (
                    transition.count /
                    transitionPairCount
                  ) * 10000
                ) / 10000
              : 0
        }))
        .sort((left, right) => {
          const fromCompare =
            left.fromStateId.localeCompare(
              right.fromStateId
            );

          if (fromCompare !== 0) {
            return fromCompare;
          }

          return left.toStateId.localeCompare(
            right.toStateId
          );
        })
  };
}

function currentRunContext(ordered) {
  if (ordered.length === 0) {
    return null;
  }

  const current =
    ordered[
      ordered.length - 1
    ];

  let runLength = 1;

  for (
    let index =
      ordered.length - 2;
    index >= 0;
    index -= 1
  ) {
    if (
      ordered[index].stateId !==
      current.stateId
    ) {
      break;
    }

    runLength += 1;
  }

  let previousDifferentState = null;

  for (
    let index =
      ordered.length - 2;
    index >= 0;
    index -= 1
  ) {
    if (
      ordered[index].stateId !==
      current.stateId
    ) {
      previousDifferentState =
        ordered[index].stateId;
      break;
    }
  }

  return {
    currentStateId:
      current.stateId,

    currentEvidenceEventId:
      current.evidenceEventId,

    currentObservedAt:
      current.evidenceReceivedAt,

    consecutiveObservationCount:
      runLength,

    previousDifferentStateId:
      previousDifferentState
  };
}

function buildSpatialTemporalLearningV1(
  observations
) {
  const ordered =
    sortObservations(
      observations
    );

  const states =
    buildStateSummaries(
      ordered
    );

  const transitions =
    buildTransitions(
      ordered
    );

  return {
    version:
      VERSION,

    sourceStateLearningVersion:
      SOURCE_STATE_VERSION,

    observerOnly: true,
    developmentOnly: true,

    observationCount:
      ordered.length,

    uniqueStateCount:
      states.length,

    states,

    transitions,

    currentContext:
      currentRunContext(
        ordered
      ),

    interpretationBoundary: {
      anonymousSpatialStatesOnly: true,
      roomZoneAssigned: false,
      postureClassification: false,
      activityClassification: false,
      medicalInference: false,
      fallDetection: false,
      operationalAlert: false
    }
  };
}

module.exports = {
  VERSION,
  SOURCE_STATE_VERSION,
  buildSpatialTemporalLearningV1
};
