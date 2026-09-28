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


test(
  "adaptive capture policy context does not issue concurrent queries on one pg client",
  () => {
    const fs = require("node:fs");
    const path = require("node:path");

    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../lib/human_presence_adaptive_capture_controller_v1.js"
      ),
      "utf8"
    );

    const start = source.indexOf(
      "async function loadNodePolicyContext("
    );

    const end = source.indexOf(
      "\nasync function evaluateNode(",
      start
    );

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const contextLoader = source.slice(
      start,
      end
    );

    assert.doesNotMatch(
      contextLoader,
      /Promise\.all\s*\(/
    );

    assert.match(
      contextLoader,
      /policyContextQueries/
    );

    assert.match(
      contextLoader,
      /for\s*\(\s*const runQuery of policyContextQueries\s*\)/
    );

    assert.match(
      contextLoader,
      /await runQuery\(\)/
    );
  }
);
