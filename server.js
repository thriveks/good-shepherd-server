// server.js
// Good Shepherd webhook and AI backend
//
// Version: v11.6 - AI Effective Sensor Online Fix
// Updated: 2026-07-11
// iOS Dependency: NearbyBLESensorSyncView human presence assignment flow + AppSetupSyncService sensor assignment payload
//
// Fixes human_presence sensor assignment persistence by making source_key authoritative
// before falling back to node_id, derives presence-[chipId] from human_presence assignment
// payloads, avoids stale motion-[chipId] rows from forcing presence sensors back to
// unassigned, and preserves full LD2410 radar telemetry payloads.

const express = require("express");
const { Pool } = require("pg");
const { randomUUID } = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_EVENTS = 50;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MIN_IOS_APP_BUILD = 1;
const NODE_OFFLINE_AFTER_SECONDS = 180;
const AI_SENSOR_MOTION_ONLINE_GRACE_SECONDS = 600;
const AI_SENSOR_EVENT_ONLINE_GRACE_SECONDS = 3600;
const AI_INACTIVE_WATCH_MINUTES = 120;
const AI_INACTIVE_WARNING_MINUTES = 240;
const AI_INACTIVE_CRITICAL_MINUTES = 480;
const AI_MOTION_HISTORY_DAYS = 30;
const AI_MOTION_HISTORY_EVENT_LIMIT = 5000;
const AI_BASELINE_MIN_DAYS = 3;
const AI_BASELINE_QUIET_RATIO = 0.5;
const AI_BASELINE_ACTIVE_RATIO = 1.75;
const AI_TIME_ZONE = process.env.AI_TIME_ZONE || "America/Chicago";
const SENSOR_COMMAND_EXPIRATION_MINUTES = 5;
const ESP32_SENSOR_COMMAND_TYPES = ["reconfigure", "update_firmware", "identify", "locate", "ping", "reboot", "factory_reset"];
const FIRMWARE_GITHUB_OWNER = process.env.FIRMWARE_GITHUB_OWNER || "thriveks";
const FIRMWARE_GITHUB_REPO = process.env.FIRMWARE_GITHUB_REPO || "good-shepherd-esp32-firmware";
const FIRMWARE_DOWNLOAD_ASSET_NAME = process.env.FIRMWARE_DOWNLOAD_ASSET_NAME || "good_shepherd_esp32_motion.ino.bin";
const MAX_FIRMWARE_DOWNLOAD_REDIRECTS = 8;
const FIRMWARE_DOWNLOAD_TIMEOUT_MS = 120000;

