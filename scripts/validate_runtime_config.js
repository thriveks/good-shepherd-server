"use strict";

const {
  loadRuntimeConfig,
  runtimeConfigurationIssues
} = require("../config/runtimeConfig");

const config = loadRuntimeConfig(process.env);
const issues = runtimeConfigurationIssues(config);

if (issues.length) {
  console.error("Good Shepherd runtime configuration is invalid:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
} else {
  console.log("PASS: Good Shepherd runtime configuration is valid.");
  console.log(`NODE_ENV=${config.nodeEnv}`);
  console.log(`MQTT_BRIDGE_ENABLED=${config.mqtt.enabled ? "true" : "false"}`);
  console.log(`PORT=${config.port}`);
}
