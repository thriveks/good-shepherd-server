"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadRuntimeConfig,
  runtimeConfigurationIssues
} = require("../../config/runtimeConfig");

test("production configuration fails closed when security settings are missing", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "production",
    MQTT_BRIDGE_ENABLED: "false"
  });

  assert.deepEqual(runtimeConfigurationIssues(config), [
    "WEBHOOK_SECRET is required in production",
    "STAFF_ACCESS_CODE must be a 4-digit value in production"
  ]);
  assert.equal(config.webhookSecret, null);
  assert.equal(config.staffAccessCode, null);
});

test("MQTT bridge requires explicit credentials when enabled", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "development",
    MQTT_BRIDGE_ENABLED: "true"
  });

  assert.deepEqual(runtimeConfigurationIssues(config), [
    "MQTT_HOST is required when MQTT bridge is enabled",
    "MQTT_USERNAME is required when MQTT bridge is enabled",
    "MQTT_PASSWORD is required when MQTT bridge is enabled"
  ]);
});

test("valid production configuration has no startup issues", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "PRODUCTION",
    PORT: "4000",
    WEBHOOK_SECRET: "configured-secret",
    STAFF_ACCESS_CODE: "1357",
    MQTT_BRIDGE_ENABLED: "true",
    MQTT_HOST: "broker.example.test",
    MQTT_PORT: "8883",
    MQTT_USERNAME: "good-shepherd",
    MQTT_PASSWORD: "configured-password"
  });

  assert.equal(config.isProduction, true);
  assert.equal(config.port, 4000);
  assert.equal(config.mqtt.port, 8883);
  assert.deepEqual(runtimeConfigurationIssues(config), []);
});

test("database execution timeouts are bounded and configurable", () => {
  const defaults = loadRuntimeConfig({
    NODE_ENV: "test",
    MQTT_BRIDGE_ENABLED: "false"
  });

  assert.equal(
    defaults.database.statementTimeoutMs,
    30000
  );

  assert.equal(
    defaults.database.queryTimeoutMs,
    35000
  );

  const configured = loadRuntimeConfig({
    NODE_ENV: "test",
    MQTT_BRIDGE_ENABLED: "false",
    DATABASE_STATEMENT_TIMEOUT_MS: "45000",
    DATABASE_QUERY_TIMEOUT_MS: "50000"
  });

  assert.equal(
    configured.database.statementTimeoutMs,
    45000
  );

  assert.equal(
    configured.database.queryTimeoutMs,
    50000
  );
});