app.use(express.json({ limit: "25mb" }));

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

  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS node_id TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS location_name TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS source_key TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS resolution_note TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS event_type TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS sensor_type TEXT`);
  await pool.query(`ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS event_payload JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`CREATE INDEX IF NOT EXISTS webhook_events_event_type_timestamp_idx ON webhook_events (event_type, timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS webhook_events_source_key_event_type_timestamp_idx ON webhook_events (source_key, event_type, timestamp DESC)`);

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

  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS archived_reason TEXT`);
  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS wifi_ssid TEXT`);
  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS wifi_rssi INTEGER`);
  await pool.query(`ALTER TABLE nodes ADD COLUMN IF NOT EXISTS setup_state TEXT NOT NULL DEFAULT 'unassigned'`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS node_health (
      node_id TEXT PRIMARY KEY,
      node_name TEXT,
      location_name TEXT,
      local_ip TEXT,
      local_config_port INTEGER,
      camera_count INTEGER NOT NULL DEFAULT 0,
      camera_summary JSONB,
      software_version TEXT,
      monitor_status TEXT NOT NULL DEFAULT 'Unknown',
      ffmpeg_status TEXT NOT NULL DEFAULT 'Unknown',
      ffmpeg_path TEXT,
      platform TEXT,
      hostname TEXT,
      uptime_seconds INTEGER,
      active_monitor_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_at TIMESTAMPTZ,
      diagnostics JSONB,
      checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS node_health_checked_in_at_idx ON node_health (checked_in_at)`);
  await pool.query(`ALTER TABLE node_health ADD COLUMN IF NOT EXISTS wifi_ssid TEXT`);
  await pool.query(`ALTER TABLE node_health ADD COLUMN IF NOT EXISTS wifi_rssi INTEGER`);
  await pool.query(`ALTER TABLE node_health ADD COLUMN IF NOT EXISTS setup_state TEXT NOT NULL DEFAULT 'unassigned'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS node_health_monitor_status_idx ON node_health (monitor_status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS node_commands (
      command_id UUID PRIMARY KEY,
      node_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      picked_up_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      result JSONB,
      error TEXT
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS node_commands_node_id_status_idx ON node_commands (node_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS node_commands_requested_at_idx ON node_commands (requested_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS firmware_releases (
      id UUID PRIMARY KEY,
      firmware_version TEXT NOT NULL UNIQUE,
      firmware_url TEXT NOT NULL,
      sha256 TEXT,
      release_notes TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS firmware_releases_is_active_idx ON firmware_releases (is_active)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS firmware_releases_created_at_idx ON firmware_releases (created_at)`);

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
    CREATE TABLE IF NOT EXISTS residents (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT 'Unassigned location',
      alert_level TEXT NOT NULL DEFAULT 'Normal',
      last_activity TEXT NOT NULL DEFAULT 'Resident added. Waiting for first device event.',
      active_warnings INTEGER NOT NULL DEFAULT 0,
      status_text TEXT NOT NULL DEFAULT 'Monitoring setup pending',
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cameras (
      id UUID PRIMARY KEY,
      source_key TEXT NOT NULL,
      source_name TEXT NOT NULL,
      resident_id UUID REFERENCES residents(id) ON DELETE SET NULL,
      resident_name TEXT NOT NULL DEFAULT 'Unassigned',
      rtsp_url TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      assigned_node_id TEXT,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE cameras ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE cameras ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE cameras ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE cameras ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE residents ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE residents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE residents ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE residents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS residents_is_deleted_idx ON residents (is_deleted)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cameras_is_deleted_idx ON cameras (is_deleted)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cameras_resident_id_idx ON cameras (resident_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS cameras_assigned_node_id_idx ON cameras (assigned_node_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensors (
      id UUID PRIMARY KEY,
      node_id TEXT,
      source_key TEXT NOT NULL UNIQUE,
      source_name TEXT NOT NULL,
      sensor_type TEXT NOT NULL DEFAULT 'Motion Sensor',
      resident_id UUID REFERENCES residents(id) ON DELETE SET NULL,
      resident_name TEXT NOT NULL DEFAULT 'Unassigned',
      location_name TEXT NOT NULL DEFAULT 'Unassigned location',
      room_name TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS node_id TEXT`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS source_key TEXT`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS source_name TEXT`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS sensor_type TEXT NOT NULL DEFAULT 'Motion Sensor'`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS resident_id UUID REFERENCES residents(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS resident_name TEXT NOT NULL DEFAULT 'Unassigned'`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS location_name TEXT NOT NULL DEFAULT 'Unassigned location'`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS room_name TEXT`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sensors_source_key_unique_idx ON sensors (source_key)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sensors_resident_id_idx ON sensors (resident_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sensors_node_id_idx ON sensors (node_id)`);
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS setup_state TEXT NOT NULL DEFAULT 'unassigned'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS sensors_is_deleted_idx ON sensors (is_deleted)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS motion_events (
      id UUID PRIMARY KEY,
      webhook_event_id UUID,
      resident_id UUID REFERENCES residents(id) ON DELETE SET NULL,
      resident_name TEXT NOT NULL,
      location_name TEXT,
      sensor_id UUID REFERENCES sensors(id) ON DELETE SET NULL,
      node_id TEXT,
      source_key TEXT,
      source_name TEXT NOT NULL,
      room_name TEXT,
      message TEXT NOT NULL,
      alert_level TEXT NOT NULL DEFAULT 'Normal',
      time_text TEXT NOT NULL DEFAULT 'Motion Event',
      event_timestamp TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS motion_events_resident_id_timestamp_idx ON motion_events (resident_id, event_timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS motion_events_resident_name_timestamp_idx ON motion_events (LOWER(TRIM(resident_name)), event_timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS motion_events_source_key_timestamp_idx ON motion_events (source_key, event_timestamp DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS motion_events_event_timestamp_idx ON motion_events (event_timestamp DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS motion_events_webhook_event_id_unique_idx ON motion_events (webhook_event_id) WHERE webhook_event_id IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_action_logs (
      id UUID PRIMARY KEY,
      resident_id UUID REFERENCES residents(id) ON DELETE SET NULL,
      resident_name TEXT NOT NULL,
      action_level TEXT NOT NULL,
      action_title TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'completed',
      action_note TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS ai_action_logs_resident_id_created_at_idx ON ai_action_logs (resident_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_action_logs_resident_name_created_at_idx ON ai_action_logs (LOWER(TRIM(resident_name)), created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_action_logs_created_at_idx ON ai_action_logs (created_at DESC)`);

  await pool.query(`
    INSERT INTO device_mappings (
      source_key,
      source_name,
      resident_name,
      default_alert_level,
      default_time_text
    )
    VALUES (
      'thrive-office-wyze',
      'Office Wyze Camera',
      'Mary Thompson',
      'Caution',
      'Office Motion Event'
    )
    ON CONFLICT (source_key) DO NOTHING
  `);
}

function cleanText(value) {
  return value ? String(value).trim() : "";
}

function cleanOptionalText(value) {
  const cleaned = cleanText(value);
  return cleaned || null;
}

function parseBooleanQuery(value) {
  const cleanValue = cleanText(value).toLowerCase();
  return cleanValue === "true" || cleanValue === "1" || cleanValue === "yes";
}

function normalizeAlertLevel(value) {
  const cleanValue = cleanText(value);

  if (!cleanValue) {
    return "Normal";
  }

  const lowerValue = cleanValue.toLowerCase();

  if (lowerValue === "critical") {
    return "Critical";
  }

  if (lowerValue === "caution") {
    return "Caution";
  }

  return "Normal";
}

function warningCountForAlertLevel(alertLevel) {
  switch (normalizeAlertLevel(alertLevel)) {
    case "Critical":
      return 2;
    case "Caution":
      return 1;
    case "Normal":
    default:
      return 0;
  }
}

function validUuidOrGenerated(value) {
  const cleanValue = cleanText(value);
  return cleanValue || randomUUID();
}

function normalizeHealthText(value, fallback) {
  const cleaned = cleanText(value);
  return cleaned || fallback;
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeJsonArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }

  return {};
}

function displaySensorTypeForValue(value, fallback = "Motion Sensor") {
  const cleanValue = cleanText(value).toLowerCase().replace(/[-\s]+/g, "_");

  if (
    cleanValue === "human_presence" ||
    cleanValue === "presence" ||
    cleanValue === "presence_sensor" ||
    cleanValue === "human_presence_sensor" ||
    cleanValue === "ld2410" ||
    cleanValue === "ld2410_presence"
  ) {
    return "Human Presence Sensor";
  }

  if (
    cleanValue === "motion_presence" ||
    cleanValue === "motion_presence_sensor" ||
    cleanValue === "motion_plus_presence" ||
    cleanValue === "motion+presence" ||
    cleanValue === "combo"
  ) {
    return "Motion + Presence Sensor";
  }

  if (
    cleanValue === "motion" ||
    cleanValue === "motion_sensor" ||
    cleanValue === "pir" ||
    cleanValue === "pir_motion"
  ) {
    return "Motion Sensor";
  }

  return fallback;
}

function normalizedSensorModeForValue(value, fallback = "motion") {
  const displayType = displaySensorTypeForValue(value, "");

  if (displayType === "Human Presence Sensor") {
    return "human_presence";
  }

  if (displayType === "Motion + Presence Sensor") {
    return "motion_presence";
  }

  if (displayType === "Motion Sensor") {
    return "motion";
  }

  return fallback;
}

function sourcePrefixForSensorMode(value) {
  const normalizedMode = normalizedSensorModeForValue(value, "motion");

  if (normalizedMode === "human_presence") {
    return "presence";
  }

  if (normalizedMode === "motion_presence") {
    return "motion-presence";
  }

  return "motion";
}

function defaultSourceNameForSensorType(sensorType, roomName, fallbackNodeName) {
  const resolvedSensorType = displaySensorTypeForValue(sensorType, "Motion Sensor");
  const cleanRoomName = cleanText(roomName);

  if (cleanRoomName) {
    return `${resolvedSensorType} - ${cleanRoomName}`;
  }

  return cleanText(fallbackNodeName) || resolvedSensorType;
}

function normalizeWebhookEventType(value, fallback = "webhook_event") {
  const cleanValue = cleanText(value).toLowerCase().replace(/[-\s]+/g, "_");
  return cleanValue || fallback;
}

function normalizeWebhookSensorType(value, fallback = "unknown") {
  const cleanValue = cleanText(value).toLowerCase().replace(/[-\s]+/g, "_");
  return cleanValue || fallback;
}

function readPayloadNumber(payload, key) {
  const value = payload?.[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPayloadBoolean(payload, key) {
  if (typeof payload?.[key] === "boolean") {
    return payload[key];
  }

  const value = cleanText(payload?.[key]).toLowerCase();

  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }

  if (value === "false" || value === "0" || value === "no") {
    return false;
  }

  return null;
}

function buildPresenceTelemetryFromEventRow(row) {
  const payload = normalizeJsonObject(row?.eventPayload || row?.event_payload);

  return {
    eventId: row?.id || null,
    nodeId: row?.nodeId || row?.node_id || null,
    locationName: row?.locationName || row?.location_name || null,
    sourceKey: row?.sourceKey || row?.source_key || null,
    sourceName: row?.sourceName || row?.source_name || null,
    residentName: row?.residentName || row?.resident_name || null,
    message: row?.message || null,
    alertLevel: row?.alertLevel || row?.alert_level || null,
    timeText: row?.timeText || row?.time_text || null,
    timestamp: row?.timestamp || null,
    eventType: row?.eventType || row?.event_type || payload.eventType || null,
    sensorType: row?.sensorType || row?.sensor_type || payload.sensorType || null,
    presence: readPayloadBoolean(payload, "presence"),
    targetState: readPayloadNumber(payload, "targetState"),
    movingTarget: readPayloadBoolean(payload, "movingTarget"),
    movingDistanceCm: readPayloadNumber(payload, "movingDistanceCm"),
    movingEnergy: readPayloadNumber(payload, "movingEnergy"),
    stationaryTarget: readPayloadBoolean(payload, "stationaryTarget"),
    stationaryDistanceCm: readPayloadNumber(payload, "stationaryDistanceCm"),
    stationaryEnergy: readPayloadNumber(payload, "stationaryEnergy"),
    detectionDistanceCm: readPayloadNumber(payload, "detectionDistanceCm"),
    detectionZone: cleanText(payload.detectionZone) || null,
    rawPayload: payload
  };
}

function normalizeSetupState(value) {
  const setupState = cleanText(value).toLowerCase();

  if (setupState === "assigned" || setupState === "active") {
    return "assigned";
  }

  return "unassigned";
}

function isAssignedSensorRow(row) {
  if (!row) {
    return false;
  }

  return Boolean(row.residentId) ||
    cleanText(row.residentName).toLowerCase() !== "unassigned" ||
    cleanText(row.roomName) ||
    normalizeSetupState(row.setupState) === "assigned";
}

function sanitizeBulkNodeIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.map((nodeId) => cleanText(nodeId)).filter(Boolean))];
}

function normalizeEsp32SensorCommandType(value) {
  const commandType = normalizeNodeCommandType(value);
  return ESP32_SENSOR_COMMAND_TYPES.includes(commandType) ? commandType : null;
}

function normalizeForMatch(value) {
  return cleanText(value).toLowerCase();
}

function isMotionEventRow(event) {
  const searchableText = [
    event?.message,
    event?.sourceName,
    event?.sourceKey,
    event?.locationName,
    event?.timeText
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  return searchableText.includes("motion") ||
    searchableText.includes("activity") ||
    searchableText.includes("esp32") ||
    searchableText.includes("pir") ||
    searchableText.includes("sensor heartbeat");
}

function isRoutineMotionEventRow(event) {
  if (!isMotionEventRow(event)) {
    return false;
  }

  const searchableText = [
    event?.message,
    event?.timeText
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  const concernTerms = [
    "no motion",
    "inactivity",
    "missed",
    "offline",
    "failed",
    "warning",
    "critical",
    "fall",
    "help",
    "emergency",
    "unexpected",
    "unusual"
  ];

  return !concernTerms.some((term) => searchableText.includes(term));
}

function isPhysicalMotionEventRow(event) {
  if (!isRoutineMotionEventRow(event)) {
    return false;
  }

  const signalText = [
    event?.message,
    event?.timeText
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  const detectedMotion =
    signalText.includes("motion detected") ||
    signalText.includes("activity detected") ||
    signalText.includes("motion/activity detected") ||
    (signalText.includes("motion") && signalText.includes("detected")) ||
    (signalText.includes("activity") && signalText.includes("detected"));

  if (!detectedMotion) {
    return false;
  }

  const noiseTerms = [
    "heartbeat",
    "check-in",
    "check in",
    "online",
    "offline",
    "setup",
    "assigned",
    "unassigned"
  ];

  return !noiseTerms.some((term) => signalText.includes(term));
}

function minutesSince(dateValue) {
  const date = dateValue ? new Date(dateValue) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
}

function roomNameFromEvent(event, sensor) {
  const cleanSensorRoom = cleanText(sensor?.roomName);

  if (cleanSensorRoom) {
    return cleanSensorRoom;
  }

  const inferredRoom = inferRoomNameFromSourceName(event?.sourceName);

  if (inferredRoom) {
    return inferredRoom;
  }

  return cleanText(event?.locationName) || "Unknown room";
}

function sensorMatchesMotionEvent(sensor, event) {
  if (!sensor || !event) {
    return false;
  }

  const sensorId = cleanText(sensor.id);
  const eventSensorId = cleanText(event.sensorId);

  if (sensorId && eventSensorId && sensorId === eventSensorId) {
    return true;
  }

  const sensorSourceKey = normalizeForMatch(sensor.sourceKey);
  const eventSourceKey = normalizeForMatch(event.sourceKey);

  if (sensorSourceKey && eventSourceKey && sensorSourceKey === eventSourceKey) {
    return true;
  }

  const sensorNodeId = normalizeForMatch(sensor.nodeId);
  const eventNodeId = normalizeForMatch(event.nodeId);

  if (sensorNodeId && eventNodeId && sensorNodeId === eventNodeId) {
    return true;
  }

  const sensorSourceName = normalizeForMatch(sensor.sourceName);
  const eventSourceName = normalizeForMatch(event.sourceName);

  return Boolean(sensorSourceName && eventSourceName && sensorSourceName === eventSourceName);
}

function latestMotionEventForSensor(sensor, residentMotionEvents) {
  let latestEvent = null;
  let latestTimestamp = 0;

  for (const event of residentMotionEvents) {
    if (!sensorMatchesMotionEvent(sensor, event)) {
      continue;
    }

    const eventDate = new Date(event.timestamp);

    if (Number.isNaN(eventDate.getTime())) {
      continue;
    }

    if (!latestEvent || eventDate.getTime() > latestTimestamp) {
      latestEvent = event;
      latestTimestamp = eventDate.getTime();
    }
  }

  return latestEvent;
}

function isRecentMotionEvent(event, graceSeconds = AI_SENSOR_MOTION_ONLINE_GRACE_SECONDS) {
  const eventDate = event?.timestamp ? new Date(event.timestamp) : null;

  if (!eventDate || Number.isNaN(eventDate.getTime())) {
    return false;
  }

  return eventDate.getTime() >= Date.now() - (graceSeconds * 1000);
}

function buildEffectiveSensorStatus(sensor, nodeHealthByNodeId, nodeLastSeenByNodeId, residentMotionEvents) {
  const nodeId = cleanText(sensor?.nodeId);
  const health = nodeId ? nodeHealthByNodeId.get(nodeId) : null;
  const latestSensorMotionEvent = latestMotionEventForSensor(sensor, residentMotionEvents);
  const latestMotionAt = latestSensorMotionEvent?.timestamp || null;
  const nodeLastSeenAt = nodeId ? (nodeLastSeenByNodeId.get(nodeId) || null) : null;
  const healthCheckedInAt = health?.checkedInAt || null;

  const motionIsFresh = isRecentMotionEvent(latestSensorMotionEvent);
  const nodeEventDate = nodeLastSeenAt ? new Date(nodeLastSeenAt) : null;
  const nodeEventIsFresh = Boolean(
    nodeEventDate &&
    !Number.isNaN(nodeEventDate.getTime()) &&
    nodeEventDate.getTime() >= Date.now() - (AI_SENSOR_EVENT_ONLINE_GRACE_SECONDS * 1000)
  );
  const healthIsOnline = health ? health.isOnline === true : false;

  const candidateLastSeen = [healthCheckedInAt, nodeLastSeenAt, latestMotionAt]
    .map((value) => ({ value, date: value ? new Date(value) : null }))
    .filter((item) => item.date && !Number.isNaN(item.date.getTime()))
    .sort((first, second) => second.date.getTime() - first.date.getTime())[0];

  let onlineSource = null;
  if (healthIsOnline) onlineSource = "heartbeat";
  else if (nodeEventIsFresh) onlineSource = "sensor_event";
  else if (motionIsFresh) onlineSource = "motion";

  if (healthIsOnline || nodeEventIsFresh || motionIsFresh) {
    return {
      isOnline: true,
      wifiRssi: health?.wifiRssi ?? null,
      lastSeenAt: candidateLastSeen?.value || null,
      latestMotionAt,
      onlineSource
    };
  }

  if (nodeId) {
    return {
      isOnline: false,
      wifiRssi: health?.wifiRssi ?? null,
      lastSeenAt: candidateLastSeen?.value || null,
      latestMotionAt,
      onlineSource: healthCheckedInAt ? "heartbeat" : (nodeLastSeenAt ? "sensor_event" : null)
    };
  }

  return {
    isOnline: null,
    wifiRssi: health?.wifiRssi ?? null,
    lastSeenAt: candidateLastSeen?.value || null,
    latestMotionAt,
    onlineSource: latestMotionAt ? "motion" : null
  };
}

function localDateKey(dateValue) {
  const date = dateValue ? new Date(dateValue) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return null;
  }

  return `${year}-${month}-${day}`;
}

function localHourFromDate(dateValue) {
  const date = dateValue ? new Date(dateValue) : null;

  if (!date || Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AI_TIME_ZONE,
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);

  return Number.isFinite(hour) ? hour : null;
}

function motionEventRoomName(event) {
  return cleanText(event?.roomName) ||
    inferRoomNameFromSourceName(event?.sourceName) ||
    cleanText(event?.locationName) ||
    "Unknown room";
}

function displayAverage(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(value * 10) / 10;
}

function buildResidentMotionBaseline(residentMotionEvents) {
  const todayKey = localDateKey(new Date());
  const hourlyCounts = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0
  }));
  const eventsByDate = new Map();
  const roomCountsToday = new Map();
  let firstMotionToday = null;
  let lastMotionToday = null;

  for (const event of residentMotionEvents) {
    const eventDate = new Date(event.timestamp);

    if (Number.isNaN(eventDate.getTime())) {
      continue;
    }

    const dateKey = localDateKey(eventDate);

    if (!dateKey) {
      continue;
    }

    if (!eventsByDate.has(dateKey)) {
      eventsByDate.set(dateKey, []);
    }

    eventsByDate.get(dateKey).push(event);

    if (dateKey === todayKey) {
      const hour = localHourFromDate(eventDate);

      if (hour !== null) {
        hourlyCounts[hour].count += 1;
      }

      const roomName = motionEventRoomName(event);
      roomCountsToday.set(roomName, (roomCountsToday.get(roomName) || 0) + 1);

      if (!firstMotionToday || eventDate.getTime() < new Date(firstMotionToday.timestamp).getTime()) {
        firstMotionToday = event;
      }

      if (!lastMotionToday || eventDate.getTime() > new Date(lastMotionToday.timestamp).getTime()) {
        lastMotionToday = event;
      }
    }
  }

  const todayEvents = eventsByDate.get(todayKey) || [];
  const baselineDateKeys = [...eventsByDate.keys()].filter((dateKey) => dateKey !== todayKey);
  const baselineMotionCounts = baselineDateKeys.map((dateKey) => eventsByDate.get(dateKey)?.length || 0);
  const baselineDayCount = baselineMotionCounts.length;
  const baselineMotionAverage = baselineDayCount > 0
    ? baselineMotionCounts.reduce((sum, count) => sum + count, 0) / baselineDayCount
    : 0;
  const todayMotionCount = todayEvents.length;
  const expectedMotionCountLow = baselineDayCount >= AI_BASELINE_MIN_DAYS
    ? Math.max(1, Math.floor(baselineMotionAverage * AI_BASELINE_QUIET_RATIO))
    : null;
  const expectedMotionCountHigh = baselineDayCount >= AI_BASELINE_MIN_DAYS
    ? Math.ceil(baselineMotionAverage * AI_BASELINE_ACTIVE_RATIO)
    : null;

  let patternStatus = "Insufficient Baseline";
  let patternExplanation = `Need at least ${AI_BASELINE_MIN_DAYS} prior motion days before comparing this resident to their own routine.`;

  if (baselineDayCount >= AI_BASELINE_MIN_DAYS) {
    if (todayMotionCount < expectedMotionCountLow) {
      patternStatus = "Too Quiet";
      patternExplanation = `Today has ${todayMotionCount} motion event(s), below the expected low range of ${expectedMotionCountLow}.`;
    } else if (todayMotionCount > expectedMotionCountHigh) {
      patternStatus = "More Active Than Usual";
      patternExplanation = `Today has ${todayMotionCount} motion event(s), above the expected high range of ${expectedMotionCountHigh}.`;
    } else {
      patternStatus = "Normal Pattern";
      patternExplanation = `Today is within this resident's recent motion baseline.`;
    }
  }

  const mostActiveRoomToday = [...roomCountsToday.entries()]
    .sort((first, second) => {
      if (first[1] !== second[1]) {
        return second[1] - first[1];
      }

      return first[0].localeCompare(second[0]);
    })[0] || null;

  return {
    baselineDayCount,
    baselineMotionAverage: displayAverage(baselineMotionAverage),
    todayMotionCount,
    expectedMotionCountLow,
    expectedMotionCountHigh,
    patternStatus,
    patternExplanation,
    firstMotionTodayAt: firstMotionToday?.timestamp || null,
    firstMotionTodayRoom: firstMotionToday ? motionEventRoomName(firstMotionToday) : null,
    lastMotionTodayAt: lastMotionToday?.timestamp || null,
    lastMotionTodayRoom: lastMotionToday ? motionEventRoomName(lastMotionToday) : null,
    mostActiveRoomToday: mostActiveRoomToday ? mostActiveRoomToday[0] : null,
    mostActiveRoomTodayCount: mostActiveRoomToday ? mostActiveRoomToday[1] : 0,
    hourlyMotionCounts: hourlyCounts
  };
}

function buildResidentRoomIntelligence(residentSensors, residentMotionEvents) {
  const todayKey = localDateKey(new Date());
  const activeSensors = residentSensors.filter((sensor) => sensor.isActive !== false);
  const assignedRooms = [...new Set(
    activeSensors
      .map((sensor) => cleanText(sensor.roomName) || inferRoomNameFromSourceName(sensor.sourceName))
      .filter(Boolean)
  )].sort((first, second) => first.localeCompare(second));
  const roomCounts = new Map();

  for (const event of residentMotionEvents) {
    const eventDate = new Date(event.timestamp);

    if (Number.isNaN(eventDate.getTime()) || localDateKey(eventDate) !== todayKey) {
      continue;
    }

    const roomName = motionEventRoomName(event);
    roomCounts.set(roomName, (roomCounts.get(roomName) || 0) + 1);
  }

  const roomMotionCountsToday = [...roomCounts.entries()]
    .map(([roomName, count]) => ({ roomName, count }))
    .sort((first, second) => {
      if (first.count !== second.count) {
        return second.count - first.count;
      }

      return first.roomName.localeCompare(second.roomName);
    });
  const activeRoomsToday = roomMotionCountsToday
    .filter((room) => room.count > 0)
    .map((room) => room.roomName);
  const quietAssignedRoomsToday = assignedRooms.filter((roomName) => {
    return !activeRoomsToday.some((activeRoomName) => normalizeForMatch(activeRoomName) === normalizeForMatch(roomName));
  });

  let coverageStatus = "No Coverage";
  let coverageExplanation = "No active ESP32 motion sensors are assigned to this resident.";

  if (activeSensors.length > 0 && assignedRooms.length === 0) {
    coverageStatus = "Coverage Pending";
    coverageExplanation = "Active sensors exist, but assigned room names are missing.";
  } else if (activeSensors.length > 0 && activeRoomsToday.length === 0) {
    coverageStatus = "No Motion Today";
    coverageExplanation = "Assigned rooms have not reported physical motion today.";
  } else if (activeSensors.length > 0 && quietAssignedRoomsToday.length === 0) {
    coverageStatus = "All Assigned Rooms Active";
    coverageExplanation = "All assigned rooms with ESP32 motion sensors have reported motion today.";
  } else if (activeSensors.length > 0) {
    coverageStatus = "Partial Room Activity";
    coverageExplanation = `${activeRoomsToday.length} room(s) reported motion today; ${quietAssignedRoomsToday.length} assigned room(s) have not.`;
  }

  return {
    assignedRooms,
    activeRoomsToday,
    quietAssignedRoomsToday,
    roomMotionCountsToday,
    coverageStatus,
    coverageExplanation
  };
}

function buildResidentActionGuidance({
  aiStatus,
  motionBaseline,
  roomIntelligence,
  activeSensorCount,
  offlineSensorCount,
  recentCriticalOpenAlertCount,
  recentCautionOpenAlertCount,
  inactiveMinutes
}) {
  const aiLevel = cleanText(aiStatus?.aiLevel || aiStatus?.aiStatus);
  const patternStatus = cleanText(motionBaseline?.patternStatus);
  const coverageStatus = cleanText(roomIntelligence?.coverageStatus);

  if (aiLevel === "Critical" || recentCriticalOpenAlertCount > 0) {
    return {
      actionLevel: "Immediate",
      actionTitle: "Immediate follow-up recommended",
      actionSummary: "A critical resident behavior signal is present.",
      actionItems: [
        "Contact or physically check on the resident using the agency's normal escalation process.",
        "Review the most recent motion room, last motion time, and open alerts before closing the event.",
        "Document the follow-up result after contact is completed."
      ],
      nextCheckMinutes: 0
    };
  }

  if (aiLevel === "Sensor Issue") {
    return {
      actionLevel: "Technical",
      actionTitle: "Restore sensor connectivity",
      actionSummary: "Resident behavior should not be judged until assigned sensors are online.",
      actionItems: [
        "Check power and Wi-Fi for the offline ESP32 sensor or local node.",
        "Confirm the sensor is assigned to the correct resident and room.",
        "Retest motion after connectivity is restored."
      ],
      nextCheckMinutes: 15
    };
  }

  if (aiLevel === "Setup Needed") {
    return {
      actionLevel: "Setup",
      actionTitle: "Complete sensor assignment",
      actionSummary: "AI behavior monitoring is not active for this resident yet.",
      actionItems: [
        "Assign at least one ESP32 motion sensor to this resident.",
        "Set the correct room name for each sensor.",
        "Trigger a test motion event and confirm it appears in the AI Dashboard."
      ],
      nextCheckMinutes: null
    };
  }

  if (aiLevel === "Warning" || patternStatus === "Too Quiet") {
    return {
      actionLevel: "Review",
      actionTitle: "Review resident activity",
      actionSummary: "Motion activity is below the current expected pattern or a warning signal is present.",
      actionItems: [
        "Review last motion time and the quiet rooms for this resident.",
        "Compare activity against the resident's expected routine for this time of day.",
        "Escalate if the resident cannot be reached or if quiet activity continues."
      ],
      nextCheckMinutes: 30
    };
  }

  if (aiLevel === "Watch" || recentCautionOpenAlertCount > 0 || coverageStatus === "No Motion Today") {
    return {
      actionLevel: "Watch",
      actionTitle: "Continue watching activity",
      actionSummary: "No immediate escalation is required, but activity should be checked again soon.",
      actionItems: [
        "Check the resident again after the next expected motion window.",
        "Watch for additional alerts or continued inactivity.",
        "Confirm sensors remain online."
      ],
      nextCheckMinutes: inactiveMinutes !== null && inactiveMinutes >= AI_INACTIVE_WATCH_MINUTES ? 30 : 60
    };
  }

  if (coverageStatus === "Partial Room Activity") {
    return {
      actionLevel: "Observe",
      actionTitle: "Room activity is partial",
      actionSummary: "Motion is present, but not all assigned rooms have reported activity today.",
      actionItems: [
        "Review which assigned rooms are quiet today.",
        "Confirm quiet rooms are expected based on the resident's routine.",
        "No action is needed if this matches normal activity."
      ],
      nextCheckMinutes: 120
    };
  }

  if (patternStatus === "More Active Than Usual") {
    return {
      actionLevel: "Observe",
      actionTitle: "Activity is higher than usual",
      actionSummary: "Motion is above the resident's recent baseline.",
      actionItems: [
        "Review room distribution to see where extra motion is happening.",
        "Check whether the resident has visitors, staff activity, or a changed routine.",
        "Continue normal monitoring unless other alerts appear."
      ],
      nextCheckMinutes: 120
    };
  }

  if (activeSensorCount > 0 && offlineSensorCount === 0) {
    return {
      actionLevel: "Normal",
      actionTitle: "No action needed",
      actionSummary: "Sensors are online and current activity is within normal monitoring rules.",
      actionItems: [
        "Continue normal monitoring."
      ],
      nextCheckMinutes: 240
    };
  }

  return {
    actionLevel: "Review",
    actionTitle: "Review resident setup",
    actionSummary: "The resident does not have enough clean monitoring data for a stronger recommendation.",
    actionItems: [
      "Check sensor assignment and recent activity.",
      "Confirm the resident should be included in AI monitoring."
    ],
    nextCheckMinutes: null
  };
}

function buildResidentFollowUpStatus({
  actionGuidance,
  latestActionLog
}) {
  const actionLevel = cleanText(actionGuidance?.actionLevel);
  const actionTitle = cleanText(actionGuidance?.actionTitle);
  const nextCheckMinutes = Number.isFinite(actionGuidance?.nextCheckMinutes)
    ? actionGuidance.nextCheckMinutes
    : null;

  if (actionLevel === "Normal") {
    return {
      followUpStatus: "No Action Needed",
      followUpExplanation: "Current action recommendation is normal monitoring.",
      followUpDueAt: null,
      minutesUntilFollowUpDue: null
    };
  }

  const logActionLevel = cleanText(latestActionLog?.actionLevel);
  const logActionTitle = cleanText(latestActionLog?.actionTitle);
  const logMatchesCurrentAction =
    latestActionLog &&
    normalizeForMatch(logActionLevel) === normalizeForMatch(actionLevel) &&
    normalizeForMatch(logActionTitle) === normalizeForMatch(actionTitle);

  if (!logMatchesCurrentAction) {
    return {
      followUpStatus: "Not Logged",
      followUpExplanation: "No follow-up has been logged for this current action recommendation.",
      followUpDueAt: null,
      minutesUntilFollowUpDue: null
    };
  }

  if (nextCheckMinutes === null) {
    return {
      followUpStatus: "Not Scheduled",
      followUpExplanation: "A follow-up was logged, and this recommendation does not require a timed recheck.",
      followUpDueAt: null,
      minutesUntilFollowUpDue: null
    };
  }

  if (nextCheckMinutes <= 0) {
    return {
      followUpStatus: "Due Now",
      followUpExplanation: "This recommendation requires immediate follow-up.",
      followUpDueAt: new Date().toISOString(),
      minutesUntilFollowUpDue: 0
    };
  }

  const loggedAt = new Date(latestActionLog.createdAt);

  if (Number.isNaN(loggedAt.getTime())) {
    return {
      followUpStatus: "Logged",
      followUpExplanation: "A follow-up was logged, but its timestamp could not be used to calculate the next due time.",
      followUpDueAt: null,
      minutesUntilFollowUpDue: null
    };
  }

  const dueAt = new Date(loggedAt.getTime() + (nextCheckMinutes * 60 * 1000));
  const minutesUntilDue = Math.ceil((dueAt.getTime() - Date.now()) / (60 * 1000));

  if (minutesUntilDue <= 0) {
    return {
      followUpStatus: "Due Again",
      followUpExplanation: "The logged follow-up interval has elapsed. Recheck this resident or sensor issue.",
      followUpDueAt: dueAt.toISOString(),
      minutesUntilFollowUpDue: 0
    };
  }

  return {
    followUpStatus: "Logged",
    followUpExplanation: "A follow-up has been logged and the next recheck is not due yet.",
    followUpDueAt: dueAt.toISOString(),
    minutesUntilFollowUpDue: minutesUntilDue
  };
}

function buildAIStatusForResident({
  resident,
  residentEvents,
  residentSensors,
  latestMotionEvent,
  latestMotionSensor,
  inactiveMinutes,
  openAlertCount,
  recentOpenAlertCount,
  recentCriticalOpenAlertCount,
  recentCautionOpenAlertCount,
  activeSensorCount,
  onlineSensorCount,
  offlineSensorCount
}) {
  const hasInactiveMinutes = Number.isFinite(inactiveMinutes);
  const motionCountLastHour = residentEvents.filter((event) => {
    const eventDate = new Date(event.timestamp);
    return isMotionEventRow(event) &&
      !Number.isNaN(eventDate.getTime()) &&
      eventDate.getTime() >= Date.now() - (60 * 60 * 1000);
  }).length;

  if (residentSensors.length === 0) {
    return {
      aiStatus: "Setup Needed",
      aiLevel: "Setup Needed",
      aiExplanation: "No ESP32 motion sensors are assigned to this resident yet. Add or assign sensors before using AI behavior monitoring."
    };
  }

  if (activeSensorCount === 0) {
    return {
      aiStatus: "Setup Needed",
      aiLevel: "Setup Needed",
      aiExplanation: "This resident has sensor records, but no active ESP32 motion sensors are available for AI behavior monitoring."
    };
  }

  if (onlineSensorCount === 0) {
    return {
      aiStatus: "Sensor Issue",
      aiLevel: "Sensor Issue",
      aiExplanation: "All assigned ESP32 motion sensors appear offline or stale. Restore sensor connectivity before treating this as a resident behavior issue."
    };
  }

  if (recentCriticalOpenAlertCount > 0 ||
    (hasInactiveMinutes && inactiveMinutes >= AI_INACTIVE_CRITICAL_MINUTES)) {
    return {
      aiStatus: "Critical",
      aiLevel: "Critical",
      aiExplanation: hasInactiveMinutes && inactiveMinutes >= AI_INACTIVE_CRITICAL_MINUTES
        ? `No routine ESP32 motion has been seen for ${inactiveMinutes} minutes. Immediate follow-up is recommended.`
        : "A recent critical behavior event is open. Immediate follow-up is recommended."
    };
  }

  if (recentCautionOpenAlertCount > 0 ||
    recentOpenAlertCount >= 2 ||
    (hasInactiveMinutes && inactiveMinutes >= AI_INACTIVE_WARNING_MINUTES) ||
    offlineSensorCount > 0) {
    return {
      aiStatus: "Warning",
      aiLevel: "Warning",
      aiExplanation: offlineSensorCount > 0
        ? `${offlineSensorCount} assigned ESP32 motion sensor(s) may be offline or stale. Review sensor coverage.`
        : "The resident has a caution-level behavior signal that should be reviewed against their normal routine."
    };
  }

  if (recentOpenAlertCount === 1 ||
    (hasInactiveMinutes && inactiveMinutes >= AI_INACTIVE_WATCH_MINUTES)) {
    return {
      aiStatus: "Watch",
      aiLevel: "Watch",
      aiExplanation: hasInactiveMinutes && inactiveMinutes >= AI_INACTIVE_WATCH_MINUTES
        ? `No routine ESP32 motion has been seen for ${inactiveMinutes} minutes. Continue watching for a missed routine.`
        : "One unresolved event is open. Keep watching for another missed activity or sensor issue."
    };
  }

  if (!latestMotionEvent) {
    return {
      aiStatus: "Normal",
      aiLevel: "Normal",
      aiExplanation: residentSensors.length > 0
        ? "ESP32 motion sensors are assigned, but no recent motion event is available in the retained event feed yet."
        : "No ESP32 motion sensors are assigned to this resident yet."
    };
  }

  return {
    aiStatus: "Normal",
    aiLevel: "Normal",
    aiExplanation: motionCountLastHour > 0
      ? "Recent ESP32 motion activity is being treated as normal routine movement."
      : `Latest ESP32 motion was in ${roomNameFromEvent(latestMotionEvent, latestMotionSensor)}. Resident remains in normal monitoring.`
  };
}

async function buildAIMotionSummary() {
  const [residentResult, sensorResult, eventResult, motionEventResult, nodeHealthResult, nodeResult, actionLogResult] = await Promise.all([
    pool.query(`
      ${residentSelectSQL()}
      WHERE is_deleted = FALSE
      ORDER BY name ASC
    `),
    pool.query(`
      ${sensorSelectSQL()}
      WHERE is_deleted = FALSE
      ORDER BY resident_name ASC, room_name ASC NULLS LAST, source_name ASC
    `),
    pool.query(`
      ${eventSelectSQL()}
      ORDER BY timestamp DESC
      LIMIT 200
    `),
    pool.query(
      `
      ${motionEventSelectSQL()}
      WHERE event_timestamp >= NOW() - ($1::int * INTERVAL '1 day')
      ORDER BY event_timestamp DESC
      LIMIT $2
      `,
      [AI_MOTION_HISTORY_DAYS, AI_MOTION_HISTORY_EVENT_LIMIT]
    ),
    pool.query(`
      ${nodeHealthSelectSQL()}
      ORDER BY checked_in_at DESC
    `),
    pool.query(`
      SELECT
        node_id AS "nodeId",
        last_seen_at AS "lastSeenAt"
      FROM nodes
      WHERE is_archived = FALSE
    `),
    pool.query(`
      ${aiActionLogSelectSQL()}
      ORDER BY created_at DESC
      LIMIT 500
    `)
  ]);

  const sensors = sensorResult.rows;
  const events = eventResult.rows;
  const motionHistoryEvents = motionEventResult.rows;
  const actionLogs = actionLogResult.rows;
  const nodeHealthByNodeId = new Map(
    nodeHealthResult.rows.map((health) => [cleanText(health.nodeId), health])
  );
  const nodeLastSeenByNodeId = new Map(
    nodeResult.rows.map((node) => [cleanText(node.nodeId), node.lastSeenAt])
  );

  const residents = residentResult.rows.map((resident) => {
    const residentNameKey = normalizeForMatch(resident.name);

    const residentSensors = sensors.filter((sensor) => {
      const sensorResidentNameKey = normalizeForMatch(sensor.residentName);
      return sensor.residentId === resident.id || sensorResidentNameKey === residentNameKey;
    });

    const residentEvents = events.filter((event) => {
      const eventResidentNameKey = normalizeForMatch(event.residentName);
      return eventResidentNameKey === residentNameKey;
    });
    const residentActionLogs = actionLogs.filter((log) => {
      const logResidentNameKey = normalizeForMatch(log.residentName);
      return log.residentId === resident.id || logResidentNameKey === residentNameKey;
    });
    const latestActionLog = residentActionLogs[0] || null;

    const motionEvents = residentEvents.filter(isMotionEventRow);
    const physicalWebhookMotionEvents = motionEvents.filter(isPhysicalMotionEventRow);
    const residentMotionHistoryEvents = motionHistoryEvents.filter((event) => {
      const eventResidentNameKey = normalizeForMatch(event.residentName);
      return event.residentId === resident.id || eventResidentNameKey === residentNameKey;
    });
    const residentMotionEvents = residentMotionHistoryEvents.length > 0
      ? residentMotionHistoryEvents
      : physicalWebhookMotionEvents;
    const latestMotionEvent = residentMotionEvents[0] || null;
    const latestMotionSensor = latestMotionEvent
      ? residentSensors.find((sensor) => {
          return normalizeForMatch(sensor.sourceKey) === normalizeForMatch(latestMotionEvent.sourceKey) ||
            normalizeForMatch(sensor.sourceName) === normalizeForMatch(latestMotionEvent.sourceName);
        })
      : null;

    const motionCountToday = residentMotionEvents.filter((event) => {
      const eventDate = new Date(event.timestamp);
      const now = new Date();
      return !Number.isNaN(eventDate.getTime()) &&
        eventDate.getFullYear() === now.getFullYear() &&
        eventDate.getMonth() === now.getMonth() &&
        eventDate.getDate() === now.getDate();
    }).length;

    const motionCountLastHour = residentMotionEvents.filter((event) => {
      const eventDate = new Date(event.timestamp);
      return !Number.isNaN(eventDate.getTime()) &&
        eventDate.getTime() >= Date.now() - (60 * 60 * 1000);
    }).length;
    const motionBaseline = buildResidentMotionBaseline(residentMotionEvents);
    const roomIntelligence = buildResidentRoomIntelligence(residentSensors, residentMotionEvents);
    const sensorStatusById = new Map(
      residentSensors.map((sensor) => {
        return [
          sensor.id,
          buildEffectiveSensorStatus(sensor, nodeHealthByNodeId, nodeLastSeenByNodeId, residentMotionEvents)
        ];
      })
    );

    const openAlerts = residentEvents.filter((event) => {
      return event.isAcknowledged !== true && normalizeAlertLevel(event.alertLevel) !== "Normal";
    });
    const recentOpenAlerts = openAlerts.filter((event) => {
      const eventDate = new Date(event.timestamp);
      return !Number.isNaN(eventDate.getTime()) &&
        eventDate.getTime() >= Date.now() - (24 * 60 * 60 * 1000);
    });
    const recentCriticalOpenAlerts = recentOpenAlerts.filter((event) => {
      return normalizeAlertLevel(event.alertLevel) === "Critical";
    });
    const recentCautionOpenAlerts = recentOpenAlerts.filter((event) => {
      return normalizeAlertLevel(event.alertLevel) === "Caution";
    });

    const activeSensors = residentSensors.filter((sensor) => sensor.isActive !== false);
    const offlineSensors = activeSensors.filter((sensor) => {
      const status = sensorStatusById.get(sensor.id);
      return status?.isOnline === false;
    });
    const onlineSensorCount = Math.max(0, activeSensors.length - offlineSensors.length);

    const inactiveMinutes = latestMotionEvent ? minutesSince(latestMotionEvent.timestamp) : null;
    const aiStatus = buildAIStatusForResident({
      resident,
      residentEvents,
      residentSensors,
      latestMotionEvent,
      latestMotionSensor,
      inactiveMinutes,
      openAlertCount: openAlerts.length,
      recentOpenAlertCount: recentOpenAlerts.length,
      recentCriticalOpenAlertCount: recentCriticalOpenAlerts.length,
      recentCautionOpenAlertCount: recentCautionOpenAlerts.length,
      activeSensorCount: activeSensors.length,
      onlineSensorCount,
      offlineSensorCount: offlineSensors.length
    });
    const actionGuidance = buildResidentActionGuidance({
      aiStatus,
      motionBaseline,
      roomIntelligence,
      activeSensorCount: activeSensors.length,
      offlineSensorCount: offlineSensors.length,
      recentCriticalOpenAlertCount: recentCriticalOpenAlerts.length,
      recentCautionOpenAlertCount: recentCautionOpenAlerts.length,
      inactiveMinutes
    });
    const followUpStatus = buildResidentFollowUpStatus({
      actionGuidance,
      latestActionLog
    });

    return {
      residentId: resident.id,
      residentName: resident.name,
      location: resident.location,
      residentAlertLevel: resident.alertLevel,
      residentLastActivity: resident.lastActivity,
      residentStatusText: resident.statusText,
      activeWarnings: resident.activeWarnings,
      sensorCount: residentSensors.length,
      activeSensorCount: activeSensors.length,
      offlineSensorCount: offlineSensors.length,
      onlineSensorCount,
      motionEventCount: residentMotionEvents.length,
      persistentMotionEventCount: residentMotionHistoryEvents.length,
      retainedMotionEventFallbackCount: physicalWebhookMotionEvents.length,
      motionCountToday,
      motionCountLastHour,
      baselineDayCount: motionBaseline.baselineDayCount,
      baselineMotionAverage: motionBaseline.baselineMotionAverage,
      expectedMotionCountLow: motionBaseline.expectedMotionCountLow,
      expectedMotionCountHigh: motionBaseline.expectedMotionCountHigh,
      patternStatus: motionBaseline.patternStatus,
      patternExplanation: motionBaseline.patternExplanation,
      firstMotionTodayAt: motionBaseline.firstMotionTodayAt,
      firstMotionTodayRoom: motionBaseline.firstMotionTodayRoom,
      lastMotionTodayAt: motionBaseline.lastMotionTodayAt,
      lastMotionTodayRoom: motionBaseline.lastMotionTodayRoom,
      mostActiveRoomToday: motionBaseline.mostActiveRoomToday,
      mostActiveRoomTodayCount: motionBaseline.mostActiveRoomTodayCount,
      hourlyMotionCounts: motionBaseline.hourlyMotionCounts,
      assignedRooms: roomIntelligence.assignedRooms,
      activeRoomsToday: roomIntelligence.activeRoomsToday,
      quietAssignedRoomsToday: roomIntelligence.quietAssignedRoomsToday,
      roomMotionCountsToday: roomIntelligence.roomMotionCountsToday,
      coverageStatus: roomIntelligence.coverageStatus,
      coverageExplanation: roomIntelligence.coverageExplanation,
      openAlertCount: openAlerts.length,
      recentOpenAlertCount: recentOpenAlerts.length,
      recentCriticalOpenAlertCount: recentCriticalOpenAlerts.length,
      recentCautionOpenAlertCount: recentCautionOpenAlerts.length,
      inactiveMinutes,
      lastMotionAt: latestMotionEvent?.timestamp || null,
      lastMotionRoom: latestMotionEvent ? roomNameFromEvent(latestMotionEvent, latestMotionSensor) : null,
      lastMotionSourceName: latestMotionEvent?.sourceName || null,
      lastMotionSourceKey: latestMotionEvent?.sourceKey || null,
      lastMotionMessage: latestMotionEvent?.message || null,
      aiStatus: aiStatus.aiStatus,
      aiLevel: aiStatus.aiLevel,
      aiExplanation: aiStatus.aiExplanation,
      actionLevel: actionGuidance.actionLevel,
      actionTitle: actionGuidance.actionTitle,
      actionSummary: actionGuidance.actionSummary,
      actionItems: actionGuidance.actionItems,
      nextCheckMinutes: actionGuidance.nextCheckMinutes,
      actionLogCount: residentActionLogs.length,
      lastActionAt: latestActionLog?.createdAt || null,
      lastActionLevel: latestActionLog?.actionLevel || null,
      lastActionTitle: latestActionLog?.actionTitle || null,
      lastActionStatus: latestActionLog?.actionStatus || null,
      lastActionNote: latestActionLog?.actionNote || null,
      lastActionBy: latestActionLog?.createdBy || null,
      followUpStatus: followUpStatus.followUpStatus,
      followUpExplanation: followUpStatus.followUpExplanation,
      followUpDueAt: followUpStatus.followUpDueAt,
      minutesUntilFollowUpDue: followUpStatus.minutesUntilFollowUpDue,
      sensors: residentSensors.map((sensor) => {
        const status = sensorStatusById.get(sensor.id) || buildEffectiveSensorStatus(sensor, nodeHealthByNodeId, nodeLastSeenByNodeId, residentMotionEvents);

        return {
          id: sensor.id,
          nodeId: sensor.nodeId,
          sourceKey: sensor.sourceKey,
          sourceName: sensor.sourceName,
          sensorType: sensor.sensorType,
          roomName: sensor.roomName,
          locationName: sensor.locationName,
          setupState: sensor.setupState,
          isActive: sensor.isActive,
          isOnline: status.isOnline,
          wifiRssi: status.wifiRssi,
          lastSeenAt: status.lastSeenAt,
          latestMotionAt: status.latestMotionAt,
          onlineSource: status.onlineSource
        };
      })
    };
  });

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    inactiveWatchMinutes: AI_INACTIVE_WATCH_MINUTES,
    inactiveWarningMinutes: AI_INACTIVE_WARNING_MINUTES,
    inactiveCriticalMinutes: AI_INACTIVE_CRITICAL_MINUTES,
    motionHistoryDays: AI_MOTION_HISTORY_DAYS,
    sensorMotionOnlineGraceSeconds: AI_SENSOR_MOTION_ONLINE_GRACE_SECONDS,
    sensorEventOnlineGraceSeconds: AI_SENSOR_EVENT_ONLINE_GRACE_SECONDS,
    baselineMinimumDays: AI_BASELINE_MIN_DAYS,
    baselineQuietRatio: AI_BASELINE_QUIET_RATIO,
    baselineActiveRatio: AI_BASELINE_ACTIVE_RATIO,
    aiTimeZone: AI_TIME_ZONE,
    nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
    residentCount: residents.length,
    residents
  };
}

function aiBriefingResidentPriorityScore(resident) {
  const followUpStatus = cleanText(resident.followUpStatus).toLowerCase();
  const actionLevel = cleanText(resident.actionLevel).toLowerCase();
  const aiLevel = cleanText(resident.aiLevel || resident.aiStatus).toLowerCase();

  let score = 0;

  if (followUpStatus === "due now") {
    score += 120;
  } else if (followUpStatus === "due again") {
    score += 110;
  } else if (followUpStatus === "not logged" && actionLevel !== "normal") {
    score += 85;
  } else if (followUpStatus === "logged") {
    score += 20;
  }

  if (actionLevel === "immediate") {
    score += 100;
  } else if (actionLevel === "technical") {
    score += 80;
  } else if (actionLevel === "review") {
    score += 65;
  } else if (actionLevel === "watch") {
    score += 50;
  } else if (actionLevel === "setup") {
    score += 40;
  } else if (actionLevel === "observe") {
    score += 20;
  }

  if (aiLevel === "critical") {
    score += 90;
  } else if (aiLevel === "sensor issue") {
    score += 80;
  } else if (aiLevel === "warning") {
    score += 70;
  } else if (aiLevel === "watch") {
    score += 55;
  } else if (aiLevel === "setup needed") {
    score += 35;
  }

  score += Math.min(normalizeInteger(resident.recentCriticalOpenAlertCount, 0), 5) * 20;
  score += Math.min(normalizeInteger(resident.recentCautionOpenAlertCount, 0), 5) * 10;
  score += Math.min(normalizeInteger(resident.offlineSensorCount, 0), 5) * 8;

  return score;
}

function aiBriefingResidentSummary(resident) {
  const onlineSensorCount = normalizeInteger(resident.onlineSensorCount, 0);
  const offlineSensorCount = normalizeInteger(resident.offlineSensorCount, 0);

  if (normalizeInteger(resident.sensorCount, 0) === 0) {
    return "No ESP32 motion sensors assigned";
  }

  if (offlineSensorCount > 0) {
    return `${onlineSensorCount} online / ${offlineSensorCount} offline`;
  }

  return `${onlineSensorCount} online`;
}

function aiBriefingPriorityLevel(resident) {
  const followUpStatus = cleanText(resident.followUpStatus).toLowerCase();
  const actionLevel = cleanText(resident.actionLevel).toLowerCase();
  const aiLevel = cleanText(resident.aiLevel || resident.aiStatus).toLowerCase();

  if (followUpStatus === "due now" || followUpStatus === "due again" || actionLevel === "immediate" || aiLevel === "critical") {
    return "Immediate";
  }

  if (actionLevel === "technical" || aiLevel === "sensor issue") {
    return "Technical";
  }

  if (followUpStatus === "not logged" || actionLevel === "review" || aiLevel === "warning") {
    return "Review";
  }

  if (actionLevel === "watch" || aiLevel === "watch") {
    return "Watch";
  }

  if (actionLevel === "setup" || aiLevel === "setup needed") {
    return "Setup";
  }

  return "Normal";
}

function aiBriefingPriorityItem(resident) {
  return {
    residentId: resident.residentId,
    residentName: resident.residentName,
    location: resident.location,
    priorityLevel: aiBriefingPriorityLevel(resident),
    aiStatus: resident.aiStatus,
    aiLevel: resident.aiLevel,
    aiExplanation: resident.aiExplanation,
    actionLevel: resident.actionLevel,
    actionTitle: resident.actionTitle,
    actionSummary: resident.actionSummary,
    followUpStatus: resident.followUpStatus,
    followUpExplanation: resident.followUpExplanation,
    followUpDueAt: resident.followUpDueAt,
    minutesUntilFollowUpDue: resident.minutesUntilFollowUpDue,
    sensorSummary: aiBriefingResidentSummary(resident),
    sensorCount: resident.sensorCount,
    onlineSensorCount: resident.onlineSensorCount,
    offlineSensorCount: resident.offlineSensorCount,
    motionCountToday: resident.motionCountToday,
    motionCountLastHour: resident.motionCountLastHour,
    lastMotionAt: resident.lastMotionAt,
    lastMotionRoom: resident.lastMotionRoom,
    lastMotionSourceName: resident.lastMotionSourceName,
    coverageStatus: resident.coverageStatus,
    patternStatus: resident.patternStatus,
    lastActionAt: resident.lastActionAt,
    lastActionBy: resident.lastActionBy,
    lastActionStatus: resident.lastActionStatus
  };
}

function buildAIBriefingFromSummary(summary) {
  const residents = Array.isArray(summary?.residents) ? summary.residents : [];
  const nonNormalActionResidents = residents.filter((resident) => {
    return cleanText(resident.actionLevel).toLowerCase() !== "normal";
  });
  const followUpDueResidents = residents.filter((resident) => {
    const status = cleanText(resident.followUpStatus).toLowerCase();
    return status === "due now" || status === "due again";
  });
  const unloggedFollowUpResidents = residents.filter((resident) => {
    const status = cleanText(resident.followUpStatus).toLowerCase();
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    return status === "not logged" && actionLevel !== "normal";
  });
  const technicalResidents = residents.filter((resident) => {
    return cleanText(resident.actionLevel).toLowerCase() === "technical" ||
      cleanText(resident.aiLevel).toLowerCase() === "sensor issue";
  });
  const setupResidents = residents.filter((resident) => {
    return cleanText(resident.actionLevel).toLowerCase() === "setup" ||
      cleanText(resident.aiLevel).toLowerCase() === "setup needed";
  });
  const residentReviewResidents = residents.filter((resident) => {
    const aiLevel = cleanText(resident.aiLevel).toLowerCase();
    return aiLevel === "watch" || aiLevel === "warning" || aiLevel === "critical";
  });
  const normalResidents = residents.filter((resident) => {
    return cleanText(resident.actionLevel).toLowerCase() === "normal";
  });

  const sortedPriorities = nonNormalActionResidents
    .slice()
    .sort((first, second) => {
      const firstScore = aiBriefingResidentPriorityScore(first);
      const secondScore = aiBriefingResidentPriorityScore(second);

      if (firstScore !== secondScore) {
        return secondScore - firstScore;
      }

      return cleanText(first.residentName).localeCompare(cleanText(second.residentName));
    });

  const topPriorities = sortedPriorities.slice(0, 12).map(aiBriefingPriorityItem);

  let headline = "All monitored residents are in normal AI monitoring.";
  let overallLevel = "Normal";

  if (followUpDueResidents.length > 0) {
    headline = `${followUpDueResidents.length} follow-up item(s) are due now or overdue.`;
    overallLevel = "Immediate";
  } else if (unloggedFollowUpResidents.length > 0) {
    headline = `${unloggedFollowUpResidents.length} AI action item(s) still need a logged follow-up.`;
    overallLevel = "Review";
  } else if (technicalResidents.length > 0) {
    headline = `${technicalResidents.length} resident(s) have sensor connectivity or technical issues.`;
    overallLevel = "Technical";
  } else if (residentReviewResidents.length > 0) {
    headline = `${residentReviewResidents.length} resident(s) need behavior review.`;
    overallLevel = "Review";
  } else if (setupResidents.length > 0) {
    headline = `${setupResidents.length} resident(s) still need ESP32 monitoring setup.`;
    overallLevel = "Setup";
  }

  const briefingItems = [];

  if (followUpDueResidents.length > 0) {
    briefingItems.push(`${followUpDueResidents.length} follow-up item(s) are due now or overdue.`);
  }

  if (unloggedFollowUpResidents.length > 0) {
    briefingItems.push(`${unloggedFollowUpResidents.length} non-normal recommendation(s) have not been logged yet.`);
  }

  if (technicalResidents.length > 0) {
    briefingItems.push(`${technicalResidents.length} resident(s) have sensor or node connectivity work to resolve.`);
  }

  if (setupResidents.length > 0) {
    briefingItems.push(`${setupResidents.length} resident(s) need sensor assignment before AI monitoring is complete.`);
  }

  if (normalResidents.length > 0) {
    briefingItems.push(`${normalResidents.length} resident(s) are currently in normal monitoring.`);
  }

  if (briefingItems.length === 0) {
    briefingItems.push("No immediate AI action items are currently visible.");
  }

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    sourceGeneratedAt: summary.generatedAt,
    overallLevel,
    headline,
    briefingItems,
    counts: {
      residentCount: residents.length,
      normalCount: normalResidents.length,
      nonNormalActionCount: nonNormalActionResidents.length,
      followUpDueCount: followUpDueResidents.length,
      unloggedFollowUpCount: unloggedFollowUpResidents.length,
      technicalCount: technicalResidents.length,
      setupNeededCount: setupResidents.length,
      residentReviewCount: residentReviewResidents.length,
      offlineSensorCount: residents.reduce((total, resident) => total + normalizeInteger(resident.offlineSensorCount, 0), 0),
      motionCountToday: residents.reduce((total, resident) => total + normalizeInteger(resident.motionCountToday, 0), 0),
      motionCountLastHour: residents.reduce((total, resident) => total + normalizeInteger(resident.motionCountLastHour, 0), 0)
    },
    topPriorities,
    followUpDueResidents: followUpDueResidents.map(aiBriefingPriorityItem),
    unloggedFollowUpResidents: unloggedFollowUpResidents.map(aiBriefingPriorityItem),
    technicalResidents: technicalResidents.map(aiBriefingPriorityItem),
    setupResidents: setupResidents.map(aiBriefingPriorityItem)
  };
}

async function buildAIBriefing() {
  const summary = await buildAIMotionSummary();
  return buildAIBriefingFromSummary(summary);
}


function isAuthorizedWebhook(req) {
  if (!WEBHOOK_SECRET) {
    return true;
  }

  const incomingSecret = req.header("x-webhook-secret");
  return incomingSecret && incomingSecret === WEBHOOK_SECRET;
}

function requireAuthorizedRequest(req, res) {
  if (!isAuthorizedWebhook(req)) {
    res.status(401).json({
      success: false,
      error: "Unauthorized request"
    });

    return false;
  }

  return true;
}

function requestAppBuild(req) {
  const rawBuild = cleanText(req.header("x-app-build"));

  if (!rawBuild) {
    return null;
  }

  const parsedBuild = Number(rawBuild);
  return Number.isFinite(parsedBuild) ? parsedBuild : null;
}

function requestAppVersion(req) {
  return cleanText(req.header("x-app-version")) || "Unknown";
}

function requestAppClient(req) {
  return cleanText(req.header("x-app-client")) || "Unknown";
}

function requireMinimumIOSAppBuildForSetupWrites(req, res) {
  const build = requestAppBuild(req);
  const version = requestAppVersion(req);
  const client = requestAppClient(req);

  if (build === null || build < MIN_IOS_APP_BUILD) {
    console.warn("Blocked old app setup write:", {
      path: req.path,
      method: req.method,
      client,
      version,
      build,
      minimumRequiredBuild: MIN_IOS_APP_BUILD
    });

    res.status(426).json({
      success: false,
      error: "This app build is too old to change resident or camera setup. Please update the app.",
      appBuild: build,
      minimumRequiredBuild: MIN_IOS_APP_BUILD,
      appVersion: version,
      appClient: client
    });

    return false;
  }

  return true;
}

function requireAuthorizedCurrentAppWrite(req, res) {
  if (!requireAuthorizedRequest(req, res)) {
    return false;
  }

  return requireMinimumIOSAppBuildForSetupWrites(req, res);
}

function normalizeNodeCommandType(value) {
  const commandType = cleanText(value).toLowerCase();

  const allowedCommands = new Set([
    "ping",
    "reload_cameras",
    "restart_monitors",
    "ffmpeg_check",
    "diagnostic_report",
    "clear_last_error",
    "rtsp_test",
    "factory_reset",
    "reconfigure",
    "reboot",
    "identify",
    "locate",
    "update_firmware"
  ]);

  return allowedCommands.has(commandType) ? commandType : null;
}

function normalizeCommandStatus(value) {
  const status = cleanText(value).toLowerCase();

  if (status === "success") {
    return "success";
  }

  if (status === "failed") {
    return "failed";
  }

  if (status === "running") {
    return "running";
  }

  return "pending";
}

function isValidFirmwareUrl(value) {
  const url = cleanText(value);

  if (!url) {
    return false;
  }

  try {
    const parsedUrl = new URL(url);
    return parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function isSafeFirmwareReleaseTag(value) {
  const releaseTag = cleanText(value);
  return /^v[0-9][A-Za-z0-9._-]*$/.test(releaseTag);
}

function isSafeFirmwareAssetName(value) {
  const assetName = cleanText(value);
  return assetName === FIRMWARE_DOWNLOAD_ASSET_NAME;
}

function githubFirmwareAssetUrl(releaseTag, assetName) {
  return `https://github.com/${encodeURIComponent(FIRMWARE_GITHUB_OWNER)}/${encodeURIComponent(FIRMWARE_GITHUB_REPO)}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(assetName)}`;
}

function copyFirmwareDownloadHeaders(upstreamResponse, res) {
  const contentLength = upstreamResponse.headers["content-length"];
  const contentType = upstreamResponse.headers["content-type"] || "application/octet-stream";
  const etag = upstreamResponse.headers.etag;
  const lastModified = upstreamResponse.headers["last-modified"];

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Content-Disposition", `attachment; filename="${FIRMWARE_DOWNLOAD_ASSET_NAME}"`);
  res.setHeader("X-Good-Shepherd-Firmware-Proxy", "true");

  if (contentLength) {
    res.setHeader("Content-Length", contentLength);
  }

  if (etag) {
    res.setHeader("ETag", etag);
  }

  if (lastModified) {
    res.setHeader("Last-Modified", lastModified);
  }
}

function firmwareDownloadClientForUrl(parsedUrl) {
  if (parsedUrl.protocol === "https:") {
    return https;
  }

  if (parsedUrl.protocol === "http:") {
    return http;
  }

  return null;
}

function proxyFirmwareDownload(upstreamUrl, res, redirectsRemaining = MAX_FIRMWARE_DOWNLOAD_REDIRECTS) {
  let parsedUrl;

  try {
    parsedUrl = new URL(upstreamUrl);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: "Invalid upstream firmware URL"
      });
    }
    return;
  }

  const client = firmwareDownloadClientForUrl(parsedUrl);

  if (!client) {
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        error: "Unsupported upstream firmware URL protocol"
      });
    }
    return;
  }

  const request = client.get(
    parsedUrl,
    {
      headers: {
        "User-Agent": "Good-Shepherd-Firmware-Proxy/1.0",
        "Accept": "application/octet-stream,*/*"
      }
    },
    (upstreamResponse) => {
      const statusCode = upstreamResponse.statusCode || 0;
      const redirectLocation = upstreamResponse.headers.location;

      if ([301, 302, 303, 307, 308].includes(statusCode) && redirectLocation) {
        upstreamResponse.resume();

        if (redirectsRemaining <= 0) {
          if (!res.headersSent) {
            res.status(502).json({
              success: false,
              error: "Firmware download failed: too many redirects"
            });
          }
          return;
        }

        const nextUrl = new URL(redirectLocation, parsedUrl).toString();
        proxyFirmwareDownload(nextUrl, res, redirectsRemaining - 1);
        return;
      }

      if (statusCode < 200 || statusCode >= 300) {
        const chunks = [];
        let totalBytes = 0;

        upstreamResponse.on("data", (chunk) => {
          if (totalBytes < 4096) {
            chunks.push(chunk);
            totalBytes += chunk.length;
          }
        });

        upstreamResponse.on("end", () => {
          const bodyPreview = Buffer.concat(chunks).toString("utf8").slice(0, 1000);

          if (!res.headersSent) {
            res.status(502).json({
              success: false,
              error: `Firmware upstream download failed with HTTP ${statusCode}`,
              upstreamStatusCode: statusCode,
              upstreamBodyPreview: bodyPreview
            });
          }
        });

        upstreamResponse.resume();
        return;
      }

      copyFirmwareDownloadHeaders(upstreamResponse, res);
      res.status(200);
      upstreamResponse.pipe(res);
    }
  );

  request.setTimeout(FIRMWARE_DOWNLOAD_TIMEOUT_MS, () => {
    request.destroy(new Error("Firmware upstream download timed out"));
  });

  request.on("error", (error) => {
    console.error("Firmware proxy download failed:", error);

    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        error: error.message || "Firmware proxy download failed"
      });
    } else {
      res.destroy(error);
    }
  });
}

function eventSelectSQL() {
  return `
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
      timestamp,
      event_type AS "eventType",
      sensor_type AS "sensorType",
      event_payload AS "eventPayload",
      acknowledged AS "isAcknowledged",
      acknowledged_at AS "acknowledgedAt",
      resolution_note AS "resolutionNote"
    FROM webhook_events
  `;
}

function motionEventSelectSQL() {
  return `
    SELECT
      id,
      webhook_event_id AS "webhookEventId",
      resident_id AS "residentId",
      resident_name AS "residentName",
      location_name AS "locationName",
      sensor_id AS "sensorId",
      node_id AS "nodeId",
      source_key AS "sourceKey",
      source_name AS "sourceName",
      room_name AS "roomName",
      message,
      alert_level AS "alertLevel",
      time_text AS "timeText",
      event_timestamp AS "timestamp",
      created_at AS "createdAt"
    FROM motion_events
  `;
}

function aiActionLogSelectSQL() {
  return `
    SELECT
      id,
      resident_id AS "residentId",
      resident_name AS "residentName",
      action_level AS "actionLevel",
      action_title AS "actionTitle",
      action_status AS "actionStatus",
      action_note AS "actionNote",
      created_by AS "createdBy",
      created_at AS "createdAt"
    FROM ai_action_logs
  `;
}

function nodeHealthSelectSQL() {
  return `
    SELECT
      node_id AS "nodeId",
      node_name AS "nodeName",
      location_name AS "locationName",
      local_ip AS "localIp",
      local_config_port AS "localConfigPort",
      camera_count AS "cameraCount",
      camera_summary AS "cameraSummary",
      software_version AS "softwareVersion",
      wifi_ssid AS "wifiSsid",
      wifi_rssi AS "wifiRssi",
      setup_state AS "setupState",
      monitor_status AS "monitorStatus",
      ffmpeg_status AS "ffmpegStatus",
      ffmpeg_path AS "ffmpegPath",
      platform,
      hostname,
      uptime_seconds AS "uptimeSeconds",
      active_monitor_count AS "activeMonitorCount",
      last_error AS "lastError",
      last_error_at AS "lastErrorAt",
      diagnostics,
      checked_in_at AS "checkedInAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      EXTRACT(EPOCH FROM (NOW() - checked_in_at))::int AS "secondsSinceCheckIn",
      CASE
        WHEN checked_in_at >= NOW() - (${NODE_OFFLINE_AFTER_SECONDS} * INTERVAL '1 second') THEN TRUE
        ELSE FALSE
      END AS "isOnline"
    FROM node_health
  `;
}

function nodeCommandSelectSQL() {
  return `
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
  `;
}

function residentSelectSQL() {
  return `
    SELECT
      id,
      name,
      location,
      alert_level AS "alertLevel",
      last_activity AS "lastActivity",
      active_warnings AS "activeWarnings",
      status_text AS "statusText",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM residents
  `;
}

function cameraSelectSQL() {
  return `
    SELECT
      id,
      source_key AS "sourceKey",
      source_name AS "sourceName",
      resident_id AS "residentId",
      resident_name AS "residentName",
      rtsp_url AS "rtspUrl",
      is_active AS "isActive",
      assigned_node_id AS "assignedNodeId",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM cameras
  `;
}

function cameraReturningSQL() {
  return `
    RETURNING
      id,
      source_key AS "sourceKey",
      source_name AS "sourceName",
      resident_id AS "residentId",
      resident_name AS "residentName",
      rtsp_url AS "rtspUrl",
      is_active AS "isActive",
      assigned_node_id AS "assignedNodeId",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;
}

function sensorSelectSQL() {
  return `
    SELECT
      id,
      node_id AS "nodeId",
      source_key AS "sourceKey",
      source_name AS "sourceName",
      sensor_type AS "sensorType",
      resident_id AS "residentId",
      resident_name AS "residentName",
      location_name AS "locationName",
      room_name AS "roomName",
      setup_state AS "setupState",
      is_active AS "isActive",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM sensors
  `;
}

function sensorReturningSQL() {
  return `
    RETURNING
      id,
      node_id AS "nodeId",
      source_key AS "sourceKey",
      source_name AS "sourceName",
      sensor_type AS "sensorType",
      resident_id AS "residentId",
      resident_name AS "residentName",
      location_name AS "locationName",
      room_name AS "roomName",
      setup_state AS "setupState",
      is_active AS "isActive",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `;
}

function firmwareReleaseSelectSQL() {
  return `
    SELECT
      id,
      firmware_version AS "firmwareVersion",
      firmware_url AS "firmwareUrl",
      sha256,
      release_notes AS "releaseNotes",
      is_active AS "isActive",
      created_by AS "createdBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM firmware_releases
  `;
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
      wifi_ssid AS "wifiSsid",
      wifi_rssi AS "wifiRssi",
      setup_state AS "setupState",
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

async function getResidentById(residentId) {
  const result = await pool.query(
    `
    ${residentSelectSQL()}
    WHERE id = $1
    LIMIT 1
    `,
    [residentId]
  );

  return result.rows[0] || null;
}

async function getResidentForExistingDeviceIdentity({ sourceKey, nodeId }) {
  const resolvedSourceKey = cleanText(sourceKey);
  const resolvedNodeId = cleanText(nodeId);

  if (!resolvedSourceKey && !resolvedNodeId) {
    return null;
  }

  const result = await pool.query(
    `
    WITH device_resident_matches AS (
      SELECT
        s.resident_id,
        s.updated_at AS match_updated_at,
        1 AS priority
      FROM sensors s
      WHERE s.is_deleted = FALSE
        AND s.resident_id IS NOT NULL
        AND (
          ($1::text <> '' AND s.source_key = $1)
          OR ($1::text = '' AND $2::text <> '' AND s.node_id = $2)
        )

      UNION ALL

      SELECT
        c.resident_id,
        c.updated_at AS match_updated_at,
        2 AS priority
      FROM cameras c
      WHERE c.is_deleted = FALSE
        AND c.resident_id IS NOT NULL
        AND (
          ($1::text <> '' AND c.source_key = $1)
          OR ($1::text = '' AND $2::text <> '' AND c.assigned_node_id = $2)
        )
    )
    SELECT
      r.id,
      r.name,
      r.location,
      r.alert_level AS "alertLevel",
      r.last_activity AS "lastActivity",
      r.active_warnings AS "activeWarnings",
      r.status_text AS "statusText",
      r.is_deleted AS "isDeleted",
      r.deleted_at AS "deletedAt",
      r.created_at AS "createdAt",
      r.updated_at AS "updatedAt"
    FROM residents r
    JOIN device_resident_matches drm ON drm.resident_id = r.id
    WHERE r.is_deleted = FALSE
    ORDER BY drm.priority ASC, drm.match_updated_at DESC
    LIMIT 1
    `,
    [resolvedSourceKey, resolvedNodeId]
  );

  return result.rows[0] || null;
}


async function getExistingSensorForDeviceIdentity({ sourceKey, nodeId }) {
  const resolvedSourceKey = cleanText(sourceKey);
  const resolvedNodeId = cleanText(nodeId);

  if (!resolvedSourceKey && !resolvedNodeId) {
    return null;
  }

  const result = await pool.query(
    `
    ${sensorSelectSQL()}
    WHERE is_deleted = FALSE
      AND (
        ($1::text <> '' AND source_key = $1)
        OR ($1::text = '' AND $2::text <> '' AND node_id = $2)
      )
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [resolvedSourceKey, resolvedNodeId]
  );

  return result.rows[0] || null;
}

