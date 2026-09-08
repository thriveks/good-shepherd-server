"use strict";

const { Pool } = require("pg");

const {
  VERSION,
  persistForLabeledEvent
} = require("../lib/human_presence_labeled_event_matching_validation_persistence_v1");

async function run(client) {
  const eligible = await client.query(
    `
      SELECT l.labeled_event_id
      FROM human_presence_labeled_events l
      LEFT JOIN human_presence_labeled_event_matching_validations m
        ON m.labeled_event_id = l.labeled_event_id
       AND m.matching_validation_version = $1
      WHERE l.ground_truth_only = TRUE
        AND l.sensor_derived = FALSE
        AND m.labeled_event_id IS NULL
      ORDER BY l.started_at ASC, l.labeled_event_id ASC
    `,
    [VERSION]
  );

  let persisted = 0;

  for (const row of eligible.rows) {
    await persistForLabeledEvent(
      client,
      row.labeled_event_id
    );
    persisted += 1;
  }

  return {
    eligible: eligible.rowCount,
    persisted
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await run(client);

    await client.query("COMMIT");

    console.log(
      `LABELED_EVENT_MATCHING_BACKFILL_ELIGIBLE=${result.eligible}`
    );
    console.log(
      `LABELED_EVENT_MATCHING_BACKFILL_PERSISTED=${result.persisted}`
    );
    console.log("LABELED_EVENT_MATCHING_BACKFILL=PASS");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  run
};
