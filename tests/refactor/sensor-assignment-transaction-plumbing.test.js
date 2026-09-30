"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const server =
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../server.js"
    ),
    "utf8"
  );

function assignmentBlock() {
  const start =
    server.indexOf(
      "async function updateSensorAssignment("
    );

  const end =
    server.indexOf(
      "\nasync function prepareNodeForReconfigure",
      start
    );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return server.slice(start, end);
}

function firstSensorRoute() {
  const start =
    server.indexOf(
      'app.post("/customer/activate-first-sensor"'
    );

  const end =
    server.indexOf(
      '\napp.post("/customer/access"',
      start
    );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  return server.slice(start, end);
}

test(
  "sensor assignment can own or join a transaction",
  () => {
    const block =
      assignmentBlock();

    assert.match(
      block,
      /}, queryable = null\) \{/
    );

    assert.match(
      block,
      /const ownsTransaction = !queryable/
    );

    assert.match(
      block,
      /const client = queryable \|\| await pool\.connect\(\)/
    );

    assert.match(
      block,
      /if \(ownsTransaction\) \{[\s\S]*client\.query\("BEGIN"\)/
    );

    assert.match(
      block,
      /if \(ownsTransaction\) \{[\s\S]*client\.query\("COMMIT"\)/
    );

    assert.match(
      block,
      /if \(didBegin\) \{[\s\S]*client\.query\("ROLLBACK"\)/
    );

    assert.match(
      block,
      /if \(ownsTransaction\) \{[\s\S]*client\.release\(\)/
    );
  }
);

test(
  "first-sensor route activates the caller-owned transaction after plumbing",
  () => {
    const route =
      firstSensorRoute();

    assert.match(
      route,
      /await withTransaction\(/
    );

    assert.match(
      route,
      /async \(client\) =>/
    );

    assert.match(
      route,
      /await updateSensorAssignment\([\s\S]*\},\s*client\s*\)/
    );
  }
);
