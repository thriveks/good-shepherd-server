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

function monitoringCheckInRoute() {
  const startMarker =
    'app.post("/monitoring/api/cases/:caseId/check-ins", async (req, res) => {';

  const endMarker =
    '\napp.post("/monitoring/api/cases/:caseId/actions", async (req, res) => {';

  const start =
    server.indexOf(
      startMarker
    );

  assert.notEqual(
    start,
    -1,
    "Missing monitoring check-in route"
  );

  const end =
    server.indexOf(
      endMarker,
      start
    );

  assert.notEqual(
    end,
    -1,
    "Missing monitoring action-route boundary"
  );

  return server.slice(
    start,
    end
  );
}

test(
  "operator check-in uses two short database transactions around APNs",
  () => {
    const route =
      monitoringCheckInRoute();

    const transactionStarts =
      [
        ...route.matchAll(
          /await withTransaction\s*\(/g
        )
      ].map(
        (match) => match.index
      );

    assert.equal(
      transactionStarts.length,
      2
    );

    const apnsIndex =
      route.indexOf(
        "sendApnsNotification("
      );

    assert.notEqual(
      apnsIndex,
      -1
    );

    assert.ok(
      transactionStarts[0] <
        apnsIndex
    );

    assert.ok(
      apnsIndex <
        transactionStarts[1]
    );
  }
);

test(
  "operator check-in creates durable intent before external delivery",
  () => {
    const route =
      monitoringCheckInRoute();

    const firstTransaction =
      route.slice(
        route.indexOf(
          "const intent ="
        ),
        route.indexOf(
          "// External network work"
        )
      );

    assert.match(
      firstTransaction,
      /FOR UPDATE/
    );

    assert.match(
      firstTransaction,
      /INSERT INTO resident_checkins/
    );

    assert.match(
      firstTransaction,
      /SELECT[\s\S]*device_token/
    );

    assert.doesNotMatch(
      firstTransaction,
      /sendApnsNotification/
    );
  }
);

test(
  "operator check-in finalizes database outcome atomically and preserves early responses",
  () => {
    const route =
      monitoringCheckInRoute();

    const secondTransaction =
      route.slice(
        route.indexOf(
          "// Phase 2 atomically"
        )
      );

    assert.match(
      secondTransaction,
      /await withTransaction\s*\(/
    );

    assert.match(
      secondTransaction,
      /UPDATE resident_checkins/
    );

    assert.match(
      secondTransaction,
      /INSERT INTO monitoring_case_events/
    );

    assert.match(
      secondTransaction,
      /UPDATE monitoring_cases/
    );

    assert.match(
      secondTransaction,
      /writeMonitoringAudit\([\s\S]*client/
    );

    assert.match(
      secondTransaction,
      /WHEN responded_at IS NULL[\s\S]*THEN \$2[\s\S]*ELSE status/
    );

    assert.doesNotMatch(
      secondTransaction,
      /\bpool\.query\s*\(/
    );
  }
);
