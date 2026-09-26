"use strict";

const mqtt = require("mqtt");
const { randomUUID } = require("crypto");

const {
  createHumanPresenceMqttIngestion
} = require("../services/humanPresenceMqttIngestion");

const MQTT_BRIDGE_VERSION = "v2.3-mqtt-direct-services";
const GLOBAL_DISPATCH_CONCURRENCY = 8;

function createMqttV2Bridge({
  pool,
  mqttConfig,
  nodeOfflineAfterSeconds,
  esp32SensorCommandTypes,
  sensorCommandOtaPendingExpirationMinutes,
  sensorCommandExpirationMinutes,
  cleanText,
  normalizeJsonObject,
  normalizeEsp32SensorCommandType,
  isEsp32NodeId,
  readPayloadBoolean,
  logStructuredDiagnostic,
  upsertNodeFromRegistration,
  upsertNodeHealth,
  processWebhookEvent,
  saveSensorCommandResult,
  logger = console
}) {
  let client = null;
  const nodeMessageChains = new Map();

  const humanPresence = createHumanPresenceMqttIngestion({
    pool,
    cleanText,
    normalizeJsonObject,
    logger
  });

  function commandTopic(nodeId) {
    return `good-shepherd/v2/nodes/${cleanText(nodeId)}/commands`;
  }

  function commandEnvelope(command) {
    return {
      protocolVersion: "2.0",
      nodeId: cleanText(command?.nodeId),
      commandId: cleanText(command?.commandId),
      commandType: cleanText(command?.commandType),
      payload: normalizeJsonObject(command?.payload),
      requestedBy: cleanText(command?.requestedBy) || null,
      requestedAt: command?.requestedAt || null
    };
  }

  function isConnected() {
    return Boolean(client && client.connected);
  }

  async function nodeIsOnline(nodeId) {
    const resolvedNodeId = cleanText(nodeId);
    if (!resolvedNodeId) return false;

    const result = await pool.query(
      `
      SELECT
        CASE
          WHEN LOWER(COALESCE(monitor_status, '')) = 'offline' THEN FALSE
          WHEN checked_in_at >= NOW() - ($2::int * INTERVAL '1 second') THEN TRUE
          ELSE FALSE
        END AS "isOnline"
      FROM node_health
      WHERE node_id = $1
      LIMIT 1
      `,
      [resolvedNodeId, nodeOfflineAfterSeconds]
    );

    return result.rows[0]?.isOnline === true;
  }

  async function publishSensorCommand(command) {
    const commandId = cleanText(command?.commandId);
    const nodeId = cleanText(command?.nodeId);
    const commandType = normalizeEsp32SensorCommandType(
      command?.commandType
    );

    if (!commandId || !nodeId || !commandType || !isEsp32NodeId(nodeId)) {
      return { published: false, reason: "invalid_command" };
    }

    if (
      commandType === "update_firmware" &&
      !(await nodeIsOnline(nodeId))
    ) {
      return { published: false, reason: "node_offline" };
    }

    if (!isConnected()) {
      return { published: false, reason: "bridge_not_connected" };
    }

    const claimResult = await pool.query(
      `
      UPDATE node_commands
      SET
        status = 'running',
        picked_up_at = COALESCE(picked_up_at, NOW()),
        completed_at = NULL,
        error = NULL
      WHERE command_id = $1
        AND node_id = $2
        AND status = 'pending'
      RETURNING
        command_id AS "commandId",
        node_id AS "nodeId",
        command_type AS "commandType",
        payload,
        status,
        requested_by AS "requestedBy",
        requested_at AS "requestedAt",
        picked_up_at AS "pickedUpAt",
        completed_at AS "completedAt",
        result,
        error
      `,
      [commandId, nodeId]
    );

    const claimedCommand = claimResult.rows[0] || null;
    if (!claimedCommand) {
      return { published: false, reason: "not_pending" };
    }

    const topic = commandTopic(nodeId);
    const body = JSON.stringify(commandEnvelope(claimedCommand));

    try {
      await new Promise((resolve, reject) => {
        client.publish(
          topic,
          body,
          { qos: 1, retain: false },
          (error) => error ? reject(error) : resolve()
        );
      });

      logStructuredDiagnostic("COMMAND_CLAIM", "info", {
        commandId,
        nodeId,
        commandType,
        runner: "mqtt",
        route: "mqtt-v2-command-publish",
        newStatus: "running",
        requestedAt: claimedCommand.requestedAt,
        pickedUpAt: claimedCommand.pickedUpAt
      });

      return {
        published: true,
        topic,
        command: claimedCommand
      };
    } catch (error) {
      await pool.query(
        `
        UPDATE node_commands
        SET
          status = 'pending',
          picked_up_at = NULL,
          error = NULL
        WHERE command_id = $1
          AND status = 'running'
          AND completed_at IS NULL
        `,
        [commandId]
      );

      logger.error?.(
        "MQTT V2 command publish failed; command returned to pending:",
        {
          nodeId,
          commandId,
          commandType,
          error: error?.message || String(error)
        }
      );

      return {
        published: false,
        reason: "publish_failed",
        error: error?.message || String(error)
      };
    }
  }

  async function runNodeQueuesWithConcurrency(queues, concurrency) {
    const entries = Array.from(queues.values());
    let cursor = 0;
    let publishedCount = 0;

    async function worker() {
      while (cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        const commands = entries[index];

        for (const command of commands) {
          const dispatch = await publishSensorCommand(command);
          if (dispatch.published) publishedCount += 1;
        }
      }
    }

    const workerCount = Math.min(
      Math.max(1, concurrency),
      Math.max(1, entries.length)
    );

    await Promise.all(
      Array.from({ length: workerCount }, () => worker())
    );

    return publishedCount;
  }

  async function dispatchPendingSensorCommands(
    limit = 100,
    targetNodeId = ""
  ) {
    if (!isConnected()) return 0;

    const resolvedTargetNodeId = cleanText(targetNodeId);
    const result = await pool.query(
      `
      SELECT
        command_id AS "commandId",
        node_id AS "nodeId",
        command_type AS "commandType",
        payload,
        status,
        requested_by AS "requestedBy",
        requested_at AS "requestedAt",
        picked_up_at AS "pickedUpAt",
        completed_at AS "completedAt",
        result,
        error
      FROM node_commands
      WHERE status = 'pending'
        AND node_id LIKE 'esp32-%'
        AND command_type = ANY($1::text[])
        AND ($2::text = '' OR node_id = $2)
        AND (
          (command_type = 'update_firmware'
            AND requested_at >= NOW() - ($3::int * INTERVAL '1 minute'))
          OR
          (command_type <> 'update_firmware'
            AND requested_at >= NOW() - ($4::int * INTERVAL '1 minute'))
        )
      ORDER BY requested_at ASC
      LIMIT $5
      `,
      [
        esp32SensorCommandTypes,
        resolvedTargetNodeId,
        sensorCommandOtaPendingExpirationMinutes,
        sensorCommandExpirationMinutes,
        limit
      ]
    );

    const queues = new Map();
    for (const command of result.rows) {
      const nodeId = cleanText(command.nodeId);
      if (!queues.has(nodeId)) queues.set(nodeId, []);
      queues.get(nodeId).push(command);
    }

    const concurrency = resolvedTargetNodeId
      ? 1
      : GLOBAL_DISPATCH_CONCURRENCY;

    const publishedCount = await runNodeQueuesWithConcurrency(
      queues,
      concurrency
    );

    if (publishedCount > 0) {
      logger.log?.(
        `MQTT V2 pending command dispatch complete: ${publishedCount} command(s) published.`
      );
    }

    return publishedCount;
  }

  async function reconcileSuccessfulOta(nodeId, reportedSoftwareVersion) {
    const resolvedNodeId = cleanText(nodeId);
    const resolvedVersion = cleanText(reportedSoftwareVersion);

    if (!resolvedNodeId || !resolvedVersion) return null;

    const result = await pool.query(
      `
      WITH target AS (
        SELECT command_id
        FROM node_commands
        WHERE node_id = $1
          AND command_type = 'update_firmware'
          AND status = 'running'
          AND COALESCE(payload->>'firmwareVersion', '') = $2
        ORDER BY requested_at DESC
        LIMIT 1
      )
      UPDATE node_commands AS c
      SET
        status = 'success',
        completed_at = NOW(),
        error = NULL,
        result = COALESCE(c.result, '{}'::jsonb) ||
          jsonb_build_object(
            'transport', 'mqtt-status-verification',
            'nodeId', $1::text,
            'commandType', 'update_firmware',
            'message', 'Firmware update verified after reboot.',
            'reportedFirmwareVersion', $2::text,
            'verifiedAt', NOW()
          )
      FROM target
      WHERE c.command_id = target.command_id
      RETURNING
        c.command_id AS "commandId",
        c.node_id AS "nodeId",
        c.status,
        c.completed_at AS "completedAt",
        c.payload,
        c.result
      `,
      [resolvedNodeId, resolvedVersion]
    );

    return result.rows[0] || null;
  }

  async function markNodeOffline(nodeId, payload = {}) {
    await pool.query(
      `
      UPDATE node_health
      SET
        monitor_status = 'Offline',
        diagnostics = COALESCE(diagnostics, '{}'::jsonb) ||
          jsonb_build_object(
            'mqttOffline', true,
            'mqttOfflineAt', NOW(),
            'mqttProtocolVersion', $2::text
          ),
        updated_at = NOW()
      WHERE node_id = $1
      `,
      [
        nodeId,
        cleanText(payload?.protocolVersion) || "2.0"
      ]
    );
  }

  async function ingestStatus(nodeId, payload) {
    await upsertNodeFromRegistration({
      nodeId,
      nodeName: payload.nodeName,
      locationName: payload.locationName,
      localIp: payload.localIp,
      localConfigPort: 80,
      cameraCount: 0,
      cameraSummary: [],
      setupId: payload.setupId,
      assignmentState: payload.assignmentState,
      softwareVersion: payload.softwareVersion,
      sensorMode: payload.sensorMode,
      sourceKey: payload.sourceKey,
      presenceInput: "GPIO21"
    });

    if (payload.online === true) {
      await upsertNodeHealth({
        nodeId,
        nodeName: payload.nodeName,
        locationName: payload.locationName,
        monitorStatus: "Online",
        ffmpegStatus: "Not Applicable",
        cameraCount: 0,
        activeMonitorCount: 1,
        softwareVersion: payload.softwareVersion,
        localIp: payload.localIp,
        sensorMode: payload.sensorMode,
        sourceKey: payload.sourceKey,
        setupId: payload.setupId,
        assignmentState: payload.assignmentState,
        wifiSsid: payload.wifiSsid,
        wifiRssi: payload.wifiRssi,
        uptimeSeconds: payload.uptimeSeconds,
        diagnostics: {
          transport: "mqtt",
          mqttProtocolVersion: payload.protocolVersion || "2.0",
          presence: readPayloadBoolean(payload, "presence")
        }
      });

      await reconcileSuccessfulOta(nodeId, payload.softwareVersion);
      await dispatchPendingSensorCommands(25, nodeId);
      return;
    }

    if (payload.online === false) {
      await markNodeOffline(nodeId, payload);
    }
  }

  function normalizeCommandResultStatus(value) {
    const normalized = cleanText(value).toLowerCase();
    return ["running", "success", "failed"].includes(normalized)
      ? normalized
      : "";
  }

  async function ingestResult(nodeId, payload) {
    const commandId = cleanText(payload?.commandId);
    const status = normalizeCommandResultStatus(payload?.status);

    if (!commandId) {
      logger.warn?.("MQTT V2 result ignored: missing commandId", { nodeId });
      return;
    }

    if (!status) {
      logger.warn?.("MQTT V2 nonterminal/unsupported result:", {
        nodeId,
        commandId,
        commandType: cleanText(payload?.commandType) || null,
        status: cleanText(payload?.status) || null,
        message: cleanText(payload?.message) || null
      });
      return;
    }

    const resultPayload = {
      transport: "mqtt",
      nodeId,
      commandType: cleanText(payload?.commandType) || null,
      message: cleanText(payload?.message) || null,
      raw: payload
    };

    const outcome = await saveSensorCommandResult({
      commandId,
      status,
      resultPayload,
      error: status === "failed"
        ? (cleanText(payload?.message) || "MQTT command failed")
        : null,
      route: "mqtt-v2-result"
    });

    if (outcome.statusCode >= 400) {
      throw new Error(outcome.message);
    }
  }

  async function ingestEvent(nodeId, payload) {
    const eventType = cleanText(payload?.eventType).toLowerCase();

    if (eventType === "high_resolution_activity_evidence") {
      await humanPresence.ingestHighResolutionActivityEvidence(
        nodeId,
        payload
      );
      return;
    }

    if (eventType === "candidate_history_evidence") {
      await humanPresence.ingestCandidateHistoryEvidence(nodeId, payload);
      return;
    }

    await processWebhookEvent({
      ...payload,
      nodeId
    });
  }

  function enqueueNodeMessage(nodeId, task) {
    const previous = nodeMessageChains.get(nodeId) || Promise.resolve();

    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (nodeMessageChains.get(nodeId) === next) {
          nodeMessageChains.delete(nodeId);
        }
      });

    nodeMessageChains.set(nodeId, next);
    return next;
  }

  function configurationIssues() {
    if (!mqttConfig?.enabled) return [];

    const issues = [];
    if (!mqttConfig.host) issues.push("MQTT_HOST");
    if (!mqttConfig.username) issues.push("MQTT_USERNAME");
    if (!mqttConfig.password) issues.push("MQTT_PASSWORD");
    return issues;
  }

  function start() {
    if (!mqttConfig?.enabled) {
      logger.log?.("Good Shepherd V2 MQTT bridge disabled by configuration.");
      return false;
    }

    const missing = configurationIssues();
    if (missing.length) {
      logger.error?.(
        `Good Shepherd V2 MQTT bridge not started: missing ${missing.join(", ")}.`
      );
      return false;
    }

    client = mqtt.connect(
      `mqtts://${mqttConfig.host}:${mqttConfig.port}`,
      {
        username: mqttConfig.username,
        password: mqttConfig.password,
        protocolVersion: 4,
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        clean: true,
        clientId: `good-shepherd-server-${randomUUID().slice(0, 8)}`
      }
    );

    client.on("connect", () => {
      logger.log?.(
        `Good Shepherd V2 MQTT bridge ${MQTT_BRIDGE_VERSION} connected to ${mqttConfig.host}:${mqttConfig.port}`
      );

      client.subscribe(
        [
          "good-shepherd/v2/nodes/+/status",
          "good-shepherd/v2/nodes/+/events",
          "good-shepherd/v2/nodes/+/results"
        ],
        { qos: 1 },
        (error, granted) => {
          if (error) {
            logger.error?.(
              "Good Shepherd V2 MQTT subscribe failed:",
              error.message
            );
            return;
          }

          logger.log?.(
            "Good Shepherd V2 MQTT subscriptions active:",
            (granted || []).map((item) => item.topic).join(", ")
          );
        }
      );

      dispatchPendingSensorCommands().catch((error) => {
        logger.error?.(
          "MQTT V2 pending command dispatch failed:",
          error?.message || String(error)
        );
      });
    });

    client.on("reconnect", () => {
      logger.log?.("Good Shepherd V2 MQTT bridge reconnecting...");
    });

    client.on("offline", () => {
      logger.warn?.("Good Shepherd V2 MQTT bridge client is offline.");
    });

    client.on("message", (topic, raw) => {
      let payload;

      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        logger.error?.("MQTT V2 parse failed:", topic, error.message);
        return;
      }

      const parts = topic.split("/");
      const nodeId = cleanText(payload?.nodeId || parts[3]);
      const channel = cleanText(parts[4]).toLowerCase();

      if (!nodeId) {
        logger.warn?.("MQTT V2 message ignored: no nodeId", topic);
        return;
      }

      enqueueNodeMessage(nodeId, async () => {
        if (channel === "status") {
          await ingestStatus(nodeId, payload);
          return;
        }
        if (channel === "events") {
          await ingestEvent(nodeId, payload);
          return;
        }
        if (channel === "results") {
          await ingestResult(nodeId, payload);
          return;
        }

        logger.warn?.("MQTT V2 unknown channel ignored:", topic);
      }).catch((error) => {
        logger.error?.(
          "MQTT V2 bridge handling failed:",
          topic,
          error?.message || String(error)
        );
      });
    });

    client.on("error", (error) => {
      logger.error?.(
        "Good Shepherd V2 MQTT bridge error:",
        error.message
      );
    });

    return true;
  }

  function stop() {
    if (!client) return;
    try {
      client.end(true);
    } finally {
      client = null;
      nodeMessageChains.clear();
    }
  }

  return {
    start,
    stop,
    isConnected,
    publishSensorCommand,
    dispatchPendingSensorCommands,
    ingestStatus,
    ingestEvent,
    ingestResult,
    configurationIssues,
    getPendingNodeChainCount: () => nodeMessageChains.size
  };
}

module.exports = {
  MQTT_BRIDGE_VERSION,
  GLOBAL_DISPATCH_CONCURRENCY,
  createMqttV2Bridge
};
