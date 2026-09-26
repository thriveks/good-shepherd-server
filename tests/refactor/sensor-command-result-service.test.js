"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createSensorCommandResultService
} = require("../../services/sensorCommandResultService");

function makeHarness(existingCommand, completedCommand = null) {
  const calls = [];
  const diagnostics = [];
  const resetNodes = [];

  const client = {
    async query(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      calls.push({ sql: normalized, params });

      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [] };
      }

      if (normalized.includes("WHERE command_id = $1 FOR UPDATE")) {
        return { rows: existingCommand ? [existingCommand] : [] };
      }

      if (normalized.startsWith("UPDATE node_commands")) {
        return { rows: completedCommand ? [completedCommand] : [] };
      }

      throw new Error(`Unexpected SQL in test: ${normalized}`);
    },
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    }
  };

  const pool = {
    async connect() {
      return client;
    }
  };

  const service = createSensorCommandResultService({
    pool,
    nodeCommandSelectSQL: () => "SELECT command_id FROM node_commands",
    isTerminalCommandStatus: (status) => ["success", "failed"].includes(status),
    cleanText: (value) => String(value ?? "").trim(),
    logStructuredDiagnostic: (...args) => diagnostics.push(args),
    finalizeSuccessfulFactoryReset: async (_client, nodeId) => {
      resetNodes.push(nodeId);
    }
  });

  return { service, calls, diagnostics, resetNodes };
}

test("command result service preserves terminal idempotency without rewriting command", async () => {
  const existing = {
    commandId: "cmd-1",
    nodeId: "node-1",
    commandType: "reboot",
    status: "success",
    error: null,
    pickedUpAt: "2026-09-26T12:00:00Z"
  };
  const harness = makeHarness(existing);

  const result = await harness.service.saveSensorCommandResult({
    commandId: "cmd-1",
    status: "success",
    resultPayload: { ok: true }
  });

  assert.equal(result.outcome, "already_recorded");
  assert.equal(result.statusCode, 200);
  assert.equal(harness.calls.some((call) => call.sql.startsWith("UPDATE node_commands")), false);
  assert.equal(harness.calls.some((call) => call.sql === "COMMIT"), true);
});

test("factory-reset success finalizes device state in the same transaction", async () => {
  const existing = {
    commandId: "cmd-reset",
    nodeId: "node-reset",
    commandType: "factory_reset",
    status: "running",
    error: null,
    pickedUpAt: "2026-09-26T12:00:00Z"
  };
  const completed = {
    ...existing,
    status: "success",
    result: { reset: true }
  };
  const harness = makeHarness(existing, completed);

  const result = await harness.service.saveSensorCommandResult({
    commandId: "cmd-reset",
    status: "success",
    resultPayload: { reset: true }
  });

  assert.equal(result.outcome, "saved");
  assert.deepEqual(harness.resetNodes, ["node-reset"]);
  const updateIndex = harness.calls.findIndex((call) => call.sql.startsWith("UPDATE node_commands"));
  const commitIndex = harness.calls.findIndex((call) => call.sql === "COMMIT");
  assert.ok(updateIndex >= 0);
  assert.ok(commitIndex > updateIndex);
  assert.equal(harness.diagnostics.at(-1)?.[0], "COMMAND_RESULT");
});
