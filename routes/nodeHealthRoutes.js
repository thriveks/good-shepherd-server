"use strict";

/*
 * Good Shepherd node-health routes.
 *
 * Extracted mechanically from server.js.
 * Route behavior, response bodies, SQL calls, authorization,
 * logging, and error handling are intentionally unchanged.
 */

function registerNodeHealthRoutes({
  app,
  pool,
  NODE_OFFLINE_AFTER_SECONDS,
  requireAuthorizedRequest,
  cleanText,
  nodeHealthSelectSQL,
  isAuthorizedWebhook,
  upsertNodeHealth
}) {

app.get("/node-health", async (req, res) => {
  try {
    if (!(await requireAuthorizedRequest(req, res))) {
      return;
    }

    const result = await pool.query(
      `
      ${nodeHealthSelectSQL()}
      ORDER BY checked_in_at DESC
      `
    );

    return res.status(200).json({
      success: true,
      count: result.rows.length,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
      health: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch node health:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch node health"
    });
  }
});

app.get("/node-health/:nodeId", async (req, res) => {
  try {
    if (!(await requireAuthorizedRequest(req, res))) {
      return;
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
      ${nodeHealthSelectSQL()}
      WHERE node_id = $1
      LIMIT 1
      `,
      [nodeId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Node health not found: ${nodeId}`
      });
    }

    return res.status(200).json({
      success: true,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
      health: result.rows[0]
    });
  } catch (error) {
    console.error("Failed to fetch node health:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch node health"
    });
  }
});

app.post("/node-health", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized node health request"
      });
    }

    const health = await upsertNodeHealth(req.body || {});

    console.log("Node health updated:");
    console.log(JSON.stringify({
      nodeId: health.nodeId,
      locationName: health.locationName,
      monitorStatus: health.monitorStatus,
      ffmpegStatus: health.ffmpegStatus,
      cameraCount: health.cameraCount,
      activeMonitorCount: health.activeMonitorCount,
      softwareVersion: health.softwareVersion,
      lastError: health.lastError || null
    }, null, 2));

    return res.status(200).json({
      success: true,
      message: "Node health updated",
      health
    });
  } catch (error) {
    console.error("Node health update failed:", error);
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
});

}

module.exports = {
  registerNodeHealthRoutes
};
