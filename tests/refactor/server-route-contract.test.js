"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const expectedRoutes = require("./expected-routes.json");

test("server can be required without opening database/network and preserves route surface", () => {
  const routes = [];
  const app = {
    use() {},
    listen() {
      throw new Error("listen must not run while server module is required");
    }
  };

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    app[method] = (route) => {
      routes.push([method.toUpperCase(), route]);
      return app;
    };
  }

  function express() {
    return app;
  }

  express.json = () => (_req, _res, next) => next?.();
  express.static = () => (_req, _res, next) => next?.();

  class Pool {
    query() {
      throw new Error("database query must not run during require-time contract test");
    }
    connect() {
      throw new Error("database connect must not run during require-time contract test");
    }
  }

  const mqtt = {
    connect() {
      throw new Error("MQTT connect must not run during require-time contract test");
    }
  };

  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "express") return express;
    if (request === "pg") return { Pool };
    if (request === "mqtt") return mqtt;
    return originalLoad.call(this, request, parent, isMain);
  };

  const oldNodeEnv = process.env.NODE_ENV;
  const oldMqttEnabled = process.env.MQTT_BRIDGE_ENABLED;
  process.env.NODE_ENV = "test";
  process.env.MQTT_BRIDGE_ENABLED = "false";

  try {
    const target = path.resolve(__dirname, "../../server.js");
    delete require.cache[target];
    const loaded = require(target);

    assert.equal(loaded.app, app);
    assert.equal(typeof loaded.startServer, "function");
  } finally {
    Module._load = originalLoad;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
    if (oldMqttEnabled === undefined) delete process.env.MQTT_BRIDGE_ENABLED;
    else process.env.MQTT_BRIDGE_ENABLED = oldMqttEnabled;
  }

  routes.sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
  assert.deepEqual(routes, expectedRoutes);
});
