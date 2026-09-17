"use strict";

const VERSION = "2026-09-17-node-setup-id-v1";
const DESCRIPTION =
  "Persist ESP32 BLE setup identifiers for physical first-resident sensor activation";

async function up(client) {
  await client.query(`
    ALTER TABLE nodes
    ADD COLUMN IF NOT EXISTS setup_id TEXT
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_nodes_setup_id
    ON nodes (setup_id)
    WHERE setup_id IS NOT NULL
  `);
}

module.exports = {
  VERSION,
  DESCRIPTION,
  up
};
