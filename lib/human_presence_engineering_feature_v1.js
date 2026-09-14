"use strict";

const VERSION = "human_presence_engineering_feature_v1";

const GATE_COUNT = 9;
const ACTIVE_GATE_THRESHOLD = 1;

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function requireGateArray(value, label) {
  if (!Array.isArray(value) || value.length !== GATE_COUNT) {
    throw new Error(`${label} must contain exactly ${GATE_COUNT} gates`);
  }

  for (let i = 0; i < value.length; i += 1) {
    requireFiniteNumber(value[i], `${label}[${i}]`);
  }
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

function dominantGate(values) {
  const total = sum(values);

  if (total <= 0) {
    return null;
  }

  let bestIndex = 0;
  let bestValue = values[0];

  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      bestIndex = i;
    }
  }

  return bestIndex;
}

function weightedCentroid(values) {
  const total = sum(values);

  if (total <= 0) {
    return null;
  }

  const weighted = values.reduce(
    (accumulator, value, gate) =>
      accumulator + value * gate,
    0
  );

  return weighted / total;
}

function normalizedDistribution(values) {
  const total = sum(values);

  if (total <= 0) {
    return null;
  }

  return values.map((value) => value / total);
}

function distributionDelta(left, right) {
  if (!left || !right) {
    return null;
  }

  let delta = 0;

  for (let i = 0; i < GATE_COUNT; i += 1) {
    delta += Math.abs(left[i] - right[i]);
  }

  return delta;
}

function bandTotals(values) {
  return {
    near: sum(values.slice(0, 3)),
    mid: sum(values.slice(3, 6)),
    far: sum(values.slice(6, 9))
  };
}

function bandShares(values) {
  const totals = bandTotals(values);
  const total = totals.near + totals.mid + totals.far;

  if (total <= 0) {
    return {
      near: null,
      mid: null,
      far: null
    };
  }

  return {
    near: round(totals.near / total),
    mid: round(totals.mid / total),
    far: round(totals.far / total)
  };
}

function summarizeGateChannel(samples, gateIndex) {
  const aggregate = Array(GATE_COUNT).fill(0);
  const sampleTotals = [];
  const samplePeaks = [];
  const sampleActiveGateCounts = [];
  const centroids = [];
  const distributions = [];

  for (const sample of samples) {
    const gates = sample[gateIndex];

    requireGateArray(gates, `sample[${gateIndex}]`);

    for (let gate = 0; gate < GATE_COUNT; gate += 1) {
      aggregate[gate] += gates[gate];
    }

    const total = sum(gates);

    sampleTotals.push(total);
    samplePeaks.push(Math.max(...gates));
    sampleActiveGateCounts.push(
      gates.filter((value) => value >= ACTIVE_GATE_THRESHOLD).length
    );

    centroids.push(weightedCentroid(gates));
    distributions.push(normalizedDistribution(gates));
  }

  const validCentroids =
    centroids.filter((value) => value !== null);

  const centroidChanges = [];

  for (let i = 1; i < centroids.length; i += 1) {
    if (
      centroids[i - 1] !== null &&
      centroids[i] !== null
    ) {
      centroidChanges.push(
        Math.abs(centroids[i] - centroids[i - 1])
      );
    }
  }

  const distributionChanges = [];

  for (let i = 1; i < distributions.length; i += 1) {
    const delta =
      distributionDelta(
        distributions[i - 1],
        distributions[i]
      );

    if (delta !== null) {
      distributionChanges.push(delta);
    }
  }

  const meanCentroidChange = mean(centroidChanges);

  const spatialStability =
    meanCentroidChange === null
      ? null
      : Math.max(
          0,
          Math.min(1, 1 - meanCentroidChange / 8)
        );

  return {
    aggregateGateEnergy: aggregate,
    dominantGate: dominantGate(aggregate),
    weightedGateCentroid: round(weightedCentroid(aggregate)),
    peakGateEnergy: Math.max(...samplePeaks),
    meanTotalGateEnergy: round(mean(sampleTotals)),
    meanActiveGateCount: round(mean(sampleActiveGateCounts)),
    meanSampleCentroid:
      validCentroids.length
        ? round(mean(validCentroids))
        : null,
    meanCentroidChange: round(meanCentroidChange),
    meanDistributionChange: round(mean(distributionChanges)),
    spatialStability: round(spatialStability),
    energyBands: {
      totals: bandTotals(aggregate),
      shares: bandShares(aggregate)
    }
  };
}

