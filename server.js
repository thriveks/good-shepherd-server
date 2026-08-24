// server.js
// Good Shepherd webhook and AI backend
//
// s
// iOS Dependency: NearbyBLESensorSyncView human presence assignment flow + AppSetupSyncService sensor assignment payload
//
// Safe cleanup plus AI v2 fields for ESP32 motion and simple human-presence sensors.
// Keeps webhook-secret behavior unchanged. Normalizes ESP32 ffmpeg status, improves
// old motion/presence event typing, and adds room routine, presence-duration, and
// AI confidence metadata to the existing AI summary responses.

const express = require("express");
const { Pool } = require("pg");
const { randomUUID, randomBytes, randomInt, createHash, pbkdf2Sync, timingSafeEqual, createHmac, createCipheriv, createDecipheriv } = require("crypto");
const path = require("path");
const https = require("https");
const http = require("http");
const mqtt = require("mqtt");

const app = express();
const PORT = process.env.PORT || 3000;
const MQTT_BRIDGE_ENABLED = String(process.env.MQTT_BRIDGE_ENABLED || "true").toLowerCase() !== "false";
const MQTT_HOST = process.env.MQTT_HOST || "c3f9bcc09adc4e7db6a3d29b63a24819.s1.eu.hivemq.cloud";
const MQTT_PORT = Number(process.env.MQTT_PORT || 8883);
const MQTT_USERNAME = process.env.MQTT_USERNAME || "good-shepherd-pilot";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "Goodshepherd1!";
let mqttBridgeClient = null;
const MQTT_BRIDGE_VERSION = "v2.2-mqtt-phase2-commands";
const MAX_EVENTS = 50;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const MIN_IOS_APP_BUILD = 1;
const NODE_OFFLINE_AFTER_SECONDS = (() => {
  const configuredValue = Number(process.env.NODE_OFFLINE_AFTER_SECONDS);
  return Number.isFinite(configuredValue) && configuredValue > 0
    ? Math.trunc(configuredValue)
    : 86400;
})();
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
const AI_PRESENCE_ACTIVE_WATCH_MINUTES = 120;
const AI_PRESENCE_ACTIVE_WARNING_MINUTES = 240;
const AI_PRESENCE_ACTIVE_CRITICAL_MINUTES = 480;
const AI_DASHBOARD_CACHE_MAX_AGE_SECONDS = 30;
const AI_DASHBOARD_REFRESH_DEBOUNCE_MS = 2000;
const SENSOR_COMMAND_EXPIRATION_MINUTES = 5;
const SENSOR_COMMAND_EXECUTION_TIMEOUT_MINUTES = 5;
const SENSOR_COMMAND_OTA_EXECUTION_TIMEOUT_MINUTES = 30;
const SENSOR_COMMAND_IDENTIFY_EXECUTION_TIMEOUT_MINUTES = 2;
const ESP32_SENSOR_COMMAND_TYPES = ["reconfigure", "update_firmware", "identify", "locate", "ping", "reboot", "factory_reset"];
const MONITOR_COMMAND_TYPES = ["ping", "ffmpeg_check", "diagnostic_report", "reload_cameras", "sync_cameras_from_cloud", "restart_monitors", "clear_last_error", "rtsp_test"];
const WATCHDOG_COMMAND_TYPES = ["watchdog_ping", "watchdog_health", "start_local_monitor", "stop_local_monitor", "restart_local_monitor"];
let acceptedWebhookCountSinceStart = 0;
const ASSIGNMENT_AUTHORITIES = ["never_assigned", "device_bootstrap", "operator_explicit", "resident_deleted", "legacy_unknown"];
const FIRMWARE_GITHUB_OWNER = process.env.FIRMWARE_GITHUB_OWNER || "thriveks";
const FIRMWARE_GITHUB_REPO = process.env.FIRMWARE_GITHUB_REPO || "good-shepherd-esp32-firmware";
const FIRMWARE_DOWNLOAD_ASSET_NAME = process.env.FIRMWARE_DOWNLOAD_ASSET_NAME || "good_shepherd_esp32_motion.ino.bin";
const MAX_FIRMWARE_DOWNLOAD_REDIRECTS = 8;
const FIRMWARE_DOWNLOAD_TIMEOUT_MS = 120000;

app.use(express.json({ limit: "25mb" }));

// Monitoring Center frontend is served by this same trusted application origin.
// No server secrets are ever placed in browser JavaScript.
app.use("/monitoring", express.static(path.join(__dirname, "public", "monitoring"), {
  index: "index.html",
  fallthrough: true,
  maxAge: process.env.NODE_ENV === "production" ? "5m" : 0
}));

