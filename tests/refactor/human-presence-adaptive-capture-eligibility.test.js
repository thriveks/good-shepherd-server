"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadEligibleNodes
} = require("../../lib/human_presence_adaptive_capture_controller_v1");

test(
  "adaptive capture eligibility is based on sensor state and heartbeat, not a firmware release label",
  async () => {
    let capturedSql = "";
    let capturedParams = null;

    const client = {
      async query(sql, params) {
        capturedSql = sql;
        capturedParams = params;
        return {
          rows: [
            {
              nodeId: "esp32-a02dbcabc31c",
              softwareVersion:
                "esp32-good-shepherd-human-presence-v2.4.8-recommission-v1"
            }
          ]
        };
      }
    };

    const nodes = await loadEligibleNodes(client);

    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].nodeId, "esp32-a02dbcabc31c");
    assert.deepEqual(capturedParams, [180]);
    assert.match(capturedSql, /human_presence/i);
    assert.doesNotMatch(capturedSql, /v2\.4\.7-adaptive-capture-v1/i);
  }
);
