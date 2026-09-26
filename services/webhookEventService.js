"use strict";

const { randomUUID } = require("crypto");

class WebhookValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "WebhookValidationError";
    this.statusCode = statusCode;
  }
}

function createWebhookEventService({
  pool,
  cleanText,
  normalizeJsonObject,
  normalizeWebhookEventTypeFromPayload,
  normalizeWebhookSensorTypeFromPayload,
  displaySensorTypeForValue,
  getDeviceMapping,
  touchNodeFromWebhook,
  getExistingSensorForDeviceIdentity,
  assignmentAuthorityProtectsServerState,
  sensorIsExplicitlyUnassigned,
  isEsp32NodeId,
  findOrCreateResidentFromEvent,
  upsertSensorFromEvent,
  getResidentById,
  recordMotionHistoryEvent,
  incrementResidentDailyActivity,
  scheduleAIDashboardRefresh,
  logStructuredDiagnostic,
  logger = console
}) {
  let acceptedWebhookCount = 0;

  async function processWebhookEvent(body) {
    const {
      nodeId,
      locationName,
      sourceKey,
      sourceName,
      residentName,
      message,
      alertLevel,
      timeText,
      sensorType,
      sensorMode
    } = body || {};

    if (!message) {
      throw new WebhookValidationError("Missing required field: message");
    }

    const resolvedNodeId = cleanText(nodeId);
    let resolvedLocationName = cleanText(locationName);
    const resolvedSourceKey = cleanText(sourceKey);

    let resolvedSourceName = cleanText(sourceName);
    let resolvedResidentName = cleanText(residentName);
    let resolvedAlertLevel = cleanText(alertLevel);
    let resolvedTimeText = cleanText(timeText);
    const fullWebhookPayload = normalizeJsonObject(body || {});
    const resolvedEventType =
      normalizeWebhookEventTypeFromPayload(fullWebhookPayload);
    const resolvedSensorType =
      normalizeWebhookSensorTypeFromPayload(fullWebhookPayload, "unknown");
    const resolvedSensorDisplayType = displaySensorTypeForValue(
      resolvedSensorType || sensorType || sensorMode || sourceName,
      "Motion Sensor"
    );

    if (!fullWebhookPayload.eventType) {
      fullWebhookPayload.eventType = resolvedEventType;
    }

    if (resolvedSensorType && !fullWebhookPayload.sensorType) {
      fullWebhookPayload.sensorType = resolvedSensorType;
    }

    if (resolvedSourceKey) {
      const mapping = await getDeviceMapping(resolvedSourceKey);

      if (mapping) {
        if (!resolvedSourceName) resolvedSourceName = mapping.sourceName;
        if (!resolvedResidentName) resolvedResidentName = mapping.residentName;
        if (!resolvedAlertLevel) resolvedAlertLevel = mapping.defaultAlertLevel;
        if (!resolvedTimeText) resolvedTimeText = mapping.defaultTimeText;
      }
    }

    if (!resolvedSourceName || !resolvedResidentName || !resolvedAlertLevel) {
      throw new WebhookValidationError(
        "Missing required fields after mapping resolution: sourceName, residentName, alertLevel"
      );
    }

    if (resolvedNodeId) {
      await touchNodeFromWebhook(resolvedNodeId);
    }

    const existingSensor = await getExistingSensorForDeviceIdentity({
      sourceKey: resolvedSourceKey,
      nodeId: resolvedNodeId
    });

    const preserveServerAssignment = Boolean(
      existingSensor &&
      assignmentAuthorityProtectsServerState(
        existingSensor.assignmentAuthority
      )
    );
    const preserveUnassignedState =
      preserveServerAssignment &&
      sensorIsExplicitlyUnassigned(existingSensor);

    let resident = existingSensor?.residentId
      ? await getResidentById(existingSensor.residentId)
      : null;

    if (preserveUnassignedState) {
      resolvedResidentName = "Unassigned";
      resolvedLocationName = "Unassigned location";
    } else if (resident && preserveServerAssignment) {
      resolvedResidentName = resident.name;
      resolvedLocationName =
        resolvedLocationName || resident.location || "";
    } else if (isEsp32NodeId(resolvedNodeId)) {
      resident = null;
      resolvedResidentName = "Unassigned";
      resolvedLocationName = "Unassigned location";
    } else {
      resident = await findOrCreateResidentFromEvent({
        residentName: resolvedResidentName,
        locationName: resolvedLocationName,
        alertLevel: resolvedAlertLevel,
        message
      });
    }

    const sensor = await upsertSensorFromEvent({
      nodeId: resolvedNodeId,
      sourceKey: resolvedSourceKey,
      sourceName: preserveUnassignedState
        ? (existingSensor?.sourceName || resolvedSourceName)
        : resolvedSourceName,
      sensorType: resolvedSensorDisplayType,
      sensorMode,
      resident,
      residentName: resolvedResidentName,
      locationName: resolvedLocationName,
      forceUnassigned: preserveUnassignedState,
      allowDeviceBootstrap: false,
      assignmentPayload: fullWebhookPayload
    });

    if (sensor && isEsp32NodeId(resolvedNodeId)) {
      resolvedSourceName = sensor.sourceName;
      resolvedResidentName = sensor.residentName;
      resolvedLocationName = sensor.locationName;
      resident = sensor.residentId
        ? (resident?.id === sensor.residentId
            ? resident
            : await getResidentById(sensor.residentId))
        : null;
    }

    const event = {
      id: randomUUID(),
      nodeId: resolvedNodeId || null,
      locationName: resolvedLocationName || null,
      sourceKey: sensor?.sourceKey || resolvedSourceKey || null,
      sourceName: resolvedSourceName,
      residentName: resolvedResidentName,
      message: String(message).trim(),
      alertLevel: resolvedAlertLevel,
      timeText: resolvedTimeText || "Webhook Event",
      timestamp: new Date().toISOString(),
      eventType: resolvedEventType,
      sensorType: resolvedSensorType,
      eventPayload: fullWebhookPayload
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
        timestamp,
        event_type,
        sensor_type,
        event_payload,
        acknowledged,
        acknowledged_at,
        resolution_note
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, FALSE, NULL, NULL)
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
        event.timestamp,
        event.eventType,
        event.sensorType,
        JSON.stringify(event.eventPayload)
      ]
    );

    const motionHistoryEvent = await recordMotionHistoryEvent({
      event,
      resident,
      sensor
    });

    if (motionHistoryEvent) {
      setImmediate(() => {
        incrementResidentDailyActivity({ resident, event, sensor })
          .catch((error) => {
            logger.error?.(
              "Resident daily activity aggregation failed:",
              {
                residentId: resident?.id || null,
                eventId: event?.id || null,
                error: error?.message || String(error)
              }
            );
          });
      });
    }

    const shouldInvalidateCustomerAI =
      Boolean(resident?.id) &&
      ["presence_detected", "presence_cleared"].includes(
        cleanText(event.eventType).toLowerCase()
      );

    scheduleAIDashboardRefresh(
      shouldInvalidateCustomerAI
        ? {
            residentId: resident.id,
            reason: event.eventType
          }
        : null
    );

    acceptedWebhookCount += 1;
    if (
      acceptedWebhookCount === 1 ||
      acceptedWebhookCount % 100 === 0
    ) {
      logStructuredDiagnostic(
        "EVENT_RETENTION_DEFERRED",
        "info",
        {
          rowCount: acceptedWebhookCount,
          reason: "request_time_deletion_disabled"
        }
      );
    }

    return {
      event,
      motionHistoryEvent,
      resident,
      sensor
    };
  }

  return {
    processWebhookEvent,
    getAcceptedWebhookCount: () => acceptedWebhookCount
  };
}

module.exports = {
  WebhookValidationError,
  createWebhookEventService
};
