"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("MQTT bridge preserves same-node ordering while allowing cross-node concurrency", async () => {
  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.connected = true;
    }
    subscribe(_topics, _options, callback) {
      callback?.(null, []);
    }
    publish(_topic, _body, _options, callback) {
      callback?.(null);
    }
    end() {}
  }

  const fakeClient = new FakeClient();
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "mqtt") {
      return { connect: () => fakeClient };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let createMqttV2Bridge;
  try {
    delete require.cache[require.resolve("../../realtime/mqttV2Bridge")];
    ({ createMqttV2Bridge } = require("../../realtime/mqttV2Bridge"));
  } finally {
    Module._load = originalLoad;
  }

  const timeline = [];
  const bridge = createMqttV2Bridge({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    mqttConfig: {
      enabled: true,
      host: "broker.test",
      port: 8883,
      username: "user",
      password: "pass"
    },
    nodeOfflineAfterSeconds: 900,
    esp32SensorCommandTypes: ["test"],
    sensorCommandOtaPendingExpirationMinutes: 120,
    sensorCommandExpirationMinutes: 15,
    cleanText: (value) => value ? String(value).trim() : "",
    normalizeJsonObject: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {},
    normalizeEsp32SensorCommandType: (value) => value || "",
    isEsp32NodeId: () => true,
    readPayloadBoolean: () => null,
    logStructuredDiagnostic() {},
    upsertNodeFromRegistration: async () => ({}),
    upsertNodeHealth: async () => ({}),
    processWebhookEvent: async (payload) => {
      timeline.push(`start:${payload.nodeId}:${payload.sequence}`);
      if (payload.sequence === 1) await delay(35);
      timeline.push(`end:${payload.nodeId}:${payload.sequence}`);
      return {};
    },
    saveSensorCommandResult: async () => ({ statusCode: 200, message: "ok" }),
    logger: { log() {}, warn() {}, error() {} }
  });

  assert.equal(bridge.start(), true);

  fakeClient.emit(
    "message",
    "good-shepherd/v2/nodes/esp32-a/events",
    Buffer.from(JSON.stringify({ nodeId: "esp32-a", sequence: 1, eventType: "motion", message: "motion" }))
  );
  fakeClient.emit(
    "message",
    "good-shepherd/v2/nodes/esp32-a/events",
    Buffer.from(JSON.stringify({ nodeId: "esp32-a", sequence: 2, eventType: "motion", message: "motion" }))
  );
  fakeClient.emit(
    "message",
    "good-shepherd/v2/nodes/esp32-b/events",
    Buffer.from(JSON.stringify({ nodeId: "esp32-b", sequence: 3, eventType: "motion", message: "motion" }))
  );

  await delay(100);

  const a1End = timeline.indexOf("end:esp32-a:1");
  const a2Start = timeline.indexOf("start:esp32-a:2");
  const b3End = timeline.indexOf("end:esp32-b:3");

  assert.ok(a1End >= 0 && a2Start > a1End, `same-node order violated: ${timeline.join(", ")}`);
  assert.ok(b3End >= 0 && b3End < a1End, `cross-node work did not run concurrently: ${timeline.join(", ")}`);
  assert.equal(bridge.getPendingNodeChainCount(), 0);

  bridge.stop();
});