function buildEngineeringFeatureV1(input) {
  if (!input || typeof input !== "object") {
    throw new Error("engineering feature input required");
  }

  if (String(input.evidenceSchemaVersion) !== "2.0") {
    throw new Error(
      "engineering feature v1 requires evidence schema 2.0"
    );
  }

  if (input.observerOnly !== true) {
    throw new Error(
      "engineering feature v1 requires observerOnly=true"
    );
  }

  if (input.developmentOnly !== true) {
    throw new Error(
      "engineering feature v1 requires developmentOnly=true"
    );
  }

  if (input.sampleEncoding !== "compact-array-v2") {
    throw new Error(
      "engineering feature v1 requires compact-array-v2"
    );
  }

  if (
    !Array.isArray(input.samples) ||
    input.samples.length < 1
  ) {
    throw new Error(
      "engineering feature v1 requires samples"
    );
  }

  for (let i = 0; i < input.samples.length; i += 1) {
    const sample = input.samples[i];

    if (!Array.isArray(sample) || sample.length !== 19) {
      throw new Error(
        `invalid compact-array-v2 sample at index ${i}`
      );
    }

    requireGateArray(sample[17], `sample ${i} moving gates`);
    requireGateArray(sample[18], `sample ${i} stationary gates`);
  }

  const moving =
    summarizeGateChannel(input.samples, 17);

  const stationary =
    summarizeGateChannel(input.samples, 18);

  const movingMeanEnergy =
    moving.meanTotalGateEnergy || 0;

  const stationaryMeanEnergy =
    stationary.meanTotalGateEnergy || 0;

  const combinedMeanEnergy =
    movingMeanEnergy + stationaryMeanEnergy;

  const firstSample = input.samples[0];
  const lastSample =
    input.samples[input.samples.length - 1];

  return {
    version: VERSION,

    evidence: {
      evidenceSchemaVersion: "2.0",
      sampleEncoding: "compact-array-v2",
      observerOnly: true,
      developmentOnly: true,
      sampleCount: input.samples.length
    },

    sampleWindow: {
      firstFrameSequence: firstSample[0],
      lastFrameSequence: lastSample[0],
      firstUptimeMs: firstSample[1],
      lastUptimeMs: lastSample[1],
      durationMs: Math.max(0, lastSample[1] - firstSample[1])
    },

    moving,
    stationary,

    combined: {
      movingEnergyShare:
        combinedMeanEnergy > 0
          ? round(movingMeanEnergy / combinedMeanEnergy)
          : null,

      stationaryEnergyShare:
        combinedMeanEnergy > 0
          ? round(stationaryMeanEnergy / combinedMeanEnergy)
          : null,

      dominantChannel:
        combinedMeanEnergy <= 0
          ? "none"
          : movingMeanEnergy > stationaryMeanEnergy
            ? "moving"
            : stationaryMeanEnergy > movingMeanEnergy
              ? "stationary"
              : "balanced"
    },

    interpretationBoundary: {
      classification: "descriptive_engineering_feature",
      operationalAlert: false,
      medicalInference: false,
      postureClassification: false,
      fallDetection: false
    }
  };
}

module.exports = {
  VERSION,
  GATE_COUNT,
  ACTIVE_GATE_THRESHOLD,
  buildEngineeringFeatureV1
};
