"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("server source contains no hardcoded MQTT or staff-access fallback", () => {
  const source = read("server.js");
  const runtimeConfig = read("config/runtimeConfig.js");
  const combined = `${source}\n${runtimeConfig}`;

  assert.doesNotMatch(combined, /MQTT_PASSWORD\s*\|\|\s*["'][^"']+["']/);
  assert.doesNotMatch(combined, /MQTT_USERNAME\s*\|\|\s*["'][^"']+["']/);
  assert.doesNotMatch(combined, /STAFF_ACCESS_CODE\s*\|\|\s*["']\d{4}["']/);
});

test("MQTT device path no longer loops back through localhost HTTP", () => {
  const server = read("server.js");
  const bridge = read("realtime/mqttV2Bridge.js");

  assert.doesNotMatch(server, /postLocalV2Route/);
  assert.doesNotMatch(bridge, /postLocalV2Route/);
  assert.doesNotMatch(bridge, /127\.0\.0\.1|localhost/);
  assert.match(bridge, /processWebhookEvent/);
  assert.match(bridge, /saveSensorCommandResult/);
});

test("latest Human Presence dashboard lookups have a versioned index migration", async () => {
  const migration = require(
    "../../scripts/migrations/2026-09-26-human-presence-latest-resident-indexes-v1"
  );
  const sql = [];

  await migration.up({
    query(text) {
      sql.push(text);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
  });

  assert.equal(sql.length, 1);
  assert.match(sql[0], /authoritative_resident_id[\s\S]*non_operational_interpretation_at DESC/);
  assert.match(sql[0], /authoritative_resident_id[\s\S]*longitudinal_interpretation_validation_at DESC/);
});


test("global AI summary endpoints use the persisted summary fast path", () => {
  const server = read("server.js");

  const briefingStart = server.indexOf('app.get("/ai/briefing"');
  const summaryStart = server.indexOf('app.get("/ai/motion-summary"');
  const eventsStart = server.indexOf('app.get("/ai/motion-events"');

  assert.notEqual(briefingStart, -1);
  assert.notEqual(summaryStart, -1);
  assert.notEqual(eventsStart, -1);

  const briefingRoute = server.slice(briefingStart, summaryStart);
  const summaryRoute = server.slice(summaryStart, eventsStart);

  assert.match(briefingRoute, /loadMonitoringSummaryFast\(\)/);
  assert.match(briefingRoute, /buildAIBriefingFromSummary\(summary\)/);
  assert.doesNotMatch(briefingRoute, /await buildAIBriefing\(\)/);

  assert.match(summaryRoute, /loadMonitoringSummaryFast\(\)/);
  assert.doesNotMatch(summaryRoute, /await buildAIMotionSummary\(\)/);
});

test("resident deletion scopes camera cleanup by resident id only", () => {
  const server = read("server.js");

  const routeStart =
    server.indexOf('app.delete("/residents/:residentId"');

  const cameraStart =
    server.indexOf(
      "const cameraResult = await client.query(",
      routeStart
    );

  const sensorStart =
    server.indexOf(
      "const sensorResult = await client.query(",
      cameraStart
    );

  assert.notEqual(routeStart, -1);
  assert.notEqual(cameraStart, -1);
  assert.notEqual(sensorStart, -1);

  const cameraBlock =
    server.slice(cameraStart, sensorStart);

  assert.match(
    cameraBlock,
    /WHERE is_deleted = FALSE[\s\S]*AND resident_id = \$1/
  );

  assert.doesNotMatch(
    cameraBlock,
    /LOWER\(TRIM\(resident_name\)\)/
  );
});

test("customer motion history preserves resident id index usage", () => {
  const server = read("server.js");

  const start =
    server.indexOf('app.get("/customer/ai/motion-events"');

  const end =
    server.indexOf('app.get("/livez"', start);

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const route =
    server.slice(start, end);

  assert.match(
    route,
    /WHERE resident_id = \$1/
  );

  assert.doesNotMatch(
    route,
    /resident_id::text/
  );
});

test("resident deletion scopes sensor cleanup by resident id only", () => {
  const server = read("server.js");

  const routeStart =
    server.indexOf('app.delete("/residents/:residentId"');

  const sensorSelectStart =
    server.indexOf(
      "const sensorResult = await client.query(",
      routeStart
    );

  const lockStart =
    server.indexOf(
      "await lockSensorIdentityForResidentDeletion(",
      sensorSelectStart
    );

  const sensorUpdateStart =
    server.indexOf(
      "const unassignedSensorResult = await client.query(",
      lockStart
    );

  const affectedNodesStart =
    server.indexOf(
      "const affectedNodeIds",
      sensorUpdateStart
    );

  assert.notEqual(routeStart, -1);
  assert.notEqual(sensorSelectStart, -1);
  assert.notEqual(lockStart, -1);
  assert.notEqual(sensorUpdateStart, -1);
  assert.notEqual(affectedNodesStart, -1);

  const sensorSelect =
    server.slice(
      sensorSelectStart,
      lockStart
    );

  const sensorUpdate =
    server.slice(
      sensorUpdateStart,
      affectedNodesStart
    );

  for (const block of [
    sensorSelect,
    sensorUpdate
  ]) {
    assert.match(
      block,
      /resident_id = \$1/
    );

    assert.doesNotMatch(
      block,
      /resident_id IS NULL/
    );

    assert.doesNotMatch(
      block,
      /LOWER\(TRIM\(resident_name\)\)/
    );

    assert.doesNotMatch(
      block,
      /LOWER\(TRIM\(location_name\)\)/
    );
  }
});

test("HTTP observability logs only safe request metadata", () => {
  const server = read("server.js");

  const start =
    server.indexOf("const HTTP_SLOW_REQUEST_MS");

  const end =
    server.indexOf(
      "app.use(express.json",
      start
    );

  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const block =
    server.slice(start, end);

  assert.match(
    block,
    /res\.once\("finish"/
  );

  assert.match(
    block,
    /process\.hrtime\.bigint\(\)/
  );

  assert.match(
    block,
    /requestId: req\.requestId/
  );

  assert.match(
    block,
    /route: routePattern/
  );

  assert.match(
    block,
    /statusCode: res\.statusCode/
  );

  assert.match(
    block,
    /durationMs/
  );

  assert.doesNotMatch(
    block,
    /req\.originalUrl/
  );

  assert.doesNotMatch(
    block,
    /req\.headers\.authorization/
  );

  assert.doesNotMatch(
    block,
    /req\.body/
  );

  assert.doesNotMatch(
    block,
    /req\.query/
  );
});

test("resident-scoped staff queries preserve UUID index usage", () => {
  const server = read("server.js");

  assert.match(
    server,
    /const UUID_PATTERN/
  );

  const routes = [
    ["/ai/human-presence-learning", "/ai/motion-events"],
    ["/ai/motion-events", "/ai/action-logs"],
    ["/ai/action-logs", "/cameras"],
    ["/cameras", "/sensors"],
    ["/sensors", "/resident-candidates"]
  ];

  for (const [startRoute, endRoute] of routes) {
    const start = server.indexOf(
      `app.get("${startRoute}"`
    );

    const end = server.indexOf(
      `app.get("${endRoute}"`,
      start + 1
    );

    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const block = server.slice(start, end);

    assert.doesNotMatch(
      block,
      /resident_id::text\s*=/
    );

    assert.match(
      block,
      /UUID_PATTERN\.test\(residentId\)/
    );
  }

  assert.match(
    server,
    /authoritative_resident_id = \$1::uuid/
  );

  assert.match(
    server,
    /resident_id = \$2::uuid/
  );

  assert.match(
    server,
    /resident_id = \$3::uuid/
  );
});

test("sensor topology changes invalidate AI dashboard cache", () => {
  const server = read("server.js");

  const assignmentStart = server.indexOf(
    "async function updateSensorAssignment"
  );
  const assignmentEnd = server.indexOf(
    "async function prepareNodeForReconfigure",
    assignmentStart
  );

  assert.notEqual(assignmentStart, -1);
  assert.notEqual(assignmentEnd, -1);

  const assignmentBlock = server.slice(
    assignmentStart,
    assignmentEnd
  );

  assert.match(
    assignmentBlock,
    /previousResidentId/
  );

  assert.match(
    assignmentBlock,
    /sensor_assignment_changed/
  );

  assert.match(
    assignmentBlock,
    /scheduleAIDashboardRefresh\(/
  );

  const archiveStart = server.indexOf(
    'app.patch("/nodes/:nodeId/archive"'
  );
  const restoreStart = server.indexOf(
    'app.patch("/nodes/:nodeId/restore"',
    archiveStart
  );
  const deleteStart = server.indexOf(
    'app.delete("/nodes/:nodeId"',
    restoreStart
  );

  assert.notEqual(archiveStart, -1);
  assert.notEqual(restoreStart, -1);
  assert.notEqual(deleteStart, -1);

  const archiveBlock = server.slice(
    archiveStart,
    restoreStart
  );

  const restoreBlock = server.slice(
    restoreStart,
    deleteStart
  );

  assert.match(
    archiveBlock,
    /scheduleAIDashboardRefresh\(\)/
  );

  assert.match(
    restoreBlock,
    /scheduleAIDashboardRefresh\(\)/
  );
});
