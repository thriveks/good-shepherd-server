const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_EVENTS = 50;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? {
        rejectUnauthorized: false
      }
    : false
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id UUID PRIMARY KEY,
      source_name TEXT NOT NULL,
      resident_name TEXT NOT NULL,
      message TEXT NOT NULL,
      alert_level TEXT NOT NULL,
      time_text TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS node_id TEXT
  `);

  await pool.query(`
    ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS location_name TEXT
  `);

  await pool.query(`
    ALTER TABLE webhook_events
    ADD COLUMN IF NOT EXISTS source_key TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS nodes (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      location_name TEXT NOT NULL DEFAULT 'Unassigned Location',
      status TEXT NOT NULL DEFAULT 'Pending Setup',
      local_ip TEXT,
      local_config_port INTEGER,
      camera_count INTEGER NOT NULL DEFAULT 0,
      camera_summary JSONB,
      software_version TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS archived_reason TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_mappings (
      source_key TEXT PRIMARY KEY,
      source_name TEXT NOT NULL,
      resident_name TEXT NOT NULL,
      default_alert_level TEXT NOT NULL,
      default_time_text TEXT NOT NULL
    )
  `);

  await pool.query(`
    INSERT INTO device_mappings (
      source_key,
      source_name,
      resident_name,
      default_alert_level,
      default_time_text
    )
    VALUES
      (
        'thrive-office-wyze',
        'Office Wyze Camera',
        'Mary Thompson',
        'Caution',
        'Office Motion Event'
      )
    ON CONFLICT (source_key) DO NOTHING
  `);
}

function isAuthorizedWebhook(req) {
  if (!WEBHOOK_SECRET) {
    return true;
  }

  const incomingSecret = req.header("x-webhook-secret");
  return incomingSecret && incomingSecret === WEBHOOK_SECRET;
}

function cleanText(value) {
  return value ? String(value).trim() : "";
}

function parseBooleanQuery(value) {
  const cleanValue = cleanText(value).toLowerCase();
  return cleanValue === "true" || cleanValue === "1" || cleanValue === "yes";
}

async function getDeviceMapping(sourceKey) {
  const result = await pool.query(
    `
    SELECT
      source_key AS "sourceKey",
      source_name AS "sourceName",
      resident_name AS "residentName",
      default_alert_level AS "defaultAlertLevel",
      default_time_text AS "defaultTimeText"
    FROM device_mappings
    WHERE source_key = $1
    LIMIT 1
    `,
    [sourceKey]
  );

  return result.rows[0] || null;
}

async function getNodeById(nodeId) {
  const result = await pool.query(
    `
    SELECT
      node_id AS "nodeId",
      node_name AS "nodeName",
      location_name AS "locationName",
      status,
      local_ip AS "localIp",
      local_config_port AS "localConfigPort",
      camera_count AS "cameraCount",
      camera_summary AS "cameraSummary",
      software_version AS "softwareVersion",
      first_seen_at AS "firstSeenAt",
      last_seen_at AS "lastSeenAt",
      is_archived AS "isArchived",
      archived_at AS "archivedAt",
      archived_reason AS "archivedReason"
    FROM nodes
    WHERE node_id = $1
    LIMIT 1
    `,
    [nodeId]
  );

  return result.rows[0] || null;
}

async function upsertNodeFromRegistration({
  nodeId,
  nodeName,
  locationName,
  localIp,
  localConfigPort,
  cameraCount,
  cameraSummary,
  softwareVersion
}) {
  const resolvedNodeId = cleanText(nodeId);

  if (!resolvedNodeId) {
    throw new Error("Missing required field: nodeId");
  }

  const resolvedNodeName = cleanText(nodeName) || "Good Shepherd Local Node";
  const resolvedLocationName = cleanText(locationName) || "Unassigned Location";
  const resolvedStatus =
    resolvedLocationName === "Unassigned Location" ? "Pending Setup" : "Active";

  const resolvedLocalIp = cleanText(localIp) || null;
  const resolvedLocalConfigPort = localConfigPort ? Number(localConfigPort) : null;
  const resolvedCameraCount = Number.isFinite(Number(cameraCount)) ? Number(cameraCount) : 0;
  const resolvedCameraSummary = Array.isArray(cameraSummary) ? cameraSummary : [];
  const resolvedSoftwareVersion = cleanText(softwareVersion) || null;

  const result = await pool.query(
    `
    INSERT INTO nodes (
      node_id,
      node_name,
      location_name,
      status,
      local_ip,
      local_config_port,
      camera_count,
      camera_summary,
      software_version,
      first_seen_at,
      last_seen_at,
      is_archived,
      archived_at,
      archived_reason
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, NOW(), NOW(), FALSE, NULL, NULL)
    ON CONFLICT (node_id)
    DO UPDATE SET
      node_name = CASE
        WHEN nodes.node_name IS NULL OR nodes.node_name = '' THEN EXCLUDED.node_name
        WHEN nodes.node_name = 'Good Shepherd Local Node' THEN EXCLUDED.node_name
        WHEN EXCLUDED.node_name = 'Good Shepherd Local Node' THEN nodes.node_name
        ELSE nodes.node_name
      END,
      location_name = CASE
        WHEN nodes.location_name = 'Unassigned Location' THEN EXCLUDED.location_name
        ELSE nodes.location_name
      END,
      status = CASE
        WHEN nodes.location_name = 'Unassigned Location' THEN EXCLUDED.status
        ELSE nodes.status
      END,
      local_ip = EXCLUDED.local_ip,
      local_config_port = EXCLUDED.local_config_port,
      camera_count = EXCLUDED.camera_count,
      camera_summary = EXCLUDED.camera_summary,
      software_version = EXCLUDED.software_version,
      last_seen_at = NOW()
    RETURNING
      node_id AS "nodeId",
      node_name AS "nodeName",
      location_name AS "locationName",
      status,
      local_ip AS "localIp",
      local_config_port AS "localConfigPort",
      camera_count AS "cameraCount",
      camera_summary AS "cameraSummary",
      software_version AS "softwareVersion",
      first_seen_at AS "firstSeenAt",
      last_seen_at AS "lastSeenAt",
      is_archived AS "isArchived",
      archived_at AS "archivedAt",
      archived_reason AS "archivedReason"
    `,
    [
      resolvedNodeId,
      resolvedNodeName,
      resolvedLocationName,
      resolvedStatus,
      resolvedLocalIp,
      resolvedLocalConfigPort,
      resolvedCameraCount,
      JSON.stringify(resolvedCameraSummary),
      resolvedSoftwareVersion
    ]
  );

  return result.rows[0];
}

async function touchNodeFromWebhook(nodeId) {
  const resolvedNodeId = cleanText(nodeId);

  if (!resolvedNodeId) {
    return null;
  }

  const result = await pool.query(
    `
    INSERT INTO nodes (
      node_id,
      node_name,
      location_name,
      status,
      first_seen_at,
      last_seen_at,
      is_archived,
      archived_at,
      archived_reason
    )
    VALUES ($1, 'Good Shepherd Local Node', 'Unassigned Location', 'Pending Setup', NOW(), NOW(), FALSE, NULL, NULL)
    ON CONFLICT (node_id)
    DO UPDATE SET
      last_seen_at = NOW()
    RETURNING
      node_id AS "nodeId",
      node_name AS "nodeName",
      location_name AS "locationName",
      status,
      local_ip AS "localIp",
      local_config_port AS "localConfigPort",
      camera_count AS "cameraCount",
      camera_summary AS "cameraSummary",
      software_version AS "softwareVersion",
      first_seen_at AS "firstSeenAt",
      last_seen_at AS "lastSeenAt",
      is_archived AS "isArchived",
      archived_at AS "archivedAt",
      archived_reason AS "archivedReason"
    `,
    [resolvedNodeId]
  );

  return result.rows[0];
}

app.get("/", async (req, res) => {
  res.json({
    success: true,
    message: "Good Shepherd webhook server is live"
  });
});

app.get("/events", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        node_id AS "nodeId",
        location_name AS "locationName",
        source_key AS "sourceKey",
        source_name AS "sourceName",
        resident_name AS "residentName",
        message,
        alert_level AS "alertLevel",
        time_text AS "timeText",
        timestamp
      FROM webhook_events
      ORDER BY timestamp DESC
      LIMIT $1
      `,
      [MAX_EVENTS]
    );

    res.status(200).json({
      success: true,
      count: result.rows.length,
      events: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch events:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch events"
    });
  }
});

