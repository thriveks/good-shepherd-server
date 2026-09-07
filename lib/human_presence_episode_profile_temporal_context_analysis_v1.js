"use strict";

const VERSION =
  "human_presence_episode_profile_temporal_context_analysis_v1";

const PROFILE_VERSION =
  "human_presence_episode_profile_analysis_v1";

const PATTERN_VERSION =
  "human_presence_episode_profile_pattern_analysis_v1";

const DEFAULT_TIME_ZONE = "America/Chicago";

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === "" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validDate(value) {
  if (!value) return null;

  const d = new Date(value);

  return Number.isFinite(d.getTime())
    ? d
    : null;
}

function mean(values) {
  const finite =
    values
      .map(finiteNumber)
      .filter((value) => value !== null);

  if (!finite.length) return null;

  return (
    finite.reduce(
      (sum, value) => sum + value,
      0
    ) / finite.length
  );
}

function median(values) {
  const finite =
    values
      .map(finiteNumber)
      .filter((value) => value !== null)
      .sort((a, b) => a - b);

  if (!finite.length) return null;

  const middle =
    Math.floor(finite.length / 2);

  return finite.length % 2
    ? finite[middle]
    : (
        finite[middle - 1] +
        finite[middle]
      ) / 2;
}

function localParts(
  timestamp,
  timeZone = DEFAULT_TIME_ZONE
) {
  const date = validDate(timestamp);

  if (!date) {
    throw new Error(
      "valid evidence timestamp required"
    );
  }

  const formatter =
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone,
        hour12: false,
        hour: "2-digit",
        weekday: "short"
      }
    );

  const parts =
    Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter(
          (part) =>
            part.type !== "literal"
        )
        .map(
          (part) => [
            part.type,
            part.value
          ]
        )
    );

  const hour =
    Number(parts.hour) % 24;

  if (!Number.isInteger(hour)) {
    throw new Error(
      "could not resolve local hour"
    );
  }

  return {
    localHour: hour,
    localWeekday:
      parts.weekday || null
  };
}

function daypartForHour(hour) {
  if (hour >= 0 && hour < 6) {
    return "overnight";
  }

  if (hour >= 6 && hour < 12) {
    return "morning";
  }

  if (hour >= 12 && hour < 18) {
    return "afternoon";
  }

  return "evening";
}

function profilePayload(row) {
  return (
    row?.episode_profile_analysis_payload ||
    row?.episodeProfileAnalysisPayload ||
    {}
  );
}

function patternPayload(row) {
  return (
    row?.episode_profile_pattern_analysis_payload ||
    row?.episodeProfilePatternAnalysisPayload ||
    {}
  );
}

function timestampOf(row) {
  return (
    row?.evidence_received_at ||
    row?.evidenceReceivedAt ||
    null
  );
}

function residentOf(row) {
  return (
    row?.authoritative_resident_id ||
    row?.authoritativeResidentId ||
    null
  );
}

function roomOf(row) {
  return (
    row?.authoritative_room_or_location ||
    row?.authoritativeRoomOrLocation ||
    null
  );
}

function eventIdOf(row) {
  return (
    row?.evidence_event_id ||
    row?.evidenceEventId ||
    null
  );
}

function validateRow(row) {
  if (!row) {
    throw new Error(
      "temporal context parent row required"
    );
  }

  if (
    (
      row.episode_profile_analysis_version ||
      row.episodeProfileAnalysisVersion
    ) !== PROFILE_VERSION
  ) {
    throw new Error(
      "unsupported episode profile analysis version"
    );
  }

  if (
    (
      row.episode_profile_pattern_analysis_version ||
      row.episodeProfilePatternAnalysisVersion
    ) !== PATTERN_VERSION
  ) {
    throw new Error(
      "unsupported episode profile pattern version"
    );
  }

  if (
    !eventIdOf(row) ||
    !residentOf(row) ||
    !roomOf(row)
  ) {
    throw new Error(
      "event, resident, and room required"
    );
  }

  if (
    (
      row.authority_resolution_status ||
      row.authorityResolutionStatus
    ) !== "resolved_assigned_sensor"
  ) {
    throw new Error(
      "resolved assigned sensor authority required"
    );
  }

  if (!validDate(timestampOf(row))) {
    throw new Error(
      "valid evidence timestamp required"
    );
  }

  const profile =
    profilePayload(row);

  const pattern =
    patternPayload(row);

  if (
    profile.observerOnly !== true ||
    pattern.observerOnly !== true ||
    pattern.descriptiveOnly !== true
  ) {
    throw new Error(
      "observer-only parent analyses required"
    );
  }

  const forbidden = [
    "operationalClassification",
    "alertLevel",
    "monitoringAction",
    "interventionRecommendation"
  ];

  for (const key of forbidden) {
    if (
      pattern[key] !== null &&
      pattern[key] !== undefined
    ) {
      throw new Error(
        `operational contamination: ${key}`
      );
    }
  }

  if (
    finiteNumber(
      profile.profileMeanRelativeDelta
    ) === null
  ) {
    throw new Error(
      "finite parent profile delta required"
    );
  }
}

