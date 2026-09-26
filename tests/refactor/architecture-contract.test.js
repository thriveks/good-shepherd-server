"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("server source contains no hardcoded MQTT or staff-access fallback", () => {
  const source = read("server.js");
  const runtimeConfig = read("config/runtimeConfig.js");
  const combined = `${source}\n${runtimeConfig}`;

  assert.doesNotMatch(combined, /MQTT_PASSWORD\s*\|\|\s*["'][^"']+["']/);
  assert.doesNotMatch(combined, /MQTT_USERNAME\s*\|\|\s*["'][^"']+["']/);
  assert.doesNotMatch(combined, /STAFF_ACCESS_CODE\s*\|\|\s*["']\d{4}["']/);
});

test("MQTT device path no longer loops back through localhost HTTP", () => {
  const server = read("server.js");
  const bridge = read("realtime/mqttV2Bridge.js");

  assert.doesNotMatch(server, /postLocalV2Route/);
  assert.doesNotMatch(bridge, /postLocalV2Route/);
  assert.doesNotMatch(bridge, /127\.0\.0\.1|localhost/);
  assert.match(bridge, /processWebhookEvent/);
  assert.match(bridge, /saveSensorCommandResult/);
});

test("latest Human Presence dashboard lookups have a versioned index migration", async () => {
  const migration = require(
    "../../scripts/migrations/2026-09-26-human-presence-latest-resident-indexes-v1"
  );
  const sql = [];

  await migration.up({
    query(text) {
      sql.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
  });

  assert.equal(sql.length, 1);
  assert.match(sql[0], /authoritative_resident_id[\s\S]*non_operational_interpretation_at DESC/);
  assert.match(sql[0], /authoritative_resident_id[\s\S]*longitudinal_interpretation_validation_at DESC/);
});
