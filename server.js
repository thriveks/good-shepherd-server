const express = require("express");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_EVENTS = 50;

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

app.post("/webhook", async (req, res) => {
  try {
    const { randomUUID } = require("crypto");
    const { sourceName, residentName, message, alertLevel, timeText } = req.body || {};

    if (!sourceName || !residentName || !message || !alertLevel) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: sourceName, residentName, message, alertLevel"
      });
    }

    const event = {
      id: randomUUID(),
      sourceName: String(sourceName).trim(),
      residentName: String(residentName).trim(),
      message: String(message).trim(),
      alertLevel: String(alertLevel).trim(),
      timeText: String(timeText || "Webhook Event").trim(),
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