function sensorIsExplicitlyUnassigned(sensor) {
  if (!sensor) {
    return false;
  }

  return !sensor.residentId &&
    normalizeForMatch(sensor.residentName) === "unassigned" &&
    normalizeSetupState(sensor.setupState) === "unassigned";
}

async function getLatestFirmwareRelease() {
  const result = await pool.query(
    `
    ${firmwareReleaseSelectSQL()}
    WHERE is_active = TRUE
    ORDER BY created_at DESC
    LIMIT 1
    `
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
  softwareVersion,
  wifiSsid,
  wifiRssi,
  setupState
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
  const resolvedWifiSsid = cleanOptionalText(wifiSsid);
  const resolvedWifiRssi = Number.isFinite(Number(wifiRssi)) ? Number(wifiRssi) : null;
  const resolvedSetupState = normalizeSetupState(setupState || resolvedStatus);

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
      wifi_ssid,
      wifi_rssi,
      setup_state,
      first_seen_at,
      last_seen_at,
      is_archived,
      archived_at,
      archived_reason
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, NOW(), NOW(), FALSE, NULL, NULL)
    ON CONFLICT (node_id)
    DO UPDATE SET
      node_name = CASE
        WHEN EXCLUDED.node_name IS NOT NULL
          AND TRIM(EXCLUDED.node_name) <> ''
          AND EXCLUDED.node_name <> 'Good Shepherd Local Node'
        THEN EXCLUDED.node_name
        WHEN nodes.node_name IS NULL OR TRIM(nodes.node_name) = ''
        THEN EXCLUDED.node_name
        ELSE nodes.node_name
      END,
      location_name = CASE
        WHEN EXCLUDED.location_name IS NOT NULL
          AND TRIM(EXCLUDED.location_name) <> ''
          AND EXCLUDED.location_name <> 'Unassigned Location'
        THEN EXCLUDED.location_name
        WHEN nodes.location_name IS NULL OR TRIM(nodes.location_name) = ''
        THEN EXCLUDED.location_name
        ELSE nodes.location_name
      END,
      status = CASE
        WHEN EXCLUDED.location_name IS NOT NULL
          AND TRIM(EXCLUDED.location_name) <> ''
          AND EXCLUDED.location_name <> 'Unassigned Location'
        THEN 'Active'
        WHEN nodes.location_name IS NULL
          OR TRIM(nodes.location_name) = ''
          OR nodes.location_name = 'Unassigned Location'
        THEN EXCLUDED.status
        ELSE nodes.status
      END,
      local_ip = EXCLUDED.local_ip,
      local_config_port = EXCLUDED.local_config_port,
      camera_count = EXCLUDED.camera_count,
      camera_summary = EXCLUDED.camera_summary,
      software_version = EXCLUDED.software_version,
      wifi_ssid = COALESCE(EXCLUDED.wifi_ssid, nodes.wifi_ssid),
      wifi_rssi = COALESCE(EXCLUDED.wifi_rssi, nodes.wifi_rssi),
      setup_state = CASE
        WHEN EXCLUDED.setup_state = 'assigned' THEN 'assigned'
        WHEN nodes.setup_state = 'assigned' THEN nodes.setup_state
        ELSE EXCLUDED.setup_state
      END,
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
      wifi_ssid AS "wifiSsid",
      wifi_rssi AS "wifiRssi",
      setup_state AS "setupState",
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
      resolvedSoftwareVersion,
      resolvedWifiSsid,
      resolvedWifiRssi,
      resolvedSetupState
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
      wifi_ssid AS "wifiSsid",
      wifi_rssi AS "wifiRssi",
      setup_state AS "setupState",
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

async function syncNodeHealthMetadataBestEffort({
  nodeId,
  nodeName,
  locationName,
  localIp,
  localConfigPort,
  cameraCount,
  cameraSummary,
  softwareVersion,
  wifiSsid,
  wifiRssi,
  setupState,
  diagnostics
}) {
  let resolvedLocationName = locationName;
  let resolvedSetupState = setupState;
  const resolvedDiagnostics = {
    ...normalizeJsonObject(diagnostics)
  };

  const existingIdentitySensor = await getExistingSensorForDeviceIdentity({
    sourceKey: resolvedDiagnostics?.sourceKey,
    nodeId
  });
  const preserveNodeUnassignedState = sensorIsExplicitlyUnassigned(existingIdentitySensor);

  if (preserveNodeUnassignedState) {
    resolvedLocationName = "Unassigned Location";
    resolvedSetupState = "unassigned";
    resolvedDiagnostics.residentName = "Unassigned";
    resolvedDiagnostics.locationName = "Unassigned Location";
    resolvedDiagnostics.roomName = "";
    resolvedDiagnostics.assignmentState = "Unassigned";
    resolvedDiagnostics.setupState = "unassigned";
  }

  await upsertNodeFromRegistration({
    nodeId,
    nodeName,
    locationName: resolvedLocationName,
    localIp,
    localConfigPort,
    cameraCount,
    cameraSummary,
    softwareVersion,
    wifiSsid,
    wifiRssi,
    setupState: resolvedSetupState
  });

  if (resolvedDiagnostics?.sourceKey) {
    const heartbeatDeviceName = cleanText(resolvedDiagnostics.deviceName) || "Motion Sensor";
    const heartbeatRoomName = cleanText(resolvedDiagnostics.roomName);
    const heartbeatResidentName = cleanText(resolvedDiagnostics.residentName);
    const heartbeatLocationName = cleanText(resolvedLocationName) || "Unassigned location";
    const heartbeatSourceName = heartbeatRoomName
      ? `${heartbeatDeviceName} - ${heartbeatRoomName}`
      : heartbeatDeviceName;

    const existingSensor = existingIdentitySensor || await getExistingSensorForDeviceIdentity({
      sourceKey: resolvedDiagnostics.sourceKey,
      nodeId
    });
    const preserveUnassignedState =
      preserveNodeUnassignedState || sensorIsExplicitlyUnassigned(existingSensor);

    let resident = preserveUnassignedState
      ? null
      : await getResidentForExistingDeviceIdentity({
          sourceKey: resolvedDiagnostics.sourceKey,
          nodeId
        });

    if (!resident && !preserveUnassignedState) {
      resident = await findOrCreateResidentFromEvent({
        residentName: heartbeatResidentName,
        locationName: heartbeatLocationName,
        alertLevel: "Normal",
        message: "ESP32 sensor heartbeat"
      });
    }

    await upsertSensorFromEvent({
      nodeId,
      sourceKey: resolvedDiagnostics.sourceKey,
      sourceName: preserveUnassignedState
        ? (existingSensor?.sourceName || heartbeatSourceName)
        : heartbeatSourceName,
      sensorType:
        resolvedDiagnostics.sensorMode ||
        resolvedDiagnostics.sensorType ||
        heartbeatDeviceName,
      resident,
      residentName: preserveUnassignedState
        ? "Unassigned"
        : (resident?.name || heartbeatResidentName),
      locationName: preserveUnassignedState
        ? "Unassigned location"
        : (resident?.location || heartbeatLocationName),
      forceUnassigned: preserveUnassignedState
    });
  }

  if (
    resolvedLocationName !== locationName ||
    resolvedSetupState !== setupState ||
    JSON.stringify(resolvedDiagnostics) !== JSON.stringify(diagnostics)
  ) {
    await pool.query(
      `
      UPDATE node_health
      SET
        location_name = $2,
        setup_state = $3,
        diagnostics = $4::jsonb,
        updated_at = NOW()
      WHERE node_id = $1
      `,
      [
        nodeId,
        resolvedLocationName,
        resolvedSetupState,
        JSON.stringify(resolvedDiagnostics)
      ]
    );
  }
}

async function upsertNodeHealth(payload) {
  const nodeId = cleanText(payload?.nodeId);

  if (!nodeId) {
    throw new Error("Missing required field: nodeId");
  }

  const nodeName = normalizeHealthText(payload?.nodeName, "Good Shepherd Local Node");
  const locationName = normalizeHealthText(payload?.locationName, "Unassigned Location");
  const localIp = cleanOptionalText(payload?.localIp);
  const localConfigPort = payload?.localConfigPort ? Number(payload.localConfigPort) : null;
  const cameraCount = normalizeInteger(payload?.cameraCount, 0);
  const cameraSummary = normalizeJsonArray(payload?.cameraSummary);
  const softwareVersion = cleanOptionalText(payload?.softwareVersion);
  const monitorStatus = normalizeHealthText(payload?.monitorStatus, "Online");
  const ffmpegStatus = normalizeHealthText(payload?.ffmpegStatus, "Unknown");
  const ffmpegPath = cleanOptionalText(payload?.ffmpegPath);
  const platform = cleanOptionalText(payload?.platform);
  const hostname = cleanOptionalText(payload?.hostname);
  const uptimeSeconds = payload?.uptimeSeconds ? normalizeInteger(payload.uptimeSeconds, 0) : null;
  const activeMonitorCount = normalizeInteger(payload?.activeMonitorCount, 0);
  const lastError = cleanOptionalText(payload?.lastError);
  const diagnostics = normalizeJsonObject(payload?.diagnostics);
  const wifiSsid = cleanOptionalText(
    payload?.wifiSsid ??
    payload?.ssid ??
    diagnostics?.wifiSsid ??
    diagnostics?.ssid
  );
  const wifiRssi = Number.isFinite(
    Number(payload?.wifiRssi ?? payload?.rssi ?? diagnostics?.wifiRssi ?? diagnostics?.rssi)
  )
    ? Number(payload?.wifiRssi ?? payload?.rssi ?? diagnostics?.wifiRssi ?? diagnostics?.rssi)
    : null;
  const setupState = normalizeSetupState(payload?.setupState ?? diagnostics?.setupState);
  const lastErrorAt = lastError ? new Date().toISOString() : null;

  // Heartbeat reliability rule:
  // Persist checked_in_at first. Assignment, resident, node, and sensor
  // reconciliation must never block or invalidate a valid heartbeat.
  const result = await pool.query(
    `
    INSERT INTO node_health (
      node_id,
      node_name,
      location_name,
      local_ip,
      local_config_port,
      camera_count,
      camera_summary,
      software_version,
      wifi_ssid,
      wifi_rssi,
      setup_state,
      monitor_status,
      ffmpeg_status,
      ffmpeg_path,
      platform,
      hostname,
      uptime_seconds,
      active_monitor_count,
      last_error,
      last_error_at,
      diagnostics,
      checked_in_at,
      created_at,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13,
      $14, $15, $16, $17, $18, $19, $20, $21::jsonb, NOW(), NOW(), NOW()
    )
    ON CONFLICT (node_id)
    DO UPDATE SET
      node_name = EXCLUDED.node_name,
      location_name = EXCLUDED.location_name,
      local_ip = EXCLUDED.local_ip,
      local_config_port = EXCLUDED.local_config_port,
      camera_count = EXCLUDED.camera_count,
      camera_summary = EXCLUDED.camera_summary,
      software_version = EXCLUDED.software_version,
      wifi_ssid = EXCLUDED.wifi_ssid,
      wifi_rssi = EXCLUDED.wifi_rssi,
      setup_state = EXCLUDED.setup_state,
      monitor_status = EXCLUDED.monitor_status,
      ffmpeg_status = EXCLUDED.ffmpeg_status,
      ffmpeg_path = EXCLUDED.ffmpeg_path,
      platform = EXCLUDED.platform,
      hostname = EXCLUDED.hostname,
      uptime_seconds = EXCLUDED.uptime_seconds,
      active_monitor_count = EXCLUDED.active_monitor_count,
      last_error = EXCLUDED.last_error,
      last_error_at = CASE
        WHEN EXCLUDED.last_error IS NULL THEN node_health.last_error_at
        ELSE NOW()
      END,
      diagnostics = EXCLUDED.diagnostics,
      checked_in_at = NOW(),
      updated_at = NOW()
    RETURNING
      node_id AS "nodeId",
      node_name AS "nodeName",
      location_name AS "locationName",
      local_ip AS "localIp",
      local_config_port AS "localConfigPort",
      camera_count AS "cameraCount",
      camera_summary AS "cameraSummary",
      software_version AS "softwareVersion",
      wifi_ssid AS "wifiSsid",
      wifi_rssi AS "wifiRssi",
      setup_state AS "setupState",
      monitor_status AS "monitorStatus",
      ffmpeg_status AS "ffmpegStatus",
      ffmpeg_path AS "ffmpegPath",
      platform,
      hostname,
      uptime_seconds AS "uptimeSeconds",
      active_monitor_count AS "activeMonitorCount",
      last_error AS "lastError",
      last_error_at AS "lastErrorAt",
      diagnostics,
      checked_in_at AS "checkedInAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt",
      EXTRACT(EPOCH FROM (NOW() - checked_in_at))::int AS "secondsSinceCheckIn",
      CASE
        WHEN checked_in_at >= NOW() - ($22::int * INTERVAL '1 second') THEN TRUE
        ELSE FALSE
      END AS "isOnline"
    `,
    [
      nodeId,
      nodeName,
      locationName,
      localIp,
      localConfigPort,
      cameraCount,
      JSON.stringify(cameraSummary),
      softwareVersion,
      wifiSsid,
      wifiRssi,
      setupState,
      monitorStatus,
      ffmpegStatus,
      ffmpegPath,
      platform,
      hostname,
      uptimeSeconds,
      activeMonitorCount,
      lastError,
      lastErrorAt,
      JSON.stringify(diagnostics),
      NODE_OFFLINE_AFTER_SECONDS
    ]
  );

  const health = result.rows[0];

  // Run assignment and inventory synchronization after the heartbeat has
  // already been committed. This work is intentionally best-effort and
  // cannot change the HTTP success response for the heartbeat.
  setImmediate(() => {
    syncNodeHealthMetadataBestEffort({
      nodeId,
      nodeName,
      locationName,
      localIp,
      localConfigPort,
      cameraCount,
      cameraSummary,
      softwareVersion,
      wifiSsid,
      wifiRssi,
      setupState,
      diagnostics
    }).catch((error) => {
      console.error("Node health secondary metadata sync failed:", {
        nodeId,
        error: error?.message || String(error)
      });
    });
  });

  return health;
}

async function createCommand({ nodeId, commandType, payload, requestedBy }) {
  const result = await pool.query(
    `
    INSERT INTO node_commands (
      command_id,
      node_id,
      command_type,
      payload,
      status,
      requested_by,
      requested_at,
      picked_up_at,
      completed_at,
      result,
      error
    )
    VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, NOW(), NULL, NULL, NULL, NULL)
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
    [
      randomUUID(),
      nodeId,
      commandType,
      JSON.stringify(payload),
      requestedBy
    ]
  );

  return result.rows[0];
}

async function findOrCreateResidentFromEvent({ residentName, locationName, alertLevel, message }) {
  const name = cleanText(residentName);
  const location = cleanText(locationName) || "Unassigned location";
  const normalizedAlertLevel = normalizeAlertLevel(alertLevel);
  const activeWarnings = warningCountForAlertLevel(normalizedAlertLevel);
  const lastActivity = cleanText(message) || "Device event received.";

  if (!name) {
    return null;
  }

  const existing = await pool.query(
    `
    ${residentSelectSQL()}
    WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
      AND is_deleted = FALSE
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [name]
  );

  if (existing.rows[0]) {
    const result = await pool.query(
      `
      UPDATE residents
      SET
        location = CASE
          WHEN location IS NULL
            OR TRIM(location) = ''
            OR location = 'Unassigned location'
          THEN $2
          ELSE location
        END,
        alert_level = $3,
        active_warnings = $4,
        last_activity = $5,
        status_text = 'Active monitoring',
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        name,
        location,
        alert_level AS "alertLevel",
        last_activity AS "lastActivity",
        active_warnings AS "activeWarnings",
        status_text AS "statusText",
        is_deleted AS "isDeleted",
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
      [
        existing.rows[0].id,
        location,
        normalizedAlertLevel,
        activeWarnings,
        lastActivity
      ]
    );

    return result.rows[0];
  }

  const result = await pool.query(
    `
    INSERT INTO residents (
      id,
      name,
      location,
      alert_level,
      last_activity,
      active_warnings,
      status_text,
      is_deleted,
      deleted_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'Active monitoring', FALSE, NULL, NOW(), NOW())
    RETURNING
      id,
      name,
      location,
      alert_level AS "alertLevel",
      last_activity AS "lastActivity",
      active_warnings AS "activeWarnings",
      status_text AS "statusText",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [
      randomUUID(),
      name,
      location,
      normalizedAlertLevel,
      lastActivity,
      activeWarnings
    ]
  );

  return result.rows[0];
}

function inferRoomNameFromSourceName(sourceName) {
  const cleanSourceName = cleanText(sourceName);

  if (!cleanSourceName) {
    return null;
  }

  const parts = cleanSourceName.split(" - ").map((part) => cleanText(part)).filter(Boolean);

  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }

  return null;
}

async function upsertSensorFromEvent({
  nodeId,
  sourceKey,
  sourceName,
  sensorType,
  resident,
  residentName,
  locationName,
  forceUnassigned = false
}) {
  const resolvedSourceKey = cleanText(sourceKey);

  if (!resolvedSourceKey) {
    return null;
  }

  const resolvedSourceName = cleanText(sourceName) || "Motion Sensor";
  const resolvedSensorType = displaySensorTypeForValue(sensorType, "Motion Sensor");
  const resolvedResidentName = forceUnassigned
    ? "Unassigned"
    : (resident?.name || cleanText(residentName) || "Unassigned");
  const resolvedLocationName = forceUnassigned
    ? "Unassigned location"
    : (cleanText(locationName) || resident?.location || "Unassigned location");
  const resolvedRoomName = forceUnassigned
    ? null
    : inferRoomNameFromSourceName(resolvedSourceName);

  const result = await pool.query(
    `
    INSERT INTO sensors (
      id,
      node_id,
      source_key,
      source_name,
      sensor_type,
      resident_id,
      resident_name,
      location_name,
      room_name,
      setup_state,
      is_active,
      is_deleted,
      deleted_at,
      created_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, FALSE, NULL, NOW(), NOW())
    ON CONFLICT (source_key)
    DO UPDATE SET
      node_id = EXCLUDED.node_id,
      source_name = EXCLUDED.source_name,
      sensor_type = EXCLUDED.sensor_type,
      resident_id = EXCLUDED.resident_id,
      resident_name = EXCLUDED.resident_name,
      location_name = EXCLUDED.location_name,
      room_name = EXCLUDED.room_name,
      setup_state = EXCLUDED.setup_state,
      is_active = TRUE,
      is_deleted = FALSE,
      deleted_at = NULL,
      updated_at = NOW()
    ${sensorReturningSQL()}
    `,
    [
      randomUUID(),
      cleanText(nodeId) || null,
      resolvedSourceKey,
      resolvedSourceName,
      resolvedSensorType,
      forceUnassigned ? null : (resident?.id || null),
      resolvedResidentName,
      resolvedLocationName,
      resolvedRoomName,
      forceUnassigned
        ? "unassigned"
        : (resolvedResidentName !== "Unassigned" || Boolean(resolvedRoomName) ? "assigned" : "unassigned")
    ]
  );

  return result.rows[0];
}

async function recordMotionHistoryEvent({ event, resident, sensor }) {
  if (!isPhysicalMotionEventRow(event)) {
    return null;
  }

  const result = await pool.query(
    `
    INSERT INTO motion_events (
      id,
      webhook_event_id,
      resident_id,
      resident_name,
      location_name,
      sensor_id,
      node_id,
      source_key,
      source_name,
      room_name,
      message,
      alert_level,
      time_text,
      event_timestamp,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
    ON CONFLICT (webhook_event_id) WHERE webhook_event_id IS NOT NULL
    DO NOTHING
    RETURNING
      id,
      webhook_event_id AS "webhookEventId",
      resident_id AS "residentId",
      resident_name AS "residentName",
      location_name AS "locationName",
      sensor_id AS "sensorId",
      node_id AS "nodeId",
      source_key AS "sourceKey",
      source_name AS "sourceName",
      room_name AS "roomName",
      message,
      alert_level AS "alertLevel",
      time_text AS "timeText",
      event_timestamp AS "timestamp",
      created_at AS "createdAt"
    `,
    [
      randomUUID(),
      event.id,
      resident?.id || null,
      resident?.name || event.residentName,
      event.locationName || resident?.location || null,
      sensor?.id || null,
      event.nodeId || sensor?.nodeId || null,
      event.sourceKey || sensor?.sourceKey || null,
      event.sourceName,
      sensor?.roomName || inferRoomNameFromSourceName(event.sourceName) || null,
      event.message,
      normalizeAlertLevel(event.alertLevel),
      event.timeText,
      event.timestamp
    ]
  );

  return result.rows[0] || null;
}


async function findResidentForSensorAssignment({ residentId, residentName, locationName }) {
  const resolvedResidentId = cleanOptionalText(residentId);
  const resolvedResidentName = cleanText(residentName);
  const resolvedLocationName = cleanText(locationName) || "Unassigned location";

  if (resolvedResidentId) {
    const resident = await getResidentById(resolvedResidentId);

    if (!resident || resident.isDeleted) {
      throw new Error(`Resident not found: ${resolvedResidentId}`);
    }

    return {
      id: resident.id,
      name: resident.name,
      location: resident.location || resolvedLocationName
    };
  }

  if (!resolvedResidentName || resolvedResidentName.toLowerCase() === "unassigned") {
    return null;
  }

  const existing = await pool.query(
    `
    ${residentSelectSQL()}
    WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
      AND LOWER(TRIM(location)) = LOWER(TRIM($2))
      AND is_deleted = FALSE
    ORDER BY created_at ASC
    LIMIT 1
    `,
    [resolvedResidentName, resolvedLocationName]
  );

  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      name: existing.rows[0].name,
      location: existing.rows[0].location || resolvedLocationName
    };
  }

  const created = await pool.query(
    `
    INSERT INTO residents (
      id,
      name,
      location,
      alert_level,
      last_activity,
      active_warnings,
      status_text,
      is_deleted,
      deleted_at,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      $3,
      'Normal',
      'Resident created during BLE sensor assignment.',
      0,
      'Active monitoring',
      FALSE,
      NULL,
      NOW(),
      NOW()
    )
    RETURNING
      id,
      name,
      location,
      alert_level AS "alertLevel",
      last_activity AS "lastActivity",
      active_warnings AS "activeWarnings",
      status_text AS "statusText",
      is_deleted AS "isDeleted",
      deleted_at AS "deletedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    `,
    [randomUUID(), resolvedResidentName, resolvedLocationName]
  );

  return {
    id: created.rows[0].id,
    name: created.rows[0].name,
    location: created.rows[0].location || resolvedLocationName
  };
}

async function clearStaleSensorAssignmentsForNode(client, { nodeId, sourceKey, keepSensorId }) {
  const resolvedNodeId = cleanText(nodeId);
  const resolvedSourceKey = cleanText(sourceKey);

  if (!resolvedNodeId && !resolvedSourceKey) {
    return 0;
  }

  const result = await client.query(
    `
    UPDATE sensors
    SET
      is_active = FALSE,
      is_deleted = TRUE,
      deleted_at = NOW(),
      setup_state = 'unassigned',
      updated_at = NOW()
    WHERE id <> $3
      AND is_deleted = FALSE
      AND (
        ($1::text <> '' AND node_id = $1)
        OR ($2::text <> '' AND source_key = $2)
      )
    RETURNING id
    `,
    [resolvedNodeId, resolvedSourceKey, keepSensorId]
  );

  return result.rows.length;
}

async function updateSensorAssignment({ nodeId, residentId, residentName, locationName, roomName, sourceName, sourceKey, sensorType, sensorMode }) {
  const resolvedNodeId = cleanText(nodeId);

  if (!resolvedNodeId) {
    throw new Error("Missing required field: nodeId");
  }

  const existingNode = await getNodeById(resolvedNodeId);

  if (!existingNode) {
    throw new Error(`Node not found: ${resolvedNodeId}`);
  }

  const resident = await findResidentForSensorAssignment({
    residentId,
    residentName,
    locationName
  });

  const requestedSensorIdentity =
    sensorType ||
    sensorMode ||
    sourceName ||
    sourceKey ||
    existingNode.nodeName ||
    "Motion Sensor";
  const resolvedSensorMode = normalizedSensorModeForValue(requestedSensorIdentity, "motion");
  const resolvedSensorType = displaySensorTypeForValue(requestedSensorIdentity, "Motion Sensor");
  const resolvedResidentId = resident?.id || null;
  const resolvedResidentName = resident?.name || cleanText(residentName) || "Unassigned";
  const resolvedLocationName =
    cleanText(locationName) ||
    resident?.location ||
    existingNode.locationName ||
    "Unassigned Location";
  const resolvedRoomName = cleanOptionalText(roomName);
  const resolvedSourceKey =
    cleanText(sourceKey) ||
    `${sourcePrefixForSensorMode(resolvedSensorMode)}-${resolvedNodeId.replace(/^esp32-/, "")}`;
  const resolvedSourceName =
    cleanText(sourceName) ||
    defaultSourceNameForSensorType(resolvedSensorType, resolvedRoomName, existingNode.nodeName);
  const setupState = resolvedResidentName !== "Unassigned" || Boolean(resolvedRoomName) ? "assigned" : "unassigned";

  const client = await pool.connect();
  let didBegin = false;

  try {
    await client.query("BEGIN");
    didBegin = true;

    const sensorResult = await client.query(
      `
      INSERT INTO sensors (
        id,
        node_id,
        source_key,
        source_name,
        sensor_type,
        resident_id,
        resident_name,
        location_name,
        room_name,
        setup_state,
        is_active,
        is_deleted,
        deleted_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, FALSE, NULL, NOW(), NOW())
      ON CONFLICT (source_key)
      DO UPDATE SET
        node_id = EXCLUDED.node_id,
        source_name = EXCLUDED.source_name,
        sensor_type = EXCLUDED.sensor_type,
        resident_id = EXCLUDED.resident_id,
        resident_name = EXCLUDED.resident_name,
        location_name = EXCLUDED.location_name,
        room_name = EXCLUDED.room_name,
        setup_state = EXCLUDED.setup_state,
        is_active = TRUE,
        is_deleted = FALSE,
        deleted_at = NULL,
        updated_at = NOW()
      ${sensorReturningSQL()}
      `,
      [
        randomUUID(),
        resolvedNodeId,
        resolvedSourceKey,
        resolvedSourceName,
        resolvedSensorType,
        resolvedResidentId,
        resolvedResidentName,
        resolvedLocationName,
        resolvedRoomName,
        setupState
      ]
    );

    const sensor = sensorResult.rows[0];

    const staleSensorCount = await clearStaleSensorAssignmentsForNode(client, {
      nodeId: resolvedNodeId,
      sourceKey: resolvedSourceKey,
      keepSensorId: sensor.id
    });

    const nodeResult = await client.query(
      `
      UPDATE nodes
      SET
        node_name = $2,
        location_name = $3,
        status = CASE WHEN $4 = 'assigned' THEN 'Active' ELSE 'Pending Setup' END,
        setup_state = $4,
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
        wifi_ssid AS "wifiSsid",
        wifi_rssi AS "wifiRssi",
        setup_state AS "setupState",
        first_seen_at AS "firstSeenAt",
        last_seen_at AS "lastSeenAt",
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      `,
      [resolvedNodeId, resolvedSourceName, resolvedLocationName, setupState]
    );

    await client.query(
      `
      UPDATE node_health
      SET
        node_name = $2,
        location_name = $3,
        setup_state = $4,
        diagnostics = COALESCE(diagnostics, '{}'::jsonb) ||
          jsonb_build_object(
            'sourceKey', $5::text,
            'deviceName', $8::text,
            'sensorType', $8::text,
            'sensorMode', $9::text,
            'roomName', COALESCE($6::text, ''),
            'residentName', $7::text,
            'locationName', $3::text,
            'assignmentState', CASE WHEN $4 = 'assigned' THEN 'Assigned' ELSE 'Unassigned' END,
            'setupState', $4::text
          ),
        updated_at = NOW()
      WHERE node_id = $1
      `,
      [
        resolvedNodeId,
        resolvedSourceName,
        resolvedLocationName,
        setupState,
        resolvedSourceKey,
        resolvedRoomName,
        resolvedResidentName,
        resolvedSensorType,
        resolvedSensorMode
      ]
    );

    await client.query("COMMIT");
    didBegin = false;

    return {
      node: nodeResult.rows[0],
      sensor,
      staleSensorCount
    };
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}

async function createSensorCommand({ nodeId, commandType, payload, requestedBy, supersedeExisting = true }) {
  const client = await pool.connect();
  let didBegin = false;

  try {
    await client.query("BEGIN");
    didBegin = true;

    if (supersedeExisting) {
      await client.query(
        `
        UPDATE node_commands
        SET
          status = 'failed',
          completed_at = NOW(),
          error = 'Superseded by newer sensor command'
        WHERE node_id = $1
          AND command_type = $2
          AND status IN ('pending', 'running')
        `,
        [nodeId, commandType]
      );
    }

    const result = await client.query(
      `
      INSERT INTO node_commands (
        command_id,
        node_id,
        command_type,
        payload,
        status,
        requested_by,
        requested_at,
        picked_up_at,
        completed_at,
        result,
        error
      )
      VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, NOW(), NULL, NULL, NULL, NULL)
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
      [
        randomUUID(),
        nodeId,
        commandType,
        JSON.stringify(payload || {}),
        requestedBy
      ]
    );

    await client.query("COMMIT");
    didBegin = false;

    return result.rows[0];
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}

async function failStaleSensorCommands(client, nodeId) {
  await client.query(
    `
    UPDATE node_commands
    SET
      status = 'failed',
      completed_at = NOW(),
      error = 'Expired stale sensor command'
    WHERE node_id = $1
      AND command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
      AND status IN ('pending', 'running')
      AND requested_at < NOW() - ($2::int * INTERVAL '1 minute')
    `,
    [nodeId, SENSOR_COMMAND_EXPIRATION_MINUTES]
  );
}

app.get("/", async (req, res) => {
  res.json({
    success: true,
    message: "Good Shepherd webhook server is live",
    minimumIOSAppBuildForSetupWrites: MIN_IOS_APP_BUILD,
    remoteSupport: {
      enabled: true,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
      sensorCommandExpirationMinutes: SENSOR_COMMAND_EXPIRATION_MINUTES,
      endpoints: [
        "GET /nodes",
        "POST /nodes/register",
        "GET /node-health",
        "GET /node-health/:nodeId",
        "POST /node-health",
        "POST /node-commands",
        "GET /node-commands/:nodeId/pending",
        "POST /node-commands/:commandId/result",
        "GET /node-commands/:nodeId",
        "GET /ai/briefing",
        "GET /ai/motion-summary",
        "GET /ai/motion-events",
        "GET /ai/action-logs",
        "POST /ai/action-logs",
        "GET /sensors",
        "GET /sensor-inventory",
        "PATCH /sensors/:nodeId/assignment",
        "POST /sensor-bulk-actions",
        "GET /sensor-config/:nodeId",
        "POST /sensor-commands",
        "GET /sensor-commands/:nodeId/pending",
        "POST /sensor-commands/:commandId/result",
        "GET /sensor-commands/:nodeId",
        "GET /firmware/releases",
        "POST /firmware/releases",
        "GET /firmware/latest",
        "GET /firmware/download/:releaseTag/:assetName",
        "POST /firmware/update-node",
        "GET /resident-candidates"
      ]
    }
  });
});

app.get("/events", async (req, res) => {
  try {
    const includeAcknowledged = parseBooleanQuery(req.query.includeAcknowledged);

    const result = await pool.query(
      `
      ${eventSelectSQL()}
      WHERE ($2::boolean = TRUE OR acknowledged = FALSE)
      ORDER BY timestamp DESC
      LIMIT $1
      `,
      [MAX_EVENTS, includeAcknowledged]
    );

    res.status(200).json({
      success: true,
      includeAcknowledged,
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


app.get("/presence-telemetry/latest", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const sourceKey = cleanOptionalText(req.query.sourceKey);
    const nodeId = cleanOptionalText(req.query.nodeId);
    const residentName = cleanOptionalText(req.query.residentName);

    const result = await pool.query(
      `
      ${eventSelectSQL()}
      WHERE event_type = 'presence_telemetry'
        AND ($1::text IS NULL OR source_key = $1)
        AND ($2::text IS NULL OR node_id = $2)
        AND ($3::text IS NULL OR LOWER(TRIM(resident_name)) = LOWER(TRIM($3)))
      ORDER BY timestamp DESC
      LIMIT 1
      `,
      [sourceKey, nodeId, residentName]
    );

    const event = result.rows[0] || null;

    return res.status(200).json({
      success: true,
      found: Boolean(event),
      telemetry: event ? buildPresenceTelemetryFromEventRow(event) : null,
      event
    });
  } catch (error) {
    console.error("Failed to fetch latest presence telemetry:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch latest presence telemetry"
    });
  }
});

app.get("/ai/briefing", async (req, res) => {
  try {
    const briefing = await buildAIBriefing();
    res.status(200).json(briefing);
  } catch (error) {
    console.error("Failed to build AI briefing:", error);
    res.status(500).json({
      success: false,
      error: "Failed to build AI briefing"
    });
  }
});

app.get("/ai/motion-summary", async (req, res) => {
  try {
    const summary = await buildAIMotionSummary();
    res.status(200).json(summary);
  } catch (error) {
    console.error("Failed to build AI motion summary:", error);
    res.status(500).json({
      success: false,
      error: "Failed to build AI motion summary"
    });
  }
});

app.get("/ai/motion-events", async (req, res) => {
  try {
    const requestedLimit = normalizeInteger(req.query.limit, 100);
    const limit = Math.min(Math.max(requestedLimit, 1), 500);
    const residentId = cleanOptionalText(req.query.residentId);

    const result = await pool.query(
      `
      ${motionEventSelectSQL()}
      WHERE ($2::text IS NULL OR resident_id::text = $2)
      ORDER BY timestamp DESC
      LIMIT $1
      `,
      [limit, residentId]
    );

    res.status(200).json({
      success: true,
      count: result.rows.length,
      events: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch AI motion events:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch AI motion events"
    });
  }
});

app.get("/ai/action-logs", async (req, res) => {
  try {
    const requestedLimit = normalizeInteger(req.query.limit, 100);
    const limit = Math.min(Math.max(requestedLimit, 1), 500);
    const residentId = cleanOptionalText(req.query.residentId);
    const residentName = cleanOptionalText(req.query.residentName);

    const result = await pool.query(
      `
      ${aiActionLogSelectSQL()}
      WHERE ($2::text IS NULL OR resident_id::text = $2)
        AND ($3::text IS NULL OR LOWER(TRIM(resident_name)) = LOWER(TRIM($3)))
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit, residentId, residentName]
    );

    res.status(200).json({
      success: true,
      count: result.rows.length,
      logs: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch AI action logs:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch AI action logs"
    });
  }
});

