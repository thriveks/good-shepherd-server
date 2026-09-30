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

function customerCheckInResponseRoute() {
  const startMarker =
    'app.post("/customer/check-ins/:checkInId/respond", async (req, res) => {';

  const endMarker =
    "\n// ---------------- Monitoring Center API ----------------";

  const start =
    server.indexOf(startMarker);

  assert.notEqual(
    start,
    -1,
    "Missing customer check-in response route"
  );

  const end =
    server.indexOf(
      endMarker,
      start
    );

  assert.notEqual(
    end,
    -1,
    "Missing monitoring API boundary"
  );

  return server.slice(
    start,
    end
  );
}

test(
  "customer check-in response writes share one transaction",
  () => {
    const route =
      customerCheckInResponseRoute();

    assert.match(
      route,
      /await withTransaction\s*\(/
    );

    assert.match(
      route,
      /async\s*\(client\)\s*=>/
    );

    assert.doesNotMatch(
      route,
      /\bpool\.query\s*\(/
    );

    assert.match(
      route,
      /UPDATE resident_checkins/
    );

    assert.match(
      route,
      /INSERT INTO monitoring_case_events/
    );

    assert.match(
      route,
      /UPDATE monitoring_cases/
    );
  }
);

test(
  "customer check-in transaction preserves response operational semantics",
  () => {
    const route =
      customerCheckInResponseRoute();

    for (const expected of [
      "check_in_response",
      "case_auto_resolved",
      "resident_help_escalation",
      "resident_call_escalation",
      "Resident confirmed safe",
      "Resident requested a call",
      "Resident requested help"
    ]) {
      assert.ok(
        route.includes(expected),
        `Missing preserved semantic: ${expected}`
      );
    }

    assert.match(
      route,
      /customerCheckInPayload\(checkIn\)/
    );

    assert.match(
      route,
      /This check-in is no longer active/
    );
  }
);
