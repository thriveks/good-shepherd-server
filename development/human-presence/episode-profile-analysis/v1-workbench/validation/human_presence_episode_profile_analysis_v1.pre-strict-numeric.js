"use strict";

const VERSION = "human_presence_episode_profile_analysis_v1";

const DIMENSIONS = Object.freeze([
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
  "stationaryEnergyWindowMedianMean",
]);

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid finite numeric dimension: ${label}`);
  }
  return n;
}

function parseProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("episodeProfile object required");
  }

  const parsed = {};
  for (const name of DIMENSIONS) {
    parsed[name] = finiteNumber(profile[name], name);
  }
  return parsed;
}

function relativeDelta(a, b) {
  const denominator = Math.max(Math.abs(a), Math.abs(b), 0.00001);
  return Math.abs(a - b) / denominator;
}

function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function analyzeEpisodeProfile({
  evidenceEventId,
  evidenceSchemaVersion,
  episodeProfile,
  evidenceReceivedAt,
  history = [],
}) {
  if (!evidenceEventId) {
    throw new Error("evidenceEventId required");
  }

  if (String(evidenceSchemaVersion) !== "1.1") {
    throw new Error("Episode Profile Analysis v1 requires Schema 1.1");
  }

  const current = parseProfile(episodeProfile);

  const parsedHistory = history.map((row, index) => {
    const profile =
      row?.episodeProfile ||
      row?.event_payload?.episodeProfile ||
      row?.eventPayload?.episodeProfile;

    return {
      profile: parseProfile(profile),
      receivedAt:
        row?.receivedAt ||
        row?.received_at ||
        row?.evidenceReceivedAt ||
        null,
      index,
    };
  });

  const dimensions = {};

  for (const name of DIMENSIONS) {
    const values = parsedHistory.map((row) => row.profile[name]);

    if (!values.length) {
      dimensions[name] = {
        current: current[name],
        historyCount: 0,
        historyMin: null,
        historyMax: null,
        historyMean: null,
        historyMedian: null,
        historyRange: null,
        currentVsHistoryMeanRelativeDelta: null,
      };
      continue;
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const mean =
      values.reduce((sum, value) => sum + value, 0) / values.length;

    dimensions[name] = {
      current: current[name],
      historyCount: values.length,
      historyMin: min,
      historyMax: max,
      historyMean: mean,
      historyMedian: median(values),
      historyRange: max - min,
      currentVsHistoryMeanRelativeDelta:
        relativeDelta(current[name], mean),
    };
  }

  const deltas = DIMENSIONS
    .map(
      (name) =>
        dimensions[name].currentVsHistoryMeanRelativeDelta
    )
    .filter(Number.isFinite);

  const historyTimes = parsedHistory
    .map((row) => row.receivedAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()))
    .sort((a, b) => a - b);

  return {
    episodeProfileAnalysisVersion: VERSION,
    evidenceEventId,
    evidenceSchemaVersion: "1.1",
    evidenceReceivedAt: evidenceReceivedAt || null,
    observerOnly: true,
    dimensionCount: DIMENSIONS.length,
    historyCount: parsedHistory.length,
    historyStartAt:
      historyTimes.length ? historyTimes[0].toISOString() : null,
    historyEndAt:
      historyTimes.length
        ? historyTimes[historyTimes.length - 1].toISOString()
        : null,
    dimensions,
    profileMeanRelativeDelta:
      deltas.length
        ? deltas.reduce((sum, value) => sum + value, 0) /
          deltas.length
        : null,
  };
}

module.exports = {
  HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION: VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS: DIMENSIONS,
  analyzeEpisodeProfile,
  parseProfile,
  relativeDelta,
};
