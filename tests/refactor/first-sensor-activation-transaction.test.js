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
  "first-sensor registration wait remains outside the database transaction",
  () => {
    const route =
      firstSensorRoute();

    assert.match(
      route,
      /registrationDeadline = registrationStartedAt \+ 90000/
    );

    const polling =
      route.indexOf(
        "while (Date.now() < registrationDeadline"
      );

    const transaction =
      route.indexOf(
        "await withTransaction("
      );

    assert.ok(
      polling >= 0
    );

    assert.ok(
      transaction > polling
    );

    assert.equal(
      (
        route.match(
          /await withTransaction\(/g
        ) || []
      ).length,
      1
    );
  }
);

test(
  "first-sensor claim is serialized and revalidated before household creation",
  () => {
    const route =
      firstSensorRoute();

    const transaction =
      route.indexOf(
        "await withTransaction("
      );

    const claimLock =
      route.indexOf(
        "pg_advisory_xact_lock",
        transaction
      );

    const lockedNode =
      route.indexOf(
        "FROM nodes",
        claimLock
      );

    const sensorLock =
      route.indexOf(
        "FOR UPDATE",
        lockedNode + 1
      );

    const residentInsert =
      route.indexOf(
        "INSERT INTO residents",
        sensorLock
      );

    assert.ok(
      transaction >= 0
    );

    assert.ok(
      claimLock > transaction
    );

    assert.ok(
      lockedNode > claimLock
    );

    assert.ok(
      sensorLock > lockedNode
    );

    assert.ok(
      residentInsert > sensorLock
    );

    assert.match(
      route,
      /lockedSetupId !== setupId/
    );

    assert.ok(
      (
        route.match(
          /This sensor has already been activated/g
        ) || []
      ).length >= 2
    );
  }
);

test(
  "resident session and sensor assignment share the transaction client",
  () => {
    const route =
      firstSensorRoute();

    assert.match(
      route,
      /await client\.query\([\s\S]*INSERT INTO residents/
    );

    assert.match(
      route,
      /await client\.query\([\s\S]*INSERT INTO customer_sessions/
    );

    assert.match(
      route,
      /await updateSensorAssignment\([\s\S]*client[\s\S]*\)/
    );

    assert.doesNotMatch(
      route,
      /createdResidentId/
    );

    assert.doesNotMatch(
      route,
      /createdSessionTokenHash/
    );

    assert.doesNotMatch(
      route,
      /DELETE FROM customer_sessions/
    );

    assert.doesNotMatch(
      route,
      /DELETE FROM residents/
    );
  }
);

test(
  "first-sensor response contract remains intact and AI refresh is post-commit",
  () => {
    const route =
      firstSensorRoute();

    const transaction =
      route.indexOf(
        "await withTransaction("
      );

    const refresh =
      route.indexOf(
        "scheduleAIDashboardRefresh(",
        transaction
      );

    const clearFailures =
      route.indexOf(
        "clearFirstSensorClaimFailures(req)",
        refresh
      );

    const response =
      route.indexOf(
        "return res.status(201).json({",
        clearFailures
      );

    assert.ok(
      refresh > transaction
    );

    assert.ok(
      clearFailures > refresh
    );

    assert.ok(
      response > clearFailures
    );

    for (
      const responseField
      of [
        'success: true',
        'mode: "customer"',
        'message: "Your Good Shepherd home is ready"',
        'token,',
        'expiresAt: expiresAt.toISOString()',
        'residentId: resident.id',
        'residentName: resident.name',
        'accessCode,',
        'assignment'
      ]
    ) {
      assert.ok(
        route.includes(
          responseField
        ),
        `Missing response field: ${responseField}`
      );
    }
  }
);
