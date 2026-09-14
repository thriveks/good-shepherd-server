"use strict";

const {
  VERSION,
  SOURCE_SIGNATURE_VERSION,
  assignSpatialStateV1
} = require(
  "./human_presence_spatial_state_learning_v1"
);

const STATES_TABLE =
  "human_presence_spatial_states";

const ASSIGNMENTS_TABLE =
  "human_presence_spatial_state_assignments";

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS human_presence_spatial_states (
    node_id TEXT NOT NULL,
    state_id TEXT NOT NULL,
    spatial_state_learning_version TEXT NOT NULL,
    source_signature_version TEXT NOT NULL,
    prototype_payload JSONB NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 1,
    first_observed_at TIMESTAMPTZ NOT NULL,
    last_observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (
      node_id,
      state_id,
      spatial_state_learning_version
    )
  );

  CREATE INDEX IF NOT EXISTS
    human_presence_spatial_states_node_recent_idx
  ON human_presence_spatial_states (
    node_id,
    last_observed_at DESC
  );

  CREATE TABLE IF NOT EXISTS
    human_presence_spatial_state_assignments (
      evidence_event_id TEXT NOT NULL,
      spatial_state_learning_version TEXT NOT NULL,
      spatial_signature_version TEXT NOT NULL,
      node_id TEXT NOT NULL,
      state_id TEXT NOT NULL,
      assignment_payload JSONB NOT NULL,
      evidence_received_at TIMESTAMPTZ NOT NULL,
      assignment_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        evidence_event_id,
        spatial_state_learning_version
      )
    );

  CREATE INDEX IF NOT EXISTS
    human_presence_spatial_state_assignments_node_time_idx
  ON human_presence_spatial_state_assignments (
    node_id,
    evidence_received_at DESC
  );
