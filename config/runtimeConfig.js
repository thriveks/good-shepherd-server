"use strict";

function cleanEnv(value) {
  return String(value ?? "").trim();
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : fallback;
}

function readBoolean(value, fallback = false) {
  const normalized = cleanEnv(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function readFourDigitCode(value) {
  const candidate = cleanEnv(value);
  return /^\d{4}$/.test(candidate) ? candidate : null;
}

function loadRuntimeConfig(env = process.env) {
  const nodeEnv = cleanEnv(env.NODE_ENV).toLowerCase() || "development";
  const isProduction = nodeEnv === "production";

  const config = {
    nodeEnv,
    isProduction,
    port: readPositiveInteger(env.PORT, 3000),

    webhookSecret: cleanEnv(env.WEBHOOK_SECRET) || null,
    serviceApiSecret: cleanEnv(env.SERVICE_API_SECRET) || null,
    staffAccessCode: readFourDigitCode(env.STAFF_ACCESS_CODE),

    database: {
      statementTimeoutMs: readPositiveInteger(
        env.DATABASE_STATEMENT_TIMEOUT_MS,
        30000
      ),
      queryTimeoutMs: readPositiveInteger(
        env.DATABASE_QUERY_TIMEOUT_MS,
        35000
      )
    },

    mqtt: {
      enabled: readBoolean(env.MQTT_BRIDGE_ENABLED, true),
      host: cleanEnv(env.MQTT_HOST) || null,
      port: readPositiveInteger(env.MQTT_PORT, 8883),
      username: cleanEnv(env.MQTT_USERNAME) || null,
      password: cleanEnv(env.MQTT_PASSWORD) || null
    }
  };

  return config;
}

function runtimeConfigurationIssues(config) {
  const issues = [];

  if (config.isProduction && !config.webhookSecret) {
    issues.push("WEBHOOK_SECRET is required in production");
  }

  if (config.isProduction && !config.staffAccessCode) {
    issues.push("STAFF_ACCESS_CODE must be a 4-digit value in production");
  }

  if (config.mqtt.enabled) {
    if (!config.mqtt.host) issues.push("MQTT_HOST is required when MQTT bridge is enabled");
    if (!config.mqtt.username) issues.push("MQTT_USERNAME is required when MQTT bridge is enabled");
    if (!config.mqtt.password) issues.push("MQTT_PASSWORD is required when MQTT bridge is enabled");
  }

  return issues;
}

module.exports = {
  cleanEnv,
  readPositiveInteger,
  readBoolean,
  readFourDigitCode,
  loadRuntimeConfig,
  runtimeConfigurationIssues
};
