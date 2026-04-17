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

    let resolvedSourceName = sourceName ? String(sourceName).trim() : "";
    let resolvedResidentName = residentName ? String(residentName).trim() : "";
    let resolvedAlertLevel = alertLevel ? String(alertLevel).trim() : "";
    let resolvedTimeText = timeText ? String(timeText).trim() : "";
    let resolvedSourceKey = sourceKey ? String(sourceKey).trim() : "";

    if (resolvedSourceKey) {
      const mapping = await getDeviceMapping(resolvedSourceKey);

      if (!mapping) {
        return res.status(400).json({
          success: false,
          error: `Unknown sourceKey: ${resolvedSourceKey}`
        });
      }

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

    if (!resolvedSourceName || !resolvedResidentName || !resolvedAlertLevel) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields after mapping resolution: sourceName, residentName, alertLevel"
      });
    }

    const event = {
      id: randomUUID(),
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
        source_name,
        resident_name,
        message,
        alert_level,
        time_text,
        timestamp
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        event.id,
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