function metricSummary(values) {
  const finite =
    values
      .map(finiteNumber)
      .filter((value) => value !== null);

  return {
    sampleCount: finite.length,
    minimum:
      finite.length
        ? Math.min(...finite)
        : null,
    maximum:
      finite.length
        ? Math.max(...finite)
        : null,
    mean: mean(finite),
    median: median(finite)
  };
}

function buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1({
  current,
  prior = [],
  timeZone = DEFAULT_TIME_ZONE
}) {
  validateRow(current);

  const currentTime =
    validDate(timestampOf(current));

  const currentLocal =
    localParts(
      currentTime,
      timeZone
    );

  const currentDaypart =
    daypartForHour(
      currentLocal.localHour
    );

  const resident =
    residentOf(current);

  const room =
    roomOf(current);

  const normalizedPrior =
    (Array.isArray(prior) ? prior : [])
      .filter((row) => {
        try {
          validateRow(row);
        } catch {
          return false;
        }

        const timestamp =
          validDate(timestampOf(row));

        return (
          residentOf(row) === resident &&
          roomOf(row) === room &&
          timestamp &&
          timestamp.getTime() <
            currentTime.getTime()
        );
      })
      .sort(
        (a, b) =>
          validDate(
            timestampOf(a)
          ).getTime() -
          validDate(
            timestampOf(b)
          ).getTime()
      );

  const sameDaypart =
    normalizedPrior.filter((row) => {
      const parts =
        localParts(
          timestampOf(row),
          timeZone
        );

      return (
        daypartForHour(parts.localHour) ===
        currentDaypart
      );
    });

  const profileDelta =
    (row) =>
      finiteNumber(
        profilePayload(row)
          .profileMeanRelativeDelta
      );

  const nearestDistance =
    (row) =>
      finiteNumber(
        patternPayload(row)
          ?.nearestPriorProfile
          ?.nearestPriorProfileDistance
      );

  const currentProfileDelta =
    profileDelta(current);

  const currentNearestDistance =
    nearestDistance(current);

  const allProfileSummary =
    metricSummary(
      normalizedPrior.map(profileDelta)
    );

  const contextProfileSummary =
    metricSummary(
      sameDaypart.map(profileDelta)
    );

  const allNearestSummary =
    metricSummary(
      normalizedPrior.map(nearestDistance)
    );

  const contextNearestSummary =
    metricSummary(
      sameDaypart.map(nearestDistance)
    );

  return {
    episodeProfileTemporalContextAnalysisVersion:
      VERSION,

    parentEpisodeProfileAnalysisVersion:
      PROFILE_VERSION,

    parentEpisodeProfilePatternAnalysisVersion:
      PATTERN_VERSION,

    evidenceEventId:
      eventIdOf(current),

    observerOnly: true,
    descriptiveOnly: true,

    authoritativeResidentId:
      resident,

    authoritativeRoomOrLocation:
      room,

    temporalContext: {
      timeZone,
      localHour:
        currentLocal.localHour,
      localWeekday:
        currentLocal.localWeekday,
      daypart:
        currentDaypart
    },

    historyContext: {
      allPriorObservationCount:
        normalizedPrior.length,
      sameDaypartPriorObservationCount:
        sameDaypart.length
    },

    profileDeltaContext: {
      current:
        currentProfileDelta,

      allPrior:
        allProfileSummary,

      sameDaypartPrior:
        contextProfileSummary,

      currentMinusAllPriorMean:
        allProfileSummary.mean === null
          ? null
          : currentProfileDelta -
            allProfileSummary.mean,

      currentMinusSameDaypartPriorMean:
        contextProfileSummary.mean === null
          ? null
          : currentProfileDelta -
            contextProfileSummary.mean
    },

    nearestProfileDistanceContext: {
      current:
        currentNearestDistance,

      allPrior:
        allNearestSummary,

      sameDaypartPrior:
        contextNearestSummary,

      currentMinusAllPriorMean:
        (
          currentNearestDistance === null ||
          allNearestSummary.mean === null
        )
          ? null
          : currentNearestDistance -
            allNearestSummary.mean,

      currentMinusSameDaypartPriorMean:
        (
          currentNearestDistance === null ||
          contextNearestSummary.mean === null
        )
          ? null
          : currentNearestDistance -
            contextNearestSummary.mean
    },

    dataSufficiency: {
      hasPriorHistory:
        normalizedPrior.length > 0,

      hasSameDaypartPriorHistory:
        sameDaypart.length > 0,

      allPriorObservationCount:
        normalizedPrior.length,

      sameDaypartPriorObservationCount:
        sameDaypart.length
    },

    operationalClassification: null,
    alertLevel: null,
    monitoringAction: null,
    interventionRecommendation: null
  };
}

module.exports = {
  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_ANALYSIS_VERSION:
    VERSION,

  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PROFILE_VERSION:
    PROFILE_VERSION,

  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_PATTERN_VERSION:
    PATTERN_VERSION,

  HUMAN_PRESENCE_EPISODE_PROFILE_TEMPORAL_CONTEXT_DEFAULT_TIME_ZONE:
    DEFAULT_TIME_ZONE,

  buildHumanPresenceEpisodeProfileTemporalContextAnalysisV1,
  daypartForHour,
  localParts,
  metricSummary
};