app.post("/ai/action-logs", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized action log request"
      });
    }

    const residentId = cleanOptionalText(req.body?.residentId);
    const residentName = cleanText(req.body?.residentName);
    const actionLevel = cleanText(req.body?.actionLevel);
    const actionTitle = cleanText(req.body?.actionTitle);
    const actionStatus = cleanText(req.body?.actionStatus) || "completed";
    const actionNote = cleanOptionalText(req.body?.actionNote);
    const createdBy = cleanOptionalText(req.body?.createdBy);

    if (!residentName || !actionLevel || !actionTitle) {
      return res.status(400).json({
        success: false,
        error: "residentName, actionLevel, and actionTitle are required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO ai_action_logs (
        id,
        resident_id,
        resident_name,
        action_level,
        action_title,
        action_status,
        action_note,
        created_by,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING
        id,
        resident_id AS "residentId",
        resident_name AS "residentName",
        action_level AS "actionLevel",
        action_title AS "actionTitle",
        action_status AS "actionStatus",
        action_note AS "actionNote",
        created_by AS "createdBy",
        created_at AS "createdAt"
      `,
      [
        randomUUID(),
        residentId,
        residentName,
        actionLevel,
        actionTitle,
        actionStatus,
        actionNote,
        createdBy
      ]
    );

    res.status(201).json({
      success: true,
      log: result.rows[0]
    });
  } catch (error) {
    console.error("Failed to create AI action log:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create AI action log"
    });
  }
});

app.patch("/events/:eventId/acknowledge", async (req, res) => {
  try {
    if (!isAuthorizedWebhook(req)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized event acknowledgment request"
      });
    }

    const eventId = cleanText(req.params.eventId);
    const resolutionNote = cleanText(req.body?.resolutionNote);

    if (!eventId) {
      return res.status(400).json({
        success: false,
        error: "Missing eventId"
      });
    }

    if (!resolutionNote) {
      return res.status(400).json({
        success: false,
        error: "Resolution note is required"
      });
    }

    const result = await pool.query(
      `
      UPDATE webhook_events
      SET
        acknowledged = TRUE,
        acknowledged_at = NOW(),
        resolution_note = $2
      WHERE id = $1
      RETURNING
        id,
        node_id AS "nodeId",
        location_name AS "locationName",
        source_key AS "sourceKey",
        source_name AS "sourceName",
        resident_name AS "residentName",
        message,
        alert_level AS "alertLevel",
        time_text AS "timeText",
        timestamp,
        event_type AS "eventType",
        sensor_type AS "sensorType",
        event_payload AS "eventPayload",
        acknowledged AS "isAcknowledged",
        acknowledged_at AS "acknowledgedAt",
        resolution_note AS "resolutionNote"
      `,
      [eventId, resolutionNote]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Event not found: ${eventId}`
      });
    }

    return res.status(200).json({
      success: true,
      message: "Event acknowledged",
      event: result.rows[0]
    });
  } catch (error) {
    console.error("Event acknowledgment failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/nodes", async (req, res) => {
  try {
    const includeArchived = parseBooleanQuery(req.query.includeArchived);

    const result = await pool.query(
      `
      SELECT
        n.node_id AS "nodeId",
        n.node_name AS "nodeName",
        n.location_name AS "locationName",
        n.status,
        n.local_ip AS "localIp",
        n.local_config_port AS "localConfigPort",
        n.camera_count AS "cameraCount",
        n.camera_summary AS "cameraSummary",
        COALESCE(h.software_version, n.software_version) AS "softwareVersion",
        COALESCE(h.wifi_ssid, n.wifi_ssid) AS "wifiSsid",
        COALESCE(h.wifi_rssi, n.wifi_rssi) AS "wifiRssi",
        COALESCE(h.setup_state, n.setup_state) AS "setupState",
        n.first_seen_at AS "firstSeenAt",
        n.last_seen_at AS "lastSeenAt",
        n.is_archived AS "isArchived",
        n.archived_at AS "archivedAt",
        n.archived_reason AS "archivedReason",
        h.monitor_status AS "monitorStatus",
        h.ffmpeg_status AS "ffmpegStatus",
        h.last_error AS "lastError",
        h.checked_in_at AS "healthCheckedInAt",
        EXTRACT(EPOCH FROM (NOW() - h.checked_in_at))::int AS "secondsSinceHealthCheckIn",
        CASE
          WHEN h.checked_in_at >= NOW() - ($2::int * INTERVAL '1 second') THEN TRUE
          ELSE FALSE
        END AS "isOnline"
      FROM nodes n
      LEFT JOIN node_health h ON h.node_id = n.node_id
      WHERE ($1::boolean = TRUE OR n.is_archived = FALSE)
      ORDER BY n.is_archived ASC, COALESCE(h.checked_in_at, n.last_seen_at) DESC
      `,
      [includeArchived, NODE_OFFLINE_AFTER_SECONDS]
    );

    res.status(200).json({
      success: true,
      includeArchived,
      count: result.rows.length,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
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

app.get("/node-health", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
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
    if (!requireAuthorizedRequest(req, res)) {
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

app.post("/node-commands", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.body?.nodeId);
    const commandType = normalizeNodeCommandType(req.body?.commandType);
    const payload = normalizeJsonObject(req.body?.payload);
    const requestedBy = cleanText(req.body?.requestedBy) || "Good Shepherd App";

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: nodeId"
      });
    }

    if (!commandType) {
      return res.status(400).json({
        success: false,
        error: "Invalid or missing commandType"
      });
    }

    const existingNode = await getNodeById(nodeId);

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    const command = await createCommand({
      nodeId,
      commandType,
      payload,
      requestedBy
    });

    console.log("Node command created:");
    console.log(JSON.stringify(command, null, 2));

    return res.status(201).json({
      success: true,
      message: "Node command created",
      command
    });
  } catch (error) {
    console.error("Create node command failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/node-commands/:nodeId/pending", async (req, res) => {
  const client = await pool.connect();
  let didBegin = false;

  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    await client.query(
      `
      UPDATE node_commands
      SET
        status = 'pending',
        picked_up_at = NULL
      WHERE node_id = $1
        AND status = 'running'
        AND picked_up_at < NOW() - INTERVAL '5 minutes'
      `,
      [nodeId]
    );

    const pendingResult = await client.query(
      `
      SELECT command_id
      FROM node_commands
      WHERE node_id = $1
        AND status = 'pending'
      ORDER BY requested_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
      `,
      [nodeId]
    );

    const commandIds = pendingResult.rows.map((row) => row.command_id);
    let commands = [];

    if (commandIds.length > 0) {
      const updateResult = await client.query(
        `
        UPDATE node_commands
        SET
          status = 'running',
          picked_up_at = NOW()
        WHERE command_id = ANY($1::uuid[])
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
        [commandIds]
      );

      commands = updateResult.rows;
    }

    await client.query("COMMIT");
    didBegin = false;

    return res.status(200).json({
      success: true,
      nodeId,
      count: commands.length,
      commands
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Fetch pending node commands failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.post("/node-commands/:commandId/result", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const commandId = cleanText(req.params.commandId);
    const status = normalizeCommandStatus(req.body?.status);
    const resultPayload = normalizeJsonObject(req.body?.result);
    const error = cleanOptionalText(req.body?.error);

    if (!commandId) {
      return res.status(400).json({
        success: false,
        error: "Missing commandId"
      });
    }

    if (status !== "success" && status !== "failed") {
      return res.status(400).json({
        success: false,
        error: "Command result status must be success or failed"
      });
    }

    const result = await pool.query(
      `
      UPDATE node_commands
      SET
        status = $2,
        completed_at = NOW(),
        result = $3::jsonb,
        error = $4
      WHERE command_id = $1
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
      [
        commandId,
        status,
        JSON.stringify(resultPayload),
        error
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Command not found: ${commandId}`
      });
    }

    console.log("Node command result received:");
    console.log(JSON.stringify(result.rows[0], null, 2));

    return res.status(200).json({
      success: true,
      message: "Node command result saved",
      command: result.rows[0]
    });
  } catch (error) {
    console.error("Save node command result failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/node-commands/:nodeId", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
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
      ${nodeCommandSelectSQL()}
      WHERE node_id = $1
      ORDER BY requested_at DESC
      LIMIT 25
      `,
      [nodeId]
    );

    return res.status(200).json({
      success: true,
      nodeId,
      count: result.rows.length,
      commands: result.rows
    });
  } catch (error) {
    console.error("Fetch node command history failed:", error);
    return res.status(500).json({
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

app.get("/residents", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const includeDeleted = parseBooleanQuery(req.query.includeDeleted);

    const result = await pool.query(
      `
      ${residentSelectSQL()}
      WHERE ($1::boolean = TRUE OR is_deleted = FALSE)
      ORDER BY is_deleted ASC, name ASC, created_at ASC
      `,
      [includeDeleted]
    );

    return res.status(200).json({
      success: true,
      includeDeleted,
      count: result.rows.length,
      residents: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch residents:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch residents"
    });
  }
});

app.post("/residents", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const residentId = validUuidOrGenerated(req.body?.id);
    const name = cleanText(req.body?.name);
    const location = cleanText(req.body?.location) || "Unassigned location";
    const alertLevel = normalizeAlertLevel(req.body?.alertLevel);
    const activeWarnings = Number.isFinite(Number(req.body?.activeWarnings))
      ? Number(req.body.activeWarnings)
      : warningCountForAlertLevel(alertLevel);
    const lastActivity =
      cleanText(req.body?.lastActivity) || "Resident added. Waiting for first device event.";
    const statusText = cleanText(req.body?.statusText) || "Monitoring setup pending";

    if (!name) {
      return res.status(400).json({
        success: false,
        error: "Resident name is required"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO residents (
        id,
        name,
        location,
        alert_level,
        last_activity,
        active_warnings,
        status_text,
        is_deleted,
        deleted_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, NULL, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        name = EXCLUDED.name,
        location = EXCLUDED.location,
        alert_level = EXCLUDED.alert_level,
        last_activity = EXCLUDED.last_activity,
        active_warnings = EXCLUDED.active_warnings,
        status_text = EXCLUDED.status_text,
        is_deleted = FALSE,
        deleted_at = NULL,
        updated_at = NOW()
      RETURNING
        id,
        name,
        location,
        alert_level AS "alertLevel",
        last_activity AS "lastActivity",
        active_warnings AS "activeWarnings",
        status_text AS "statusText",
        is_deleted AS "isDeleted",
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
      [
        residentId,
        name,
        location,
        alertLevel,
        lastActivity,
        activeWarnings,
        statusText
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Resident saved",
      resident: result.rows[0]
    });
  } catch (error) {
    console.error("Resident save failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/residents/:residentId", async (req, res) => {
  const client = await pool.connect();
  let didBegin = false;

  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const residentId = cleanText(req.params.residentId);

    if (!residentId) {
      return res.status(400).json({
        success: false,
        error: "Missing residentId"
      });
    }

    const existingResident = await getResidentById(residentId);

    if (!existingResident || existingResident.isDeleted) {
      return res.status(404).json({
        success: false,
        error: `Resident not found: ${residentId}`
      });
    }

    const nextName = cleanText(req.body?.name) || existingResident.name;
    const nextLocation = cleanText(req.body?.location) || existingResident.location || "Unassigned location";
    const nextAlertLevel = req.body?.alertLevel
      ? normalizeAlertLevel(req.body.alertLevel)
      : existingResident.alertLevel;
    const nextLastActivity = cleanText(req.body?.lastActivity) || existingResident.lastActivity;
    const nextActiveWarnings = Number.isFinite(Number(req.body?.activeWarnings))
      ? Number(req.body.activeWarnings)
      : warningCountForAlertLevel(nextAlertLevel);
    const nextStatusText = cleanText(req.body?.statusText) || existingResident.statusText;

    if (!nextName) {
      return res.status(400).json({
        success: false,
        error: "Resident name is required"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    const sourceResult = await client.query(
      `
      SELECT DISTINCT source_key
      FROM (
        SELECT source_key
        FROM sensors
        WHERE resident_id = $1
          AND is_deleted = FALSE
          AND source_key IS NOT NULL
          AND TRIM(source_key) <> ''

        UNION

        SELECT source_key
        FROM cameras
        WHERE resident_id = $1
          AND is_deleted = FALSE
          AND source_key IS NOT NULL
          AND TRIM(source_key) <> ''
      ) related_sources
      `,
      [residentId]
    );

    const relatedSourceKeys = sourceResult.rows.map((row) => row.source_key).filter(Boolean);

    const result = await client.query(
      `
      UPDATE residents
      SET
        name = $2,
        location = $3,
        alert_level = $4,
        last_activity = $5,
        active_warnings = $6,
        status_text = $7,
        updated_at = NOW()
      WHERE id = $1
      RETURNING
        id,
        name,
        location,
        alert_level AS "alertLevel",
        last_activity AS "lastActivity",
        active_warnings AS "activeWarnings",
        status_text AS "statusText",
        is_deleted AS "isDeleted",
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
      [
        residentId,
        nextName,
        nextLocation,
        nextAlertLevel,
        nextLastActivity,
        nextActiveWarnings,
        nextStatusText
      ]
    );

    await client.query(
      `
      UPDATE cameras
      SET
        resident_name = $2,
        updated_at = NOW()
      WHERE resident_id = $1
        AND is_deleted = FALSE
      `,
      [residentId, nextName]
    );

    await client.query(
      `
      UPDATE sensors
      SET
        resident_name = $2,
        location_name = $3,
        updated_at = NOW()
      WHERE resident_id = $1
        AND is_deleted = FALSE
      `,
      [residentId, nextName, nextLocation]
    );

    await client.query(
      `
      UPDATE motion_events
      SET
        resident_name = $2,
        location_name = COALESCE(location_name, $3)
      WHERE resident_id = $1
      `,
      [residentId, nextName, nextLocation]
    );

    await client.query(
      `
      UPDATE ai_action_logs
      SET
        resident_name = $2
      WHERE resident_id = $1
      `,
      [residentId, nextName]
    );

    if (relatedSourceKeys.length > 0) {
      await client.query(
        `
        UPDATE device_mappings
        SET
          resident_name = $2
        WHERE source_key = ANY($1::text[])
          AND LOWER(TRIM(resident_name)) = LOWER(TRIM($3))
        `,
        [relatedSourceKeys, nextName, existingResident.name]
      );

      await client.query(
        `
        UPDATE webhook_events
        SET
          resident_name = $2,
          location_name = COALESCE(location_name, $3)
        WHERE source_key = ANY($1::text[])
          AND LOWER(TRIM(resident_name)) = LOWER(TRIM($4))
        `,
        [relatedSourceKeys, nextName, nextLocation, existingResident.name]
      );
    }

    await client.query("COMMIT");
    didBegin = false;

    return res.status(200).json({
      success: true,
      message: "Resident updated",
      resident: result.rows[0],
      relatedSourceKeys
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Resident update failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.delete("/residents/:residentId", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const residentId = cleanText(req.params.residentId);

    if (!residentId) {
      return res.status(400).json({
        success: false,
        error: "Missing residentId"
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const residentResult = await client.query(
        `
        UPDATE residents
        SET
          is_deleted = TRUE,
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
          AND is_deleted = FALSE
        RETURNING
          id,
          name,
          location,
          alert_level AS "alertLevel",
          last_activity AS "lastActivity",
          active_warnings AS "activeWarnings",
          status_text AS "statusText",
          is_deleted AS "isDeleted",
          deleted_at AS "deletedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        `,
        [residentId]
      );

      if (!residentResult.rows[0]) {
        await client.query("ROLLBACK");

        return res.status(404).json({
          success: false,
          error: `Resident not found: ${residentId}`
        });
      }

      const deletedResidentName = residentResult.rows[0].name;

      const cameraResult = await client.query(
        `
        UPDATE cameras
        SET
          is_deleted = TRUE,
          deleted_at = NOW(),
          resident_id = NULL,
          resident_name = 'Unassigned',
          is_active = FALSE,
          assigned_node_id = NULL,
          updated_at = NOW()
        WHERE is_deleted = FALSE
          AND (
            resident_id = $1
            OR LOWER(TRIM(resident_name)) = LOWER(TRIM($2))
          )
        RETURNING id
        `,
        [residentId, deletedResidentName]
      );

      const sensorResult = await client.query(
        `
        UPDATE sensors
        SET
          resident_id = NULL,
          resident_name = 'Unassigned',
          setup_state = 'unassigned',
          updated_at = NOW()
        WHERE is_deleted = FALSE
          AND (
            resident_id = $1
            OR LOWER(TRIM(resident_name)) = LOWER(TRIM($2))
          )
        RETURNING id
        `,
        [residentId, deletedResidentName]
      );

      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        message: "Resident deleted",
        resident: residentResult.rows[0],
        affectedCameraCount: cameraResult.rows.length,
        affectedSensorCount: sensorResult.rows.length
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Resident delete failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/cameras", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const includeDeleted = parseBooleanQuery(req.query.includeDeleted);
    const activeOnly = parseBooleanQuery(req.query.activeOnly);
    const residentId = cleanText(req.query.residentId);
    const nodeId = cleanText(req.query.nodeId);

    const result = await pool.query(
      `
      ${cameraSelectSQL()}
      WHERE ($1::boolean = TRUE OR is_deleted = FALSE)
        AND ($2::boolean = FALSE OR is_active = TRUE)
        AND ($3::text IS NULL OR resident_id::text = $3)
        AND ($4::text IS NULL OR assigned_node_id = $4)
      ORDER BY is_deleted ASC, source_name ASC, created_at ASC
      `,
      [includeDeleted, activeOnly, residentId || null, nodeId || null]
    );

    return res.status(200).json({
      success: true,
      includeDeleted,
      activeOnly,
      count: result.rows.length,
      cameras: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch cameras:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch cameras"
    });
  }
});

app.post("/cameras", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const cameraId = validUuidOrGenerated(req.body?.id);
    const sourceKey = cleanText(req.body?.sourceKey);
    const sourceName = cleanText(req.body?.sourceName);
    const rtspUrl = cleanText(req.body?.rtspUrl);
    const requestedResidentId = cleanOptionalText(req.body?.residentID ?? req.body?.residentId);
    const requestedResidentName = cleanText(req.body?.residentName);
    const requestedAssignedNodeId = cleanOptionalText(req.body?.assignedNodeId);
    const requestedIsActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : null;

    if (!sourceKey) {
      return res.status(400).json({
        success: false,
        error: "sourceKey is required"
      });
    }

    if (!sourceName) {
      return res.status(400).json({
        success: false,
        error: "sourceName is required"
      });
    }

    if (!rtspUrl) {
      return res.status(400).json({
        success: false,
        error: "rtspUrl is required"
      });
    }

    let resolvedResidentId = requestedResidentId;
    let resolvedResidentName = requestedResidentName || "Unassigned";

    if (resolvedResidentId) {
      const resident = await getResidentById(resolvedResidentId);

      if (!resident || resident.isDeleted) {
        return res.status(400).json({
          success: false,
          error: `Resident not found: ${resolvedResidentId}`
        });
      }

      resolvedResidentName = resident.name;
    } else {
      resolvedResidentId = null;
    }

    const resolvedIsActive =
      requestedIsActive === null ? Boolean(resolvedResidentId) : requestedIsActive;

    const result = await pool.query(
      `
      INSERT INTO cameras (
        id,
        source_key,
        source_name,
        resident_id,
        resident_name,
        rtsp_url,
        is_active,
        assigned_node_id,
        is_deleted,
        deleted_at,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE, NULL, NOW(), NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        source_key = EXCLUDED.source_key,
        source_name = EXCLUDED.source_name,
        resident_id = EXCLUDED.resident_id,
        resident_name = EXCLUDED.resident_name,
        rtsp_url = EXCLUDED.rtsp_url,
        is_active = EXCLUDED.is_active,
        assigned_node_id = EXCLUDED.assigned_node_id,
        is_deleted = FALSE,
        deleted_at = NULL,
        updated_at = NOW()
      ${cameraReturningSQL()}
      `,
      [
        cameraId,
        sourceKey,
        sourceName,
        resolvedResidentId,
        resolvedResidentName,
        rtspUrl,
        resolvedIsActive,
        requestedAssignedNodeId
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Camera saved",
      camera: result.rows[0]
    });
  } catch (error) {
    console.error("Camera save failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/cameras/:cameraId", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const cameraId = cleanText(req.params.cameraId);

    if (!cameraId) {
      return res.status(400).json({
        success: false,
        error: "Missing cameraId"
      });
    }

    const existingResult = await pool.query(
      `
      ${cameraSelectSQL()}
      WHERE id = $1
      LIMIT 1
      `,
      [cameraId]
    );

    const existingCamera = existingResult.rows[0];

    if (!existingCamera || existingCamera.isDeleted) {
      return res.status(404).json({
        success: false,
        error: `Camera not found: ${cameraId}`
      });
    }

    const nextSourceKey = cleanText(req.body?.sourceKey) || existingCamera.sourceKey;
    const nextSourceName = cleanText(req.body?.sourceName) || existingCamera.sourceName;
    const nextRtspUrl = cleanText(req.body?.rtspUrl) || existingCamera.rtspUrl;
    const requestIncludesResident =
      Object.prototype.hasOwnProperty.call(req.body || {}, "residentID") ||
      Object.prototype.hasOwnProperty.call(req.body || {}, "residentId");
    const requestIncludesAssignedNode =
      Object.prototype.hasOwnProperty.call(req.body || {}, "assignedNodeId");
    const requestIncludesIsActive =
      Object.prototype.hasOwnProperty.call(req.body || {}, "isActive");

    let nextResidentId = existingCamera.residentId;
    let nextResidentName = existingCamera.residentName;

    if (requestIncludesResident) {
      const requestedResidentId = cleanOptionalText(req.body?.residentID ?? req.body?.residentId);

      if (requestedResidentId) {
        const resident = await getResidentById(requestedResidentId);

        if (!resident || resident.isDeleted) {
          return res.status(400).json({
            success: false,
            error: `Resident not found: ${requestedResidentId}`
          });
        }

        nextResidentId = requestedResidentId;
        nextResidentName = resident.name;
      } else {
        nextResidentId = null;
        nextResidentName = "Unassigned";
      }
    }

    const nextAssignedNodeId = requestIncludesAssignedNode
      ? cleanOptionalText(req.body?.assignedNodeId)
      : existingCamera.assignedNodeId;

    const nextIsActive = requestIncludesIsActive
      ? Boolean(req.body?.isActive)
      : existingCamera.isActive;

    const result = await pool.query(
      `
      UPDATE cameras
      SET
        source_key = $2,
        source_name = $3,
        resident_id = $4,
        resident_name = $5,
        rtsp_url = $6,
        is_active = $7,
        assigned_node_id = $8,
        updated_at = NOW()
      WHERE id = $1
      ${cameraReturningSQL()}
      `,
      [
        cameraId,
        nextSourceKey,
        nextSourceName,
        nextResidentId,
        nextResidentName,
        nextRtspUrl,
        nextIsActive,
        nextAssignedNodeId
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Camera updated",
      camera: result.rows[0]
    });
  } catch (error) {
    console.error("Camera update failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.delete("/cameras/:cameraId", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const cameraId = cleanText(req.params.cameraId);

    if (!cameraId) {
      return res.status(400).json({
        success: false,
        error: "Missing cameraId"
      });
    }

    const result = await pool.query(
      `
      UPDATE cameras
      SET
        is_deleted = TRUE,
        deleted_at = NOW(),
        is_active = FALSE,
        assigned_node_id = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND is_deleted = FALSE
      ${cameraReturningSQL()}
      `,
      [cameraId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({
        success: false,
        error: `Camera not found: ${cameraId}`
      });
    }

    return res.status(200).json({
      success: true,
      message: "Camera deleted",
      camera: result.rows[0]
    });
  } catch (error) {
    console.error("Camera delete failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/sensor-inventory", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const includeArchived = parseBooleanQuery(req.query.includeArchived);
    const includeDeleted = parseBooleanQuery(req.query.includeDeleted);

    const result = await pool.query(
      `
      SELECT
        n.node_id AS "nodeId",
        n.node_name AS "nodeName",
        COALESCE(s.source_name, n.node_name, h.node_name, 'Motion Sensor') AS "displayName",
        n.location_name AS "nodeLocationName",
        COALESCE(s.location_name, n.location_name, h.location_name, 'Unassigned location') AS "locationName",
        n.status AS "nodeStatus",
        n.local_ip AS "localIp",
        n.local_config_port AS "localConfigPort",
        COALESCE(h.software_version, n.software_version) AS "softwareVersion",
        COALESCE(h.wifi_ssid, n.wifi_ssid) AS "wifiSsid",
        COALESCE(h.wifi_rssi, n.wifi_rssi) AS "wifiRssi",
        h.checked_in_at AS "healthCheckedInAt",
        EXTRACT(EPOCH FROM (NOW() - h.checked_in_at))::int AS "secondsSinceHealthCheckIn",
        CASE
          WHEN h.checked_in_at >= NOW() - ($3::int * INTERVAL '1 second') THEN TRUE
          ELSE FALSE
        END AS "isOnline",
        n.is_archived AS "isArchived",
        n.archived_at AS "archivedAt",
        n.archived_reason AS "archivedReason",
        s.id AS "sensorId",
        s.source_key AS "sourceKey",
        s.source_name AS "sourceName",
        s.sensor_type AS "sensorType",
        s.resident_id AS "residentId",
        s.resident_name AS "residentName",
        s.room_name AS "roomName",
        s.is_active AS "isActive",
        s.is_deleted AS "isDeleted",
        CASE
          WHEN s.id IS NULL THEN FALSE
          WHEN s.resident_id IS NOT NULL THEN TRUE
          WHEN LOWER(TRIM(COALESCE(s.resident_name, ''))) <> '' AND LOWER(TRIM(COALESCE(s.resident_name, ''))) <> 'unassigned' THEN TRUE
          WHEN TRIM(COALESCE(s.room_name, '')) <> '' THEN TRUE
          WHEN s.setup_state = 'assigned' THEN TRUE
          WHEN n.setup_state = 'assigned' THEN TRUE
          ELSE FALSE
        END AS "isAssigned",
        CASE
          WHEN s.id IS NULL THEN 'unassigned'
          WHEN s.resident_id IS NOT NULL THEN 'assigned'
          WHEN LOWER(TRIM(COALESCE(s.resident_name, ''))) <> '' AND LOWER(TRIM(COALESCE(s.resident_name, ''))) <> 'unassigned' THEN 'assigned'
          WHEN TRIM(COALESCE(s.room_name, '')) <> '' THEN 'assigned'
          WHEN s.setup_state = 'assigned' THEN 'assigned'
          WHEN n.setup_state = 'assigned' THEN 'assigned'
          ELSE 'unassigned'
        END AS "setupState",
        h.diagnostics AS "diagnostics",
        (
          SELECT jsonb_build_object(
            'commandId', c.command_id,
            'commandType', c.command_type,
            'status', c.status,
            'requestedAt', c.requested_at,
            'pickedUpAt', c.picked_up_at,
            'completedAt', c.completed_at,
            'result', c.result,
            'error', c.error
          )
          FROM node_commands c
          WHERE c.node_id = n.node_id
            AND c.command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
          ORDER BY c.requested_at DESC
          LIMIT 1
        ) AS "latestCommand"
      FROM nodes n
      LEFT JOIN node_health h ON h.node_id = n.node_id
      LEFT JOIN sensors s ON s.node_id = n.node_id
        AND ($2::boolean = TRUE OR s.is_deleted = FALSE)
      WHERE n.node_id LIKE 'esp32-%'
        AND ($1::boolean = TRUE OR n.is_archived = FALSE)
      ORDER BY
        CASE WHEN h.checked_in_at >= NOW() - ($3::int * INTERVAL '1 second') THEN 0 ELSE 1 END,
        CASE
          WHEN s.id IS NULL THEN 1
          WHEN s.resident_id IS NULL AND LOWER(TRIM(COALESCE(s.resident_name, ''))) IN ('', 'unassigned') AND TRIM(COALESCE(s.room_name, '')) = '' THEN 1
          ELSE 0
        END DESC,
        COALESCE(h.checked_in_at, n.last_seen_at) DESC
      `,
      [includeArchived, includeDeleted, NODE_OFFLINE_AFTER_SECONDS]
    );

    const sensors = result.rows.map((row) => ({
      ...row,
      actionState: row.latestCommand && ["pending", "running"].includes(row.latestCommand.status)
        ? row.latestCommand.status
        : "idle"
    }));

    return res.status(200).json({
      success: true,
      includeArchived,
      includeDeleted,
      count: sensors.length,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
      sensors
    });
  } catch (error) {
    console.error("Fetch sensor inventory failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.patch("/sensors/:nodeId/assignment", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const assignment = await updateSensorAssignment({
      nodeId,
      residentId: req.body?.residentId ?? req.body?.residentID,
      residentName: req.body?.residentName,
      locationName: req.body?.locationName,
      roomName: req.body?.roomName,
      sourceName: req.body?.sourceName,
      sourceKey: req.body?.sourceKey,
      sensorType: req.body?.sensorType,
      sensorMode: req.body?.sensorMode
    });

    return res.status(200).json({
      success: true,
      message: "Sensor assignment updated without setup reset",
      ...assignment
    });
  } catch (error) {
    console.error("Sensor assignment update failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/sensor-bulk-actions", async (req, res) => {
  try {
    if (!requireAuthorizedCurrentAppWrite(req, res)) {
      return;
    }

    const action = cleanText(req.body?.action).toLowerCase();
    const nodeIds = sanitizeBulkNodeIds(req.body?.nodeIds);
    const payload = normalizeJsonObject(req.body?.payload);
    const requestedBy = cleanText(req.body?.requestedBy) || "Good Shepherd Bulk Sensor Commissioning";
    const allowedBulkActions = ["identify", "locate", "update_firmware", "reconfigure", "factory_reset", "reboot", "ping", "assign"];

    if (!allowedBulkActions.includes(action)) {
      return res.status(400).json({
        success: false,
        error: "Invalid or missing bulk action",
        allowedBulkActions
      });
    }

    if (nodeIds.length === 0 && action !== "assign") {
      return res.status(400).json({
        success: false,
        error: "nodeIds must contain at least one nodeId"
      });
    }

    if (action === "assign") {
      const assignments = Array.isArray(req.body?.assignments) ? req.body.assignments : [];

      if (assignments.length === 0) {
        return res.status(400).json({
          success: false,
          error: "assign bulk action requires assignments[]"
        });
      }

      const results = [];
      const errors = [];

      for (const assignmentRequest of assignments) {
        const assignmentNodeId = cleanText(assignmentRequest?.nodeId);

        try {
          const assignment = await updateSensorAssignment({
            nodeId: assignmentNodeId,
            residentId: assignmentRequest?.residentId ?? assignmentRequest?.residentID,
            residentName: assignmentRequest?.residentName,
            locationName: assignmentRequest?.locationName,
            roomName: assignmentRequest?.roomName,
            sourceName: assignmentRequest?.sourceName,
            sourceKey: assignmentRequest?.sourceKey,
            sensorType: assignmentRequest?.sensorType,
            sensorMode: assignmentRequest?.sensorMode
          });

          results.push({
            nodeId: assignmentNodeId,
            success: true,
            ...assignment
          });
        } catch (error) {
          errors.push({
            nodeId: assignmentNodeId || null,
            success: false,
            error: error.message
          });
        }
      }

      return res.status(errors.length > 0 ? 207 : 200).json({
        success: errors.length === 0,
        action,
        requestedCount: assignments.length,
        successCount: results.length,
        errorCount: errors.length,
        results,
        errors
      });
    }

    const commandType = normalizeEsp32SensorCommandType(action);

    if (!commandType) {
      return res.status(400).json({
        success: false,
        error: "Action is not a valid ESP32 sensor command"
      });
    }

    if (commandType === "update_firmware") {
      if (!isValidFirmwareUrl(payload.firmwareUrl)) {
        return res.status(400).json({
          success: false,
          error: "update_firmware requires payload.firmwareUrl as an HTTPS URL"
        });
      }

      if (!cleanText(payload.firmwareVersion)) {
        return res.status(400).json({
          success: false,
          error: "update_firmware requires payload.firmwareVersion"
        });
      }
    }

    const results = [];
    const errors = [];

    for (const nodeId of nodeIds) {
      try {
        const existingNode = await getNodeById(nodeId);

        if (!existingNode) {
          throw new Error(`Node not found: ${nodeId}`);
        }

        const command = await createSensorCommand({
          nodeId,
          commandType,
          payload,
          requestedBy,
          supersedeExisting: true
        });

        results.push({
          nodeId,
          success: true,
          command
        });
      } catch (error) {
        errors.push({
          nodeId,
          success: false,
          error: error.message
        });
      }
    }

    return res.status(errors.length > 0 ? 207 : 201).json({
      success: errors.length === 0,
      action,
      commandType,
      requestedCount: nodeIds.length,
      successCount: results.length,
      errorCount: errors.length,
      results,
      errors
    });
  } catch (error) {
    console.error("Sensor bulk action failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/sensors", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const includeDeleted = parseBooleanQuery(req.query.includeDeleted);
    const activeOnly = parseBooleanQuery(req.query.activeOnly);
    const residentId = cleanText(req.query.residentId);
    const nodeId = cleanText(req.query.nodeId);

    const result = await pool.query(
      `
      ${sensorSelectSQL()}
      WHERE ($1::boolean = TRUE OR is_deleted = FALSE)
        AND ($2::boolean = FALSE OR is_active = TRUE)
        AND ($3::text IS NULL OR resident_id::text = $3)
        AND ($4::text IS NULL OR node_id = $4)
      ORDER BY is_deleted ASC, source_name ASC, created_at ASC
      `,
      [
        includeDeleted,
        activeOnly,
        residentId || null,
        nodeId || null
      ]
    );

    return res.status(200).json({
      success: true,
      includeDeleted,
      activeOnly,
      count: result.rows.length,
      sensors: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch sensors:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch sensors"
    });
  }
});

app.get("/resident-candidates", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const locationName = cleanText(req.query.locationName);
    const includeDeleted = parseBooleanQuery(req.query.includeDeleted);

    const result = await pool.query(
      `
      ${residentSelectSQL()}
      WHERE ($1::boolean = TRUE OR is_deleted = FALSE)
        AND (
          $2::text = ''
          OR LOWER(TRIM(location)) = LOWER(TRIM($2))
          OR LOWER(TRIM(location)) LIKE LOWER(TRIM($2)) || '%'
        )
      ORDER BY is_deleted ASC, name ASC, created_at ASC
      `,
      [includeDeleted, locationName]
    );

    return res.status(200).json({
      success: true,
      locationName: locationName || null,
      includeDeleted,
      count: result.rows.length,
      residents: result.rows
    });
  } catch (error) {
    console.error("Failed to fetch resident candidates:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch resident candidates"
    });
  }
});

app.get("/sensor-config/:nodeId", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const node = await getNodeById(nodeId);

    const sensorResult = await pool.query(
      `
      ${sensorSelectSQL()}
      WHERE node_id = $1
        AND is_deleted = FALSE
      ORDER BY source_name ASC, created_at ASC
      `,
      [nodeId]
    );

    const residentIds = sensorResult.rows
      .map((sensor) => sensor.residentId)
      .filter(Boolean);

    let residents = [];

    if (residentIds.length > 0) {
      const residentResult = await pool.query(
        `
        ${residentSelectSQL()}
        WHERE id = ANY($1::uuid[])
          AND is_deleted = FALSE
        ORDER BY name ASC, created_at ASC
        `,
        [residentIds]
      );

      residents = residentResult.rows;
    } else if (node?.locationName) {
      const residentResult = await pool.query(
        `
        ${residentSelectSQL()}
        WHERE is_deleted = FALSE
          AND LOWER(TRIM(location)) = LOWER(TRIM($1))
        ORDER BY name ASC, created_at ASC
        `,
        [node.locationName]
      );

      residents = residentResult.rows;
    }

    return res.status(200).json({
      success: true,
      nodeId,
      node: node || null,
      sensors: sensorResult.rows,
      residents,
      residentCount: residents.length,
      sensorCount: sensorResult.rows.length,
      suggestedResident: residents.length === 1 ? residents[0] : null
    });
  } catch (error) {
    console.error("Failed to fetch sensor config:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/sensor-commands/:nodeId", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.params.nodeId);
    const activeOnly = parseBooleanQuery(req.query.activeOnly);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    const result = await pool.query(
      `
      ${nodeCommandSelectSQL()}
      WHERE node_id = $1
        AND command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
        AND ($2::boolean = FALSE OR status IN ('pending', 'running'))
      ORDER BY requested_at DESC
      LIMIT 50
      `,
      [nodeId, activeOnly]
    );

    return res.status(200).json({
      success: true,
      nodeId,
      activeOnly,
      count: result.rows.length,
      commands: result.rows
    });
  } catch (error) {
    console.error("Fetch sensor command history failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/sensor-commands", async (req, res) => {
  const client = await pool.connect();
  let didBegin = false;

  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.body?.nodeId);
    const commandType = normalizeEsp32SensorCommandType(req.body?.commandType);
    const payload = normalizeJsonObject(req.body?.payload);
    const requestedBy = cleanText(req.body?.requestedBy) || "Good Shepherd App";

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: nodeId"
      });
    }

    if (!commandType) {
      return res.status(400).json({
        success: false,
        error: "Invalid or missing commandType",
        allowedCommandTypes: [
          "reconfigure",
          "update_firmware",
          "identify",
          "locate",
          "ping",
          "reboot",
          "factory_reset"
        ]
      });
    }

    if (!["reconfigure", "update_firmware", "identify", "locate", "ping", "reboot", "factory_reset"].includes(commandType)) {
      return res.status(400).json({
        success: false,
        error: "ESP32 sensor firmware supports reconfigure, update_firmware, identify, locate, ping, reboot, and factory_reset.",
        allowedCommandTypes: [
          "reconfigure",
          "update_firmware",
          "identify",
          "locate",
          "ping",
          "reboot",
          "factory_reset"
        ]
      });
    }

    if (commandType === "update_firmware") {
      if (!isValidFirmwareUrl(payload.firmwareUrl)) {
        return res.status(400).json({
          success: false,
          error: "update_firmware requires payload.firmwareUrl as an HTTPS URL"
        });
      }

      if (!cleanText(payload.firmwareVersion)) {
        return res.status(400).json({
          success: false,
          error: "update_firmware requires payload.firmwareVersion"
        });
      }
    }

    const existingNode = await getNodeById(nodeId);

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    await client.query(
      `
      UPDATE node_commands
      SET
        status = 'failed',
        completed_at = NOW(),
        error = 'Superseded by newer sensor command of same type'
      WHERE node_id = $1
        AND command_type = $2
        AND status IN ('pending', 'running')
      `,
      [nodeId, commandType]
    );

    const result = await client.query(
      `
      INSERT INTO node_commands (
        command_id,
        node_id,
        command_type,
        payload,
        status,
        requested_by,
        requested_at,
        picked_up_at,
        completed_at,
        result,
        error
      )
      VALUES ($1, $2, $3, $4::jsonb, 'pending', $5, NOW(), NULL, NULL, NULL, NULL)
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
      [
        randomUUID(),
        nodeId,
        commandType,
        JSON.stringify(payload),
        requestedBy
      ]
    );

    await client.query("COMMIT");
    didBegin = false;

    return res.status(201).json({
      success: true,
      message: `Sensor ${commandType} command created`,
      command: result.rows[0]
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Create sensor command failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/sensor-commands/:nodeId/pending", async (req, res) => {
  const client = await pool.connect();
  let didBegin = false;

  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.params.nodeId);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    await failStaleSensorCommands(client, nodeId);

    const pendingResult = await client.query(
      `
      SELECT command_id
      FROM node_commands
      WHERE node_id = $1
        AND status = 'pending'
        AND command_type IN ('reconfigure', 'update_firmware', 'identify', 'locate', 'ping', 'reboot', 'factory_reset')
        AND requested_at >= NOW() - ($2::int * INTERVAL '1 minute')
      ORDER BY requested_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
      `,
      [nodeId, SENSOR_COMMAND_EXPIRATION_MINUTES]
    );

    const commandIds = pendingResult.rows.map((row) => row.command_id);
    let commands = [];

    if (commandIds.length > 0) {
      const updateResult = await client.query(
        `
        UPDATE node_commands
        SET
          status = 'running',
          picked_up_at = NOW()
        WHERE command_id = ANY($1::uuid[])
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
        [commandIds]
      );

      commands = updateResult.rows;
    }

    await client.query("COMMIT");
    didBegin = false;

    return res.status(200).json({
      success: true,
      nodeId,
      count: commands.length,
      commands
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Fetch pending sensor commands failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.post("/sensor-commands/:commandId/result", async (req, res) => {
  const client = await pool.connect();
  let didBegin = false;

  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const commandId = cleanText(req.params.commandId);
    const status = normalizeCommandStatus(req.body?.status);
    const resultPayload = normalizeJsonObject(req.body?.result);
    const error = cleanOptionalText(req.body?.error);

    if (!commandId) {
      return res.status(400).json({
        success: false,
        error: "Missing commandId"
      });
    }

    if (status !== "success" && status !== "failed") {
      return res.status(400).json({
        success: false,
        error: "Command result status must be success or failed"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    const result = await client.query(
      `
      UPDATE node_commands
      SET
        status = $2,
        completed_at = NOW(),
        result = $3::jsonb,
        error = $4
      WHERE command_id = $1
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
      [
        commandId,
        status,
        JSON.stringify(resultPayload),
        error
      ]
    );

    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      didBegin = false;

      return res.status(404).json({
        success: false,
        error: `Command not found: ${commandId}`
      });
    }

    const completedCommand = result.rows[0];

    await client.query(
      `
      UPDATE node_commands
      SET
        status = 'failed',
        completed_at = NOW(),
        error = 'Cleared after sensor command result'
      WHERE node_id = $1
        AND command_id <> $2
        AND command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
        AND status IN ('pending', 'running')
      `,
      [completedCommand.nodeId, commandId]
    );

    await client.query("COMMIT");
    didBegin = false;

    return res.status(200).json({
      success: true,
      message: "Sensor command result saved",
      command: completedCommand
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Save sensor command result failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});


app.get("/firmware/download/:releaseTag/:assetName", async (req, res) => {
  try {
    const releaseTag = cleanText(req.params.releaseTag);
    const assetName = cleanText(req.params.assetName);

    if (!isSafeFirmwareReleaseTag(releaseTag)) {
      return res.status(400).json({
        success: false,
        error: "Invalid firmware release tag"
      });
    }

    if (!isSafeFirmwareAssetName(assetName)) {
      return res.status(400).json({
        success: false,
        error: "Invalid firmware asset name"
      });
    }

    const upstreamUrl = githubFirmwareAssetUrl(releaseTag, assetName);

    console.log("Firmware download proxy requested:");
    console.log(JSON.stringify({ releaseTag, assetName, upstreamUrl }, null, 2));

    return proxyFirmwareDownload(upstreamUrl, res);
  } catch (error) {
    console.error("Firmware download proxy failed:", error);

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    return res.end();
  }
});

app.get("/firmware/releases", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const includeInactive = parseBooleanQuery(req.query.includeInactive);

    const result = await pool.query(
      `
      ${firmwareReleaseSelectSQL()}
      WHERE ($1::boolean = TRUE OR is_active = TRUE)
      ORDER BY created_at DESC
      `,
      [includeInactive]
    );

    return res.status(200).json({
      success: true,
      includeInactive,
      count: result.rows.length,
      releases: result.rows
    });
  } catch (error) {
    console.error("Fetch firmware releases failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/firmware/releases", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const firmwareVersion = cleanText(req.body?.firmwareVersion);
    const firmwareUrl = cleanText(req.body?.firmwareUrl);
    const sha256 = cleanOptionalText(req.body?.sha256);
    const releaseNotes = cleanOptionalText(req.body?.releaseNotes);
    const createdBy = cleanText(req.body?.createdBy) || "Good Shepherd Admin";
    const isActive = typeof req.body?.isActive === "boolean" ? req.body.isActive : true;

    if (!firmwareVersion) {
      return res.status(400).json({
        success: false,
        error: "firmwareVersion is required"
      });
    }

    if (!isValidFirmwareUrl(firmwareUrl)) {
      return res.status(400).json({
        success: false,
        error: "firmwareUrl must be a valid HTTPS URL"
      });
    }

    const result = await pool.query(
      `
      INSERT INTO firmware_releases (
        id,
        firmware_version,
        firmware_url,
        sha256,
        release_notes,
        is_active,
        created_by,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      ON CONFLICT (firmware_version)
      DO UPDATE SET
        firmware_url = EXCLUDED.firmware_url,
        sha256 = EXCLUDED.sha256,
        release_notes = EXCLUDED.release_notes,
        is_active = EXCLUDED.is_active,
        created_by = EXCLUDED.created_by,
        updated_at = NOW()
      RETURNING
        id,
        firmware_version AS "firmwareVersion",
        firmware_url AS "firmwareUrl",
        sha256,
        release_notes AS "releaseNotes",
        is_active AS "isActive",
        created_by AS "createdBy",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      `,
      [
        randomUUID(),
        firmwareVersion,
        firmwareUrl,
        sha256,
        releaseNotes,
        isActive,
        createdBy
      ]
    );

    return res.status(200).json({
      success: true,
      message: "Firmware release saved",
      release: result.rows[0]
    });
  } catch (error) {
    console.error("Save firmware release failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get("/firmware/latest", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const latest = await getLatestFirmwareRelease();

    if (!latest) {
      return res.status(404).json({
        success: false,
        error: "No active firmware release found"
      });
    }

    return res.status(200).json({
      success: true,
      release: latest
    });
  } catch (error) {
    console.error("Fetch latest firmware release failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post("/firmware/update-node", async (req, res) => {
  try {
    if (!requireAuthorizedRequest(req, res)) {
      return;
    }

    const nodeId = cleanText(req.body?.nodeId);
    const requestedBy = cleanText(req.body?.requestedBy) || "Good Shepherd Firmware Manager";
    const explicitFirmwareVersion = cleanText(req.body?.firmwareVersion);
    const explicitFirmwareUrl = cleanText(req.body?.firmwareUrl);
    const explicitSha256 = cleanOptionalText(req.body?.sha256);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "nodeId is required"
      });
    }

    const node = await getNodeById(nodeId);

    if (!node) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    let firmwareVersion = explicitFirmwareVersion;
    let firmwareUrl = explicitFirmwareUrl;
    let sha256 = explicitSha256;

    if (!firmwareVersion || !firmwareUrl) {
      const latest = await getLatestFirmwareRelease();

      if (!latest) {
        return res.status(404).json({
          success: false,
          error: "No active firmware release found. Create one first with POST /firmware/releases."
        });
      }

      firmwareVersion = latest.firmwareVersion;
      firmwareUrl = latest.firmwareUrl;
      sha256 = latest.sha256 || null;
    }

    if (!firmwareVersion) {
      return res.status(400).json({
        success: false,
        error: "firmwareVersion is required"
      });
    }

    if (!isValidFirmwareUrl(firmwareUrl)) {
      return res.status(400).json({
        success: false,
        error: "firmwareUrl must be a valid HTTPS URL"
      });
    }

    const command = await createCommand({
      nodeId,
      commandType: "update_firmware",
      payload: {
        firmwareVersion,
        firmwareUrl,
        sha256
      },
      requestedBy
    });

    return res.status(201).json({
      success: true,
      message: "Firmware update command queued",
      node,
      command
    });
  } catch (error) {
    console.error("Queue firmware update failed:", error);
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
      timeText,
      eventType,
      sensorType,
      sensorMode
    } = req.body || {};

    if (!message) {
      return res.status(400).json({
        success: false,
        error: "Missing required field: message"
      });
    }

    const resolvedNodeId = cleanText(nodeId);
    let resolvedLocationName = cleanText(locationName);
    const resolvedSourceKey = cleanText(sourceKey);

    let resolvedSourceName = cleanText(sourceName);
    let resolvedResidentName = cleanText(residentName);
    let resolvedAlertLevel = cleanText(alertLevel);
    let resolvedTimeText = cleanText(timeText);
    const fullWebhookPayload = normalizeJsonObject(req.body || {});
    const resolvedEventType = normalizeWebhookEventType(eventType);
    const resolvedSensorType = normalizeWebhookSensorType(sensorType || sensorMode, "unknown");
    const resolvedSensorDisplayType = displaySensorTypeForValue(sensorType || sensorMode || sourceName, "Motion Sensor");

    if (resolvedEventType === "presence_telemetry") {
      console.log("LD2410 telemetry received:");
      console.log(JSON.stringify(fullWebhookPayload, null, 2));
    }

    if (resolvedSensorType === "human_presence" && !fullWebhookPayload.eventType) {
      fullWebhookPayload.eventType = resolvedEventType;
    }

    if (resolvedSensorType && !fullWebhookPayload.sensorType) {
      fullWebhookPayload.sensorType = resolvedSensorType;
    }

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

    const existingSensor = await getExistingSensorForDeviceIdentity({
      sourceKey: resolvedSourceKey,
      nodeId: resolvedNodeId
    });
    const preserveUnassignedState = sensorIsExplicitlyUnassigned(existingSensor);

    let resident = preserveUnassignedState
      ? null
      : await getResidentForExistingDeviceIdentity({
          sourceKey: resolvedSourceKey,
          nodeId: resolvedNodeId
        });

    if (preserveUnassignedState) {
      resolvedResidentName = "Unassigned";
      resolvedLocationName = "Unassigned location";
    } else if (resident) {
      resolvedResidentName = resident.name;
      resolvedLocationName = resolvedLocationName || resident.location || "";
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
      resident,
      residentName: resolvedResidentName,
      locationName: resolvedLocationName,
      forceUnassigned: preserveUnassignedState
    });

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
      event,
      motionHistoryEvent,
      resident,
      sensor
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
      console.log(`Minimum iOS app build for resident/camera writes: ${MIN_IOS_APP_BUILD}`);
      console.log(`Remote support node health enabled. Offline after ${NODE_OFFLINE_AFTER_SECONDS} seconds.`);
      console.log("Remote node command queue enabled.");
      console.log("ESP32 OTA firmware update command support enabled.");
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
