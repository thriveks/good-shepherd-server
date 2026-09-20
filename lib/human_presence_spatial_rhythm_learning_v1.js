"use strict";

const VERSION =
  "human_presence_spatial_rhythm_learning_v1";

const SOURCE_STATE_VERSION =
  "human_presence_spatial_state_learning_v1";

/*
 * V1 intentionally uses UTC hour/day buckets.
 *
 * This keeps the evidence model deterministic and avoids
 * silently assuming a resident timezone that is not yet
 * explicitly attached to this evidence stream.
 *
 * A future resident-aware presentation layer may translate
 * these buckets into local time.
 */

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

  const date =
    new Date(
      observation.evidenceReceivedAt
    );

  const timestamp =
    date.getTime();

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
      date.toISOString(),

    timestamp,

    utcHour:
      date.getUTCHours(),

    utcDayOfWeek:
      date.getUTCDay(),

    utcDate:
      date.toISOString().slice(0, 10)
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

function emptyHistogram(length) {
  return Array.from(
    { length },
    () => 0
  );
}

function round4(value) {
  return Math.round(
    value * 10000
  ) / 10000;
}

function dominantBucket(histogram) {
  let bestIndex = 0;
  let bestCount = -1;

  histogram.forEach(
    (count, index) => {
      if (count > bestCount) {
        bestCount = count;
        bestIndex = index;
      }
    }
  );

  return bestCount > 0
    ? {
        bucket: bestIndex,
        observationCount:
          bestCount
      }
    : null;
}

function buildStateRhythms(ordered) {
  const totalObservations =
    ordered.length;

  const states =
    new Map();

  for (const observation of ordered) {
    let state =
      states.get(
        observation.stateId
      );

    if (!state) {
      state = {
        stateId:
          observation.stateId,

        observationCount: 0,

        uniqueDates:
          new Set(),

        utcHourHistogram:
          emptyHistogram(24),

        utcDayOfWeekHistogram:
          emptyHistogram(7),

        firstObservedAt:
          observation.evidenceReceivedAt,

        lastObservedAt:
          observation.evidenceReceivedAt
      };

      states.set(
        observation.stateId,
        state
      );
    }

    state.observationCount += 1;

    state.uniqueDates.add(
      observation.utcDate
    );

    state.utcHourHistogram[
      observation.utcHour
    ] += 1;

    state.utcDayOfWeekHistogram[
      observation.utcDayOfWeek
    ] += 1;

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

  return Array.from(
    states.values()
  )
    .map((state) => {
      const activeUtcHours =
        state.utcHourHistogram.filter(
          (count) => count > 0
        ).length;

      const activeUtcDaysOfWeek =
        state.utcDayOfWeekHistogram.filter(
          (count) => count > 0
        ).length;

      return {
        stateId:
          state.stateId,

        observationCount:
          state.observationCount,

        observationShare:
          totalObservations > 0
            ? round4(
                state.observationCount /
                totalObservations
              )
            : 0,

        uniqueUtcDates:
          state.uniqueDates.size,

        firstObservedAt:
          state.firstObservedAt,

        lastObservedAt:
          state.lastObservedAt,

        activeUtcHours,
        activeUtcDaysOfWeek,

        dominantUtcHour:
          dominantBucket(
            state.utcHourHistogram
          ),

        dominantUtcDayOfWeek:
          dominantBucket(
            state.utcDayOfWeekHistogram
          ),

        utcHourHistogram:
          state.utcHourHistogram,

        utcDayOfWeekHistogram:
          state.utcDayOfWeekHistogram
      };
    })
    .sort(
      (left, right) =>
        left.stateId.localeCompare(
          right.stateId
        )
    );
}

function buildCurrentRecurrence(
  ordered,
  stateRhythms
) {
  if (ordered.length === 0) {
    return null;
  }

  const current =
    ordered[
      ordered.length - 1
    ];

  const currentState =
    stateRhythms.find(
      (state) =>
        state.stateId ===
        current.stateId
    );

  if (!currentState) {
    throw new Error(
      "current state rhythm missing"
    );
  }

  const hourCount =
    currentState.utcHourHistogram[
      current.utcHour
    ];

  const dayOfWeekCount =
    currentState.utcDayOfWeekHistogram[
      current.utcDayOfWeek
    ];

  return {
    currentStateId:
      current.stateId,

    currentEvidenceEventId:
      current.evidenceEventId,

    currentObservedAt:
      current.evidenceReceivedAt,

    currentUtcHour:
      current.utcHour,

    currentUtcDayOfWeek:
      current.utcDayOfWeek,

    stateObservationCount:
      currentState.observationCount,

    stateUniqueUtcDates:
      currentState.uniqueUtcDates,

    observationsAtCurrentUtcHour:
      hourCount,

    shareOfStateObservationsAtCurrentUtcHour:
      currentState.observationCount > 0
        ? round4(
            hourCount /
            currentState.observationCount
          )
        : 0,

    observationsOnCurrentUtcDayOfWeek:
      dayOfWeekCount,

    shareOfStateObservationsOnCurrentUtcDayOfWeek:
      currentState.observationCount > 0
        ? round4(
            dayOfWeekCount /
            currentState.observationCount
          )
        : 0
  };
}

function buildDailyRhythmTimelineV1(
  ordered
) {
  if (!Array.isArray(ordered) || ordered.length === 0) {
    return null;
  }

  const current =
    ordered[
      ordered.length - 1
    ];

  const currentUtcDate =
    current.utcDate;

  const currentUtcHour =
    current.utcHour;

  const observationsByUtcDate =
    new Map();

  for (const observation of ordered) {
    if (
      typeof observation.utcDate !== "string" ||
      !Number.isInteger(observation.utcHour) ||
      observation.utcHour < 0 ||
      observation.utcHour > 23
    ) {
      continue;
    }

    let hourly =
      observationsByUtcDate.get(
        observation.utcDate
      );

    if (!hourly) {
      hourly =
        emptyHistogram(24);

      observationsByUtcDate.set(
        observation.utcDate,
        hourly
      );
    }

    hourly[
      observation.utcHour
    ] += 1;
  }

  const utcDates =
    Array.from(
      observationsByUtcDate.keys()
    ).sort();

  const priorUtcDates =
    utcDates.filter(
      (utcDate) =>
        utcDate < currentUtcDate
    );

  const todayHourly =
    observationsByUtcDate.get(
      currentUtcDate
    ) ||
    emptyHistogram(24);

  const buckets =
    Array.from(
      { length: 24 },
      (_, utcHour) => {
        const priorValues =
          priorUtcDates.map(
            (utcDate) => {
              const hourly =
                observationsByUtcDate.get(
                  utcDate
                );

              return hourly
                ? hourly[utcHour]
                : 0;
            }
          );

        const priorUtcDateCount =
          priorValues.length;

        const priorMean =
          priorUtcDateCount > 0
            ? round4(
                priorValues.reduce(
                  (sum, value) =>
                    sum + value,
                  0
                ) /
                priorUtcDateCount
              )
            : null;

        return {
          utcHour,

          todayObservationCount:
            todayHourly[
              utcHour
            ],

          priorUtcDateCount,

          priorMeanObservationCount:
            priorMean,

          priorMinObservationCount:
            priorUtcDateCount > 0
              ? Math.min(
                  ...priorValues
                )
              : null,

          priorMaxObservationCount:
            priorUtcDateCount > 0
              ? Math.max(
                  ...priorValues
                )
              : null
        };
      }
    );

  return {
    version:
      "human_presence_daily_rhythm_observation_v1",

    descriptiveOnly: true,

    countSemantics:
      "spatial_state_observations",

    zeroDoesNotEstablishAbsence:
      true,

    timeBasis: {
      timezone: "UTC",
      hourBucketCount: 24,
      residentLocalTimezoneApplied:
        false
    },

    currentUtcDate,
    currentUtcHour,

    priorUtcDateCount:
      priorUtcDates.length,

    historicalRangeReady:
      priorUtcDates.length >= 2,

    buckets
  };
}

function buildSpatialRhythmLearningV1(
  observations
) {
  const ordered =
    sortObservations(
      observations
    );

  const states =
    buildStateRhythms(
      ordered
    );

  const dailyRhythm =
    buildDailyRhythmTimelineV1(
      ordered
    );

  return {
    version:
      VERSION,

    sourceStateLearningVersion:
      SOURCE_STATE_VERSION,

    observerOnly: true,
    developmentOnly: true,

    timeBasis: {
      timezone: "UTC",
      hourBucketCount: 24,
      dayOfWeekBucketCount: 7,
      residentLocalTimezoneApplied:
        false
    },

    dailyRhythm,

    observationCount:
      ordered.length,

    uniqueStateCount:
      states.length,

    uniqueUtcDates:
      new Set(
        ordered.map(
          (observation) =>
            observation.utcDate
        )
      ).size,

    states,

    currentRecurrence:
      buildCurrentRecurrence(
        ordered,
        states
      ),

    interpretationBoundary: {
      anonymousSpatialStatesOnly: true,
      roomZoneAssigned: false,
      postureClassification: false,
      activityClassification: false,
      medicalInference: false,
      fallDetection: false,
      operationalAlert: false,
      routineDeviationAlert: false
    }
  };
}

module.exports = {
  VERSION,
  SOURCE_STATE_VERSION,
  buildSpatialRhythmLearningV1
};