app.get("/nodes", async (req, res) => {
  try {
    const includeArchived = parseBooleanQuery(req.query.includeArchived);

    const result = await pool.query(
      `
      SELECT
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        local_ip AS "localIp",
        local_config_port AS "localConfigPort",
        camera_count AS "cameraCount",
        camera_summary AS "cameraSummary",
        software_version AS "softwareVersion",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      FROM nodes
      WHERE ($1::boolean = TRUE OR is_archived = FALSE)
      ORDER BY is_archived ASC, last_seen_at DESC
      `,
      [includeArchived]
    );

    res.status(200).json({
      success: true,
      includeArchived,
      count: result.rows.length,
      nodes: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch nodes:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch nodes"
    });
  }
});

app.post("/nodes/register", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node registration request"
      });
    }

    const node = await upsertNodeFromRegistration(req.body || {});

    console.log("Node registered/updated:");
    console.log(JSON.stringify(node, null, 2));

    return res.status(200).json({
      success: true,
      message: "Node registered/updated",
      node
    });
  } catch (error) {
    console.error("Node registration failed:", error);
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/nodes/:nodeId", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node update request"
      });
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const existingNode = await getNodeById(nodeId);

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    const requestedNodeName = cleanText(req.body?.nodeName);
    const requestedLocationName = cleanText(req.body?.locationName);
    const requestedStatus = cleanText(req.body?.status);

    const nextNodeName = requestedNodeName || existingNode.nodeName || "Good Shepherd Local Node";
    const nextLocationName = requestedLocationName || existingNode.locationName || "Unassigned Location";
    const nextStatus =
      requestedStatus ||
      (nextLocationName === "Unassigned Location" ? "Pending Setup" : "Active");

    const result = await pool.query(
      `
      UPDATE nodes
      SET
        node_name = $2,
        location_name = $3,
        status = $4,
        last_seen_at = NOW()
      WHERE node_id = $1
      RETURNING
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        local_ip AS "localIp",
        local_config_port AS "localConfigPort",
        camera_count AS "cameraCount",
        camera_summary AS "cameraSummary",
        software_version AS "softwareVersion",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      `,
      [nodeId, nextNodeName, nextLocationName, nextStatus]
    );

    return res.status(200).json({
      success: true,
      message: "Node updated",
      node: result.rows[0]
    });
  } catch (error) {
    console.error("Node update failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/nodes/:nodeId/archive", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node archive request"
      });
    }

    const nodeId = cleanText(req.params.nodeId);
    const archivedReason = cleanText(req.body?.reason) || "Archived from Good Shepherd admin";

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const result = await pool.query(
      `
      UPDATE nodes
      SET
        is_archived = TRUE,
        archived_at = NOW(),
        archived_reason = $2,
        status = CASE
          WHEN status = 'Archived' THEN status
          ELSE 'Archived'
        END,
        last_seen_at = NOW()
      WHERE node_id = $1
      RETURNING
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        local_ip AS "localIp",
        local_config_port AS "localConfigPort",
        camera_count AS "cameraCount",
        camera_summary AS "cameraSummary",
        software_version AS "softwareVersion",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      `,
      [nodeId, archivedReason]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    return res.status(200).json({
      success: true,
      message: "Node archived",
      node: result.rows[0]
    });
  } catch (error) {
    console.error("Node archive failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/nodes/:nodeId/restore", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node restore request"
      });
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const existingNode = await getNodeById(nodeId);

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    const restoredStatus =
      existingNode.locationName === "Unassigned Location" ? "Pending Setup" : "Active";

    const result = await pool.query(
      `
      UPDATE nodes
      SET
        is_archived = FALSE,
        archived_at = NULL,
        archived_reason = NULL,
        status = $2,
        last_seen_at = NOW()
      WHERE node_id = $1
      RETURNING
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        local_ip AS "localIp",
        local_config_port AS "localConfigPort",
        camera_count AS "cameraCount",
        camera_summary AS "cameraSummary",
        software_version AS "softwareVersion",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      `,
      [nodeId, restoredStatus]
    );

    return res.status(200).json({
      success: true,
      message: "Node restored",
      node: result.rows[0]
    });
  } catch (error) {
    console.error("Node restore failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.delete("/nodes/:nodeId", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node delete request"
      });
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const result = await pool.query(
      `
      DELETE FROM nodes
      WHERE node_id = $1
      RETURNING
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      `,
      [nodeId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    return res.status(200).json({
      success: true,
      message: "Node deleted",
      node: result.rows[0]
    });
  } catch (error) {
    console.error("Node delete failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/device-mappings", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        source_key AS "sourceKey",
        source_name AS "sourceName",
        resident_name AS "residentName",
        default_alert_level AS "defaultAlertLevel",
        default_time_text AS "defaultTimeText"
      FROM device_mappings
      ORDER BY source_key ASC
      `
    );

    res.status(200).json({
      success: true,
      count: result.rows.length,
      mappings: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch device mappings:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch device mappings"
    });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const { randomUUID } = require("crypto");

    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized webhook request"
      });
    }

    const {
      nodeId,
      locationName,
      sourceKey,
      sourceName,
      residentName,
      message,
      alertLevel,
      timeText
    } = req.body || {};

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: message"
      });
    }

    const resolvedNodeId = cleanText(nodeId);
    const resolvedLocationName = cleanText(locationName);
    const resolvedSourceKey = cleanText(sourceKey);

    let resolvedSourceName = cleanText(sourceName);
    let resolvedResidentName = cleanText(residentName);
    let resolvedAlertLevel = cleanText(alertLevel);
    let resolvedTimeText = cleanText(timeText);

    if (resolvedSourceKey) {
      const mapping = await getDeviceMapping(resolvedSourceKey);

      if (mapping) {
        if (!resolvedSourceName) {
          resolvedSourceName = mapping.sourceName;
        }

        if (!resolvedResidentName) {
          resolvedResidentName = mapping.residentName;
        }

        if (!resolvedAlertLevel) {
          resolvedAlertLevel = mapping.defaultAlertLevel;
        }

        if (!resolvedTimeText) {
          resolvedTimeText = mapping.defaultTimeText;
        }
      }
    }

    if (!resolvedSourceName || !resolvedResidentName || !resolvedAlertLevel) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields after mapping resolution: sourceName, residentName, alertLevel"
      });
    }

    if (resolvedNodeId) {
      await touchNodeFromWebhook(resolvedNodeId);
    }

    const event = {
      id: randomUUID(),
      nodeId: resolvedNodeId || null,
      locationName: resolvedLocationName || null,
      sourceKey: resolvedSourceKey || null,
      sourceName: resolvedSourceName,
      residentName: resolvedResidentName,
      message: String(message).trim(),
      alertLevel: resolvedAlertLevel,
      timeText: resolvedTimeText || "Webhook Event",
      timestamp: new Date().toISOString()
    };

    await pool.query(
      `
      INSERT INTO webhook_events (
        id,
        node_id,
        location_name,
        source_key,
        source_name,
        resident_name,
        message,
        alert_level,
        time_text,
        timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        event.id,
        event.nodeId,
        event.locationName,
        event.sourceKey,
        event.sourceName,
        event.residentName,
        event.message,
        event.alertLevel,
        event.timeText,
        event.timestamp
      ]
    );

    await pool.query(
      `
      DELETE FROM webhook_events
      WHERE id IN (
        SELECT id
        FROM webhook_events
        ORDER BY timestamp DESC
        OFFSET $1
      )
      `,
      [MAX_EVENTS]
    );

    console.log("Webhook event received:");
    console.log(JSON.stringify(event, null, 2));

    return res.status(200).json({
      success: true,
      message: "Webhook event received",
      event
    });
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Good Shepherd webhook server running on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });