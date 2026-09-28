"use strict";

const test =
  require("node:test");

const assert =
  require("node:assert/strict");

const fs =
  require("node:fs");

const path =
  require("node:path");

const {
  hashStaffAppSessionToken,
  createStaffAppSession,
  authenticateStaffAppSession,
  revokeStaffAppSession
} =
  require(
    "../../lib/staffAppSessionService"
  );

test(
  "staff app session stores only a token hash and supports authentication and revocation",
  async () => {
    const calls = [];

    const expectedExpiry =
      new Date(
        Date.now() +
        60 * 60 * 1000
      );

    const pool = {
      async query(
        sql,
        params = []
      ) {
        calls.push({
          sql,
          params
        });

        if (
          sql.includes(
            "SELECT"
          )
        ) {
          return {
            rowCount: 1,
            rows: [
              {
                expiresAt:
                  expectedExpiry
              }
            ]
          };
        }

        return {
          rowCount: 1,
          rows: []
        };
      }
    };

    const created =
      await createStaffAppSession(
        pool,
        {
          sessionHours: 1
        }
      );

    assert.equal(
      typeof created.token,
      "string"
    );

    assert.ok(
      created.token.length >= 40
    );

    const expectedHash =
      hashStaffAppSessionToken(
        created.token
      );

    const insertCall =
      calls.find(
        (call) =>
          call.sql.includes(
            "INSERT INTO staff_app_sessions"
          )
      );

    assert.ok(insertCall);

    assert.equal(
      insertCall.params[0],
      expectedHash
    );

    assert.notEqual(
      insertCall.params[0],
      created.token
    );

    const authenticated =
      await authenticateStaffAppSession(
        pool,
        created.token
      );

    assert.ok(authenticated);

    const selectCall =
      calls.find(
        (call) =>
          call.sql.includes(
            "FROM staff_app_sessions"
          ) &&
          call.sql.includes(
            "SELECT"
          )
      );

    assert.ok(selectCall);

    assert.equal(
      selectCall.params[0],
      expectedHash
    );

    await revokeStaffAppSession(
      pool,
      created.token
    );

    const revokeCall =
      [...calls]
        .reverse()
        .find(
          (call) =>
            call.sql.includes(
              "DELETE FROM staff_app_sessions"
            ) &&
            call.sql.includes(
              "token_hash"
            )
        );

    assert.ok(revokeCall);

    assert.equal(
      revokeCall.params[0],
      expectedHash
    );

    for (const call of calls) {
      for (
        const param of
        call.params || []
      ) {
        assert.notEqual(
          param,
          created.token,
          "raw staff token must never be written to PostgreSQL"
        );
      }
    }
  }
);

test(
  "server staff-auth contract separates app sessions from device webhook authentication",
  () => {
    const server =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../server.js"
        ),
        "utf8"
      );

    const nodeHealthRoutes =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../routes/nodeHealthRoutes.js"
        ),
        "utf8"
      );

    const migration =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../scripts/migrations/2026-09-28-staff-app-sessions-v1.js"
        ),
        "utf8"
      );

    assert.match(
      server,
      /createStaffAppSession/
    );

    assert.match(
      server,
      /authenticateStaffAppSession/
    );

    assert.match(
      server,
      /app\.get\("\/staff\/session"/
    );

    assert.match(
      server,
      /app\.post\("\/staff\/logout"/
    );

    assert.match(
      server,
      /if \(accessCode === STAFF_ACCESS_CODE\)[\s\S]{0,1000}createStaffAppSession/
    );

    assert.match(
      server,
      /async function requireAuthorizedRequest\(req, res\)[\s\S]{0,500}isAuthorizedStaffOrServiceRequest/
    );

    assert.doesNotMatch(
      server,
      /if \(!requireAuthorizedRequest\(req, res\)\)/
    );

    assert.doesNotMatch(
      server,
      /if \(!requireAuthorizedCurrentAppWrite\(req, res\)\)/
    );

    assert.match(
      server,
      /app\.post\("\/webhook"[\s\S]{0,400}if \(!isAuthorizedWebhook\(req\)\)/
    );

    assert.match(
      server,
      /app\.post\("\/nodes\/register"[\s\S]{0,400}if \(!isAuthorizedWebhook\(req\)\)/
    );

    assert.match(
      server,
      /app\.get\("\/ai\/dashboard"[\s\S]{0,400}await requireAuthorizedRequest/
    );

    assert.match(
      server,
      /app\.get\("\/ai\/human-presence-learning"[\s\S]{0,400}await requireAuthorizedRequest/
    );

    assert.match(
      nodeHealthRoutes,
      /await requireAuthorizedRequest/
    );

    assert.match(
      migration,
      /CREATE TABLE IF NOT EXISTS[\s\S]*staff_app_sessions/
    );
  }
);
