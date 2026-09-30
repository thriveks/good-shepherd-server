"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root =
  path.resolve(__dirname, "../..");

const service =
  fs.readFileSync(
    path.join(
      root,
      "services/webhookEventService.js"
    ),
    "utf8"
  );

const server =
  fs.readFileSync(
    path.join(
      root,
      "server.js"
    ),
    "utf8"
  );

function processWebhookSource() {
  const start =
    service.indexOf(
      "  async function processWebhookEvent("
    );

  const end =
    service.indexOf(
      "\n  return {\n    processWebhookEvent,",
      start
    );

  assert.notEqual(
    start,
    -1,
    "processWebhookEvent is missing"
  );

  assert.notEqual(
    end,
    -1,
    "processWebhookEvent boundary is missing"
  );

  return service.slice(
    start,
    end
  );
}

test(
  "webhook authoritative database writes share one transaction client",
  () => {
    const block =
      processWebhookSource();

    assert.match(
      block,
      /await withTransaction\(async \(client\) =>/
    );

    assert.match(
      block,
      /getDeviceMapping\([\s\S]*client/
    );

    assert.match(
      block,
      /touchNodeFromWebhook\([\s\S]*client/
    );

    assert.match(
      block,
      /getExistingSensorForDeviceIdentity\([\s\S]*client/
    );

    assert.match(
      block,
      /findOrCreateResidentFromEvent\([\s\S]*client/
    );

    assert.match(
      block,
      /upsertSensorFromEvent\([\s\S]*client/
    );

    assert.match(
      block,
      /await client\.query\([\s\S]*INSERT INTO webhook_events/
    );

    assert.match(
      block,
      /recordMotionHistoryEvent\([\s\S]*client/
    );

    assert.match(
      block,
      /incrementResidentDailyActivity\([\s\S]*client/
    );

    assert.doesNotMatch(
      block,
      /\bpool\.query\s*\(/
    );
  }
);

test(
  "signed replay serialization occurs before webhook state mutation",
  () => {
    const block =
      processWebhookSource();

    const transaction =
      block.indexOf(
        "await withTransaction(async (client) =>"
      );

    const replayLock =
      block.indexOf(
        "pg_advisory_xact_lock",
        transaction
      );

    const secondReplayCheck =
      block.indexOf(
        "findWebhookEventByRequestFingerprint(",
        replayLock
      );

    const nodeTouch =
      block.indexOf(
        "touchNodeFromWebhook(",
        secondReplayCheck
      );

    const webhookInsert =
      block.indexOf(
        "INSERT INTO webhook_events",
        nodeTouch
      );

    assert.ok(
      transaction >= 0
    );

    assert.ok(
      replayLock > transaction
    );

    assert.ok(
      secondReplayCheck > replayLock
    );

    assert.ok(
      nodeTouch > secondReplayCheck
    );

    assert.ok(
      webhookInsert > nodeTouch
    );
  }
);

test(
  "derived in-database activity is atomic while AI invalidation remains post-commit",
  () => {
    const block =
      processWebhookSource();

    const daily =
      block.indexOf(
        "incrementResidentDailyActivity("
      );

    const transactionResultCheck =
      block.indexOf(
        "if (transactionResult.duplicate === true)"
      );

    const aiRefresh =
      block.indexOf(
        "scheduleAIDashboardRefresh("
      );

    assert.ok(
      daily >= 0
    );

    assert.ok(
      transactionResultCheck > daily
    );

    assert.ok(
      aiRefresh > transactionResultCheck
    );

    assert.doesNotMatch(
      block,
      /\bsetImmediate\s*\(/
    );

    assert.match(
      server,
      /createWebhookEventService\(\{[\s\S]*pool,[\s\S]*withTransaction,/
    );
  }
);