`;

async function ensureHumanPresenceSpatialStateLearningV1(
  db
) {
  await db.query(TABLE_SQL);
}

function requireSignature(signature) {
  if (
    !signature ||
    signature.version !== SOURCE_SIGNATURE_VERSION
  ) {
    throw new Error(
      "Spatial State Learning persistence requires Spatial Signature v1"
    );
  }

  if (
    signature.observerOnly !== true ||
    signature.developmentOnly !== true
  ) {
    throw new Error(
      "Spatial State Learning requires observer/development signature"
    );
  }
}

function requireCurrent(current) {
  if (
    !current?.evidence_event_id ||
    !current?.node_id ||
    !current?.evidence_received_at
  ) {
    throw new Error(
      "Spatial State Learning evidence identity required"
    );
  }
}

function stateNumber(stateId) {
  const match =
    /^state_(\d+)$/.exec(String(stateId || ""));

  return match
    ? Number(match[1])
    : 0;
}

function nextStateId(states) {
  let maximum = 0;

  for (const state of states) {
    maximum = Math.max(
      maximum,
      stateNumber(state.stateId)
    );
  }

  return `state_${maximum + 1}`;
}

function prototypeFromSignature(signature) {
  return {
    moving: {
      normalizedGateDistribution:
        signature.moving.normalizedGateDistribution
          .map(Number)
    },

    stationary: {
      normalizedGateDistribution:
        signature.stationary.normalizedGateDistribution
          .map(Number)
    }
  };
}

function runningMeanVector(
  existing,
  incoming,
  existingCount
) {
  if (
    !Array.isArray(existing) ||
    !Array.isArray(incoming) ||
    existing.length !== 9 ||
    incoming.length !== 9
  ) {
    throw new Error(
      "Spatial state prototype vectors must contain 9 gates"
    );
  }

  return existing.map(
    (value, index) => {
      const prior = Number(value);
      const next = Number(incoming[index]);

      if (
        !Number.isFinite(prior) ||
        !Number.isFinite(next)
      ) {
        throw new Error(
          "Spatial state prototype values must be finite"
        );
      }

      return Math.round(
        (
          (
            (prior * existingCount) +
            next
          ) /
          (existingCount + 1)
        ) * 10000
      ) / 10000;
    }
  );
}

function updatePrototype(
  prototype,
  signature,
  existingCount
) {
  return {
    moving: {
      normalizedGateDistribution:
        runningMeanVector(
          prototype.moving
            .normalizedGateDistribution,
          signature.moving
            .normalizedGateDistribution,
          existingCount
        )
    },

    stationary: {
      normalizedGateDistribution:
        runningMeanVector(
          prototype.stationary
            .normalizedGateDistribution,
          signature.stationary
            .normalizedGateDistribution,
          existingCount
        )
    }
  };
}

async function loadExistingStates(
  db,
  nodeId
) {
  const result = await db.query(
    `
      SELECT
        state_id,
        prototype_payload,
        observation_count
      FROM ${STATES_TABLE}
      WHERE node_id = $1
        AND spatial_state_learning_version = $2
      ORDER BY
        state_id
    `,
    [
      nodeId,
      VERSION
    ]
  );

  return result.rows.map((row) => ({
    stateId: row.state_id,
    prototype: row.prototype_payload,
    observationCount:
      Number(row.observation_count) || 0
  }));
}

async function persistAssignment(
  db,
  current,
  signature,
  stateId,
  assignment
) {
  const result = await db.query(
    `
      INSERT INTO ${ASSIGNMENTS_TABLE} (
        evidence_event_id,
        spatial_state_learning_version,
        spatial_signature_version,
        node_id,
        state_id,
        assignment_payload,
        evidence_received_at,
        assignment_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6::jsonb,$7,NOW()
      )
      ON CONFLICT (
        evidence_event_id,
        spatial_state_learning_version
      )
      DO NOTHING
      RETURNING assignment_at
    `,
    [
      current.evidence_event_id,
      VERSION,
      signature.version,
      current.node_id,
      stateId,
      JSON.stringify(assignment),
      current.evidence_received_at
    ]
  );

  return result.rowCount === 1;
}

async function createState(
  db,
  current,
  signature,
  stateId
) {
  const prototype =
    prototypeFromSignature(signature);

  await db.query(
    `
      INSERT INTO ${STATES_TABLE} (
        node_id,
        state_id,
        spatial_state_learning_version,
        source_signature_version,
        prototype_payload,
        observation_count,
        first_observed_at,
        last_observed_at,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5::jsonb,1,$6,$6,NOW(),NOW()
      )
      ON CONFLICT (
        node_id,
        state_id,
        spatial_state_learning_version
      )
      DO NOTHING
    `,
    [
      current.node_id,
      stateId,
      VERSION,
      signature.version,
      JSON.stringify(prototype),
      current.evidence_received_at
    ]
  );

  return prototype;
}

async function updateExistingState(
  db,
  current,
  signature,
  state
) {
  const nextPrototype =
    updatePrototype(
      state.prototype,
      signature,
      state.observationCount
    );

  await db.query(
    `
      UPDATE ${STATES_TABLE}
      SET
        prototype_payload = $1::jsonb,
        observation_count = observation_count + 1,
        last_observed_at = $2,
        updated_at = NOW()
      WHERE node_id = $3
        AND state_id = $4
        AND spatial_state_learning_version = $5
    `,
    [
      JSON.stringify(nextPrototype),
      current.evidence_received_at,
      current.node_id,
      state.stateId,
      VERSION
    ]
  );

  return nextPrototype;
}

async function buildAndPersistHumanPresenceSpatialStateLearningV1(
  db,
  current,
  signature,
  options = {}
) {
  requireCurrent(current);
  requireSignature(signature);

  const states =
    await loadExistingStates(
      db,
      current.node_id
    );

  const assignment =
    assignSpatialStateV1(
      signature,
      states,
      options
    );

  let stateId;
  let prototype;

  if (
    assignment.assignment.action ===
    "match_existing_state"
  ) {
    stateId =
      assignment.assignment.matchedStateId;

    const matched =
      states.find(
        (state) =>
          state.stateId === stateId
      );

    if (!matched) {
      throw new Error(
        "matched spatial state not found"
      );
    }

    prototype =
      await updateExistingState(
        db,
        current,
        signature,
        matched
      );
  } else {
    stateId =
      nextStateId(states);

    prototype =
      await createState(
        db,
        current,
        signature,
        stateId
      );
  }

  const persisted =
    await persistAssignment(
      db,
      current,
      signature,
      stateId,
      {
        ...assignment,

        assignedStateId:
          stateId,

        prototypeAfterAssignment:
          prototype
      }
    );

  return {
    stateId,
    assignment,
    prototype,
    persistence: {
      inserted:
        persisted,
      spatialStateLearningVersion:
        VERSION
    }
  };
}

module.exports = {
  VERSION,
  STATES_TABLE,
  ASSIGNMENTS_TABLE,
  TABLE_SQL,
  ensureHumanPresenceSpatialStateLearningV1,
  buildAndPersistHumanPresenceSpatialStateLearningV1
};
