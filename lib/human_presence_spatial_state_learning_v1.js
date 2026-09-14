"use strict";

const VERSION =
  "human_presence_spatial_state_learning_v1";

const SOURCE_SIGNATURE_VERSION =
  "human_presence_spatial_signature_v1";

/*
 * Development-only anonymous spatial-state learning.
 *
 * IMPORTANT:
 * - No room labels.
 * - No posture classification.
 * - No activity classification.
 * - No medical inference.
 * - No fall detection.
 * - No operational alerts.
 *
 * This layer compares normalized LD2410 spatial signatures
 * and groups sufficiently similar observations into anonymous
 * states such as state_1, state_2, etc.
 */

const DEFAULT_DISTANCE_THRESHOLD = 0.22;

function finiteNumber(value, name) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be finite`);
  }

  return number;
}

function requireDistribution(value, name) {
  if (!Array.isArray(value) || value.length !== 9) {
    throw new Error(
      `${name} normalizedGateDistribution must contain 9 gates`
    );
  }

  return value.map((entry, index) => {
    const number =
      finiteNumber(entry, `${name}[${index}]`);

    if (number < 0 || number > 1) {
      throw new Error(
        `${name}[${index}] must be between 0 and 1`
      );
    }

    return number;
  });
}

function requireSignature(signature) {
  if (!signature || typeof signature !== "object") {
    throw new Error("spatial signature required");
  }

  if (signature.version !== SOURCE_SIGNATURE_VERSION) {
    throw new Error(
      `Spatial State Learning v1 requires ${SOURCE_SIGNATURE_VERSION}`
    );
  }

  if (
    signature.observerOnly !== true ||
    signature.developmentOnly !== true
  ) {
    throw new Error(
      "Spatial State Learning v1 requires observer/development signature"
    );
  }

  const moving =
    requireDistribution(
      signature.moving?.normalizedGateDistribution,
      "moving"
    );

  const stationary =
    requireDistribution(
      signature.stationary?.normalizedGateDistribution,
      "stationary"
    );

  return {
    moving,
    stationary
  };
}

function l1Distance(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !== b.length
  ) {
    throw new Error("distance vectors must match");
  }

  let total = 0;

  for (let index = 0; index < a.length; index += 1) {
    total += Math.abs(
      finiteNumber(a[index], "left vector") -
      finiteNumber(b[index], "right vector")
    );
  }

  /*
   * Two normalized distributions have L1 distance
   * in the range 0...2. Divide by two so our
   * reported channel distance is 0...1.
   */
  return total / 2;
}

function combinedSpatialDistance(
  signatureA,
  signatureB
) {
  const a = requireSignature(signatureA);
  const b = requireSignature(signatureB);

  const movingDistance =
    l1Distance(a.moving, b.moving);

  const stationaryDistance =
    l1Distance(a.stationary, b.stationary);

  /*
   * Treat moving and stationary LD2410 channels
   * equally for v1. This can be empirically tuned later.
   */
  const combinedDistance =
    (movingDistance + stationaryDistance) / 2;

  return {
    movingDistance:
      Math.round(movingDistance * 10000) / 10000,

    stationaryDistance:
      Math.round(stationaryDistance * 10000) / 10000,

    combinedDistance:
      Math.round(combinedDistance * 10000) / 10000
  };
}

function meanDistribution(distributions) {
  if (
    !Array.isArray(distributions) ||
    distributions.length === 0
  ) {
    throw new Error("state distributions required");
  }

  const result = Array(9).fill(0);

  for (const distribution of distributions) {
    const clean =
      requireDistribution(
        distribution,
        "state distribution"
      );

    clean.forEach((value, index) => {
      result[index] += value;
    });
  }

  return result.map(
    (value) =>
      Math.round(
        (value / distributions.length) * 10000
      ) / 10000
  );
}

function buildStatePrototype(signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Error("state signatures required");
  }

  const validated =
    signatures.map((signature) => {
      const channels = requireSignature(signature);

      return {
        signature,
        channels
      };
    });

  return {
    moving: {
      normalizedGateDistribution:
        meanDistribution(
          validated.map(
            (entry) => entry.channels.moving
          )
        )
    },

    stationary: {
      normalizedGateDistribution:
        meanDistribution(
          validated.map(
            (entry) => entry.channels.stationary
          )
        )
    }
  };
}

function statePrototypeAsSignature(prototype) {
  return {
    version: SOURCE_SIGNATURE_VERSION,
    observerOnly: true,
    developmentOnly: true,

    moving: {
      normalizedGateDistribution:
        prototype.moving.normalizedGateDistribution
    },

    stationary: {
      normalizedGateDistribution:
        prototype.stationary.normalizedGateDistribution
    }
  };
}

function assignSpatialStateV1(
  signature,
  existingStates = [],
  options = {}
) {
  requireSignature(signature);

  const threshold =
    Number.isFinite(Number(options.distanceThreshold))
      ? Number(options.distanceThreshold)
      : DEFAULT_DISTANCE_THRESHOLD;

  if (threshold < 0 || threshold > 1) {
    throw new Error(
      "distanceThreshold must be between 0 and 1"
    );
  }

  const candidates = [];

  for (const state of existingStates) {
    if (
      !state ||
      typeof state.stateId !== "string" ||
      !state.prototype
    ) {
      throw new Error("invalid existing spatial state");
    }

    const distance =
      combinedSpatialDistance(
        signature,
        statePrototypeAsSignature(
          state.prototype
        )
      );

    candidates.push({
      stateId: state.stateId,
      observationCount:
        Number(state.observationCount) || 0,
      ...distance
    });
  }

  candidates.sort(
    (left, right) =>
      left.combinedDistance -
      right.combinedDistance
  );

  const nearest =
    candidates.length > 0
      ? candidates[0]
      : null;

  const matched =
    nearest !== null &&
    nearest.combinedDistance <= threshold;

  return {
    version: VERSION,

    observerOnly: true,
    developmentOnly: true,

    assignment: {
      action:
        matched
          ? "match_existing_state"
          : "create_new_state",

      matchedStateId:
        matched
          ? nearest.stateId
          : null,

      nearestStateId:
        nearest
          ? nearest.stateId
          : null,

      distance:
        nearest
          ? nearest.combinedDistance
          : null,

      movingDistance:
        nearest
          ? nearest.movingDistance
          : null,

      stationaryDistance:
        nearest
          ? nearest.stationaryDistance
          : null,

      distanceThreshold: threshold
    },

    candidateDistances:
      candidates.slice(0, 5),

    learningBoundary: {
      anonymousStateOnly: true,
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
  SOURCE_SIGNATURE_VERSION,
  DEFAULT_DISTANCE_THRESHOLD,
  l1Distance,
  combinedSpatialDistance,
  buildStatePrototype,
  assignSpatialStateV1
};