app.use((req, res, next) => {
    const origin = req.headers.origin;

    const allowedOrigins = [
        "https://thriveks.com",
        "https://www.thriveks.com",
        "https://thriveks.neocities.org"
    ];

    if (allowedOrigins.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
        res.header(
  "Access-Control-Allow-Headers",
  "Origin, X-Requested-With, Content-Type, Accept, Authorization, x-webhook-secret, x-app-build, x-app-version, x-app-client"
);
        res.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    }

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

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
  await pool.query(`ALTER TABLE sensors ADD COLUMN IF NOT EXISTS assignment_authority TEXT NOT NULL DEFAULT 'legacy_unknown'`);
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
    CREATE TABLE IF NOT EXISTS resident_activity_daily (
      resident_id UUID NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
      activity_date DATE NOT NULL,
      motion_count INTEGER NOT NULL DEFAULT 0,
      first_motion_at TIMESTAMPTZ,
      last_motion_at TIMESTAMPTZ,
      room_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      hourly_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (resident_id, activity_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS resident_activity_daily_date_idx ON resident_activity_daily (activity_date DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ai_dashboard_cache (
      cache_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Customer access is resident-based: every resident receives one unique 4-digit code.
  await pool.query(`ALTER TABLE residents ADD COLUMN IF NOT EXISTS access_code TEXT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS residents_access_code_unique_idx ON residents (access_code) WHERE access_code IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_sessions (
      token_hash TEXT PRIMARY KEY,
      resident_id UUID NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS customer_sessions_resident_id_idx ON customer_sessions (resident_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS customer_sessions_expires_at_idx ON customer_sessions (expires_at)`);

  // Monitoring Center operator identity, sessions, and audit trail.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoring_operators (
      id UUID PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      password_hash TEXT NOT NULL,
      totp_secret_encrypted TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    )
  `);
  await pool.query(`ALTER TABLE monitoring_operators ADD COLUMN IF NOT EXISTS is_bootstrap BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS monitoring_operators_username_unique_idx ON monitoring_operators (LOWER(username))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoring_sessions (
      token_hash TEXT PRIMARY KEY,
      operator_id UUID NOT NULL REFERENCES monitoring_operators(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS monitoring_sessions_operator_id_idx ON monitoring_sessions (operator_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS monitoring_sessions_expires_at_idx ON monitoring_sessions (expires_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS monitoring_audit_log (
      id UUID PRIMARY KEY,
      operator_id UUID REFERENCES monitoring_operators(id) ON DELETE SET NULL,
      operator_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS monitoring_audit_log_created_at_idx ON monitoring_audit_log (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS monitoring_audit_log_operator_id_idx ON monitoring_audit_log (operator_id, created_at DESC)`);

  await ensureMonitoringBootstrapOperator();

  await ensureResidentAccessCodes();

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

let residentActivityBackfillPromise = null;

function runResidentActivityBackfill() {
  if (residentActivityBackfillPromise) {
    return residentActivityBackfillPromise;
  }

  console.log(`Resident activity backfill starting for the last ${AI_MOTION_HISTORY_DAYS} day(s).`);

  residentActivityBackfillPromise = pool.query(`
    INSERT INTO resident_activity_daily (
      resident_id, activity_date, motion_count, first_motion_at, last_motion_at, room_counts, hourly_counts, updated_at
    )
    SELECT
      resident_id,
      (event_timestamp AT TIME ZONE '${AI_TIME_ZONE}')::date AS activity_date,
      COUNT(*)::int AS motion_count,
      MIN(event_timestamp) AS first_motion_at,
      MAX(event_timestamp) AS last_motion_at,
      jsonb_object_agg(COALESCE(NULLIF(TRIM(room_name), ''), 'Unknown room'), room_count),
      jsonb_object_agg(local_hour::text, hour_count),
      NOW()
    FROM (
      SELECT
        resident_id, event_timestamp, room_name,
        EXTRACT(HOUR FROM event_timestamp AT TIME ZONE '${AI_TIME_ZONE}')::int AS local_hour,
        COUNT(*) OVER (PARTITION BY resident_id, (event_timestamp AT TIME ZONE '${AI_TIME_ZONE}')::date, COALESCE(NULLIF(TRIM(room_name), ''), 'Unknown room'))::int AS room_count,
        COUNT(*) OVER (PARTITION BY resident_id, (event_timestamp AT TIME ZONE '${AI_TIME_ZONE}')::date, EXTRACT(HOUR FROM event_timestamp AT TIME ZONE '${AI_TIME_ZONE}'))::int AS hour_count
      FROM motion_events
      WHERE resident_id IS NOT NULL
        AND event_timestamp >= NOW() - (${AI_MOTION_HISTORY_DAYS} * INTERVAL '1 day')
    ) source_rows
    GROUP BY resident_id, (event_timestamp AT TIME ZONE '${AI_TIME_ZONE}')::date
    ON CONFLICT (resident_id, activity_date) DO NOTHING
  `)
    .then((result) => {
      console.log(`Resident activity backfill finished. ${result.rowCount || 0} daily row(s) inserted.`);
      return result;
    })
    .catch((error) => {
      console.warn('Resident activity backfill failed:', error.message);
      return null;
    })
    .finally(() => {
      residentActivityBackfillPromise = null;
    });

  return residentActivityBackfillPromise;
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

function normalizedTextSignalForPayload(payload) {
  const normalizedPayload = normalizeJsonObject(payload);

  return [
    normalizedPayload.nodeId,
    normalizedPayload.sourceKey,
    normalizedPayload.sourceName,
    normalizedPayload.sensorType,
    normalizedPayload.sensorMode,
    normalizedPayload.eventType,
    normalizedPayload.message,
    normalizedPayload.timeText,
    normalizedPayload.softwareVersion,
    normalizedPayload.platform,
    normalizedPayload?.diagnostics?.sourceKey,
    normalizedPayload?.diagnostics?.sensorMode,
    normalizedPayload?.diagnostics?.sensorType,
    normalizedPayload?.diagnostics?.deviceName
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase()
    .replace(/[-\s]+/g, "_");
}

function isEsp32Payload(payload) {
  const signal = normalizedTextSignalForPayload(payload);
  return signal.includes("esp32") ||
    signal.includes("good_shepherd_esp32") ||
    signal.includes("motion_") ||
    signal.includes("presence_") ||
    signal.includes("human_presence") ||
    signal.includes("pir");
}

function normalizeFfmpegStatusForPayload(payload, fallback = "Unknown") {
  const explicitStatus = cleanText(payload?.ffmpegStatus);

  if (explicitStatus && explicitStatus.toLowerCase() !== "unknown") {
    return explicitStatus;
  }

  if (isEsp32Payload(payload)) {
    return "Not Applicable";
  }

  return explicitStatus || fallback;
}

function normalizeWebhookEventTypeFromPayload(payload, fallback = "webhook_event") {
  const normalizedPayload = normalizeJsonObject(payload);
  const explicitEventType = normalizeWebhookEventType(normalizedPayload.eventType, "");

  if (explicitEventType) {
    return explicitEventType;
  }

  const sensorSignal = normalizedTextSignalForPayload(normalizedPayload);
  const messageText = [
    normalizedPayload.message,
    normalizedPayload.timeText
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  if (
    sensorSignal.includes("human_presence") ||
    sensorSignal.includes("presence_") ||
    sensorSignal.includes("ld2410")
  ) {
    const presenceValue = readPayloadBoolean(normalizedPayload, "presence");

    if (presenceValue === true ||
      messageText.includes("presence detected") ||
      messageText.includes("human presence detected")) {
      return "presence_detected";
    }

    if (presenceValue === false ||
      messageText.includes("presence cleared") ||
      messageText.includes("human presence cleared")) {
      return "presence_cleared";
    }
  }

  if (
    sensorSignal.includes("motion") ||
    sensorSignal.includes("pir") ||
    messageText.includes("motion detected") ||
    messageText.includes("activity detected")
  ) {
    return "motion_detected";
  }

  return fallback;
}

function normalizeWebhookSensorTypeFromPayload(payload, fallback = "unknown") {
  const normalizedPayload = normalizeJsonObject(payload);
  const explicitSensorType = normalizeWebhookSensorType(
    normalizedPayload.sensorType || normalizedPayload.sensorMode,
    ""
  );

  if (explicitSensorType && explicitSensorType !== "unknown") {
    return explicitSensorType;
  }

  const signal = normalizedTextSignalForPayload(normalizedPayload);

  if (
    signal.includes("human_presence") ||
    signal.includes("presence_") ||
    signal.includes("ld2410")
  ) {
    return "human_presence";
  }

  if (
    signal.includes("motion") ||
    signal.includes("pir") ||
    signal.includes("activity_detected")
  ) {
    return "motion";
  }

  return fallback;
}

function isPresenceEventRow(event) {
  const eventType = cleanText(event?.eventType || event?.event_type).toLowerCase();
  const sensorType = cleanText(event?.sensorType || event?.sensor_type).toLowerCase();
  const payload = normalizeJsonObject(event?.eventPayload || event?.event_payload);
  const payloadPresence = readPayloadBoolean(payload, "presence");
  const searchableText = [
    event?.message,
    event?.sourceName,
    event?.sourceKey,
    event?.timeText,
    eventType,
    sensorType,
    payload?.eventType,
    payload?.sensorType,
    payload?.sensorMode
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  return eventType === "presence_detected" ||
    eventType === "presence_cleared" ||
    sensorType === "human_presence" ||
    sensorType === "presence" ||
    payloadPresence !== null ||
    searchableText.includes("human presence") ||
    searchableText.includes("presence detected") ||
    searchableText.includes("presence cleared") ||
    searchableText.includes("ld2410");
}

function presenceEventIsActive(event) {
  const eventType = cleanText(event?.eventType || event?.event_type).toLowerCase();
  const payload = normalizeJsonObject(event?.eventPayload || event?.event_payload);
  const payloadPresence = readPayloadBoolean(payload, "presence");
  const messageText = [
    event?.message,
    event?.timeText
  ]
    .map((value) => cleanText(value))
    .join(" ")
    .toLowerCase();

  if (payloadPresence !== null) {
    return payloadPresence;
  }

  if (eventType === "presence_detected" || messageText.includes("presence detected")) {
    return true;
  }

  if (eventType === "presence_cleared" || messageText.includes("presence cleared")) {
    return false;
  }

  return null;
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

function normalizeOptionalSetupState(value) {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === "assigned" || normalized === "active") return "assigned";
  if (normalized === "unassigned" || normalized === "pending setup" || normalized === "pending_setup") return "unassigned";
  return null;
}

function normalizeReportedSetupState(payload, diagnostics = normalizeJsonObject(payload?.diagnostics)) {
  const candidates = [
    ["setupState", payload?.setupState],
    ["assignmentState", payload?.assignmentState],
    ["diagnostics.setupState", diagnostics?.setupState],
    ["diagnostics.assignmentState", diagnostics?.assignmentState]
  ].map(([field, value]) => ({ field, state: normalizeOptionalSetupState(value) }))
    .filter((candidate) => candidate.state);
  const selected = candidates[0] || null;
  const disagreement = Boolean(selected && candidates.some((candidate) => candidate.state !== selected.state));
  return {
    state: selected?.state || null,
    field: selected?.field || null,
    present: candidates.length > 0,
    disagreement,
    candidates
  };
}

function isEsp32NodeId(value) {
  return cleanText(value).toLowerCase().startsWith("esp32-");
}

function normalizeAssignmentAuthority(value, fallback = "legacy_unknown") {
  const authority = cleanText(value).toLowerCase();
  return ASSIGNMENT_AUTHORITIES.includes(authority) ? authority : fallback;
}

function assignmentAuthorityProtectsServerState(value) {
  return ["device_bootstrap", "operator_explicit", "resident_deleted", "legacy_unknown"].includes(
    normalizeAssignmentAuthority(value)
  );
}

function isCompleteFirmwareAssignment(payload, diagnostics = normalizeJsonObject(payload?.diagnostics)) {
  const reported = normalizeReportedSetupState(payload, diagnostics);
  const residentName = cleanText(payload?.residentName ?? diagnostics?.residentName);
  const locationName = cleanText(payload?.locationName ?? diagnostics?.locationName);
  const roomName = cleanText(payload?.roomName ?? diagnostics?.roomName);
  return reported.state === "assigned" &&
    residentName && normalizeForMatch(residentName) !== "unassigned" &&
    locationName && !normalizeForMatch(locationName).startsWith("unassigned") &&
    roomName;
}

const SAFE_DIAGNOSTIC_KEYS = new Set([
  "nodeId", "sensorId", "sourceKey", "reportedSourceKey", "conflictingNodeId", "conflictingSensorId",
  "canonicalSensorId", "canonicalSourceKey", "retiredSensorId", "retiredSourceKey", "aliasCount", "reason",
  "field", "state", "reportedState", "storedState", "assignmentAuthority", "commandId", "commandType",
  "runner", "route", "oldStatus", "newStatus", "submittedStatus", "healthAgeSeconds", "lastKnownPresenceState",
  "lastKnownPresenceAt", "diagnosticState", "archivedNodeCount", "inactiveSensorCount", "deletedSensorCount",
  "rowCount", "oldestTimestamp", "newestTimestamp", "requestedAt", "pickedUpAt", "accepted", "late"
]);

function logStructuredDiagnostic(code, severity = "info", details = {}) {
  try {
    const safeDetails = {};
    for (const [key, value] of Object.entries(normalizeJsonObject(details))) {
      if (!SAFE_DIAGNOSTIC_KEYS.has(key)) continue;
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) safeDetails[key] = value;
    }
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      serverVersion: "12.0.0-phase1",
      code: cleanText(code) || "PHASE1_DIAGNOSTIC",
      severity: cleanText(severity) || "info",
      details: safeDetails
    }));
  } catch {
    // Diagnostics are best-effort and must never fail a valid request.
  }
}

function commandOwnerFor(nodeId, commandType) {
  const type = cleanText(commandType).toLowerCase();
  if (isEsp32NodeId(nodeId)) return ESP32_SENSOR_COMMAND_TYPES.includes(type) ? "sensor" : null;
  if (WATCHDOG_COMMAND_TYPES.includes(type)) return "watchdog";
  if (MONITOR_COMMAND_TYPES.includes(type)) return "monitor";
  return null;
}

function commandTypesForRunner(runner) {
  if (runner === "monitor") return MONITOR_COMMAND_TYPES;
  if (runner === "watchdog") return WATCHDOG_COMMAND_TYPES;
  return null;
}

function isTerminalCommandStatus(status) {
  return status === "success" || status === "failed";
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

class SensorAssignmentConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "SensorAssignmentConflictError";
    this.statusCode = 409;
    this.code = "SENSOR_ASSIGNMENT_CONFLICT";
  }
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

  const healthDate = healthCheckedInAt ? new Date(healthCheckedInAt) : null;
  const healthIsOnline = Boolean(
    healthDate &&
    !Number.isNaN(healthDate.getTime()) &&
    healthDate.getTime() >= Date.now() - (NODE_OFFLINE_AFTER_SECONDS * 1000)
  );

  const candidateLastSeen = [healthCheckedInAt, nodeLastSeenAt, latestMotionAt]
    .map((value) => ({ value, date: value ? new Date(value) : null }))
    .filter((item) => item.date && !Number.isNaN(item.date.getTime()))
    .sort((first, second) => second.date.getTime() - first.date.getTime())[0];

  if (healthIsOnline) {
    return {
      isOnline: true,
      wifiRssi: health?.wifiRssi ?? null,
      lastSeenAt: candidateLastSeen?.value || null,
      latestMotionAt,
      onlineSource: "heartbeat"
    };
  }

  if (nodeId) {
    return {
      isOnline: false,
      wifiRssi: health?.wifiRssi ?? null,
      lastSeenAt: candidateLastSeen?.value || null,
      latestMotionAt,
      onlineSource: null
    };
  }

  return {
    isOnline: null,
    wifiRssi: health?.wifiRssi ?? null,
    lastSeenAt: candidateLastSeen?.value || null,
    latestMotionAt,
    onlineSource: null
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

function buildResidentMotionBaseline(residentMotionEvents, residentMotionDailyStats = null) {
  const now = new Date();
  const todayKey = localDateKey(now);
  const currentLocalHour = localHourFromDate(now) ?? 0;
  const currentLocalMinute = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: AI_TIME_ZONE,
      minute: "2-digit"
    }).formatToParts(now);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(minute) ? minute : 0;
  })();
  const currentMinuteOfDay = (currentLocalHour * 60) + currentLocalMinute;
  const hourlyCounts = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: 0
  }));
  const eventsByDate = new Map();
  const roomCountsToday = new Map();
  let firstMotionToday = null;
  let lastMotionToday = null;

  const localMinuteOfDay = (dateValue) => {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);

    if (Number.isNaN(date.getTime())) {
      return null;
    }

    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: AI_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }

    return (hour * 60) + minute;
  };

  const median = (values) => {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((first, second) => first - second);

    if (sorted.length === 0) {
      return 0;
    }

    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  };

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
  const baselineDayStats = Array.isArray(residentMotionDailyStats)
    ? residentMotionDailyStats
        .filter((day) => cleanText(day?.dateKey) && day.dateKey !== todayKey)
        .map((day) => ({
          dateKey: cleanText(day.dateKey),
          motionCount: normalizeInteger(day.motionCount, 0),
          sameTimeCount: normalizeInteger(day.sameTimeCount, 0),
          coverageHours: Number.isFinite(Number(day.coverageHours)) ? Number(day.coverageHours) : 0
        }))
    : [...eventsByDate.keys()]
        .filter((dateKey) => dateKey !== todayKey)
        .map((dateKey) => {
          const dayEvents = eventsByDate.get(dateKey) || [];
          const validDates = dayEvents
            .map((event) => new Date(event.timestamp))
            .filter((date) => !Number.isNaN(date.getTime()))
            .sort((first, second) => first.getTime() - second.getTime());
          const firstDate = validDates[0] || null;
          const lastDate = validDates[validDates.length - 1] || null;
          const coverageHours = firstDate && lastDate
            ? Math.max(0, (lastDate.getTime() - firstDate.getTime()) / (60 * 60 * 1000))
            : 0;
          const sameTimeCount = dayEvents.reduce((count, event) => {
            const minuteOfDay = localMinuteOfDay(event.timestamp);
            return minuteOfDay !== null && minuteOfDay <= currentMinuteOfDay ? count + 1 : count;
          }, 0);

          return {
            dateKey,
            motionCount: dayEvents.length,
            sameTimeCount,
            coverageHours
          };
        });

  // A baseline day should represent a meaningful portion of a normal monitored day.
  // Very short or tiny data fragments are retained in raw history but are not allowed
  // to train the resident's normal behavior model.
  const completeBaselineDays = baselineDayStats.filter((day) => {
    return day.motionCount >= 10 && day.coverageHours >= 8;
  });
  const usableBaselineDays = completeBaselineDays.length >= AI_BASELINE_MIN_DAYS
    ? completeBaselineDays
    : baselineDayStats;
  const baselineDayCount = usableBaselineDays.length;
  const baselineExcludedDayCount = Math.max(0, baselineDayStats.length - completeBaselineDays.length);
  const baselineMotionCounts = usableBaselineDays.map((day) => day.motionCount);
  const baselineSameTimeCounts = usableBaselineDays.map((day) => day.sameTimeCount);
  const baselineMotionMedian = median(baselineMotionCounts);
  const baselineSameTimeMedian = median(baselineSameTimeCounts);
  const baselineMotionAverage = baselineMotionMedian;
  const todayMotionCount = todayEvents.length;
  const expectedMotionCountLow = baselineDayCount >= AI_BASELINE_MIN_DAYS
    ? Math.max(1, Math.floor(baselineSameTimeMedian * AI_BASELINE_QUIET_RATIO))
    : null;
  const expectedMotionCountHigh = baselineDayCount >= AI_BASELINE_MIN_DAYS
    ? Math.ceil(baselineSameTimeMedian * AI_BASELINE_ACTIVE_RATIO)
    : null;

  let patternStatus = "Insufficient Baseline";
  let patternExplanation = `Need at least ${AI_BASELINE_MIN_DAYS} usable prior motion days before comparing this resident to their own routine.`;

  if (baselineDayCount >= AI_BASELINE_MIN_DAYS) {
    if (todayMotionCount < expectedMotionCountLow) {
      patternStatus = "Too Quiet";
      patternExplanation = `Today has ${todayMotionCount} motion event(s) so far, below the expected range through this time of day (${expectedMotionCountLow}-${expectedMotionCountHigh}).`;
    } else if (todayMotionCount > expectedMotionCountHigh) {
      patternStatus = "More Active Than Usual";
      patternExplanation = `Today has ${todayMotionCount} motion event(s) so far, above the expected range through this time of day (${expectedMotionCountLow}-${expectedMotionCountHigh}).`;
    } else {
      patternStatus = "Normal Pattern";
      patternExplanation = `Today is within this resident's recent motion baseline for this time of day (${expectedMotionCountLow}-${expectedMotionCountHigh}).`;
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
    baselineExcludedDayCount,
    baselineMotionAverage: displayAverage(baselineMotionAverage),
    baselineMotionMedian: displayAverage(baselineMotionMedian),
    baselineSameTimeMedian: displayAverage(baselineSameTimeMedian),
    baselineMethod: completeBaselineDays.length >= AI_BASELINE_MIN_DAYS
      ? "median_of_complete_days_same_time_comparison"
      : "median_of_available_days_same_time_comparison",
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

function presenceEventRoomName(event, sensor) {
  const cleanSensorRoom = cleanText(sensor?.roomName);

  if (cleanSensorRoom) {
    return cleanSensorRoom;
  }

  return inferRoomNameFromSourceName(event?.sourceName) ||
    cleanText(event?.locationName) ||
    "Unknown room";
}

function buildResidentPresenceIntelligence(residentSensors, residentPresenceEvents, nodeHealthByNodeId) {
  const presenceSensors = residentSensors.filter((sensor) => {
    const sensorType = cleanText(sensor.sensorType).toLowerCase();
    const sourceKey = cleanText(sensor.sourceKey).toLowerCase();
    const sourceName = cleanText(sensor.sourceName).toLowerCase();

    return sensorType.includes("presence") ||
      sourceKey.startsWith("presence-") ||
      sourceKey.startsWith("motion-presence-") ||
      sourceName.includes("presence");
  });

  const latestBySourceKey = new Map();

  for (const event of residentPresenceEvents) {
    const sourceKey = cleanText(event.sourceKey);

    if (!sourceKey) {
      continue;
    }

    const eventDate = new Date(event.timestamp);

    if (Number.isNaN(eventDate.getTime())) {
      continue;
    }

    const current = latestBySourceKey.get(sourceKey);
    const currentDate = current?.timestamp ? new Date(current.timestamp) : null;

    if (!current || !currentDate || Number.isNaN(currentDate.getTime()) || eventDate.getTime() > currentDate.getTime()) {
      latestBySourceKey.set(sourceKey, event);
    }
  }

  const latestPresenceEvent = residentPresenceEvents
    .slice()
    .sort((first, second) => new Date(second.timestamp).getTime() - new Date(first.timestamp).getTime())[0] || null;
  const lastKnownPresenceAt = latestPresenceEvent?.timestamp || null;
  const lastKnownPresenceState = latestPresenceEvent ? presenceEventIsActive(latestPresenceEvent) : null;
  const latestSensor = latestPresenceEvent
    ? presenceSensors.find((sensor) => sensorMatchesMotionEvent(sensor, latestPresenceEvent))
    : presenceSensors[0] || null;
  const health = latestSensor?.nodeId ? nodeHealthByNodeId.get(cleanText(latestSensor.nodeId)) : null;
  const healthDate = health?.checkedInAt ? new Date(health.checkedInAt) : null;
  const healthIsFresh = Boolean(
    healthDate &&
    !Number.isNaN(healthDate.getTime()) &&
    healthDate.getTime() >= Date.now() - (NODE_OFFLINE_AFTER_SECONDS * 1000)
  );
  const diagnosticState = readPayloadBoolean(normalizeJsonObject(health?.diagnostics), "presenceState");
  const presenceIsFresh = Boolean(
    latestPresenceEvent &&
    healthIsFresh &&
    diagnosticState !== null &&
    diagnosticState === lastKnownPresenceState
  );
  let presenceFreshnessReason = "no_presence_sensor";
  if (presenceSensors.length > 0 && !latestPresenceEvent) presenceFreshnessReason = "no_retained_presence_edge";
  else if (presenceSensors.length > 0 && !health) presenceFreshnessReason = "missing_heartbeat";
  else if (presenceSensors.length > 0 && !healthIsFresh) presenceFreshnessReason = "stale_heartbeat";
  else if (presenceSensors.length > 0 && diagnosticState === null) presenceFreshnessReason = "missing_presence_diagnostic";
  else if (presenceSensors.length > 0 && diagnosticState !== lastKnownPresenceState) presenceFreshnessReason = "heartbeat_event_disagreement";
  else if (presenceIsFresh) presenceFreshnessReason = "fresh_heartbeat_corroborates_last_edge";

  const latestPresenceAt = lastKnownPresenceAt;
  const latestPresenceState = presenceIsFresh ? lastKnownPresenceState : null;
  const activePresenceEvents = presenceIsFresh && latestPresenceState === true
    ? [latestPresenceEvent]
    : [];

  const currentPresenceRooms = activePresenceEvents
    .map((event) => {
      const sensor = presenceSensors.find((candidate) => sensorMatchesMotionEvent(candidate, event));
      return presenceEventRoomName(event, sensor);
    })
    .filter(Boolean)
    .filter((roomName, index, rooms) => rooms.indexOf(roomName) === index)
    .sort((first, second) => first.localeCompare(second));

  const activeDurations = activePresenceEvents
    .map((event) => minutesSince(event.timestamp))
    .filter((minutes) => Number.isFinite(minutes));
  const activePresenceDurationMinutes = activeDurations.length > 0 ? Math.max(...activeDurations) : null;

  let presenceStatus = "No Presence Sensor";
  let presenceExplanation = "No human-presence sensor is assigned to this resident.";

  if (presenceSensors.length > 0 && !presenceIsFresh) {
    presenceStatus = "Presence Unknown";
    presenceExplanation = latestPresenceEvent
      ? `Last-known presence is retained, but current presence is unknown because ${presenceFreshnessReason.replaceAll("_", " ")}.`
      : "Current presence is unknown because no retained presence edge is available.";
    logStructuredDiagnostic("PRESENCE_STALE_OR_DISAGREED", "warning", {
      nodeId: latestSensor?.nodeId || null,
      sensorId: latestSensor?.id || null,
      reason: presenceFreshnessReason,
      healthAgeSeconds: healthDate && !Number.isNaN(healthDate.getTime())
        ? Math.max(0, Math.floor((Date.now() - healthDate.getTime()) / 1000))
        : null,
      lastKnownPresenceState,
      lastKnownPresenceAt,
      diagnosticState
    });
  } else if (presenceSensors.length > 0 && latestPresenceState === false) {
    presenceStatus = "Presence Clear";
    presenceExplanation = "Latest human-presence event says the monitored room is clear.";
  } else if (presenceSensors.length > 0 && latestPresenceState === true) {
    if (Number.isFinite(activePresenceDurationMinutes) && activePresenceDurationMinutes >= AI_PRESENCE_ACTIVE_CRITICAL_MINUTES) {
      presenceStatus = "Presence Active Very Long";
      presenceExplanation = `Human presence has remained active for about ${activePresenceDurationMinutes} minutes. Review this against the resident's normal routine.`;
    } else if (Number.isFinite(activePresenceDurationMinutes) && activePresenceDurationMinutes >= AI_PRESENCE_ACTIVE_WARNING_MINUTES) {
      presenceStatus = "Presence Active Long";
      presenceExplanation = `Human presence has remained active for about ${activePresenceDurationMinutes} minutes. Continue watching or verify if this is expected.`;
    } else {
      presenceStatus = "Presence Active";
      presenceExplanation = currentPresenceRooms.length > 0
        ? `Human presence is currently active in ${currentPresenceRooms.join(", ")}.`
        : "Human presence is currently active.";
    }
  }

  return {
    presenceSensorCount: presenceSensors.length,
    presenceEventCount: residentPresenceEvents.length,
    latestPresenceAt,
    latestPresenceState,
    lastKnownPresenceState,
    lastKnownPresenceAt,
    presenceIsFresh,
    presenceFreshnessReason,
    currentPresenceRooms,
    activePresenceDurationMinutes,
    presenceStatus,
    presenceExplanation
  };
}

function buildResidentAIConfidence({ motionBaseline, activeSensorCount, onlineSensorCount, offlineSensorCount, residentMotionEvents, motionEventHistoryCount = null, presenceIntelligence }) {
  let score = 25;
  const reasons = [];

  const baselineDayCount = normalizeInteger(motionBaseline?.baselineDayCount, 0);

  if (baselineDayCount >= 7) {
    score += 25;
    reasons.push(`${baselineDayCount} baseline days`);
  } else if (baselineDayCount >= AI_BASELINE_MIN_DAYS) {
    score += 15;
    reasons.push(`${baselineDayCount} baseline days`);
  } else {
    reasons.push("limited baseline history");
  }

  if (activeSensorCount > 0 && onlineSensorCount === activeSensorCount) {
    score += 25;
    reasons.push("all active sensors online");
  } else if (onlineSensorCount > 0) {
    score += 12;
    reasons.push(`${onlineSensorCount} sensor(s) online`);
  } else {
    score -= 20;
    reasons.push("no active sensor currently online");
  }

  if (offlineSensorCount > 0) {
    score -= Math.min(25, offlineSensorCount * 10);
    reasons.push(`${offlineSensorCount} offline sensor(s)`);
  }

  const effectiveMotionHistoryCount = Number.isFinite(Number(motionEventHistoryCount))
    ? Number(motionEventHistoryCount)
    : (Array.isArray(residentMotionEvents) ? residentMotionEvents.length : 0);

  if (effectiveMotionHistoryCount >= 20) {
    score += 10;
    reasons.push("enough recent motion events");
  }

  if (presenceIntelligence?.presenceSensorCount > 0) {
    score += 5;
    reasons.push("presence sensor available");
  }

  score = Math.max(0, Math.min(100, score));

  let confidence = "Low";

  if (score >= 75) {
    confidence = "High";
  } else if (score >= 50) {
    confidence = "Medium";
  }

  return {
    aiConfidence: confidence,
    aiConfidenceScore: score,
    aiConfidenceExplanation: reasons.length > 0 ? reasons.join("; ") : "Not enough monitoring context yet."
  };
}


function buildResidentLongitudinalIntelligence(residentMotionDailyStats, motionBaseline, residentTodayMotionEvents = []) {
  const todayKey = localDateKey(new Date());
  const DAYTIME_START_MINUTE = 5 * 60;
  const OVERNIGHT_END_MINUTE = DAYTIME_START_MINUTE;
  const OVERNIGHT_EPISODE_GAP_MINUTES = 15;

  const median = (values) => {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  };
  const average = (values) => {
    const valid = values.filter(Number.isFinite);
    return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
  };
  const displayNumber = (value) => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  const relativeDifference = (first, second) => {
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) return null;
    return Math.abs(first - second) / Math.max(first, second);
  };

  const cleanDays = (Array.isArray(residentMotionDailyStats) ? residentMotionDailyStats : [])
    .filter((day) => cleanText(day?.dateKey) && day.dateKey !== todayKey)
    .map((day) => {
      const reportingSensorCount = Math.max(0, normalizeInteger(day.reportingSensorCount, 0));
      const reportingRoomCount = Math.max(0, normalizeInteger(day.reportingRoomCount, 0));
      const motionCount = normalizeInteger(day.motionCount, 0);
      return {
        dateKey: cleanText(day.dateKey),
        motionCount,
        coverageHours: Number.isFinite(Number(day.coverageHours)) ? Number(day.coverageHours) : 0,
        firstDaytimeMinute: Number.isFinite(Number(day.firstDaytimeMinute)) ? Number(day.firstDaytimeMinute) : null,
        lastMinuteOfDay: Number.isFinite(Number(day.lastMinuteOfDay)) ? Number(day.lastMinuteOfDay) : null,
        overnightMotionCount: Math.max(0, normalizeInteger(day.overnightMotionCount, 0)),
        overnightEpisodeCount: Math.max(0, normalizeInteger(day.overnightEpisodeCount, 0)),
        reportingSensorCount,
        reportingRoomCount,
        normalizedMotionCount: reportingSensorCount > 0 ? motionCount / reportingSensorCount : null
      };
    })
    .filter((day) => day.motionCount >= 10 && day.coverageHours >= 8)
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  const windowStats = (size) => {
    const days = cleanDays.slice(0, size);
    const counts = days.map((day) => day.motionCount);
    return {
      days: days.length,
      average: displayNumber(average(counts)),
      median: displayNumber(median(counts))
    };
  };

  const seven = windowStats(7);
  const fourteen = windowStats(14);
  const thirty = windowStats(30);
  const latestSevenDays = cleanDays.slice(0, 7);
  const priorSevenDays = cleanDays.slice(7, 14);

  const latestSensorMedian = median(latestSevenDays.map((day) => day.reportingSensorCount).filter((value) => value > 0));
  const priorSensorMedian = median(priorSevenDays.map((day) => day.reportingSensorCount).filter((value) => value > 0));
  const latestRoomMedian = median(latestSevenDays.map((day) => day.reportingRoomCount).filter((value) => value > 0));
  const priorRoomMedian = median(priorSevenDays.map((day) => day.reportingRoomCount).filter((value) => value > 0));
  const sensorCoverageDifference = relativeDifference(latestSensorMedian, priorSensorMedian);
  const roomCoverageDifference = relativeDifference(latestRoomMedian, priorRoomMedian);
  const hasComparisonWindows = latestSevenDays.length >= 3 && priorSevenDays.length >= 3;
  const hasCoverageData = Number.isFinite(latestSensorMedian) && Number.isFinite(priorSensorMedian);
  const monitoringCoverageComparable = hasComparisonWindows && hasCoverageData &&
    (sensorCoverageDifference === null || sensorCoverageDifference <= 0.25) &&
    (roomCoverageDifference === null || roomCoverageDifference <= 0.25);

  const latestNormalizedAverage = average(latestSevenDays.map((day) => day.normalizedMotionCount));
  const priorNormalizedAverage = average(priorSevenDays.map((day) => day.normalizedMotionCount));
  const sevenDayChangePercent = monitoringCoverageComparable && Number.isFinite(priorNormalizedAverage) && priorNormalizedAverage > 0
    ? displayNumber(((latestNormalizedAverage - priorNormalizedAverage) / priorNormalizedAverage) * 100)
    : null;

  let trendDirection = "Learning";
  let trendCoverageStatus = "Learning";
  if (hasComparisonWindows && !monitoringCoverageComparable) {
    trendDirection = "Trend Learning";
    trendCoverageStatus = "Monitoring Coverage Changed";
  } else if (sevenDayChangePercent !== null) {
    trendCoverageStatus = "Comparable Coverage";
    if (sevenDayChangePercent <= -15) trendDirection = "Declining Activity";
    else if (sevenDayChangePercent >= 15) trendDirection = "Increasing Activity";
    else trendDirection = "Stable Activity";
  }

  const normalizedCounts = cleanDays.map((day) => day.normalizedMotionCount).filter(Number.isFinite);
  const normalizedMedian = median(normalizedCounts);
  const normalizedMAD = normalizedMedian && normalizedMedian > 0
    ? median(normalizedCounts.map((value) => Math.abs(value - normalizedMedian)))
    : null;
  const firstDaytimeMinutes = cleanDays.map((day) => day.firstDaytimeMinute).filter(Number.isFinite);
  const firstDaytimeMedian = median(firstDaytimeMinutes);
  const firstDaytimeMAD = firstDaytimeMedian !== null
    ? median(firstDaytimeMinutes.map((value) => Math.abs(value - firstDaytimeMedian)))
    : null;
  const lastMinutes = cleanDays.map((day) => day.lastMinuteOfDay).filter(Number.isFinite);
  const lastMedian = median(lastMinutes);
  const overnightEpisodeMedian = median(cleanDays.map((day) => day.overnightEpisodeCount).filter(Number.isFinite));

  let routineConsistencyScore = null;
  if (cleanDays.length >= AI_BASELINE_MIN_DAYS && normalizedMedian && normalizedMedian > 0) {
    const activityDispersion = normalizedMAD !== null ? Math.min(1, normalizedMAD / normalizedMedian) : 0.5;
    const timingDispersion = firstDaytimeMAD !== null ? Math.min(1, firstDaytimeMAD / 120) : 0.5;
    routineConsistencyScore = Math.max(0, Math.min(100, Math.round(100 - (activityDispersion * 55 + timingDispersion * 45))));
  }
  let routineConsistencyLabel = "Learning";
  if (routineConsistencyScore !== null) {
    if (routineConsistencyScore >= 80) routineConsistencyLabel = "Highly Consistent";
    else if (routineConsistencyScore >= 60) routineConsistencyLabel = "Consistent";
    else if (routineConsistencyScore >= 40) routineConsistencyLabel = "Variable";
    else routineConsistencyLabel = "Highly Variable";
  }

  const localMinuteFromTimestamp = (timestamp) => {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: AI_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(date);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? (hour * 60) + minute : null;
  };
  const minuteLabel = (minuteOfDay) => {
    if (!Number.isFinite(minuteOfDay)) return null;
    const normalized = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
    const hour = Math.floor(normalized / 60);
    const minute = normalized % 60;
    const suffix = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
  };
  const timingStatus = (actual, typical, threshold = 45) => {
    if (!Number.isFinite(actual) || !Number.isFinite(typical)) return "Learning";
    const delta = actual - typical;
    if (delta >= threshold) return "Later Than Usual";
    if (delta <= -threshold) return "Earlier Than Usual";
    return "Within Usual Window";
  };
  const episodeLabel = (value) => {
    if (!Number.isFinite(value)) return null;
    const rounded = Math.max(0, Math.round(value));
    return `${rounded} episode${rounded === 1 ? "" : "s"}`;
  };

  const todayEventsWithMinute = (Array.isArray(residentTodayMotionEvents) ? residentTodayMotionEvents : [])
    .map((event) => ({ event, minute: localMinuteFromTimestamp(event?.timestamp) }))
    .filter((item) => Number.isFinite(item.minute));
  const todayFirstDaytimeMinute = todayEventsWithMinute
    .filter((item) => item.minute >= DAYTIME_START_MINUTE)
    .reduce((minimum, item) => minimum === null || item.minute < minimum ? item.minute : minimum, null);
  const todayLastMinute = localMinuteFromTimestamp(motionBaseline?.lastMotionTodayAt);
  const overnightEvents = todayEventsWithMinute
    .filter((item) => item.minute < OVERNIGHT_END_MINUTE)
    .map((item) => new Date(item.event.timestamp))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  let overnightEpisodesToday = 0;
  let previousOvernightEvent = null;
  for (const eventDate of overnightEvents) {
    if (!previousOvernightEvent || (eventDate.getTime() - previousOvernightEvent.getTime()) > (OVERNIGHT_EPISODE_GAP_MINUTES * 60 * 1000)) {
      overnightEpisodesToday += 1;
    }
    previousOvernightEvent = eventDate;
  }

  let overnightStatus = "Learning";
  if (Number.isFinite(overnightEpisodeMedian)) {
    if (overnightEpisodesToday >= overnightEpisodeMedian + 2) overnightStatus = "Above Usual";
    else if (overnightEpisodesToday <= Math.max(0, overnightEpisodeMedian - 2)) overnightStatus = "Below Usual";
    else overnightStatus = "Within Usual Range";
  }

  const milestones = [
    {
      key: "first_daytime_activity",
      title: "First Daytime Activity",
      typicalTime: minuteLabel(firstDaytimeMedian),
      todayTime: minuteLabel(todayFirstDaytimeMinute),
      deviationMinutes: Number.isFinite(todayFirstDaytimeMinute) && Number.isFinite(firstDaytimeMedian)
        ? Math.round(todayFirstDaytimeMinute - firstDaytimeMedian)
        : null,
      status: todayFirstDaytimeMinute === null ? "No Daytime Activity Yet" : timingStatus(todayFirstDaytimeMinute, firstDaytimeMedian),
      detail: Number.isFinite(firstDaytimeMedian)
        ? `Typical first daytime activity after 5:00 AM is around ${minuteLabel(firstDaytimeMedian)}.`
        : "Learning the resident's typical first daytime activity time."
    },
    {
      key: "overnight_activity",
      title: "Overnight Activity",
      typicalTime: episodeLabel(overnightEpisodeMedian),
      todayTime: episodeLabel(overnightEpisodesToday),
      deviationMinutes: null,
      status: overnightStatus,
      detail: Number.isFinite(overnightEpisodeMedian)
        ? `Typical overnight activity before 5:00 AM is about ${episodeLabel(overnightEpisodeMedian)}; episodes are separated by at least ${OVERNIGHT_EPISODE_GAP_MINUTES} minutes.`
        : "Learning the resident's overnight activity pattern."
    },
    {
      key: "latest_activity",
      title: "Latest Activity So Far",
      typicalTime: minuteLabel(lastMedian),
      todayTime: minuteLabel(todayLastMinute),
      deviationMinutes: null,
      status: todayLastMinute !== null ? "Tracking" : "No Activity Yet",
      detail: Number.isFinite(lastMedian)
        ? `Typical final monitored activity is around ${minuteLabel(lastMedian)}; today's value remains provisional until the day is complete.`
        : "Learning the resident's typical evening activity endpoint."
    }
  ];

  let trendNarrative = `Using ${cleanDays.length} complete historical day(s).`;
  if (hasComparisonWindows && !monitoringCoverageComparable) {
    trendNarrative += ` A week-over-week percentage is intentionally withheld because monitoring coverage changed between the comparison windows`;
    if (Number.isFinite(latestSensorMedian) && Number.isFinite(priorSensorMedian)) {
      trendNarrative += ` (typical reporting sensors ${priorSensorMedian} → ${latestSensorMedian})`;
    }
    trendNarrative += ".";
  } else if (sevenDayChangePercent !== null) {
    const directionText = sevenDayChangePercent > 0 ? "higher" : sevenDayChangePercent < 0 ? "lower" : "unchanged";
    trendNarrative += ` Coverage-normalized recent 7-day activity is ${Math.abs(sevenDayChangePercent)}% ${directionText} than the preceding comparison week.`;
  }
  if (routineConsistencyScore !== null) {
    trendNarrative += ` Routine consistency is ${routineConsistencyLabel.toLowerCase()} (${routineConsistencyScore}/100), based on coverage-normalized activity and first daytime activity timing.`;
  }

  return {
    routineMilestones: milestones,
    routineConsistencyScore,
    routineConsistencyLabel,
    sevenDayAverage: seven.average,
    fourteenDayAverage: fourteen.average,
    thirtyDayAverage: thirty.average,
    sevenDayMedian: seven.median,
    fourteenDayMedian: fourteen.median,
    thirtyDayMedian: thirty.median,
    sevenDayDaysUsed: seven.days,
    fourteenDayDaysUsed: fourteen.days,
    thirtyDayDaysUsed: thirty.days,
    sevenDayChangePercent,
    trendDirection,
    trendNarrative,
    trendCoverageStatus,
    monitoringCoverageComparable,
    latestReportingSensorMedian: displayNumber(latestSensorMedian),
    priorReportingSensorMedian: displayNumber(priorSensorMedian),
    latestReportingRoomMedian: displayNumber(latestRoomMedian),
    priorReportingRoomMedian: displayNumber(priorRoomMedian),
    typicalFirstActivityTime: minuteLabel(firstDaytimeMedian),
    typicalLastActivityTime: minuteLabel(lastMedian),
    typicalOvernightEpisodes: displayNumber(overnightEpisodeMedian),
    overnightEpisodesToday
  };
}

function buildResidentBehaviorInsights({ motionBaseline, roomIntelligence, presenceIntelligence, aiStatus }) {
  const insights = [];

  if (motionBaseline?.patternStatus) {
    insights.push({
      type: "motion_pattern",
      title: motionBaseline.patternStatus,
      detail: motionBaseline.patternExplanation
    });
  }

  if (roomIntelligence?.coverageStatus) {
    insights.push({
      type: "room_coverage",
      title: roomIntelligence.coverageStatus,
      detail: roomIntelligence.coverageExplanation
    });
  }

  if (presenceIntelligence?.presenceStatus && presenceIntelligence.presenceStatus !== "No Presence Sensor") {
    insights.push({
      type: "presence",
      title: presenceIntelligence.presenceStatus,
      detail: presenceIntelligence.presenceExplanation
    });
  }

  if (aiStatus?.aiExplanation) {
    insights.push({
      type: "overall_ai",
      title: aiStatus.aiLevel || aiStatus.aiStatus || "AI Status",
      detail: aiStatus.aiExplanation
    });
  }

  return insights;
}

function buildResidentActionGuidance({
  aiStatus,
  motionBaseline,
  roomIntelligence,
  presenceIntelligence,
  activeSensorCount,
  offlineSensorCount,
  recentCriticalOpenAlertCount,
  recentCautionOpenAlertCount,
  inactiveMinutes
}) {
  const aiLevel = cleanText(aiStatus?.aiLevel || aiStatus?.aiStatus);
  const patternStatus = cleanText(motionBaseline?.patternStatus);
  const coverageStatus = cleanText(roomIntelligence?.coverageStatus);
  const presenceStatus = cleanText(presenceIntelligence?.presenceStatus);

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

  if (presenceStatus === "Presence Active Very Long" || presenceStatus === "Presence Active Long") {
    return {
      actionLevel: "Watch",
      actionTitle: "Review sustained presence",
      actionSummary: presenceIntelligence?.presenceExplanation || "Human presence has remained active longer than the current watch threshold.",
      actionItems: [
        "Compare this sustained presence with the resident's expected routine.",
        "Check the room if the active presence does not match normal activity.",
        "Confirm the sensor is aimed correctly and is not detecting a fan, chair, or other false presence source."
      ],
      nextCheckMinutes: 30
    };
  }

  if (aiLevel === "Learning" || (
    patternStatus === "Insufficient Baseline" &&
    activeSensorCount > 0 &&
    offlineSensorCount === 0 &&
    recentCriticalOpenAlertCount === 0 &&
    recentCautionOpenAlertCount === 0
  )) {
    return {
      actionLevel: "Learning",
      actionTitle: "Learning resident routine",
      actionSummary: "The system is collecting baseline history and no staff follow-up is currently required.",
      actionItems: [
        "Continue normal monitoring while baseline history is collected."
      ],
      nextCheckMinutes: null
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

  if (actionLevel === "Normal" || actionLevel === "Observe" || actionLevel === "Learning") {
    const followUpExplanation = actionLevel === "Observe"
      ? "Observation only. No staff follow-up is required unless the resident's status escalates."
      : actionLevel === "Learning"
        ? "Baseline learning is in progress. No staff follow-up is required unless another warning signal appears."
        : "Current action recommendation is normal monitoring.";

    return {
      followUpStatus: "No Action Needed",
      followUpExplanation,
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
  motionBaseline,
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
  const baselineDayCount = normalizeInteger(motionBaseline?.baselineDayCount, 0);
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

  // Healthy residents without enough usable baseline history are still learning.
  // Do not promote "No Motion Today" to Watch unless another real warning signal exists.
  if (baselineDayCount < AI_BASELINE_MIN_DAYS && offlineSensorCount === 0) {
    return {
      aiStatus: "Learning",
      aiLevel: "Learning",
      aiExplanation: `Learning this resident's routine from ${baselineDayCount} usable baseline day(s). Sensors are online and no current warning signal requires follow-up.`
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
  const now = new Date();
  const currentLocalHour = localHourFromDate(now) ?? 0;
  const currentLocalMinute = (() => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: AI_TIME_ZONE,
      minute: "2-digit"
    }).formatToParts(now);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isFinite(minute) ? minute : 0;
  })();
  const currentMinuteOfDay = (currentLocalHour * 60) + currentLocalMinute;

  const [residentResult, sensorResult, eventResult, presenceEventResult, motionDailyResult, todayMotionResult, latestSensorMotionResult, nodeHealthResult, nodeResult, actionLogResult, excludedResult] = await Promise.all([
    pool.query(`
      ${residentSelectSQL()}
      WHERE is_deleted = FALSE
      ORDER BY name ASC
    `),
    pool.query(`
      ${sensorSelectSQL()}
      WHERE is_deleted = FALSE
        AND is_active = TRUE
        AND EXISTS (
          SELECT 1 FROM nodes n
          WHERE n.node_id = sensors.node_id
            AND n.is_archived = FALSE
        )
      ORDER BY resident_name ASC, room_name ASC NULLS LAST, source_name ASC
    `),
    pool.query(`
      ${eventSelectSQL()}
      WHERE node_id IS NULL
        OR node_id NOT LIKE 'esp32-%'
        OR EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = webhook_events.node_id AND n.is_archived = FALSE)
      ORDER BY timestamp DESC
      LIMIT 200
    `),
    pool.query(`
      ${eventSelectSQL()}
      WHERE (event_type IN ('presence_detected', 'presence_cleared')
        OR sensor_type IN ('human_presence', 'presence'))
        AND EXISTS (
          SELECT 1 FROM sensors s
          JOIN nodes n ON n.node_id = s.node_id
          WHERE s.node_id = webhook_events.node_id
            AND s.is_active = TRUE
            AND s.is_deleted = FALSE
            AND n.is_archived = FALSE
        )
      ORDER BY timestamp DESC
      LIMIT $1
    `, [AI_MOTION_HISTORY_EVENT_LIMIT]),
    pool.query(
      `
      WITH eligible_motion AS (
        SELECT
          motion_events.*,
          (event_timestamp AT TIME ZONE $2)::date AS local_date,
          (
            EXTRACT(HOUR FROM event_timestamp AT TIME ZONE $2)::int * 60 +
            EXTRACT(MINUTE FROM event_timestamp AT TIME ZONE $2)::int
          ) AS minute_of_day,
          LAG(event_timestamp) OVER (
            PARTITION BY COALESCE(resident_id::text, LOWER(TRIM(resident_name))), (event_timestamp AT TIME ZONE $2)::date
            ORDER BY event_timestamp
          ) AS previous_event_timestamp
        FROM motion_events
        WHERE event_timestamp >= NOW() - ($1::int * INTERVAL '1 day')
          AND EXISTS (
            SELECT 1 FROM sensors s
            JOIN nodes n ON n.node_id = s.node_id
            WHERE s.id = motion_events.sensor_id
              AND s.is_active = TRUE
              AND s.is_deleted = FALSE
              AND n.is_archived = FALSE
          )
      )
      SELECT
        resident_id AS "residentId",
        MAX(resident_name) AS "residentName",
        local_date::text AS "dateKey",
        COUNT(*)::int AS "motionCount",
        COUNT(*) FILTER (WHERE minute_of_day <= $3::int)::int AS "sameTimeCount",
        EXTRACT(EPOCH FROM (MAX(event_timestamp) - MIN(event_timestamp))) / 3600.0 AS "coverageHours",
        MIN(minute_of_day) FILTER (WHERE minute_of_day >= 300)::int AS "firstDaytimeMinute",
        MAX(minute_of_day)::int AS "lastMinuteOfDay",
        COUNT(*) FILTER (WHERE minute_of_day < 300)::int AS "overnightMotionCount",
        COUNT(*) FILTER (
          WHERE minute_of_day < 300
            AND (
              previous_event_timestamp IS NULL
              OR event_timestamp - previous_event_timestamp > INTERVAL '15 minutes'
            )
        )::int AS "overnightEpisodeCount",
        COUNT(DISTINCT sensor_id)::int AS "reportingSensorCount",
        COUNT(DISTINCT COALESCE(NULLIF(TRIM(room_name), ''), NULLIF(TRIM(source_name), ''), sensor_id::text))::int AS "reportingRoomCount"
      FROM eligible_motion
      GROUP BY
        resident_id,
        CASE WHEN resident_id IS NULL THEN LOWER(TRIM(resident_name)) ELSE NULL END,
        local_date
      ORDER BY local_date DESC
      `,
      [AI_MOTION_HISTORY_DAYS, AI_TIME_ZONE, currentMinuteOfDay]
    ),
    pool.query(
      `
      ${motionEventSelectSQL()}
      WHERE event_timestamp >= ((NOW() AT TIME ZONE $1)::date AT TIME ZONE $1)
        AND event_timestamp < (((NOW() AT TIME ZONE $1)::date + 1) AT TIME ZONE $1)
        AND EXISTS (
          SELECT 1 FROM sensors s
          JOIN nodes n ON n.node_id = s.node_id
          WHERE s.id = motion_events.sensor_id
            AND s.is_active = TRUE
            AND s.is_deleted = FALSE
            AND n.is_archived = FALSE
        )
      ORDER BY event_timestamp DESC
      `,
      [AI_TIME_ZONE]
    ),
    pool.query(
      `
      SELECT DISTINCT ON (sensor_id)
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
      WHERE sensor_id IS NOT NULL
        AND event_timestamp >= NOW() - ($1::int * INTERVAL '1 day')
        AND EXISTS (
          SELECT 1 FROM sensors s
          JOIN nodes n ON n.node_id = s.node_id
          WHERE s.id = motion_events.sensor_id
            AND s.is_active = TRUE
            AND s.is_deleted = FALSE
            AND n.is_archived = FALSE
        )
      ORDER BY sensor_id, event_timestamp DESC
      `,
      [AI_MOTION_HISTORY_DAYS]
    ),
    pool.query(`
      ${nodeHealthSelectSQL()}
      WHERE EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = node_health.node_id AND n.is_archived = FALSE)
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
    `),
    pool.query(`
      SELECT
        COUNT(DISTINCT n.node_id) FILTER (WHERE n.is_archived = TRUE)::int AS "archivedNodeCount",
        COUNT(s.id) FILTER (WHERE s.is_active = FALSE AND s.is_deleted = FALSE)::int AS "inactiveSensorCount",
        COUNT(s.id) FILTER (WHERE s.is_deleted = TRUE)::int AS "deletedSensorCount"
      FROM nodes n
      LEFT JOIN sensors s ON s.node_id = n.node_id
      WHERE n.node_id LIKE 'esp32-%'
    `)
  ]);

  const excluded = excludedResult.rows[0] || {};
  if ((excluded.archivedNodeCount || 0) + (excluded.inactiveSensorCount || 0) + (excluded.deletedSensorCount || 0) > 0) {
    logStructuredDiagnostic("ARCHIVED_INACTIVE_EXCLUDED", "info", excluded);
  }

  const sensors = sensorResult.rows;
  const events = eventResult.rows;
  const presenceEvents = presenceEventResult.rows.filter(isPresenceEventRow);
  const motionDailyStats = motionDailyResult.rows;
  const todayMotionEvents = todayMotionResult.rows;
  const latestSensorMotionEvents = latestSensorMotionResult.rows;
  const actionLogs = actionLogResult.rows;
  const nodeHealthByNodeId = new Map(
    nodeHealthResult.rows.map((health) => [cleanText(health.nodeId), health])
  );
  const nodeLastSeenByNodeId = new Map(
    nodeResult.rows.map((node) => [cleanText(node.nodeId), node.lastSeenAt])
  );

  const groupByResident = (rows, idField = 'residentId', nameField = 'residentName') => {
    const byId = new Map();
    const byName = new Map();
    for (const row of rows) {
      const id = cleanText(row?.[idField]);
      const name = normalizeForMatch(row?.[nameField]);
      if (id) { if (!byId.has(id)) byId.set(id, []); byId.get(id).push(row); }
      if (name) { if (!byName.has(name)) byName.set(name, []); byName.get(name).push(row); }
    }
    return { byId, byName };
  };
  const sensorGroups = groupByResident(sensors);
  const eventGroups = groupByResident(events, 'residentId', 'residentName');
  const presenceGroups = groupByResident(presenceEvents, 'residentId', 'residentName');
  const motionDailyGroups = groupByResident(motionDailyStats);
  const todayMotionGroups = groupByResident(todayMotionEvents);
  const latestSensorMotionGroups = groupByResident(latestSensorMotionEvents);
  const actionGroups = groupByResident(actionLogs);
  const rowsForResident = (groups, resident) => {
    const byIdRows = groups.byId.get(cleanText(resident.id)) || [];
    const byNameRows = groups.byName.get(normalizeForMatch(resident.name)) || [];
    if (byIdRows.length === 0) return byNameRows;
    if (byNameRows.length === 0) return byIdRows;
    return [...new Map([...byIdRows, ...byNameRows].map((row) => [row.id || JSON.stringify(row), row])).values()];
  };

  const residents = residentResult.rows.map((resident) => {
    const residentNameKey = normalizeForMatch(resident.name);

    const residentSensors = rowsForResident(sensorGroups, resident);
    const residentEvents = rowsForResident(eventGroups, resident);
    const residentPresenceEvents = rowsForResident(presenceGroups, resident);
    const residentActionLogs = rowsForResident(actionGroups, resident);
    const latestActionLog = residentActionLogs[0] || null;

    const motionEvents = residentEvents.filter(isMotionEventRow);
    const physicalWebhookMotionEvents = motionEvents.filter(isPhysicalMotionEventRow);
    const residentMotionDailyStats = rowsForResident(motionDailyGroups, resident);
    const residentTodayMotionEvents = rowsForResident(todayMotionGroups, resident);
    const residentLatestSensorMotionEvents = rowsForResident(latestSensorMotionGroups, resident);
    const residentPersistentMotionEventCount = residentMotionDailyStats.reduce((total, day) => {
      return total + normalizeInteger(day.motionCount, 0);
    }, 0);
    const residentMotionEvents = [...new Map(
      [...residentTodayMotionEvents, ...residentLatestSensorMotionEvents]
        .map((row) => [row.id || JSON.stringify(row), row])
    ).values()].sort((first, second) => {
      return new Date(second.timestamp).getTime() - new Date(first.timestamp).getTime();
    });
    const effectiveResidentMotionEvents = residentMotionEvents.length > 0
      ? residentMotionEvents
      : physicalWebhookMotionEvents;
    const latestMotionEvent = effectiveResidentMotionEvents[0] || null;
    const latestMotionSensor = latestMotionEvent
      ? residentSensors.find((sensor) => {
          return normalizeForMatch(sensor.sourceKey) === normalizeForMatch(latestMotionEvent.sourceKey) ||
            normalizeForMatch(sensor.sourceName) === normalizeForMatch(latestMotionEvent.sourceName);
        })
      : null;

    const motionBaseline = buildResidentMotionBaseline(residentTodayMotionEvents, residentMotionDailyStats);
    // Use one canonical AI-time-zone calculation for every "today" count.
    // This keeps the displayed total, room totals, hourly totals, briefing totals,
    // and pattern comparison aligned even when the server process runs in UTC.
    const motionCountToday = motionBaseline.todayMotionCount;

    const motionCountLastHour = effectiveResidentMotionEvents.filter((event) => {
      const eventDate = new Date(event.timestamp);
      return !Number.isNaN(eventDate.getTime()) &&
        eventDate.getTime() >= Date.now() - (60 * 60 * 1000);
    }).length;
    const roomIntelligence = buildResidentRoomIntelligence(residentSensors, residentTodayMotionEvents);
    const presenceIntelligence = buildResidentPresenceIntelligence(
      residentSensors,
      residentPresenceEvents,
      nodeHealthByNodeId
    );
    const sensorStatusById = new Map(
      residentSensors.map((sensor) => {
        return [
          sensor.id,
          buildEffectiveSensorStatus(sensor, nodeHealthByNodeId, nodeLastSeenByNodeId, effectiveResidentMotionEvents)
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
      motionBaseline,
      inactiveMinutes,
      openAlertCount: openAlerts.length,
      recentOpenAlertCount: recentOpenAlerts.length,
      recentCriticalOpenAlertCount: recentCriticalOpenAlerts.length,
      recentCautionOpenAlertCount: recentCautionOpenAlerts.length,
      activeSensorCount: activeSensors.length,
      onlineSensorCount,
      offlineSensorCount: offlineSensors.length
    });
    const aiConfidence = buildResidentAIConfidence({
      motionBaseline,
      activeSensorCount: activeSensors.length,
      onlineSensorCount,
      offlineSensorCount: offlineSensors.length,
      residentMotionEvents: effectiveResidentMotionEvents,
      motionEventHistoryCount: residentPersistentMotionEventCount,
      presenceIntelligence
    });
    const actionGuidance = buildResidentActionGuidance({
      aiStatus,
      motionBaseline,
      roomIntelligence,
      presenceIntelligence,
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
    const longitudinalIntelligence = buildResidentLongitudinalIntelligence(
      residentMotionDailyStats,
      motionBaseline,
      residentTodayMotionEvents
    );
    const behaviorInsights = buildResidentBehaviorInsights({
      motionBaseline,
      roomIntelligence,
      presenceIntelligence,
      aiStatus
    });

    if (longitudinalIntelligence.sevenDayChangePercent !== null) {
      behaviorInsights.push({
        type: "longitudinal_trend",
        title: longitudinalIntelligence.trendDirection,
        detail: longitudinalIntelligence.trendNarrative
      });
    }
    if (longitudinalIntelligence.routineConsistencyScore !== null) {
      behaviorInsights.push({
        type: "routine_consistency",
        title: `Routine ${longitudinalIntelligence.routineConsistencyLabel}`,
        detail: `Consistency score ${longitudinalIntelligence.routineConsistencyScore}/100 based on day-to-day activity volume and first-activity timing.`
      });
    }

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
      motionEventCount: residentPersistentMotionEventCount,
      presenceEventCount: residentPresenceEvents.length,
      persistentMotionEventCount: residentPersistentMotionEventCount,
      retainedMotionEventFallbackCount: physicalWebhookMotionEvents.length,
      motionCountToday,
      motionCountLastHour,
      baselineDayCount: motionBaseline.baselineDayCount,
      baselineExcludedDayCount: motionBaseline.baselineExcludedDayCount,
      baselineMotionAverage: motionBaseline.baselineMotionAverage,
      baselineMotionMedian: motionBaseline.baselineMotionMedian,
      baselineSameTimeMedian: motionBaseline.baselineSameTimeMedian,
      baselineMethod: motionBaseline.baselineMethod,
      routineMilestones: longitudinalIntelligence.routineMilestones,
      routineConsistencyScore: longitudinalIntelligence.routineConsistencyScore,
      routineConsistencyLabel: longitudinalIntelligence.routineConsistencyLabel,
      sevenDayAverage: longitudinalIntelligence.sevenDayAverage,
      fourteenDayAverage: longitudinalIntelligence.fourteenDayAverage,
      thirtyDayAverage: longitudinalIntelligence.thirtyDayAverage,
      sevenDayMedian: longitudinalIntelligence.sevenDayMedian,
      fourteenDayMedian: longitudinalIntelligence.fourteenDayMedian,
      thirtyDayMedian: longitudinalIntelligence.thirtyDayMedian,
      sevenDayDaysUsed: longitudinalIntelligence.sevenDayDaysUsed,
      fourteenDayDaysUsed: longitudinalIntelligence.fourteenDayDaysUsed,
      thirtyDayDaysUsed: longitudinalIntelligence.thirtyDayDaysUsed,
      sevenDayChangePercent: longitudinalIntelligence.sevenDayChangePercent,
      trendDirection: longitudinalIntelligence.trendDirection,
      trendNarrative: longitudinalIntelligence.trendNarrative,
      trendCoverageStatus: longitudinalIntelligence.trendCoverageStatus,
      monitoringCoverageComparable: longitudinalIntelligence.monitoringCoverageComparable,
      latestReportingSensorMedian: longitudinalIntelligence.latestReportingSensorMedian,
      priorReportingSensorMedian: longitudinalIntelligence.priorReportingSensorMedian,
      latestReportingRoomMedian: longitudinalIntelligence.latestReportingRoomMedian,
      priorReportingRoomMedian: longitudinalIntelligence.priorReportingRoomMedian,
      typicalOvernightEpisodes: longitudinalIntelligence.typicalOvernightEpisodes,
      overnightEpisodesToday: longitudinalIntelligence.overnightEpisodesToday,
      typicalFirstActivityTime: longitudinalIntelligence.typicalFirstActivityTime,
      typicalLastActivityTime: longitudinalIntelligence.typicalLastActivityTime,
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
      presenceSensorCount: presenceIntelligence.presenceSensorCount,
      latestPresenceAt: presenceIntelligence.latestPresenceAt,
      latestPresenceState: presenceIntelligence.latestPresenceState,
      currentPresenceRooms: presenceIntelligence.currentPresenceRooms,
      activePresenceDurationMinutes: presenceIntelligence.activePresenceDurationMinutes,
      presenceStatus: presenceIntelligence.presenceStatus,
      presenceExplanation: presenceIntelligence.presenceExplanation,
      aiConfidence: aiConfidence.aiConfidence,
      aiConfidenceScore: aiConfidence.aiConfidenceScore,
      aiConfidenceExplanation: aiConfidence.aiConfidenceExplanation,
      behaviorInsights,
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
        const status = sensorStatusById.get(sensor.id) || buildEffectiveSensorStatus(sensor, nodeHealthByNodeId, nodeLastSeenByNodeId, effectiveResidentMotionEvents);

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
    presenceActiveWatchMinutes: AI_PRESENCE_ACTIVE_WATCH_MINUTES,
    presenceActiveWarningMinutes: AI_PRESENCE_ACTIVE_WARNING_MINUTES,
    presenceActiveCriticalMinutes: AI_PRESENCE_ACTIVE_CRITICAL_MINUTES,
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
  } else if (
    followUpStatus === "not logged" &&
    !["normal", "observe", "learning"].includes(actionLevel)
  ) {
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

  if (actionLevel === "learning" || aiLevel === "learning") {
    return "Learning";
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
    presenceStatus: resident.presenceStatus,
    aiConfidence: resident.aiConfidence,
    aiConfidenceScore: resident.aiConfidenceScore,
    lastActionAt: resident.lastActionAt,
    lastActionBy: resident.lastActionBy,
    lastActionStatus: resident.lastActionStatus
  };
}

function buildAIBriefingFromSummary(summary) {
  const residents = Array.isArray(summary?.residents) ? summary.residents : [];
  const nonNormalActionResidents = residents.filter((resident) => {
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    return !["normal", "observe", "learning"].includes(actionLevel);
  });
  const followUpDueResidents = residents.filter((resident) => {
    const status = cleanText(resident.followUpStatus).toLowerCase();
    return status === "due now" || status === "due again";
  });
  const unloggedFollowUpResidents = residents.filter((resident) => {
    const status = cleanText(resident.followUpStatus).toLowerCase();
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    return status === "not logged" &&
      !["normal", "observe", "learning"].includes(actionLevel);
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
    const actionLevel = cleanText(resident.actionLevel).toLowerCase();
    return ["normal", "observe", "learning"].includes(actionLevel);
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
      motionCountLastHour: residents.reduce((total, resident) => total + normalizeInteger(resident.motionCountLastHour, 0), 0),
      activePresenceCount: residents.reduce((total, resident) => {
        return total + (resident.latestPresenceState === true ? 1 : 0);
      }, 0)
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

let aiDashboardRefreshPromise = null;
let aiDashboardRefreshTimer = null;

async function persistAIDashboardPayload(payload) {
  try {
    await pool.query(
      `
      INSERT INTO ai_dashboard_cache (cache_key, payload, generated_at, updated_at)
      VALUES ('default', $1::jsonb, $2, NOW())
      ON CONFLICT (cache_key)
      DO UPDATE SET payload = EXCLUDED.payload, generated_at = EXCLUDED.generated_at, updated_at = NOW()
      `,
      [JSON.stringify(payload), payload.generatedAt]
    );
    return true;
  } catch (error) {
    // Cache persistence is an optimization only. A cache write failure must
    // never make a successfully built dashboard fail.
    console.error('AI dashboard cache persistence failed:', error);
    return false;
  }
}

async function loadCachedAIDashboardPayload() {
  const result = await pool.query(`
    SELECT payload, generated_at AS "generatedAt"
    FROM ai_dashboard_cache
    WHERE cache_key = 'default'
    LIMIT 1
  `);
  return result.rows[0] || null;
}

// Monitoring Center must never recompute the full AI motion summary on every
// page load or resident click. Serve the latest persisted AI dashboard snapshot
// immediately and refresh it in the background when it is stale.
let monitoringSummaryMemoryCache = null;
let monitoringSummaryMemoryLoadedAt = 0;
const MONITORING_SUMMARY_MEMORY_TTL_MS = 5000;

async function loadMonitoringSummaryFast() {
  const now = Date.now();
  if (monitoringSummaryMemoryCache && (now - monitoringSummaryMemoryLoadedAt) < MONITORING_SUMMARY_MEMORY_TTL_MS) {
    return monitoringSummaryMemoryCache;
  }

  let cached = null;
  try {
    cached = await loadCachedAIDashboardPayload();
  } catch (error) {
    console.error("Monitoring Center AI cache read failed:", error);
  }

  if (cached?.payload?.summary) {
    const generatedAt = new Date(cached.generatedAt);
    const ageSeconds = Number.isNaN(generatedAt.getTime())
      ? AI_DASHBOARD_CACHE_MAX_AGE_SECONDS + 1
      : Math.max(0, Math.floor((now - generatedAt.getTime()) / 1000));

    monitoringSummaryMemoryCache = cached.payload.summary;
    monitoringSummaryMemoryLoadedAt = now;

    if (ageSeconds > AI_DASHBOARD_CACHE_MAX_AGE_SECONDS) {
      refreshAIDashboardPayloadSingleFlight().catch(() => {});
    }

    return monitoringSummaryMemoryCache;
  }

  // Only the cold-start/no-cache path performs the expensive rebuild.
  const payload = await refreshAIDashboardPayloadSingleFlight();
  monitoringSummaryMemoryCache = payload.summary;
  monitoringSummaryMemoryLoadedAt = Date.now();
  return monitoringSummaryMemoryCache;
}

async function buildAIDashboardPayload() {
  const summary = await buildAIMotionSummary();
  const briefing = buildAIBriefingFromSummary(summary);
  const payload = {
    success: true,
    generatedAt: new Date().toISOString(),
    summary,
    briefing
  };
  await persistAIDashboardPayload(payload);
  return payload;
}

async function refreshAIDashboardPayloadSingleFlight() {
  if (aiDashboardRefreshPromise) return aiDashboardRefreshPromise;
  aiDashboardRefreshPromise = buildAIDashboardPayload()
    .catch((error) => {
      console.error('AI dashboard background refresh failed:', error);
      throw error;
    })
    .finally(() => { aiDashboardRefreshPromise = null; });
  return aiDashboardRefreshPromise;
}

function scheduleAIDashboardRefresh() {
  if (aiDashboardRefreshTimer) clearTimeout(aiDashboardRefreshTimer);
  aiDashboardRefreshTimer = setTimeout(() => {
    aiDashboardRefreshTimer = null;
    refreshAIDashboardPayloadSingleFlight().catch(() => {});
  }, AI_DASHBOARD_REFRESH_DEBOUNCE_MS);
}

async function incrementResidentDailyActivity({ resident, event, sensor }) {
  if (!resident?.id || !isPhysicalMotionEventRow(event)) return;
  const roomName = cleanText(sensor?.roomName) || inferRoomNameFromSourceName(event.sourceName) || 'Unknown room';
  await pool.query(
    `
    INSERT INTO resident_activity_daily (
      resident_id, activity_date, motion_count, first_motion_at, last_motion_at, room_counts, hourly_counts, updated_at
    )
    VALUES (
      $1, ($2::timestamptz AT TIME ZONE $3)::date, 1, $2, $2,
      jsonb_build_object($4::text, 1),
      jsonb_build_object(EXTRACT(HOUR FROM $2::timestamptz AT TIME ZONE $3)::int::text, 1), NOW()
    )
    ON CONFLICT (resident_id, activity_date)
    DO UPDATE SET
      motion_count = resident_activity_daily.motion_count + 1,
      first_motion_at = LEAST(resident_activity_daily.first_motion_at, EXCLUDED.first_motion_at),
      last_motion_at = GREATEST(resident_activity_daily.last_motion_at, EXCLUDED.last_motion_at),
      room_counts = jsonb_set(
        resident_activity_daily.room_counts, ARRAY[$4::text],
        to_jsonb(COALESCE((resident_activity_daily.room_counts ->> $4::text)::int, 0) + 1), true
      ),
      hourly_counts = jsonb_set(
        resident_activity_daily.hourly_counts,
        ARRAY[EXTRACT(HOUR FROM $2::timestamptz AT TIME ZONE $3)::int::text],
        to_jsonb(COALESCE((resident_activity_daily.hourly_counts ->> EXTRACT(HOUR FROM $2::timestamptz AT TIME ZONE $3)::int::text)::int, 0) + 1), true
      ),
      updated_at = NOW()
    `,
    [resident.id, event.timestamp, AI_TIME_ZONE, roomName]
  );
}


const MONITORING_SESSION_HOURS = 12;
const MONITORING_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MONITORING_LOGIN_MAX_ATTEMPTS = 8;
const monitoringLoginAttempts = new Map();

function monitoringEncryptionKey() {
  const raw = cleanText(process.env.MONITORING_ENCRYPTION_KEY);
  if (!raw) return null;
  return createHash("sha256").update(raw).digest();
}

function encryptMonitoringSecret(plaintext) {
  const key = monitoringEncryptionKey();
  if (!key) throw new Error("MONITORING_ENCRYPTION_KEY is required");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(part => part.toString("base64url")).join(".");
}

function decryptMonitoringSecret(value) {
  const key = monitoringEncryptionKey();
  if (!key) throw new Error("MONITORING_ENCRYPTION_KEY is required");
  const [ivText, tagText, encryptedText] = String(value || "").split(".");
  if (!ivText || !tagText || !encryptedText) throw new Error("Invalid encrypted monitoring secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

function passwordHash(password, saltText = null) {
  const salt = saltText ? Buffer.from(saltText, "base64url") : randomBytes(16);
  const derived = pbkdf2Sync(String(password), salt, 210000, 32, "sha256");
  return `pbkdf2_sha256$210000$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function passwordMatches(password, stored) {
  try {
    const [algorithm, iterationsText, saltText, hashText] = String(stored || "").split("$");
    if (algorithm !== "pbkdf2_sha256") return false;
    const iterations = Number(iterationsText);
    const expected = Buffer.from(hashText, "base64url");
    const actual = pbkdf2Sync(String(password), Buffer.from(saltText, "base64url"), iterations, expected.length, "sha256");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decodeBase32(input) {
  const clean = String(input || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) bits += BASE32_ALPHABET.indexOf(ch).toString(2).padStart(5, "0");
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}

function monitoringTotp(secret, counter) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000);
  return String(code).padStart(6, "0");
}

function verifyMonitoringTotp(secret, code) {
  const normalized = String(code || "").replace(/\D/g, "");
  if (normalized.length !== 6) return false;
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let drift = -1; drift <= 1; drift += 1) {
    const expected = monitoringTotp(secret, counter + drift);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) return true;
  }
  return false;
}

async function ensureMonitoringBootstrapOperator() {
  const username = cleanText(process.env.MONITORING_ADMIN_USERNAME);
  const password = String(process.env.MONITORING_ADMIN_PASSWORD || "");
  const totpSecret = cleanText(process.env.MONITORING_ADMIN_TOTP_SECRET);
  const displayName = cleanText(process.env.MONITORING_ADMIN_DISPLAY_NAME) || username;
  if (!username || !password || !totpSecret) {
    console.warn("Monitoring Center bootstrap operator not synchronized: MONITORING_ADMIN_USERNAME, MONITORING_ADMIN_PASSWORD, and MONITORING_ADMIN_TOTP_SECRET are required.");
    return;
  }
  if (!monitoringEncryptionKey()) {
    console.warn("Monitoring Center bootstrap operator not synchronized: MONITORING_ENCRYPTION_KEY is required.");
    return;
  }

  const existing = await pool.query(`
    SELECT id, username, display_name AS "displayName", role, password_hash AS "passwordHash",
           totp_secret_encrypted AS "totpSecretEncrypted", is_active AS "isActive",
           COALESCE(is_bootstrap, FALSE) AS "isBootstrap"
    FROM monitoring_operators
    WHERE LOWER(username)=LOWER($1)
    LIMIT 1
  `, [username]);

  if (existing.rowCount === 0) {
    const id = randomUUID();
    await pool.query(`
      INSERT INTO monitoring_operators (id, username, display_name, role, password_hash, totp_secret_encrypted, is_active, is_bootstrap)
      VALUES ($1, $2, $3, 'admin', $4, $5, TRUE, TRUE)
    `, [id, username, displayName, passwordHash(password), encryptMonitoringSecret(totpSecret)]);
    console.log(`Monitoring Center bootstrap admin created: ${username}`);
    return;
  }

  const operator = existing.rows[0];
  let storedTotp = null;
  try { storedTotp = decryptMonitoringSecret(operator.totpSecretEncrypted); }
  catch (_) { storedTotp = null; }

  const credentialsChanged = !passwordMatches(password, operator.passwordHash) || storedTotp !== totpSecret;
  const profileChanged = operator.displayName !== displayName || operator.role !== "admin" || operator.isActive !== true || operator.isBootstrap !== true;

  if (!credentialsChanged && !profileChanged) return;

  await pool.query(`
    UPDATE monitoring_operators
    SET display_name=$2,
        role='admin',
        password_hash=$3,
        totp_secret_encrypted=$4,
        is_active=TRUE,
        is_bootstrap=TRUE,
        updated_at=NOW()
    WHERE id=$1
  `, [operator.id, displayName, passwordHash(password), encryptMonitoringSecret(totpSecret)]);

  if (credentialsChanged) {
    await pool.query(`DELETE FROM monitoring_sessions WHERE operator_id=$1`, [operator.id]);
  }

  console.log(`Monitoring Center bootstrap admin synchronized: ${username}${credentialsChanged ? " (credentials refreshed)" : ""}`);
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || "");
  const cookies = {};
  raw.split(";").forEach(part => {
    const idx = part.indexOf("=");
    if (idx < 0) return;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return cookies;
}

function monitoringAttemptKey(req) {
  return cleanText(req.ip || req.socket?.remoteAddress || "unknown") || "unknown";
}

function monitoringRateLimited(req) {
  const key = monitoringAttemptKey(req);
  const now = Date.now();
  const prior = monitoringLoginAttempts.get(key);
  if (!prior || now - prior.startedAt >= MONITORING_LOGIN_WINDOW_MS) {
    monitoringLoginAttempts.set(key, { startedAt: now, attempts: 0 });
    return false;
  }
  return prior.attempts >= MONITORING_LOGIN_MAX_ATTEMPTS;
}

function recordMonitoringFailure(req) {
  const key = monitoringAttemptKey(req);
  const now = Date.now();
  const prior = monitoringLoginAttempts.get(key);
  if (!prior || now - prior.startedAt >= MONITORING_LOGIN_WINDOW_MS) monitoringLoginAttempts.set(key, { startedAt: now, attempts: 1 });
  else prior.attempts += 1;
}

function clearMonitoringFailures(req) { monitoringLoginAttempts.delete(monitoringAttemptKey(req)); }

async function writeMonitoringAudit(operator, req, action, targetType = null, targetId = null, details = {}) {
  await pool.query(`
    INSERT INTO monitoring_audit_log (id, operator_id, operator_name, action, target_type, target_id, details, ip_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
  `, [randomUUID(), operator?.id || null, operator?.displayName || operator?.username || null, action, targetType, targetId, JSON.stringify(details || {}), monitoringAttemptKey(req)]);
}

async function authenticatedMonitoringOperator(req) {
  const token = parseCookies(req).gs_monitor_session;
  if (!token) return null;
  const tokenHash = hashSessionToken(token);
  const result = await pool.query(`
    SELECT o.id, o.username, o.display_name AS "displayName", o.role, s.expires_at AS "expiresAt"
    FROM monitoring_sessions s
    JOIN monitoring_operators o ON o.id=s.operator_id
    WHERE s.token_hash=$1 AND s.expires_at>NOW() AND o.is_active=TRUE
    LIMIT 1
  `, [tokenHash]);
  const operator = result.rows[0] || null;
  if (operator) pool.query(`UPDATE monitoring_sessions SET last_used_at=NOW() WHERE token_hash=$1`, [tokenHash]).catch(()=>{});
  return operator;
}

async function requireMonitoringOperator(req, res) {
  const operator = await authenticatedMonitoringOperator(req);
  if (!operator) {
    res.status(401).json({ success:false, error:"Monitoring Center sign-in required" });
    return null;
  }
  return operator;
}

function monitoringPriorityForResident(resident) {
  const action = cleanText(resident?.actionLevel).toLowerCase();
  const ai = cleanText(resident?.aiLevel).toLowerCase();
  const follow = cleanText(resident?.followUpStatus).toLowerCase();
  if (action === "immediate" || ai === "critical" || follow === "due now" || follow === "due again") return "P1";
  if (["review","watch"].includes(action) || ["warning","watch"].includes(ai)) return "P2";
  if (action === "technical" || ai === "sensor issue") return "P3";
  if (action === "observe") return "P4";
  return "P5";
}

function monitoringResidentPayload(resident) {
  const priority = monitoringPriorityForResident(resident);
  return {
    residentId: resident.residentId,
    residentName: resident.residentName,
    location: resident.location,
    priority,
    actionLevel: resident.actionLevel,
    actionTitle: resident.actionTitle,
    actionSummary: resident.actionSummary,
    actionItems: resident.actionItems,
    aiLevel: resident.aiLevel,
    aiStatus: resident.aiStatus,
    aiExplanation: resident.aiExplanation,
    aiConfidence: resident.aiConfidence,
    aiConfidenceScore: resident.aiConfidenceScore,
    followUpStatus: resident.followUpStatus,
    followUpExplanation: resident.followUpExplanation,
    followUpDueAt: resident.followUpDueAt,
    minutesUntilFollowUpDue: resident.minutesUntilFollowUpDue,
    sensorCount: resident.sensorCount,
    onlineSensorCount: resident.onlineSensorCount,
    offlineSensorCount: resident.offlineSensorCount,
    coverageStatus: resident.coverageStatus,
    coverageExplanation: resident.coverageExplanation,
    motionCountToday: resident.motionCountToday,
    motionCountLastHour: resident.motionCountLastHour,
    lastMotionAt: resident.lastMotionAt,
    lastMotionRoom: resident.lastMotionRoom,
    inactiveMinutes: resident.inactiveMinutes,
    typicalFirstActivityTime: resident.typicalFirstActivityTime,
    typicalLastActivityTime: resident.typicalLastActivityTime,
    typicalOvernightEpisodes: resident.typicalOvernightEpisodes,
    overnightEpisodesToday: resident.overnightEpisodesToday,
    baselineDayCount: resident.baselineDayCount,
    patternStatus: resident.patternStatus,
    patternExplanation: resident.patternExplanation,
    behaviorInsights: resident.behaviorInsights,
    currentPresenceRooms: resident.currentPresenceRooms,
    activePresenceDurationMinutes: resident.activePresenceDurationMinutes,
    presenceStatus: resident.presenceStatus,
    presenceExplanation: resident.presenceExplanation,
    sensors: resident.sensors,
    lastActionAt: resident.lastActionAt,
    lastActionBy: resident.lastActionBy,
    lastActionStatus: resident.lastActionStatus,
    lastActionNote: resident.lastActionNote
  };
}

const CUSTOMER_SESSION_DAYS = 180;
const CUSTOMER_CODE_WINDOW_MS = 15 * 60 * 1000;
const CUSTOMER_CODE_MAX_ATTEMPTS = 5;
const STAFF_ACCESS_CODE = normalizeAccessCode(process.env.STAFF_ACCESS_CODE) || "2468";
const customerCodeAttempts = new Map();

function hashSessionToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

function bearerToken(req) {
  const authorization = cleanText(req.header("authorization"));
  if (!authorization || !authorization.toLowerCase().startsWith("bearer ")) return null;
  return authorization.slice(7).trim() || null;
}

function normalizeAccessCode(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 4 ? digits : null;
}

async function generateUniqueResidentAccessCode() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = String(randomInt(0, 10000)).padStart(4, "0");
    if (candidate === STAFF_ACCESS_CODE) continue;
    const existing = await pool.query(`SELECT 1 FROM residents WHERE access_code = $1 LIMIT 1`, [candidate]);
    if (existing.rowCount === 0) return candidate;
  }
  throw new Error("Unable to allocate a unique 4-digit resident access code");
}

async function ensureResidentAccessCodes() {
  const missing = await pool.query(`SELECT id FROM residents WHERE access_code IS NULL OR access_code !~ '^[0-9]{4}$' ORDER BY created_at ASC`);
  for (const row of missing.rows) {
    let assigned = false;
    while (!assigned) {
      const code = await generateUniqueResidentAccessCode();
      try {
        await pool.query(`UPDATE residents SET access_code = $1 WHERE id = $2`, [code, row.id]);
        assigned = true;
      } catch (error) {
        if (error?.code !== "23505") throw error;
      }
    }
  }
}

async function authenticatedCustomerSession(req) {
  const token = bearerToken(req);
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const result = await pool.query(
    `
    SELECT
      s.resident_id AS "residentId",
      s.expires_at AS "expiresAt",
      r.name AS "residentName"
    FROM customer_sessions s
    JOIN residents r ON r.id = s.resident_id
    WHERE s.token_hash = $1
      AND s.expires_at > NOW()
      AND r.is_deleted = FALSE
    LIMIT 1
    `,
    [tokenHash]
  );

  const session = result.rows[0] || null;
  if (session) {
    pool.query(`UPDATE customer_sessions SET last_used_at = NOW() WHERE token_hash = $1`, [tokenHash]).catch(() => {});
  }
  return session;
}

async function requireCustomerSession(req, res) {
  const session = await authenticatedCustomerSession(req);
  if (!session) {
    res.status(401).json({ success: false, error: "Access code required" });
    return null;
  }
  return session;
}

function customerAttemptKey(req) {
  return cleanText(req.ip || req.socket?.remoteAddress || "unknown") || "unknown";
}

function customerCodeRateLimited(req) {
  const key = customerAttemptKey(req);
  const now = Date.now();
  const prior = customerCodeAttempts.get(key);
  if (!prior || now - prior.startedAt >= CUSTOMER_CODE_WINDOW_MS) {
    customerCodeAttempts.set(key, { startedAt: now, attempts: 0 });
    return false;
  }
  return prior.attempts >= CUSTOMER_CODE_MAX_ATTEMPTS;
}

function recordCustomerCodeFailure(req) {
  const key = customerAttemptKey(req);
  const now = Date.now();
  const prior = customerCodeAttempts.get(key);
  if (!prior || now - prior.startedAt >= CUSTOMER_CODE_WINDOW_MS) {
    customerCodeAttempts.set(key, { startedAt: now, attempts: 1 });
  } else {
    prior.attempts += 1;
    customerCodeAttempts.set(key, prior);
  }
}

function clearCustomerCodeFailures(req) {
  customerCodeAttempts.delete(customerAttemptKey(req));
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
    ...ESP32_SENSOR_COMMAND_TYPES,
    ...MONITOR_COMMAND_TYPES,
    ...WATCHDOG_COMMAND_TYPES
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
        WHEN LOWER(COALESCE(monitor_status, '')) = 'offline' THEN FALSE
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
      access_code AS "accessCode",
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
      assignment_authority AS "assignmentAuthority",
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
      assignment_authority AS "assignmentAuthority",
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
  const lookupSourceKey = isEsp32NodeId(resolvedNodeId) ? "" : resolvedSourceKey;

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
    [lookupSourceKey, resolvedNodeId]
  );

  return result.rows[0] || null;
}


async function getExistingSensorForDeviceIdentity({ sourceKey, nodeId }) {
  const resolvedSourceKey = cleanText(sourceKey);
  const resolvedNodeId = cleanText(nodeId);
  const lookupSourceKey = isEsp32NodeId(resolvedNodeId) ? "" : resolvedSourceKey;

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
    [lookupSourceKey, resolvedNodeId]
  );

  return result.rows[0] || null;
}

function sensorIsExplicitlyUnassigned(sensor) {
  if (!sensor) {
    return false;
  }

  return assignmentAuthorityProtectsServerState(sensor.assignmentAuthority) &&
    !sensor.residentId &&
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
  setupState,
  assignmentState,
  diagnostics
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
  const reportedSetup = normalizeReportedSetupState({ setupState, assignmentState, diagnostics });
  const resolvedSetupState = reportedSetup.state || normalizeSetupState(resolvedStatus);
  if (reportedSetup.disagreement) {
    logStructuredDiagnostic("ASSIGNMENT_PAYLOAD_DISAGREEMENT", "warning", {
      nodeId: resolvedNodeId, field: reportedSetup.field, state: reportedSetup.state
    });
  }

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
  diagnostics,
  assignmentPayload
}) {
  let resolvedNodeName = nodeName;
  let resolvedLocationName = locationName;
  let resolvedSetupState = setupState;
  const resolvedDiagnostics = {
    ...normalizeJsonObject(diagnostics)
  };

  const existingIdentitySensor = await getExistingSensorForDeviceIdentity({
    sourceKey: resolvedDiagnostics?.sourceKey,
    nodeId
  });
  const preserveServerAssignment = Boolean(
    existingIdentitySensor && assignmentAuthorityProtectsServerState(existingIdentitySensor.assignmentAuthority)
  );
  const preserveNodeUnassignedState = preserveServerAssignment && sensorIsExplicitlyUnassigned(existingIdentitySensor);

  if (preserveServerAssignment) {
    resolvedNodeName = existingIdentitySensor?.sourceName || "Unassigned Sensor";
    resolvedLocationName = existingIdentitySensor?.locationName || "Unassigned Location";
    resolvedSetupState = existingIdentitySensor?.setupState || "unassigned";
    resolvedDiagnostics.residentName = existingIdentitySensor?.residentName || "Unassigned";
    resolvedDiagnostics.locationName = resolvedLocationName;
    resolvedDiagnostics.roomName = existingIdentitySensor?.roomName || "";
    resolvedDiagnostics.assignmentState = resolvedSetupState === "assigned" ? "Assigned" : "Unassigned";
    resolvedDiagnostics.setupState = resolvedSetupState;
  }

  await upsertNodeFromRegistration({
    nodeId,
    nodeName: resolvedNodeName,
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
    const existingAuthority = existingSensor
      ? normalizeAssignmentAuthority(existingSensor.assignmentAuthority)
      : "never_assigned";

    // Resident/location/room assignment is server-authoritative.
    // Firmware-reported assignment metadata remains available for diagnostics,
    // but a device heartbeat/registration may never create or change ownership.
    // The authorized PATCH /sensors/:nodeId/assignment workflow is responsible
    // for committing the assignment selected during BLE setup.
    const canBootstrap = false;

    let resident = existingSensor?.residentId
      ? await getResidentForExistingDeviceIdentity({
          sourceKey: resolvedDiagnostics.sourceKey,
          nodeId
        })
      : null;

    if (!resident && canBootstrap) {
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
      sourceName: preserveServerAssignment
        ? (existingSensor?.sourceName || heartbeatSourceName)
        : heartbeatSourceName,
      sensorType:
        resolvedDiagnostics.sensorMode ||
        resolvedDiagnostics.sensorType ||
        heartbeatDeviceName,
      sensorMode: resolvedDiagnostics.sensorMode,
      resident,
      residentName: preserveServerAssignment
        ? "Unassigned"
        : (resident?.name || heartbeatResidentName),
      locationName: preserveServerAssignment
        ? "Unassigned location"
        : (resident?.location || heartbeatLocationName),
      forceUnassigned: preserveNodeUnassignedState,
      allowDeviceBootstrap: false,
      assignmentPayload: assignmentPayload || { diagnostics: resolvedDiagnostics }
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
  const ffmpegStatus = normalizeFfmpegStatusForPayload(payload, "Unknown");
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
  const reportedSetup = normalizeReportedSetupState(payload, diagnostics);
  const setupState = reportedSetup.state || "unassigned";
  if (reportedSetup.disagreement) {
    logStructuredDiagnostic("ASSIGNMENT_PAYLOAD_DISAGREEMENT", "warning", {
      nodeId, field: reportedSetup.field, state: reportedSetup.state
    });
  }
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
        WHEN LOWER(COALESCE(monitor_status, '')) = 'offline' THEN FALSE
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
      diagnostics,
      assignmentPayload: payload
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
  if (!commandOwnerFor(nodeId, commandType)) {
    throw new Error("Command type is not supported for this target");
  }
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
      access_code AS "accessCode",
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

function resolvedCanonicalSensorType(existingSensor, sensorMode, sensorType) {
  if (displaySensorTypeForValue(existingSensor?.sensorType, "") === "Motion + Presence Sensor") {
    return "Motion + Presence Sensor";
  }
  const normalizedMode = normalizedSensorModeForValue(sensorMode, "");
  if (normalizedMode) return displaySensorTypeForValue(normalizedMode, existingSensor?.sensorType || "Motion Sensor");
  return displaySensorTypeForValue(sensorType, existingSensor?.sensorType || "Motion Sensor");
}

async function resolveCanonicalEsp32Sensor(client, { nodeId, reportedSourceKey }) {
  const resolvedNodeId = cleanText(nodeId);
  const resolvedReportedKey = cleanText(reportedSourceKey);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`sensor-identity:${resolvedNodeId}`]);

  const keyOwnerResult = resolvedReportedKey
    ? await client.query(`${sensorSelectSQL()} WHERE source_key = $1 LIMIT 1`, [resolvedReportedKey])
    : { rows: [] };
  const keyOwner = keyOwnerResult.rows[0] || null;
  if (keyOwner && cleanText(keyOwner.nodeId) && cleanText(keyOwner.nodeId) !== resolvedNodeId) {
    logStructuredDiagnostic("IDENTITY_SOURCE_CONFLICT", "warning", {
      nodeId: resolvedNodeId,
      reportedSourceKey: resolvedReportedKey,
      conflictingNodeId: keyOwner.nodeId,
      conflictingSensorId: keyOwner.id
    });
  }

  const rowsResult = await client.query(
    `${sensorSelectSQL()}
     WHERE node_id = $1
     ORDER BY
       is_deleted ASC,
       CASE assignment_authority
         WHEN 'operator_explicit' THEN 0
         WHEN 'resident_deleted' THEN 1
         WHEN 'device_bootstrap' THEN 2
         WHEN 'legacy_unknown' THEN 3
         ELSE 4
       END,
       CASE WHEN resident_id IS NOT NULL OR setup_state = 'assigned' THEN 0 ELSE 1 END,
       is_active DESC,
       created_at ASC,
       id ASC
     FOR UPDATE`,
    [resolvedNodeId]
  );

  let canonical = rowsResult.rows[0] || null;
  if (!canonical && keyOwner && cleanText(keyOwner.nodeId) === resolvedNodeId) canonical = keyOwner;
  if (!canonical && keyOwner && cleanText(keyOwner.nodeId) !== resolvedNodeId) {
    throw new SensorAssignmentConflictError(`Source key is already owned by another node: ${resolvedReportedKey}`);
  }
  return { canonical, rows: rowsResult.rows, keyOwner };
}

async function releaseSourceKeyForCanonicalSensor(client, { nodeId, canonicalSensorId, sourceKey }) {
  const resolvedNodeId = cleanText(nodeId);
  const resolvedSourceKey = cleanText(sourceKey);

  if (!resolvedNodeId || !canonicalSensorId || !resolvedSourceKey) {
    return;
  }

  const ownerResult = await client.query(
    `${sensorSelectSQL()} WHERE source_key = $1 LIMIT 1 FOR UPDATE`,
    [resolvedSourceKey]
  );
  const owner = ownerResult.rows[0] || null;

  if (!owner || owner.id === canonicalSensorId) {
    return;
  }

  if (cleanText(owner.nodeId) !== resolvedNodeId) {
    throw new SensorAssignmentConflictError(`Source key is already owned by another node: ${resolvedSourceKey}`);
  }

  const retiredSourceKey = `${resolvedSourceKey}--retired-${String(owner.id).replace(/-/g, "").slice(0, 12)}`;
  await client.query(
    `UPDATE sensors
     SET source_key = $2,
         is_active = FALSE,
         is_deleted = TRUE,
         deleted_at = COALESCE(deleted_at, NOW()),
         updated_at = NOW()
     WHERE id = $1`,
    [owner.id, retiredSourceKey]
  );

  logStructuredDiagnostic("IDENTITY_ALIAS_RELEASED", "info", {
    nodeId: resolvedNodeId,
    canonicalSensorId,
    releasedSensorId: owner.id,
    reportedSourceKey: resolvedSourceKey,
    retiredSourceKey
  });
}

async function upsertSensorFromEvent({
  nodeId,
  sourceKey,
  sourceName,
  sensorType,
  sensorMode,
  resident,
  residentName,
  locationName,
  forceUnassigned = false,
  allowDeviceBootstrap = false,
  assignmentPayload = null
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

  if (isEsp32NodeId(nodeId)) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await resolveCanonicalEsp32Sensor(client, {
        nodeId,
        reportedSourceKey: resolvedSourceKey
      });
      const existing = identity.canonical;
      const existingAuthority = existing
        ? normalizeAssignmentAuthority(existing.assignmentAuthority)
        : "never_assigned";
      const canBootstrap = allowDeviceBootstrap &&
        existingAuthority === "never_assigned" &&
        isCompleteFirmwareAssignment(assignmentPayload || {});
      const protectedState = Boolean(existing && assignmentAuthorityProtectsServerState(existingAuthority));
      const assignmentAuthority = canBootstrap ? "device_bootstrap" : existingAuthority;
      const canonicalSensorType = resolvedCanonicalSensorType(existing, sensorMode, sensorType);
      const mustRemainUnassigned = forceUnassigned || (!existing && !canBootstrap);

      const nextResidentId = protectedState || (existing && !canBootstrap)
        ? existing.residentId
        : (mustRemainUnassigned ? null : (resident?.id || null));
      const nextResidentName = protectedState || (existing && !canBootstrap)
        ? existing.residentName
        : (mustRemainUnassigned ? "Unassigned" : resolvedResidentName);
      const nextLocationName = protectedState || (existing && !canBootstrap)
        ? existing.locationName
        : (mustRemainUnassigned ? "Unassigned location" : resolvedLocationName);
      const nextRoomName = protectedState || (existing && !canBootstrap)
        ? existing.roomName
        : (mustRemainUnassigned ? null : resolvedRoomName);
      const nextSetupState = nextResidentId ||
        (normalizeForMatch(nextResidentName) !== "unassigned" && cleanText(nextResidentName)) ||
        cleanText(nextRoomName)
        ? "assigned"
        : "unassigned";
      const nextSourceName = protectedState || (existing && !canBootstrap)
        ? existing.sourceName
        : resolvedSourceName;

      let result;
      if (existing) {
        await releaseSourceKeyForCanonicalSensor(client, {
          nodeId,
          canonicalSensorId: existing.id,
          sourceKey: resolvedSourceKey
        });

        result = await client.query(
          `UPDATE sensors SET
             source_key = $2,
             source_name = $3,
             sensor_type = $4,
             resident_id = $5,
             resident_name = $6,
             location_name = $7,
             room_name = $8,
             setup_state = $9,
             assignment_authority = $10,
             is_active = TRUE,
             is_deleted = FALSE,
             deleted_at = NULL,
             updated_at = NOW()
           WHERE id = $1
           ${sensorReturningSQL()}`,
          [existing.id, resolvedSourceKey, nextSourceName, canonicalSensorType, nextResidentId, nextResidentName,
            nextLocationName, nextRoomName, nextSetupState, assignmentAuthority]
        );
      } else {
        result = await client.query(
          `INSERT INTO sensors (
             id, node_id, source_key, source_name, sensor_type, resident_id, resident_name,
             location_name, room_name, setup_state, assignment_authority, is_active, is_deleted,
             deleted_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,FALSE,NULL,NOW(),NOW())
           ${sensorReturningSQL()}`,
          [randomUUID(), cleanText(nodeId), resolvedSourceKey, nextSourceName, canonicalSensorType,
            nextResidentId, nextResidentName, nextLocationName, nextRoomName, nextSetupState, assignmentAuthority]
        );
      }

      const canonical = result.rows[0];
      const retiredResult = await client.query(
        `UPDATE sensors SET
           is_active = FALSE,
           is_deleted = TRUE,
           deleted_at = COALESCE(deleted_at, NOW()),
           updated_at = NOW()
         WHERE node_id = $1 AND id <> $2 AND (is_active = TRUE OR is_deleted = FALSE)
         RETURNING id, source_key AS "sourceKey"`,
        [cleanText(nodeId), canonical.id]
      );
      if (retiredResult.rows.length > 0) {
        logStructuredDiagnostic("IDENTITY_MULTIPLE_ACTIVE", "warning", {
          nodeId: cleanText(nodeId), canonicalSensorId: canonical.id,
          canonicalSourceKey: canonical.sourceKey, aliasCount: retiredResult.rows.length
        });
        for (const retired of retiredResult.rows) {
          logStructuredDiagnostic("IDENTITY_ALIAS_RETIRED", "info", {
            nodeId: cleanText(nodeId), canonicalSensorId: canonical.id,
            canonicalSourceKey: canonical.sourceKey, retiredSensorId: retired.id,
            retiredSourceKey: retired.sourceKey, reason: "mode_alias"
          });
        }
      }
      if (protectedState && assignmentPayload) {
        const reported = normalizeReportedSetupState(assignmentPayload);
        if ((reported.present && reported.state !== existing.setupState) ||
            (cleanText(assignmentPayload?.residentName ?? assignmentPayload?.diagnostics?.residentName) &&
             normalizeForMatch(assignmentPayload?.residentName ?? assignmentPayload?.diagnostics?.residentName) !== normalizeForMatch(existing.residentName))) {
          logStructuredDiagnostic("ASSIGNMENT_SERVER_DEVICE_DISAGREEMENT", "warning", {
            nodeId: cleanText(nodeId), sensorId: canonical.id, assignmentAuthority,
            reportedState: reported.state, storedState: existing.setupState
          });
        }
      }
      await client.query("COMMIT");
      return canonical;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

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


async function findResidentForSensorAssignment(client, { residentId, residentName, locationName }) {
  const resolvedResidentId = cleanOptionalText(residentId);
  const resolvedResidentName = cleanText(residentName);
  const resolvedLocationName = cleanText(locationName) || "Unassigned location";

  if (resolvedResidentId) {
    const residentResult = await client.query(
      `
      ${residentSelectSQL()}
      WHERE id = $1
        AND is_deleted = FALSE
      FOR UPDATE
      `,
      [resolvedResidentId]
    );
    const resident = residentResult.rows[0] || null;

    if (!resident) {
      throw new SensorAssignmentConflictError(`Resident is deleted or unavailable: ${resolvedResidentId}`);
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

  const existing = await client.query(
    `
    ${residentSelectSQL()}
    WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
      AND LOWER(TRIM(location)) = LOWER(TRIM($2))
      AND is_deleted = FALSE
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE
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

  const created = await client.query(
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
      access_code AS "accessCode",
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

async function tryLockSensorAssignmentIdentity(client, identityValues) {
  const lockKeys = [...new Set(identityValues.map((value) => cleanText(value)).filter(Boolean))]
    .map((value) => `sensor-assignment:${value}`)
    .sort();

  for (const lockKey of lockKeys) {
    const result = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "acquired"`,
      [lockKey]
    );

    if (result.rows[0]?.acquired !== true) {
      throw new SensorAssignmentConflictError("Sensor assignment is being changed by another request. Refresh and try again.");
    }
  }
}

async function lockSensorIdentityForResidentDeletion(client, identityValues) {
  const lockKeys = [...new Set(identityValues.map((value) => cleanText(value)).filter(Boolean))]
    .map((value) => `sensor-assignment:${value}`)
    .sort();

  for (const lockKey of lockKeys) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey]);
  }
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

  const client = await pool.connect();
  let didBegin = false;

  try {
    await client.query("BEGIN");
    didBegin = true;

    const resident = await findResidentForSensorAssignment(client, {
      residentId,
      residentName,
      locationName
    });

    const requestedSourceKey = cleanText(sourceKey);
    await tryLockSensorAssignmentIdentity(client, [resolvedNodeId, requestedSourceKey]);

    const nodeResultForLock = await client.query(
      `
      SELECT
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName"
      FROM nodes
      WHERE node_id = $1
      FOR UPDATE
      `,
      [resolvedNodeId]
    );
    const existingNode = nodeResultForLock.rows[0] || null;

    if (!existingNode) {
      throw new Error(`Node not found: ${resolvedNodeId}`);
    }

    let existingNodeSensor = null;
    if (isEsp32NodeId(resolvedNodeId)) {
      const identity = await resolveCanonicalEsp32Sensor(client, {
        nodeId: resolvedNodeId,
        reportedSourceKey: requestedSourceKey
      });
      existingNodeSensor = identity.canonical;
    } else {
      const existingNodeSensorResult = await client.query(
        `
        ${sensorSelectSQL()}
        WHERE node_id = $1
          AND is_deleted = FALSE
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE
        `,
        [resolvedNodeId]
      );
      existingNodeSensor = existingNodeSensorResult.rows[0] || null;
    }

    if (requestedSourceKey) {
      const requestedSourceResult = await client.query(
        `
        ${sensorSelectSQL()}
        WHERE source_key = $1
          AND is_deleted = FALSE
        LIMIT 1
        FOR UPDATE
        `,
        [requestedSourceKey]
      );
      const requestedSourceSensor = requestedSourceResult.rows[0] || null;

      if (requestedSourceSensor && cleanText(requestedSourceSensor.nodeId) !== resolvedNodeId) {
        throw new SensorAssignmentConflictError(`Source identity ${requestedSourceKey} belongs to another physical node.`);
      }
    }

    const requestedSensorIdentity =
      sensorType || sensorMode || sourceName || requestedSourceKey || existingNode.nodeName || "Motion Sensor";
    const resolvedSensorMode = normalizedSensorModeForValue(requestedSensorIdentity, "motion");
    const resolvedSensorType = displaySensorTypeForValue(requestedSensorIdentity, "Motion Sensor");
    const resolvedResidentId = resident?.id || null;
    const resolvedResidentName = resident?.name || cleanText(residentName) || "Unassigned";
    const resolvedLocationName = cleanText(locationName) || resident?.location || existingNode.locationName || "Unassigned Location";
    const resolvedRoomName = cleanOptionalText(roomName);
    const resolvedSourceKey = requestedSourceKey || existingNodeSensor?.sourceKey ||
      `${sourcePrefixForSensorMode(resolvedSensorMode)}-${resolvedNodeId.replace(/^esp32-/, "")}`;
    const resolvedSourceName = cleanText(sourceName) ||
      defaultSourceNameForSensorType(resolvedSensorType, resolvedRoomName, existingNode.nodeName);
    const setupState = resolvedResidentName !== "Unassigned" || Boolean(resolvedRoomName) ? "assigned" : "unassigned";

    await tryLockSensorAssignmentIdentity(client, [resolvedSourceKey]);

    let sensorResult;
    if (existingNodeSensor) {
      await releaseSourceKeyForCanonicalSensor(client, {
        nodeId: resolvedNodeId,
        canonicalSensorId: existingNodeSensor.id,
        sourceKey: resolvedSourceKey
      });

      sensorResult = await client.query(
        `UPDATE sensors SET
           source_key = $2,
           source_name = $3,
           sensor_type = $4,
           resident_id = $5,
           resident_name = $6,
           location_name = $7,
           room_name = $8,
           setup_state = $9,
           assignment_authority = 'operator_explicit',
           is_active = TRUE,
           is_deleted = FALSE,
           deleted_at = NULL,
           updated_at = NOW()
         WHERE id = $1
         ${sensorReturningSQL()}`,
        [
          existingNodeSensor.id,
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
    } else {
      sensorResult = await client.query(
        `INSERT INTO sensors (
           id, node_id, source_key, source_name, sensor_type, resident_id, resident_name,
           location_name, room_name, setup_state, assignment_authority, is_active, is_deleted,
           deleted_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'operator_explicit',TRUE,FALSE,NULL,NOW(),NOW())
         ${sensorReturningSQL()}`,
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
    }

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
        is_archived = FALSE,
        archived_at = NULL,
        archived_reason = NULL,
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

async function prepareNodeForFactoryReset(client, nodeId) {
  const sensorResult = await client.query(
    `
    SELECT id, source_key AS "sourceKey"
    FROM sensors
    WHERE node_id = $1
    FOR UPDATE
    `,
    [nodeId]
  );

  const sensorIds = sensorResult.rows.map((row) => row.id);
  const sourceKeys = sensorResult.rows.map((row) => row.sourceKey).filter(Boolean);

  // Keep historical events, but detach them from the installation being reset.
  if (sensorIds.length > 0) {
    await client.query(
      `UPDATE motion_events SET sensor_id = NULL WHERE sensor_id = ANY($1::uuid[])`,
      [sensorIds]
    );
  }

  await client.query(`DELETE FROM sensors WHERE node_id = $1`, [nodeId]);

  if (sourceKeys.length > 0) {
    await client.query(
      `DELETE FROM device_mappings WHERE source_key = ANY($1::text[])`,
      [sourceKeys]
    );
  }

  // Remove the old live-health/assignment picture immediately. The node itself
  // is archived only while the factory-reset command is waiting for the ESP32.
  await client.query(`DELETE FROM node_health WHERE node_id = $1`, [nodeId]);
  await client.query(
    `
    UPDATE nodes
    SET
      node_name = 'Good Shepherd Local Node',
      location_name = 'Unassigned Location',
      status = 'Pending Setup',
      local_ip = NULL,
      local_config_port = NULL,
      camera_count = 0,
      camera_summary = '[]'::jsonb,
      wifi_ssid = NULL,
      wifi_rssi = NULL,
      setup_state = 'unassigned',
      is_archived = TRUE,
      archived_at = NOW(),
      archived_reason = 'Factory reset pending'
    WHERE node_id = $1
    `,
    [nodeId]
  );

  await client.query(
    `UPDATE cameras SET assigned_node_id = NULL, updated_at = NOW() WHERE assigned_node_id = $1`,
    [nodeId]
  );
}

async function finalizeSuccessfulFactoryReset(client, nodeId) {
  // The ESP32 reports success immediately before it clears NVS and reboots.
  // At that point the server can forget the old installation completely.
  const sensorResult = await client.query(
    `SELECT id, source_key AS "sourceKey" FROM sensors WHERE node_id = $1 FOR UPDATE`,
    [nodeId]
  );
  const sensorIds = sensorResult.rows.map((row) => row.id);
  const sourceKeys = sensorResult.rows.map((row) => row.sourceKey).filter(Boolean);

  if (sensorIds.length > 0) {
    await client.query(
      `UPDATE motion_events SET sensor_id = NULL WHERE sensor_id = ANY($1::uuid[])`,
      [sensorIds]
    );
  }

  await client.query(`DELETE FROM sensors WHERE node_id = $1`, [nodeId]);
  if (sourceKeys.length > 0) {
    await client.query(
      `DELETE FROM device_mappings WHERE source_key = ANY($1::text[])`,
      [sourceKeys]
    );
  }
  await client.query(`DELETE FROM node_health WHERE node_id = $1`, [nodeId]);
  await client.query(
    `UPDATE cameras SET assigned_node_id = NULL, updated_at = NOW() WHERE assigned_node_id = $1`,
    [nodeId]
  );
  await client.query(`DELETE FROM nodes WHERE node_id = $1`, [nodeId]);
}

async function createSensorCommand({ nodeId, commandType, payload, requestedBy, supersedeExisting = true }) {
  if (!isEsp32NodeId(nodeId) || !ESP32_SENSOR_COMMAND_TYPES.includes(commandType)) {
    throw new Error("ESP32 sensor command requires an esp32-* target and firmware-owned command type");
  }
  const client = await pool.connect();
  let didBegin = false;

  try {
    await client.query("BEGIN");
    didBegin = true;

    if (supersedeExisting) {
      const runningResult = await client.query(
        `
        SELECT command_id
        FROM node_commands
        WHERE node_id = $1
          AND command_type = $2
          AND status = 'running'
        ORDER BY picked_up_at DESC NULLS LAST, requested_at DESC
        LIMIT 1
        FOR UPDATE
        `,
        [nodeId, commandType]
      );

      if (runningResult.rows[0]) {
        const error = new Error(`A ${commandType} command is already running for ${nodeId}`);
        error.statusCode = 409;
        error.code = "SENSOR_COMMAND_ALREADY_RUNNING";
        throw error;
      }

      await client.query(
        `
        UPDATE node_commands
        SET
          status = 'failed',
          completed_at = NOW(),
          error = 'Superseded by newer pending sensor command'
        WHERE node_id = $1
          AND command_type = $2
          AND status = 'pending'
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

    if (commandType === "factory_reset") {
      await prepareNodeForFactoryReset(client, nodeId);
    }

    await client.query("COMMIT");
    didBegin = false;

    const command = result.rows[0];
    await publishMqttV2SensorCommand(command);
    return command;
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
  const pendingResult = await client.query(
    `
    UPDATE node_commands
    SET
      status = 'failed',
      completed_at = NOW(),
      error = 'Expired pending sensor command'
    WHERE node_id = $1
      AND command_type IN ('reconfigure', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
      AND status = 'pending'
      AND requested_at < NOW() - ($2::int * INTERVAL '1 minute')
    RETURNING command_id
    `,
    [nodeId, SENSOR_COMMAND_EXPIRATION_MINUTES]
  );

  const runningResult = await client.query(
    `
    UPDATE node_commands
    SET
      status = 'failed',
      completed_at = NOW(),
      error = 'Expired running sensor command'
    WHERE node_id = $1
      AND status = 'running'
      AND picked_up_at IS NOT NULL
      AND (
        (command_type = 'update_firmware'
          AND picked_up_at < NOW() - ($2::int * INTERVAL '1 minute'))
        OR
        (command_type IN ('identify', 'locate')
          AND picked_up_at < NOW() - ($3::int * INTERVAL '1 minute'))
        OR
        (command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping')
          AND picked_up_at < NOW() - ($4::int * INTERVAL '1 minute'))
      )
    RETURNING command_id
    `,
    [
      nodeId,
      SENSOR_COMMAND_OTA_EXECUTION_TIMEOUT_MINUTES,
      SENSOR_COMMAND_IDENTIFY_EXECUTION_TIMEOUT_MINUTES,
      SENSOR_COMMAND_EXECUTION_TIMEOUT_MINUTES
    ]
  );

  return {
    expiredPendingCount: pendingResult.rowCount || 0,
    expiredRunningCount: runningResult.rowCount || 0
  };
}

app.post("/customer/access", async (req, res) => {
  try {
    await ensureResidentAccessCodes();
    if (customerCodeRateLimited(req)) {
      return res.status(429).json({
        success: false,
        error: "Too many incorrect codes. Please wait a few minutes and try again."
      });
    }

    const accessCode = normalizeAccessCode(req.body?.code);
    if (!accessCode) {
      recordCustomerCodeFailure(req);
      return res.status(400).json({ success: false, error: "Enter the 4-digit access code." });
    }

    if (accessCode === STAFF_ACCESS_CODE) {
      clearCustomerCodeFailures(req);
      return res.status(200).json({
        success: true,
        mode: "staff"
      });
    }

    const residentResult = await pool.query(
      `${residentSelectSQL()} WHERE access_code = $1 AND is_deleted = FALSE LIMIT 1`,
      [accessCode]
    );
    const resident = residentResult.rows[0];
    if (!resident) {
      recordCustomerCodeFailure(req);
      return res.status(401).json({ success: false, error: "That access code was not recognized." });
    }

    clearCustomerCodeFailures(req);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashSessionToken(token);
    const expiresAt = new Date(Date.now() + CUSTOMER_SESSION_DAYS * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO customer_sessions (token_hash, resident_id, expires_at) VALUES ($1, $2, $3)`,
      [tokenHash, resident.id, expiresAt.toISOString()]
    );

    return res.status(200).json({
      success: true,
      mode: "customer",
      token,
      expiresAt: expiresAt.toISOString(),
      residentId: resident.id,
      residentName: resident.name
    });
  } catch (error) {
    console.error("Customer access failed:", error);
    return res.status(500).json({ success: false, error: "Unable to connect this home right now." });
  }
});

app.get("/customer/session", async (req, res) => {
  try {
    const session = await requireCustomerSession(req, res);
    if (!session) return;
    return res.status(200).json({
      success: true,
      residentId: session.residentId,
      residentName: session.residentName
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: "Session check failed" });
  }
});

app.post("/customer/logout", async (req, res) => {
  try {
    const token = bearerToken(req);
    if (token) await pool.query(`DELETE FROM customer_sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(200).json({ success: true });
  }
});

app.get("/customer/bootstrap", async (req, res) => {
  try {
    const session = await requireCustomerSession(req, res);
    if (!session) return;
    const residentId = session.residentId;

    const residentResult = await pool.query(
      `${residentSelectSQL()} WHERE id = $1 AND is_deleted = FALSE LIMIT 1`,
      [residentId]
    );
    const resident = residentResult.rows[0];
    if (!resident) return res.status(404).json({ success: false, error: "Assigned resident not found" });

    const camerasResult = await pool.query(
      `${cameraSelectSQL()} WHERE resident_id = $1 AND is_deleted = FALSE ORDER BY source_name ASC`,
      [residentId]
    );
    const eventsResult = await pool.query(
      `${eventSelectSQL()} WHERE LOWER(TRIM(resident_name)) = LOWER(TRIM($1)) ORDER BY timestamp DESC LIMIT 50`,
      [resident.name]
    );

    const { accessCode: _privateAccessCode, ...customerResident } = resident;
    return res.status(200).json({
      success: true,
      resident: customerResident,
      cameras: camerasResult.rows.map((camera) => ({ ...camera, rtspUrl: "" })),
      events: eventsResult.rows
    });
  } catch (error) {
    console.error("Customer bootstrap failed:", error);
    return res.status(500).json({ success: false, error: "Customer dashboard load failed" });
  }
});

app.get("/customer/ai/dashboard", async (req, res) => {
  try {
    const session = await requireCustomerSession(req, res);
    if (!session) return;
    const residentId = session.residentId;

    const fullSummary = await buildAIMotionSummary();
    const residents = (fullSummary.residents || []).filter((resident) => String(resident.residentId) === String(residentId));
    const summary = { ...fullSummary, residentCount: residents.length, residents };
    const briefing = buildAIBriefingFromSummary(summary);
    return res.status(200).json({
      success: true,
      generatedAt: new Date().toISOString(),
      summary,
      briefing
    });
  } catch (error) {
    console.error("Customer AI dashboard failed:", error);
    return res.status(500).json({ success: false, error: "Customer AI dashboard load failed" });
  }
});

app.get("/", async (req, res) => {
  res.json({
    success: true,
    message: "Good Shepherd webhook server is live",
    minimumIOSAppBuildForSetupWrites: MIN_IOS_APP_BUILD,
    remoteSupport: {
      enabled: true,
      nodeOfflineAfterSeconds: NODE_OFFLINE_AFTER_SECONDS,
      sensorCommandExpirationMinutes: SENSOR_COMMAND_EXPIRATION_MINUTES,
      sensorCommandExecutionTimeoutMinutes: SENSOR_COMMAND_EXECUTION_TIMEOUT_MINUTES,
      sensorCommandOtaExecutionTimeoutMinutes: SENSOR_COMMAND_OTA_EXECUTION_TIMEOUT_MINUTES,
      sensorCommandIdentifyExecutionTimeoutMinutes: SENSOR_COMMAND_IDENTIFY_EXECUTION_TIMEOUT_MINUTES,
      endpoints: [
        "GET /nodes",
        "DELETE /nodes/:nodeId",
        "POST /nodes/register",
        "GET /node-health",
        "GET /node-health/:nodeId",
        "POST /node-health",
        "POST /node-commands",
        "GET /node-commands/:nodeId/pending",
        "POST /node-commands/:commandId/result",
        "GET /node-commands/:nodeId",
        "GET /ai/dashboard",
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
        "POST /sensor-commands/:nodeId/cleanup",
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


// ---------------- Monitoring Center API ----------------
app.post("/monitoring/api/login", async (req, res) => {
  try {
    if (monitoringRateLimited(req)) return res.status(429).json({ success:false, error:"Too many sign-in attempts. Try again later." });
    const username = cleanText(req.body?.username);
    const password = String(req.body?.password || "");
    const code = String(req.body?.code || "");
    const result = await pool.query(`SELECT id, username, display_name AS "displayName", role, password_hash AS "passwordHash", totp_secret_encrypted AS "totpSecretEncrypted" FROM monitoring_operators WHERE LOWER(username)=LOWER($1) AND is_active=TRUE LIMIT 1`, [username]);
    const operator = result.rows[0];
    let valid = Boolean(operator) && passwordMatches(password, operator.passwordHash);
    if (valid) {
      try { valid = verifyMonitoringTotp(decryptMonitoringSecret(operator.totpSecretEncrypted), code); }
      catch (_) { valid = false; }
    }
    if (!valid) {
      recordMonitoringFailure(req);
      await writeMonitoringAudit(operator || null, req, "login_failed", "operator", operator?.id || username || null, {});
      return res.status(401).json({ success:false, error:"Invalid username, password, or authenticator code" });
    }
    clearMonitoringFailures(req);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + MONITORING_SESSION_HOURS * 60 * 60 * 1000);
    await pool.query(`INSERT INTO monitoring_sessions (token_hash, operator_id, expires_at, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5)`, [hashSessionToken(token), operator.id, expiresAt, monitoringAttemptKey(req), cleanText(req.header("user-agent"))]);
    await pool.query(`UPDATE monitoring_operators SET last_login_at=NOW() WHERE id=$1`, [operator.id]);
    res.cookie("gs_monitor_session", token, { httpOnly:true, secure: process.env.NODE_ENV === "production", sameSite:"lax", path:"/monitoring", maxAge: MONITORING_SESSION_HOURS * 60 * 60 * 1000 });
    await writeMonitoringAudit(operator, req, "login_success", "operator", operator.id, {});
    return res.json({ success:true, operator:{ id:operator.id, username:operator.username, displayName:operator.displayName, role:operator.role }, expiresAt });
  } catch (error) {
    console.error("Monitoring login failed:", error);
    return res.status(500).json({ success:false, error:"Monitoring Center sign-in failed" });
  }
});

app.post("/monitoring/api/logout", async (req, res) => {
  try {
    const operator = await authenticatedMonitoringOperator(req);
    const token = parseCookies(req).gs_monitor_session;
    if (token) await pool.query(`DELETE FROM monitoring_sessions WHERE token_hash=$1`, [hashSessionToken(token)]);
    if (operator) await writeMonitoringAudit(operator, req, "logout", "operator", operator.id, {});
    res.clearCookie("gs_monitor_session", { path:"/monitoring" });
    return res.json({ success:true });
  } catch (error) { return res.status(500).json({ success:false, error:"Logout failed" }); }
});

app.get("/monitoring/api/me", async (req, res) => {
  const operator = await requireMonitoringOperator(req, res); if (!operator) return;
  return res.json({ success:true, operator });
});

app.get("/monitoring/api/dashboard", async (req, res) => {
  try {
    const operator = await requireMonitoringOperator(req, res); if (!operator) return;
    const summary = await loadMonitoringSummaryFast();
    const residents = (summary.residents || []).map(monitoringResidentPayload);
    const order = { P1:1, P2:2, P3:3, P4:4, P5:5 };
    residents.sort((a,b) => (order[a.priority]-order[b.priority]) || cleanText(a.residentName).localeCompare(cleanText(b.residentName)));
    const counts = residents.reduce((acc,row)=>{ acc[row.priority]=(acc[row.priority]||0)+1; return acc; }, {P1:0,P2:0,P3:0,P4:0,P5:0});
    return res.json({ success:true, generatedAt:summary.generatedAt, operator:{id:operator.id,displayName:operator.displayName,role:operator.role}, counts, residents });
  } catch (error) {
    console.error("Monitoring dashboard failed:", error);
    return res.status(500).json({ success:false, error:"Failed to load Monitoring Center" });
  }
});

app.get("/monitoring/api/residents/:residentId", async (req, res) => {
  try {
    const operator = await requireMonitoringOperator(req, res); if (!operator) return;
    const summary = await loadMonitoringSummaryFast();
    const resident = (summary.residents || []).find(row => String(row.residentId) === String(req.params.residentId));
    if (!resident) return res.status(404).json({ success:false, error:"Resident not found" });
    await writeMonitoringAudit(operator, req, "resident_viewed", "resident", resident.residentId, { priority: monitoringPriorityForResident(resident) });
    return res.json({ success:true, generatedAt:summary.generatedAt, resident:monitoringResidentPayload(resident) });
  } catch (error) {
    console.error("Monitoring resident view failed:", error);
    return res.status(500).json({ success:false, error:"Failed to load resident operational view" });
  }
});

app.post("/monitoring/api/residents/:residentId/follow-up", async (req, res) => {
  try {
    const operator = await requireMonitoringOperator(req, res); if (!operator) return;
    const summary = await loadMonitoringSummaryFast();
    const resident = (summary.residents || []).find(row => String(row.residentId) === String(req.params.residentId));
    if (!resident) return res.status(404).json({ success:false, error:"Resident not found" });
    const note = cleanText(req.body?.note);
    const status = cleanText(req.body?.status) || "completed";
    const id = randomUUID();
    await pool.query(`INSERT INTO ai_action_logs (id,resident_id,resident_name,action_level,action_title,action_status,action_note,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, resident.residentId, resident.residentName, resident.actionLevel || "Review", resident.actionTitle || "Monitoring Center follow-up", status, note || null, operator.displayName]);
    await writeMonitoringAudit(operator, req, "follow_up_logged", "resident", resident.residentId, { actionLogId:id, status, note: note || null });
    scheduleAIDashboardRefresh();
    return res.status(201).json({ success:true, id });
  } catch (error) {
    console.error("Monitoring follow-up failed:", error);
    return res.status(500).json({ success:false, error:"Failed to log follow-up" });
  }
});

app.get("/ai/dashboard", async (req, res) => {
  try {
    let cached = null;

    try {
      cached = await loadCachedAIDashboardPayload();
    } catch (cacheReadError) {
      // A missing, unavailable, or temporarily failed cache must not take the
      // dashboard down. Fall through to the existing live calculation path.
      console.error("AI dashboard cache read failed; using live calculation:", cacheReadError);
    }

    if (cached?.payload) {
      const generatedAt = new Date(cached.generatedAt);
      const ageSeconds = Number.isNaN(generatedAt.getTime())
        ? AI_DASHBOARD_CACHE_MAX_AGE_SECONDS + 1
        : Math.max(0, Math.floor((Date.now() - generatedAt.getTime()) / 1000));

      if (ageSeconds > AI_DASHBOARD_CACHE_MAX_AGE_SECONDS) {
        refreshAIDashboardPayloadSingleFlight().catch(() => {});
      }

      res.set("Cache-Control", "private, max-age=10");
      return res.status(200).json({ ...cached.payload, cacheAgeSeconds: ageSeconds, servedFromCache: true });
    }

    const payload = await refreshAIDashboardPayloadSingleFlight();
    res.set("Cache-Control", "private, max-age=10");
    return res.status(200).json({ ...payload, cacheAgeSeconds: 0, servedFromCache: false });
  } catch (error) {
    console.error("Failed to load scalable AI dashboard:", error);
    return res.status(500).json({ success: false, error: "Failed to load AI dashboard" });
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
      await client.query("ROLLBACK");
      didBegin = false;
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
          WHEN LOWER(COALESCE(h.monitor_status, '')) = 'offline' THEN FALSE
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

    if (!commandOwnerFor(nodeId, commandType)) {
      return res.status(400).json({
        success: false,
        error: "Command type is not supported for this target"
      });
    }

    const existingNode = await getNodeById(nodeId);

    if (!existingNode) {
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    const command = isEsp32NodeId(nodeId)
      ? await createSensorCommand({
          nodeId,
          commandType,
          payload,
          requestedBy
        })
      : await createCommand({
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
    const runner = cleanText(req.query.runner).toLowerCase();
    const allowedCommandTypes = commandTypesForRunner(runner);

    if (!nodeId) {
      return res.status(400).json({
        success: false,
        error: "Missing nodeId"
      });
    }

    if (!allowedCommandTypes) {
      return res.status(400).json({
        success: false,
        error: "runner must be monitor or watchdog"
      });
    }

    if (isEsp32NodeId(nodeId)) {
      return res.status(400).json({
        success: false,
        error: "Generic runners cannot claim ESP32 sensor commands"
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
        AND command_type = ANY($2::text[])
        AND picked_up_at < NOW() - INTERVAL '5 minutes'
      `,
      [nodeId, allowedCommandTypes]
    );

    const pendingResult = await client.query(
      `
      SELECT command_id
      FROM node_commands
      WHERE node_id = $1
        AND status = 'pending'
        AND command_type = ANY($2::text[])
      ORDER BY requested_at ASC
      LIMIT 5
      FOR UPDATE SKIP LOCKED
      `,
      [nodeId, allowedCommandTypes]
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
      for (const command of commands) {
        logStructuredDiagnostic("COMMAND_CLAIM", "info", {
          commandId: command.commandId,
          nodeId,
          commandType: command.commandType,
          runner,
          route: "node-commands-pending",
          newStatus: "running",
          requestedAt: command.requestedAt,
          pickedUpAt: command.pickedUpAt
        });
      }
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

    if (!["running", "success", "failed"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Command result status must be running, success, or failed"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    const existingResult = await client.query(
      `${nodeCommandSelectSQL()} WHERE command_id = $1 FOR UPDATE`,
      [commandId]
    );
    const existingCommand = existingResult.rows[0] || null;
    if (!existingCommand) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(404).json({ success: false, error: `Command not found: ${commandId}` });
    }

    if (isTerminalCommandStatus(existingCommand.status)) {
      await client.query("COMMIT");
      didBegin = false;
      logStructuredDiagnostic("COMMAND_LATE_RESULT", "warning", {
        commandId,
        nodeId: existingCommand.nodeId,
        commandType: existingCommand.commandType,
        oldStatus: existingCommand.status,
        submittedStatus: status,
        route: "node-command-result",
        accepted: false,
        late: true
      });
      return res.status(200).json({ success: true, message: "Late command result ignored", command: existingCommand });
    }

    if (status === "running" && existingCommand.status !== "running") {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(400).json({
        success: false,
        error: "running is only valid for a command already claimed as running"
      });
    }

    const result = await client.query(
      `
      UPDATE node_commands
      SET
        status = $2,
        completed_at = CASE WHEN $2 IN ('success', 'failed') THEN NOW() ELSE NULL END,
        picked_up_at = COALESCE(picked_up_at, NOW()),
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


    await client.query("COMMIT");
    didBegin = false;
    logStructuredDiagnostic("COMMAND_RESULT", "info", {
      commandId,
      nodeId: result.rows[0].nodeId,
      commandType: result.rows[0].commandType,
      oldStatus: existingCommand.status,
      newStatus: status,
      route: "node-command-result",
      accepted: true,
      late: false
    });

    console.log("Node command result received:");
    console.log(JSON.stringify(result.rows[0], null, 2));

    return res.status(200).json({
      success: true,
      message: "Node command result saved",
      command: result.rows[0]
    });
  } catch (error) {
    if (didBegin) await client.query("ROLLBACK");
    console.error("Save node command result failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
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
  const client = await pool.connect();
  let didBegin = false;

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

    await client.query("BEGIN");
    didBegin = true;

    const nodeResult = await client.query(
      `
      SELECT
        node_id AS "nodeId",
        node_name AS "nodeName",
        location_name AS "locationName",
        status,
        is_archived AS "isArchived",
        archived_at AS "archivedAt",
        archived_reason AS "archivedReason"
      FROM nodes
      WHERE node_id = $1
      FOR UPDATE
      `,
      [nodeId]
    );

    const node = nodeResult.rows[0] || null;

    if (!node) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(404).json({
        success: false,
        error: `Node not found: ${nodeId}`
      });
    }

    // Permanent deletion is intentionally restricted to archived nodes.
    // This server-side check protects active devices even if the endpoint is
    // called directly instead of through the Command Center UI.
    if (node.isArchived !== true) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({
        success: false,
        error: "Active devices cannot be permanently deleted. Archive the device first.",
        code: "NODE_MUST_BE_ARCHIVED"
      });
    }

    const sensorResult = await client.query(
      `
      SELECT id, source_key AS "sourceKey"
      FROM sensors
      WHERE node_id = $1
      FOR UPDATE
      `,
      [nodeId]
    );

    const sensorIds = sensorResult.rows.map((row) => row.id);
    const sourceKeys = sensorResult.rows.map((row) => row.sourceKey).filter(Boolean);

    // Preserve historical motion/event rows, but detach them from sensor rows
    // before deleting the inventory identity.
    if (sensorIds.length > 0) {
      await client.query(
        `UPDATE motion_events SET sensor_id = NULL WHERE sensor_id = ANY($1::uuid[])`,
        [sensorIds]
      );
    }

    // Cameras are separate assets. If a camera happened to reference this
    // node, keep the camera and only clear the node assignment.
    await client.query(
      `UPDATE cameras SET assigned_node_id = NULL, updated_at = NOW() WHERE assigned_node_id = $1`,
      [nodeId]
    );

    const deletedCommands = await client.query(
      `DELETE FROM node_commands WHERE node_id = $1 RETURNING command_id`,
      [nodeId]
    );

    const deletedHealth = await client.query(
      `DELETE FROM node_health WHERE node_id = $1 RETURNING node_id`,
      [nodeId]
    );

    const deletedSensors = await client.query(
      `DELETE FROM sensors WHERE node_id = $1 RETURNING id, source_key AS "sourceKey"`,
      [nodeId]
    );

    // Remove mappings only for source keys owned by the deleted sensor rows.
    // Historical webhook_events remain intact for audit/history purposes.
    if (sourceKeys.length > 0) {
      await client.query(
        `DELETE FROM device_mappings WHERE source_key = ANY($1::text[])`,
        [sourceKeys]
      );
    }

    const deletedNode = await client.query(
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

    await client.query("COMMIT");
    didBegin = false;

    scheduleAIDashboardRefresh();

    return res.status(200).json({
      success: true,
      message: "Archived device permanently deleted",
      node: deletedNode.rows[0],
      cleanup: {
        sensorsDeleted: deletedSensors.rowCount || 0,
        healthRowsDeleted: deletedHealth.rowCount || 0,
        commandRowsDeleted: deletedCommands.rowCount || 0,
        historicalEventsPreserved: true
      }
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Permanent archived node delete failed:", error);
    return res.status(500).json({
      success: false,
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.get("/residents", async (req, res) => {
  try {
    await ensureResidentAccessCodes();
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
      WHERE residents.is_deleted = FALSE
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

    if (!result.rows[0]) {
      return res.status(409).json({
        success: false,
        error: `Resident ${residentId} was deleted and cannot be restored by an ordinary save request.`,
        code: "RESIDENT_RESTORE_REQUIRED"
      });
    }

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
      const deletedResidentLocation = residentResult.rows[0].location;

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
        SELECT
          id,
          node_id AS "nodeId",
          source_key AS "sourceKey"
        FROM sensors
        WHERE is_deleted = FALSE
          AND (
            resident_id = $1
            OR (
              resident_id IS NULL
              AND LOWER(TRIM(resident_name)) = LOWER(TRIM($2))
              AND LOWER(TRIM(location_name)) = LOWER(TRIM($3))
            )
          )
        ORDER BY node_id NULLS LAST, source_key
        `,
        [residentId, deletedResidentName, deletedResidentLocation]
      );

      await lockSensorIdentityForResidentDeletion(
        client,
        sensorResult.rows.flatMap((sensor) => [sensor.nodeId, sensor.sourceKey])
      );

      const unassignedSensorResult = await client.query(
        `
        UPDATE sensors
        SET
          resident_id = NULL,
          resident_name = 'Unassigned',
          location_name = 'Unassigned Location',
          room_name = NULL,
          source_name = COALESCE(NULLIF(TRIM(sensor_type), ''), 'Sensor'),
          setup_state = 'unassigned',
          assignment_authority = 'resident_deleted',
          is_active = TRUE,
          updated_at = NOW()
        WHERE is_deleted = FALSE
          AND (
            resident_id = $1
            OR (
              resident_id IS NULL
              AND LOWER(TRIM(resident_name)) = LOWER(TRIM($2))
              AND LOWER(TRIM(location_name)) = LOWER(TRIM($3))
            )
          )
        RETURNING id, node_id AS "nodeId", source_key AS "sourceKey"
        `,
        [residentId, deletedResidentName, deletedResidentLocation]
      );

      const affectedNodeIds = [...new Set(
        unassignedSensorResult.rows.map((sensor) => cleanText(sensor.nodeId)).filter(Boolean)
      )];

      if (affectedNodeIds.length > 0) {
        await client.query(
          `
          UPDATE nodes
          SET
            node_name = 'Unassigned Sensor',
            location_name = 'Unassigned Location',
            status = 'Pending Setup',
            setup_state = 'unassigned'
          WHERE node_id = ANY($1::text[])
          `,
          [affectedNodeIds]
        );

        await client.query(
          `
          UPDATE node_health
          SET
            node_name = 'Unassigned Sensor',
            location_name = 'Unassigned Location',
            setup_state = 'unassigned',
            diagnostics = COALESCE(diagnostics, '{}'::jsonb) ||
              jsonb_build_object(
                'deviceName', 'Unassigned Sensor',
                'roomName', '',
                'residentName', 'Unassigned',
                'locationName', 'Unassigned Location',
                'assignmentState', 'Unassigned',
                'setupState', 'unassigned'
              ),
            updated_at = NOW()
          WHERE node_id = ANY($1::text[])
          `,
          [affectedNodeIds]
        );
      }

      await client.query("COMMIT");

      return res.status(200).json({
        success: true,
        message: "Resident deleted",
        resident: residentResult.rows[0],
        affectedCameraCount: cameraResult.rows.length,
        affectedSensorCount: unassignedSensorResult.rows.length
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

    if (!includeArchived || !includeDeleted) {
      const excludedResult = await pool.query(`
        SELECT
          COUNT(DISTINCT n.node_id) FILTER (WHERE n.is_archived = TRUE)::int AS "archivedNodeCount",
          COUNT(s.id) FILTER (WHERE s.is_active = FALSE AND s.is_deleted = FALSE)::int AS "inactiveSensorCount",
          COUNT(s.id) FILTER (WHERE s.is_deleted = TRUE)::int AS "deletedSensorCount"
        FROM nodes n
        LEFT JOIN sensors s ON s.node_id = n.node_id
        WHERE n.node_id LIKE 'esp32-%'
      `);
      const excluded = excludedResult.rows[0] || {};
      if ((excluded.archivedNodeCount || 0) + (excluded.inactiveSensorCount || 0) + (excluded.deletedSensorCount || 0) > 0) {
        logStructuredDiagnostic("ARCHIVED_INACTIVE_EXCLUDED", "info", excluded);
      }
    }

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
          WHEN LOWER(COALESCE(h.monitor_status, '')) = 'offline' THEN FALSE
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
        AND ($2::boolean = TRUE OR (s.is_deleted = FALSE AND s.is_active = TRUE))
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
    return res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {})
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
            error: error.message,
            ...(error.code ? { code: error.code } : {})
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
        AND ($2::boolean = FALSE OR EXISTS (
          SELECT 1 FROM nodes n
          WHERE n.node_id = sensors.node_id
            AND n.is_archived = FALSE
        ))
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
        AND is_active = TRUE
        AND EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = sensors.node_id AND n.is_archived = FALSE)
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

    if (!isEsp32NodeId(nodeId)) {
      return res.status(400).json({
        success: false,
        error: "Sensor commands require an esp32-* target"
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

    const runningCommandResult = await client.query(
      `
      SELECT command_id
      FROM node_commands
      WHERE node_id = $1
        AND command_type = $2
        AND status = 'running'
      ORDER BY picked_up_at DESC NULLS LAST, requested_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [nodeId, commandType]
    );

    if (runningCommandResult.rows[0]) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(409).json({
        success: false,
        error: `A ${commandType} command is already running for ${nodeId}`,
        code: "SENSOR_COMMAND_ALREADY_RUNNING",
        runningCommandId: runningCommandResult.rows[0].command_id
      });
    }

    await client.query(
      `
      UPDATE node_commands
      SET
        status = 'failed',
        completed_at = NOW(),
        error = 'Superseded by newer pending sensor command of same type'
      WHERE node_id = $1
        AND command_type = $2
        AND status = 'pending'
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

    if (commandType === "factory_reset") {
      await prepareNodeForFactoryReset(client, nodeId);
    }

    await client.query("COMMIT");
    didBegin = false;

    const command = result.rows[0];
    const mqttDispatch = await publishMqttV2SensorCommand(command);

    return res.status(201).json({
      success: true,
      message: mqttDispatch.published
        ? `Sensor ${commandType} command published over MQTT`
        : `Sensor ${commandType} command queued; MQTT delivery pending`,
      command,
      mqttDispatch: {
        published: mqttDispatch.published,
        reason: mqttDispatch.reason || null
      }
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

app.post("/sensor-commands/:nodeId/cleanup", async (req, res) => {
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

    if (!isEsp32NodeId(nodeId)) {
      return res.status(400).json({
        success: false,
        error: "Sensor command cleanup requires an esp32-* target"
      });
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

    const cleanup = await failStaleSensorCommands(client, nodeId);

    const activeResult = await client.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS "pendingCount",
        COUNT(*) FILTER (WHERE status = 'running')::int AS "runningCount"
      FROM node_commands
      WHERE node_id = $1
        AND command_type IN ('reconfigure', 'factory_reset', 'reboot', 'ping', 'identify', 'locate', 'update_firmware')
        AND status IN ('pending', 'running')
      `,
      [nodeId]
    );

    await client.query("COMMIT");
    didBegin = false;

    const active = activeResult.rows[0] || {};
    const expiredPendingCount = cleanup.expiredPendingCount || 0;
    const expiredRunningCount = cleanup.expiredRunningCount || 0;
    const expiredTotal = expiredPendingCount + expiredRunningCount;
    const pendingCount = active.pendingCount || 0;
    const runningCount = active.runningCount || 0;

    logStructuredDiagnostic("COMMAND_QUEUE_CLEANUP", "info", {
      nodeId,
      rowCount: expiredTotal
    });

    return res.status(200).json({
      success: true,
      message: expiredTotal > 0
        ? `Cleaned ${expiredTotal} stale sensor command(s).`
        : "No stale sensor commands needed cleanup.",
      nodeId,
      expiredPendingCount,
      expiredRunningCount,
      expiredTotal,
      pendingCount,
      runningCount,
      activeCount: pendingCount + runningCount
    });
  } catch (error) {
    if (didBegin) {
      await client.query("ROLLBACK");
    }

    console.error("Sensor command cleanup failed:", error);
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

    if (!isEsp32NodeId(nodeId)) {
      return res.status(400).json({
        success: false,
        error: "Sensor pending route requires an esp32-* target"
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
        AND (
          command_type = 'factory_reset'
          OR requested_at >= NOW() - ($2::int * INTERVAL '1 minute')
        )
      ORDER BY requested_at ASC
      LIMIT 1
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
      for (const command of commands) {
        logStructuredDiagnostic("COMMAND_CLAIM", "info", {
          commandId: command.commandId,
          nodeId,
          commandType: command.commandType,
          runner: "sensor",
          route: "sensor-commands-pending",
          newStatus: "running",
          requestedAt: command.requestedAt,
          pickedUpAt: command.pickedUpAt
        });
      }
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

    if (!["running", "success", "failed"].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Command result status must be running, success, or failed"
      });
    }

    await client.query("BEGIN");
    didBegin = true;

    const existingResult = await client.query(
      `${nodeCommandSelectSQL()} WHERE command_id = $1 FOR UPDATE`,
      [commandId]
    );
    const existingCommand = existingResult.rows[0] || null;

    if (!existingCommand) {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(404).json({ success: false, error: `Command not found: ${commandId}` });
    }

    if (isTerminalCommandStatus(existingCommand.status)) {
      const sameTerminalStatus = existingCommand.status === status;
      const wasAutoExpiredRunning =
        existingCommand.status === "failed" &&
        cleanText(existingCommand.error) === "Expired running sensor command" &&
        Boolean(existingCommand.pickedUpAt);

      if (sameTerminalStatus) {
        await client.query("COMMIT");
        didBegin = false;
        return res.status(200).json({
          success: true,
          message: "Sensor command result already recorded",
          command: existingCommand
        });
      }

      if (!wasAutoExpiredRunning || status !== "success") {
        await client.query("COMMIT");
        didBegin = false;
        logStructuredDiagnostic("COMMAND_LATE_RESULT", "warning", {
          commandId,
          nodeId: existingCommand.nodeId,
          commandType: existingCommand.commandType,
          oldStatus: existingCommand.status,
          submittedStatus: status,
          route: "sensor-command-result",
          accepted: false,
          late: true
        });
        return res.status(200).json({
          success: true,
          message: "Late sensor command result ignored",
          command: existingCommand
        });
      }

      logStructuredDiagnostic("COMMAND_LATE_RESULT", "warning", {
        commandId,
        nodeId: existingCommand.nodeId,
        commandType: existingCommand.commandType,
        oldStatus: existingCommand.status,
        submittedStatus: status,
        route: "sensor-command-result",
        accepted: true,
        late: true
      });
    }

    if (status === "running" && existingCommand.status !== "running") {
      await client.query("ROLLBACK");
      didBegin = false;
      return res.status(400).json({
        success: false,
        error: "running is only valid for a command already claimed as running"
      });
    }

    const result = await client.query(
      `
      UPDATE node_commands
      SET
        status = $2,
        picked_up_at = COALESCE(picked_up_at, NOW()),
        completed_at = CASE WHEN $2 IN ('success', 'failed') THEN NOW() ELSE NULL END,
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

    const completedCommand = result.rows[0];

    if (completedCommand.commandType === "factory_reset" && status === "success") {
      await finalizeSuccessfulFactoryReset(client, completedCommand.nodeId);
    }

    await client.query("COMMIT");
    didBegin = false;
    logStructuredDiagnostic("COMMAND_RESULT", "info", {
      commandId,
      nodeId: completedCommand.nodeId,
      commandType: completedCommand.commandType,
      oldStatus: existingCommand.status,
      newStatus: status,
      route: "sensor-command-result",
      accepted: true,
      late: false
    });

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

    if (!isEsp32NodeId(nodeId)) {
      return res.status(400).json({
        success: false,
        error: "Firmware update commands require an esp32-* target"
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

    const command = await createSensorCommand({
  nodeId,
  commandType: "update_firmware",
  payload: {
    firmwareVersion,
    firmwareUrl,
    sha256
  },
  requestedBy,
  supersedeExisting: true
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
    const resolvedEventType = normalizeWebhookEventTypeFromPayload(fullWebhookPayload);
    const resolvedSensorType = normalizeWebhookSensorTypeFromPayload(fullWebhookPayload, "unknown");
    const resolvedSensorDisplayType = displaySensorTypeForValue(resolvedSensorType || sensorType || sensorMode || sourceName, "Motion Sensor");

    if (resolvedEventType === "presence_telemetry") {
      console.log("Legacy LD2410 telemetry received:");
      console.log(JSON.stringify(fullWebhookPayload, null, 2));
    }

    if (!fullWebhookPayload.eventType) {
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
    const preserveServerAssignment = Boolean(
      existingSensor && assignmentAuthorityProtectsServerState(existingSensor.assignmentAuthority)
    );
    const preserveUnassignedState = preserveServerAssignment && sensorIsExplicitlyUnassigned(existingSensor);

    let resident = existingSensor?.residentId
      ? await getResidentForExistingDeviceIdentity({
          sourceKey: resolvedSourceKey,
          nodeId: resolvedNodeId
        })
      : null;

    if (preserveUnassignedState) {
      resolvedResidentName = "Unassigned";
      resolvedLocationName = "Unassigned location";
    } else if (resident && preserveServerAssignment) {
      resolvedResidentName = resident.name;
      resolvedLocationName = resolvedLocationName || resident.location || "";
    } else {
      // Webhook free text is never an assignment authority. A new/incomplete
      // ESP32 remains never_assigned until a complete registration/heartbeat
      // bootstrap or an authorized assignment action occurs.
      if (isEsp32NodeId(resolvedNodeId)) {
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
      resident = sensor.residentId ? await getResidentById(sensor.residentId) : null;
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
      // Daily aggregation is deliberately best-effort and asynchronous.
      // The raw webhook event and motion-history record are already saved;
      // an aggregate failure must never turn a valid sensor event into HTTP 500.
      setImmediate(() => {
        incrementResidentDailyActivity({ resident, event, sensor }).catch((error) => {
          console.error("Resident daily activity aggregation failed:", {
            residentId: resident?.id || null,
            eventId: event?.id || null,
            error: error?.message || String(error)
          });
        });
      });
    }

    // Dashboard refresh is also an optimization and is already internally
    // debounced. Scheduling it must not delay the sensor webhook response.
    scheduleAIDashboardRefresh();

    acceptedWebhookCountSinceStart += 1;
    if (acceptedWebhookCountSinceStart === 1 || acceptedWebhookCountSinceStart % 100 === 0) {
      logStructuredDiagnostic("EVENT_RETENTION_DEFERRED", "info", {
        rowCount: acceptedWebhookCountSinceStart,
        reason: "request_time_deletion_disabled"
      });
    }

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


// MARK: - Good Shepherd V2 MQTT Bridge
async function postLocalV2Route(pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-webhook-secret": WEBHOOK_SECRET || ""
    },
    body: JSON.stringify(payload || {})
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Local V2 bridge ${pathname} HTTP ${response.status}` +
      (body ? ` | ${body.slice(0, 300)}` : "")
    );
  }

  return response;
}

async function markMqttNodeOffline(nodeId, payload = {}) {
  // Explicit MQTT offline must take effect immediately. Do NOT route this
  // through /node-health because /node-health intentionally refreshes
  // checked_in_at. Instead, preserve the last real check-in and set only
  // monitor_status/diagnostics.
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

  console.log("MQTT V2 node marked offline:", nodeId);
}

function mqttV2CommandTopic(nodeId) {
  return `good-shepherd/v2/nodes/${cleanText(nodeId)}/commands`;
}

function mqttV2CommandEnvelope(command) {
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

function mqttBridgeIsConnected() {
  return Boolean(mqttBridgeClient && mqttBridgeClient.connected);
}

async function publishMqttV2SensorCommand(command) {
  const commandId = cleanText(command?.commandId);
  const nodeId = cleanText(command?.nodeId);
  const commandType = normalizeEsp32SensorCommandType(command?.commandType);

  if (!commandId || !nodeId || !commandType || !isEsp32NodeId(nodeId)) {
    return { published: false, reason: "invalid_command" };
  }

  if (!mqttBridgeIsConnected()) {
    console.warn("MQTT V2 sensor command left pending: bridge not connected", {
      commandId,
      nodeId,
      commandType
    });
    return { published: false, reason: "bridge_not_connected" };
  }

  // Mark the command running BEFORE publishing. This prevents a fast ESP32
  // result from racing the database transition from pending -> running.
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

  const topic = mqttV2CommandTopic(nodeId);
  const envelope = mqttV2CommandEnvelope(claimedCommand);
  const body = JSON.stringify(envelope);

  try {
    await new Promise((resolve, reject) => {
      mqttBridgeClient.publish(topic, body, { qos: 1, retain: false }, (error) => {
        if (error) reject(error);
        else resolve();
      });
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

    console.log("MQTT V2 command published:", nodeId, commandId, commandType);
    return { published: true, topic, command: claimedCommand };
  } catch (error) {
    // If the broker publish fails, put the command back into pending so the
    // reconnect path can retry it instead of leaving a false running command.
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

    console.error("MQTT V2 command publish failed; command returned to pending:", {
      nodeId,
      commandId,
      commandType,
      error: error?.message || String(error)
    });

    return { published: false, reason: "publish_failed", error: error?.message || String(error) };
  }
}

async function dispatchPendingMqttV2SensorCommands(limit = 100) {
  if (!mqttBridgeIsConnected()) return 0;

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
      AND requested_at >= NOW() - ($2::int * INTERVAL '1 minute')
    ORDER BY requested_at ASC
    LIMIT $3
    `,
    [ESP32_SENSOR_COMMAND_TYPES, SENSOR_COMMAND_EXPIRATION_MINUTES, limit]
  );

  let publishedCount = 0;
  for (const command of result.rows) {
    const dispatch = await publishMqttV2SensorCommand(command);
    if (dispatch.published) publishedCount += 1;
  }

  if (publishedCount > 0) {
    console.log(`MQTT V2 pending command dispatch complete: ${publishedCount} command(s) published.`);
  }

  return publishedCount;
}

function normalizeMqttCommandResultStatus(value) {
  const normalized = cleanText(value).toLowerCase();

  if (["running", "success", "failed"].includes(normalized)) {
    return normalized;
  }

  return "";
}

async function ingestMqttV2Status(nodeId, payload) {
  await postLocalV2Route("/nodes/register", {
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
    await postLocalV2Route("/node-health", {
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
        mqttProtocolVersion: payload.protocolVersion || "2.0"
      }
    });

    console.log("MQTT V2 status ingested:", nodeId, "online");
    return;
  }

  if (payload.online === false) {
    await markMqttNodeOffline(nodeId, payload);
    console.log("MQTT V2 status ingested:", nodeId, "offline");
    return;
  }

  console.log("MQTT V2 status ingested:", nodeId, "status-without-online-flag");
}

async function ingestMqttV2Event(nodeId, payload) {
  await postLocalV2Route("/webhook", {
    ...payload,
    nodeId
  });

  console.log(
    "MQTT V2 event ingested:",
    nodeId,
    payload.eventType || "event"
  );
}

async function ingestMqttV2Result(nodeId, payload) {
  const commandId = cleanText(payload?.commandId);
  const status = normalizeMqttCommandResultStatus(payload?.status);

  if (!commandId) {
    console.warn("MQTT V2 result ignored: missing commandId", { nodeId });
    return;
  }

  // Ignore malformed/unsupported statuses without corrupting the durable command queue.
  if (!status) {
    console.warn("MQTT V2 nonterminal/unsupported result:", {
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

  await postLocalV2Route(
    `/sensor-commands/${encodeURIComponent(commandId)}/result`,
    {
      status,
      result: resultPayload,
      error: status === "failed"
        ? (cleanText(payload?.message) || "MQTT command failed")
        : null
    }
  );

  console.log("MQTT V2 command result ingested:", nodeId, commandId, status);
}

function startMqttV2Bridge() {
  if (!MQTT_BRIDGE_ENABLED) {
    console.log("Good Shepherd V2 MQTT bridge disabled by MQTT_BRIDGE_ENABLED.");
    return;
  }

  if (!WEBHOOK_SECRET) {
    console.warn("Good Shepherd V2 MQTT bridge not started: WEBHOOK_SECRET is missing.");
    return;
  }

  mqttBridgeClient = mqtt.connect(`mqtts://${MQTT_HOST}:${MQTT_PORT}`, {
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    clean: true,
    clientId: `good-shepherd-server-${randomUUID().slice(0,8)}`
  });

  mqttBridgeClient.on("connect", () => {
    console.log(
      `Good Shepherd V2 MQTT bridge ${MQTT_BRIDGE_VERSION} connected to ` +
      `${MQTT_HOST}:${MQTT_PORT}`
    );

    mqttBridgeClient.subscribe(
      [
        "good-shepherd/v2/nodes/+/status",
        "good-shepherd/v2/nodes/+/events",
        "good-shepherd/v2/nodes/+/results"
      ],
      { qos: 1 },
      (error, granted) => {
        if (error) {
          console.error("Good Shepherd V2 MQTT subscribe failed:", error.message);
          return;
        }

        console.log(
          "Good Shepherd V2 MQTT subscriptions active:",
          (granted || []).map(item => item.topic).join(", ")
        );
      }
    );

    // Commands created while Render or the broker was reconnecting remain
    // durable in Postgres as pending. Publish them as soon as the bridge is live.
    dispatchPendingMqttV2SensorCommands().catch((error) => {
      console.error("MQTT V2 pending command dispatch failed:", error.message);
    });
  });

  mqttBridgeClient.on("reconnect", () => {
    console.log("Good Shepherd V2 MQTT bridge reconnecting...");
  });

  mqttBridgeClient.on("offline", () => {
    console.warn("Good Shepherd V2 MQTT bridge client is offline.");
  });

  mqttBridgeClient.on("message", (topic, raw) => {
    let payload;

    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch (error) {
      console.error("MQTT V2 parse failed:", topic, error.message);
      return;
    }

    const parts = topic.split("/");
    const nodeId = cleanText(payload?.nodeId || parts[3]);
    const channel = cleanText(parts[4]).toLowerCase();

    if (!nodeId) {
      console.warn("MQTT V2 message ignored: no nodeId", topic);
      return;
    }

    Promise.resolve()
      .then(async () => {
        if (channel === "status") {
          await ingestMqttV2Status(nodeId, payload);
          return;
        }

        if (channel === "events") {
          await ingestMqttV2Event(nodeId, payload);
          return;
        }

        if (channel === "results") {
          await ingestMqttV2Result(nodeId, payload);
          return;
        }

        console.warn("MQTT V2 unknown channel ignored:", topic);
      })
      .catch(error => {
        console.error(
          "MQTT V2 bridge handling failed:",
          topic,
          error.message
        );
      });
  });

  mqttBridgeClient.on("error", error => {
    console.error("Good Shepherd V2 MQTT bridge error:", error.message);
  });
}

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Good Shepherd webhook server running on port ${PORT}`);
      startMqttV2Bridge();
      console.log(`Minimum iOS app build for resident/camera writes: ${MIN_IOS_APP_BUILD}`);
      console.log(`Remote support node health enabled. Offline after ${NODE_OFFLINE_AFTER_SECONDS} seconds.`);
      console.log("Remote node command queue enabled.");
      console.log("ESP32 OTA firmware update command support enabled.");
      console.log("Scalable persisted AI dashboard cache enabled.");
      setImmediate(() => {
        runResidentActivityBackfill().catch(() => {});
      });
      scheduleAIDashboardRefresh();
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
