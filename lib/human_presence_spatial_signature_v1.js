"use strict";

const VERSION = "human_presence_spatial_signature_v1";

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireChannel(channel, name) {
  if (!channel || typeof channel !== "object") {
    throw new Error(`${name} engineering channel required`);
  }

  if (
    !Array.isArray(channel.aggregateGateEnergy) ||
    channel.aggregateGateEnergy.length !== 9
  ) {
    throw new Error(`${name} aggregateGateEnergy must contain 9 gates`);
  }
}

function normalizeGateVector(values) {
  const clean = values.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
      throw new Error("invalid gate energy");
    }
    return number;
  });

  const total = clean.reduce((sum, value) => sum + value, 0);

  if (total <= 0) {
    return Array(9).fill(0);
  }

  return clean.map(
    (value) => Math.round((value / total) * 10000) / 10000
  );
}

function buildSpatialSignatureV1(engineeringFeature) {
  if (!engineeringFeature || typeof engineeringFeature !== "object") {
    throw new Error("engineering feature required");
  }

  if (
    engineeringFeature.version !==
    "human_presence_engineering_feature_v1"
  ) {
    throw new Error(
      "Spatial Signature v1 requires Engineering Feature v1"
    );
  }

  if (
    engineeringFeature.evidence?.observerOnly !== true ||
    engineeringFeature.evidence?.developmentOnly !== true
  ) {
    throw new Error(
      "Spatial Signature v1 requires observer/development evidence"
    );
  }

  requireChannel(engineeringFeature.moving, "moving");
  requireChannel(engineeringFeature.stationary, "stationary");

  const moving = engineeringFeature.moving;
  const stationary = engineeringFeature.stationary;
  const combined = engineeringFeature.combined || {};

  return {
    version: VERSION,

    sourceFeatureVersion:
      engineeringFeature.version,

    observerOnly: true,
    developmentOnly: true,

    moving: {
      normalizedGateDistribution:
        normalizeGateVector(moving.aggregateGateEnergy),
      dominantGate:
        finiteOrNull(moving.dominantGate),
      centroid:
        finiteOrNull(moving.weightedGateCentroid),
      centroidVariability:
        finiteOrNull(moving.meanCentroidChange),
      distributionVariability:
        finiteOrNull(moving.meanDistributionChange),
      meanTotalEnergy:
        finiteOrNull(moving.meanTotalGateEnergy),
      nearShare:
        finiteOrNull(moving.energyBands?.shares?.near),
      midShare:
        finiteOrNull(moving.energyBands?.shares?.mid),
      farShare:
        finiteOrNull(moving.energyBands?.shares?.far)
    },

    stationary: {
      normalizedGateDistribution:
        normalizeGateVector(stationary.aggregateGateEnergy),
      dominantGate:
        finiteOrNull(stationary.dominantGate),
      centroid:
        finiteOrNull(stationary.weightedGateCentroid),
      centroidVariability:
        finiteOrNull(stationary.meanCentroidChange),
      distributionVariability:
        finiteOrNull(stationary.meanDistributionChange),
      meanTotalEnergy:
        finiteOrNull(stationary.meanTotalGateEnergy),
      nearShare:
        finiteOrNull(stationary.energyBands?.shares?.near),
      midShare:
        finiteOrNull(stationary.energyBands?.shares?.mid),
      farShare:
        finiteOrNull(stationary.energyBands?.shares?.far)
    },

    combined: {
      movingEnergyShare:
        finiteOrNull(combined.movingEnergyShare),
      stationaryEnergyShare:
        finiteOrNull(combined.stationaryEnergyShare),
      dominantChannel:
        typeof combined.dominantChannel === "string"
          ? combined.dominantChannel
          : null
    },

    learningBoundary: {
      learnedState: false,
      roomZoneAssigned: false,
      postureClassification: false,
      activityClassification: false,
      fallDetection: false,
      operationalAlert: false
    }
  };
}

module.exports = {
  VERSION,
  buildSpatialSignatureV1
};
