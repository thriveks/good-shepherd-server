"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const server =
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../server.js"
    ),
    "utf8"
  );

function readinessRoute() {
  const start =
    server.indexOf(
      'app.post("/customer/first-sensor-readiness"'
    );

  const end =
    server.indexOf(
      '\napp.post("/customer/activate-first-sensor"',
      start
    );

  assert.notEqual(
    start,
    -1
  );

  assert.notEqual(
    end,
    -1
  );

  return server.slice(
    start,
    end
  );
}

function activationRoute() {
  const start =
    server.indexOf(
      'app.post("/customer/activate-first-sensor"'
    );

  const end =
    server.indexOf(
      '\napp.post("/customer/access"',
      start
    );

  assert.notEqual(
    start,
    -1
  );

  assert.notEqual(
    end,
    -1
  );

  return server.slice(
    start,
    end
  );
}

test(
  "first-sensor readiness is a bounded immediate probe",
  () => {
    const route =
      readinessRoute();

    assert.match(
      route,
      /firstSensorReadinessRateLimited\(req\)/
    );

    assert.match(
      route,
      /requireMinimumIOSAppBuildForSetupWrites\(req, res\)/
    );

    assert.equal(
      (
        route.match(
          /await pool\.query\(/g
        ) || []
      ).length,
      1
    );

    assert.doesNotMatch(
      route,
      /\bwhile\s*\(/
    );

    assert.doesNotMatch(
      route,
      /setTimeout\(/
    );

    assert.doesNotMatch(
      route,
      /withTransaction\(/
    );
  }
);

test(
  "readiness probe is read-only and verifies physical identity",
  () => {
    const route =
      readinessRoute();

    assert.match(
      route,
      /FROM nodes n/
    );

    assert.match(
      route,
      /WHERE n\.node_id = \$1/
    );

    assert.match(
      route,
      /n\.setup_id AS "setupId"/
    );

    assert.match(
      route,
      /FROM sensors s/
    );

    assert.match(
      route,
      /registeredSetupId !== setupId/
    );

    assert.doesNotMatch(
      route,
      /\bINSERT\s+INTO\b/i
    );

    assert.doesNotMatch(
      route,
      /\bUPDATE\s+[a-z_]/i
    );

    assert.doesNotMatch(
      route,
      /\bDELETE\s+FROM\b/i
    );
  }
);

test(
  "readiness response preserves pending ready and activated states",
  () => {
    const route =
      readinessRoute();

    assert.match(
      route,
      /ready: false,[\s\S]*retryAfterMs: 2000/
    );

    assert.match(
      route,
      /node\.sensorHasResident/
    );

    assert.match(
      route,
      /This sensor has already been activated/
    );

    assert.match(
      route,
      /ready: true,[\s\S]*retryAfterMs: 0/
    );
  }
);

test(
  "5C1 leaves legacy activation compatibility wait intact",
  () => {
    const route =
      activationRoute();

    assert.match(
      route,
      /registrationDeadline = registrationStartedAt \+ 90000/
    );

    assert.match(
      route,
      /while \(Date\.now\(\) < registrationDeadline/
    );

    assert.match(
      route,
      /await withTransaction\(/
    );
  }
);
