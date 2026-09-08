"use strict";

const labeledEventCaptureV1Migration =
  require(
    "./migrations/2026-09-08-human-presence-labeled-event-capture-v1"
  );

const longitudinalInterpretationValidationV1Migration =
  require(
    "./migrations/2026-09-08-human-presence-longitudinal-interpretation-validation-v1"
  );

const nonOperationalInterpretationV1Migration =
  require(
    "./migrations/2026-09-08-human-presence-non-operational-interpretation-v1"
  );

const candidateInterpretationRulesV1Migration =
  require(
    "./migrations/2026-09-07-human-presence-candidate-interpretation-rules-v1"
  );

const { Pool } = require("pg");

const {
  SCHEMA_BASELINE_VERSION,
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES
} = require("./migrations/schema_requirements");

const episodeProfilePatternAnalysisV1Migration =
  require("./migrations/2026-09-07-human-presence-episode-profile-pattern-analysis-v1");

const episodeProfilePatternBackfillV1Migration =
  require("./migrations/2026-09-07-human-presence-episode-profile-pattern-backfill-v1");

const episodeProfileTemporalContextAnalysisV1Migration =
  require("./migrations/2026-09-07-human-presence-episode-profile-temporal-context-analysis-v1");

const episodeProfileTemporalContextBackfillV1Migration =
  require("./migrations/2026-09-07-human-presence-episode-profile-temporal-context-backfill-v1");

const temporalContextDataSufficiencyV1Migration =
  require("./migrations/2026-09-07-human-presence-temporal-context-data-sufficiency-v1");

const temporalContextDataSufficiencyBackfillV1Migration =
  require("./migrations/2026-09-07-human-presence-temporal-context-data-sufficiency-backfill-v1");

const episodeProfileChainRecoveryV1Migration =
  require("./migrations/2026-09-07-human-presence-episode-profile-chain-recovery-v1");

if (!process.env.DATABASE_URL) {
  console.error(
    "Good Shepherd database migration failed: DATABASE_URL is required"
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

function setFromRows(rows, selector) {
  return new Set(rows.map(selector));
}

async function verifyExistingProductionSchema(client) {
  const [tableResult, columnResult, indexResult] =
    await Promise.all([
      client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
      `),

      client.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `),

      client.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = 'public'
      `)
    ]);

  const existingTables =
    setFromRows(
      tableResult.rows,
      (row) => row.table_name
    );

  const existingColumns =
    setFromRows(
      columnResult.rows,
      (row) => `${row.table_name}.${row.column_name}`
    );

  const existingIndexes =
    setFromRows(
      indexResult.rows,
      (row) => row.indexname
    );

  const missingTables =
    REQUIRED_TABLES.filter(
      (table) => !existingTables.has(table)
    );

  const missingColumns =
    REQUIRED_COLUMNS
      .map(([table, column]) => `${table}.${column}`)
      .filter(
        (key) => !existingColumns.has(key)
      );

  const missingIndexes =
    REQUIRED_INDEXES.filter(
      (index) => !existingIndexes.has(index)
    );

  if (
    missingTables.length ||
    missingColumns.length ||
    missingIndexes.length
  ) {
    const error = new Error(
      [
        "Existing database does not satisfy",
        `baseline ${SCHEMA_BASELINE_VERSION}.`,
        `Missing tables: ${missingTables.join(", ") || "none"}.`,
        `Missing columns: ${missingColumns.join(", ") || "none"}.`,
        `Missing indexes: ${missingIndexes.join(", ") || "none"}.`
      ].join(" ")
    );

    error.code = "SCHEMA_BASELINE_MISMATCH";
    throw error;
  }

  return {
    tables: REQUIRED_TABLES.length,
    columns: REQUIRED_COLUMNS.length,
    indexes: REQUIRED_INDEXES.length
  };
}

async function applyVersionedMigration(
  client,
  migration
) {
  const existing = await client.query(
    `
      SELECT version
      FROM schema_migrations
      WHERE version = $1
      LIMIT 1
    `,
    [migration.VERSION]
  );

  if (existing.rowCount === 1) {
    console.log(
      `Migration ${migration.VERSION} already applied.`
    );
    return;
  }

  console.log(
    `Applying migration ${migration.VERSION}.`
  );

  await client.query("BEGIN");

  try {
    await migration.up(client);

    await client.query(
      `
        INSERT INTO schema_migrations (
          version,
          description
        )
        VALUES ($1, $2)
      `,
      [
        migration.VERSION,
        migration.DESCRIPTION
      ]
    );

    await client.query("COMMIT");

    console.log(
      `Applied migration ${migration.VERSION}.`
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    throw error;
  }
}

async function runMigrations() {
  const client = await pool.connect();

  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '120s'");

    console.log(
      "Good Shepherd database migration starting."
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const existing =
      await client.query(
        `
          SELECT version
          FROM schema_migrations
          WHERE version = $1
          LIMIT 1
        `,
        [SCHEMA_BASELINE_VERSION]
      );

    if (existing.rowCount === 0) {
      console.log(
        `Verifying existing schema before establishing ${SCHEMA_BASELINE_VERSION}.`
      );

      const verified =
        await verifyExistingProductionSchema(client);

      console.log(
        `Schema verified: ${verified.tables} tables, ` +
        `${verified.columns} columns, ` +
        `${verified.indexes} indexes.`
      );

      await client.query(
        `
          INSERT INTO schema_migrations (
            version,
            description
          )
          VALUES ($1, $2)
          ON CONFLICT (version) DO NOTHING
        `,
        [
          SCHEMA_BASELINE_VERSION,
          "Existing Good Shepherd production schema verified and baselined"
        ]
      );

      console.log(
        `Established schema baseline ${SCHEMA_BASELINE_VERSION}.`
      );
    } else {
      console.log(
        `Schema baseline ${SCHEMA_BASELINE_VERSION} already applied.`
      );
    }

    await applyVersionedMigration(
      client,
      episodeProfilePatternAnalysisV1Migration
    );

    await applyVersionedMigration(
      client,
      episodeProfilePatternBackfillV1Migration
    );

    await applyVersionedMigration(
      client,
      episodeProfileTemporalContextAnalysisV1Migration
    );

    await applyVersionedMigration(
      client,
      episodeProfileTemporalContextBackfillV1Migration
    );

    await applyVersionedMigration(
      client,
      temporalContextDataSufficiencyV1Migration
    );

    await applyVersionedMigration(
      client,
      temporalContextDataSufficiencyBackfillV1Migration
    );

    await applyVersionedMigration(
      client,
      episodeProfileChainRecoveryV1Migration
    );

    await applyVersionedMigration(
      client,
      candidateInterpretationRulesV1Migration
    );

    await applyVersionedMigration(
      client,
      nonOperationalInterpretationV1Migration
    );

    await applyVersionedMigration(
      client,
      longitudinalInterpretationValidationV1Migration
    );

    await applyVersionedMigration(
      client,
      labeledEventCaptureV1Migration
    );

    /*
     * Future schema changes belong here as explicit,
     * versioned one-time migrations.
     *
     * Historical CREATE/ALTER/INDEX statements are intentionally
     * NOT rerun on every deployment.
     */

    console.log(
      "Good Shepherd database migration completed."
    );
  } finally {
    client.release();
  }
}

runMigrations()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(
      "Good Shepherd database migration failed:",
      error
    );

    try {
      await pool.end();
    } catch (_) {}

    process.exit(1);
  });
