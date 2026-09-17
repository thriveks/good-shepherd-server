"use strict";

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isHumanPresenceSensor(sensor) {
  const sensorType =
    cleanText(sensor?.sensorType).toLowerCase();

  const sourceKey =
    cleanText(sensor?.sourceKey).toLowerCase();

  const sourceName =
    cleanText(sensor?.sourceName).toLowerCase();

  return (
    sensorType.includes("presence") ||
    sourceKey.startsWith("presence-") ||
    sourceKey.startsWith("motion-presence-") ||
    sourceName.includes("presence")
  );
}

function attachRows(byNode, rows, key) {
  for (const row of rows || []) {
    const nodeId =
      cleanText(row?.nodeId);

    if (!nodeId) continue;

    if (!byNode.has(nodeId)) {
      byNode.set(nodeId, {
        nodeId
      });
    }

    byNode.get(nodeId)[key] = {
      evidenceReceivedAt:
        row?.evidenceReceivedAt || null,

      rowPayload:
        row?.rowPayload &&
        typeof row.rowPayload === "object"
          ? row.rowPayload
          : {}
    };
  }
}

async function loadHumanPresenceEngineeringDashboardByNode(
  db
) {
  const [
    featureResult,
    signatureResult,
    stateResult,
    assignmentResult,
    temporalResult,
    rhythmResult
  ] = await Promise.all([
    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        evidence_received_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_engineering_features t
      ORDER BY
        node_id,
        evidence_received_at DESC
    `),

    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        evidence_received_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_spatial_signatures t
      ORDER BY
        node_id,
        evidence_received_at DESC
    `),

    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        last_observed_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_spatial_states t
      ORDER BY
        node_id,
        last_observed_at DESC
    `),

    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        evidence_received_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_spatial_state_assignments t
      ORDER BY
        node_id,
        evidence_received_at DESC
    `),

    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        evidence_received_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_spatial_temporal_snapshots t
      ORDER BY
        node_id,
        evidence_received_at DESC
    `),

    db.query(`
      SELECT DISTINCT ON (node_id)
        node_id AS "nodeId",
        evidence_received_at AS "evidenceReceivedAt",
        to_jsonb(t) AS "rowPayload"
      FROM human_presence_spatial_rhythm_snapshots t
      ORDER BY
        node_id,
        evidence_received_at DESC
    `)
  ]);

  let adaptiveDecisionRows = [];

  try {
    const adaptiveDecisionResult =
      await db.query(`
        SELECT DISTINCT ON (node_id)
          node_id AS "nodeId",
          decided_at AS "evidenceReceivedAt",
          to_jsonb(t) AS "rowPayload"
        FROM human_presence_adaptive_capture_decisions t
        ORDER BY
          node_id,
          decided_at DESC
      `);

    adaptiveDecisionRows =
      adaptiveDecisionResult.rows;
  } catch (error) {
    if (error?.code !== "42P01") {
      throw error;
    }
  }

  const byNode = new Map();

  attachRows(
    byNode,
    featureResult.rows,
    "engineeringFeature"
  );

  attachRows(
    byNode,
    signatureResult.rows,
    "spatialSignature"
  );

  attachRows(
    byNode,
    stateResult.rows,
    "spatialState"
  );

  attachRows(
    byNode,
    assignmentResult.rows,
    "spatialAssignment"
  );

  attachRows(
    byNode,
    temporalResult.rows,
    "spatialTemporal"
  );

  attachRows(
    byNode,
    rhythmResult.rows,
    "spatialRhythm"
  );

  attachRows(
    byNode,
    adaptiveDecisionRows,
    "adaptiveCaptureDecision"
  );

  return byNode;
}

function buildHumanPresenceEngineeringBundlesForSensors(
  residentSensors,
  byNode
) {
  const metadataByNode =
    new Map();

  for (
    const sensor of
    Array.isArray(residentSensors)
      ? residentSensors
      : []
  ) {
    if (!isHumanPresenceSensor(sensor)) {
      continue;
    }

    const nodeId =
      cleanText(sensor?.nodeId);

    if (!nodeId) continue;

    if (!metadataByNode.has(nodeId)) {
      metadataByNode.set(nodeId, {
        nodeId,

        roomName:
          cleanText(sensor?.roomName) ||
          null,

        sourceName:
          cleanText(sensor?.sourceName) ||
          null
      });
    }
  }

  return Array.from(
    metadataByNode.values()
  ).map((metadata) => ({
    ...metadata,
    ...(byNode?.get(metadata.nodeId) || {})
  }));
}

module.exports = {
  loadHumanPresenceEngineeringDashboardByNode,
  buildHumanPresenceEngineeringBundlesForSensors
};
