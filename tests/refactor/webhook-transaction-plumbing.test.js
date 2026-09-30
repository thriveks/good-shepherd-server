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

const webhookService =
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../services/webhookEventService.js"
    ),
    "utf8"
  );

function extractFunction(signature) {
  const start =
    server.indexOf(signature);

  assert.notEqual(
    start,
    -1,
    `Missing function: ${signature}`
  );

  const bodyMarker =
    server.indexOf(
      ") {",
      start
    );

  assert.notEqual(
    bodyMarker,
    -1,
    `Missing body: ${signature}`
  );

  const openBrace =
    bodyMarker + 2;

  let depth = 0;

  for (
    let index = openBrace;
    index < server.length;
    index += 1
  ) {
    const character =
      server[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return server.slice(
          start,
          index + 1
        );
      }
    }
  }

  assert.fail(
    `Unable to extract function: ${signature}`
  );
}

test(
  "webhook state helpers accept a caller-supplied queryable",
  () => {
    const signatures = [
      "async function incrementResidentDailyActivity({ resident, event, sensor }, queryable = pool)",
      "async function getDeviceMapping(sourceKey, queryable = pool)",
      "async function getResidentById(residentId, queryable = pool)",
      "async function getExistingSensorForDeviceIdentity({ sourceKey, nodeId }, queryable = pool)",
      "async function touchNodeFromWebhook(nodeId, queryable = pool)",
      "async function findOrCreateResidentFromEvent({ residentName, locationName, alertLevel, message }, queryable = pool)",
      "async function recordMotionHistoryEvent({ event, resident, sensor }, queryable = pool)"
    ];

    for (const signature of signatures) {
      const block =
        extractFunction(signature);

      assert.match(
        block,
        /queryable\.query\s*\(/
      );

      assert.doesNotMatch(
        block,
        /\bpool\.query\s*\(/
      );
    }
  }
);

test(
  "ESP32 sensor upsert can either own or join a transaction",
  () => {
    const start =
      server.indexOf(
        "async function upsertSensorFromEvent({"
      );

    const end =
      server.indexOf(
        "async function recordMotionHistoryEvent(",
        start
      );

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const block =
      server.slice(start, end);

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
      /if \(ownsTransaction\) \{[\s\S]*client\.query\("ROLLBACK"\)/
    );

    assert.match(
      block,
      /if \(ownsTransaction\) \{[\s\S]*client\.release\(\)/
    );

    assert.match(
      block,
      /\(queryable \|\| pool\)\.query\s*\(/
    );
  }
);

test(
  "webhook ingestion activates the caller-owned transaction after plumbing",
  () => {
    assert.match(
      webhookService,
      /await withTransaction\(async \(client\) =>/
    );

    assert.match(
      webhookService,
      /pg_advisory_xact_lock\(hashtext\(\$1\)\)/
    );

    assert.match(
      webhookService,
      /findWebhookEventByRequestFingerprint\([\s\S]*requestFingerprint,[\s\S]*client/
    );

    assert.match(
      webhookService,
      /incrementResidentDailyActivity\([\s\S]*client/
    );
  }
);
