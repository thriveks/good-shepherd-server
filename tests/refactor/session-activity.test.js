"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  SESSION_ACTIVITY_REFRESH_MS,
  sessionActivityNeedsRefresh,
  touchSessionActivityBestEffort
} = require("../../lib/sessionActivity");

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("session activity refresh policy suppresses recent writes", () => {
  const now = Date.now();

  assert.equal(sessionActivityNeedsRefresh(null, now), true);
  assert.equal(
    sessionActivityNeedsRefresh(new Date(now - 60_000), now),
    false
  );
  assert.equal(
    sessionActivityNeedsRefresh(
      new Date(now - SESSION_ACTIVITY_REFRESH_MS),
      now
    ),
    true
  );
});

test("fresh session does not issue a database write", async () => {
  let queryCount = 0;
  const pool = {
    query() {
      queryCount += 1;
      return Promise.resolve({ rowCount: 1 });
    }
  };

  const touched = touchSessionActivityBestEffort({
    pool,
    tableName: "customer_sessions",
    tokenHash: "abc",
    lastUsedAt: new Date()
  });

  await flushPromises();
  assert.equal(touched, false);
  assert.equal(queryCount, 0);
});

test("stale session issues one best-effort database write", async () => {
  const queries = [];
  const pool = {
    query(sql, values) {
      queries.push({ sql, values });
      return Promise.resolve({ rowCount: 1 });
    }
  };

  const touched = touchSessionActivityBestEffort({
    pool,
    tableName: "monitoring_sessions",
    tokenHash: "hash-1",
    lastUsedAt: new Date(Date.now() - SESSION_ACTIVITY_REFRESH_MS - 1000)
  });

  await flushPromises();
  assert.equal(touched, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /UPDATE monitoring_sessions/);
  assert.match(queries[0].sql, /last_used_at <= NOW\(\) -/);
  assert.deepEqual(queries[0].values, [
    "hash-1",
    SESSION_ACTIVITY_REFRESH_MS
  ]);
});

test("background session-write failures are observed without breaking auth", async () => {
  const warnings = [];
  const pool = {
    query() {
      throw new Error("database unavailable");
    }
  };

  const touched = touchSessionActivityBestEffort({
    pool,
    tableName: "customer_sessions",
    tokenHash: "hash-2",
    lastUsedAt: null,
    logger: {
      warn(...args) {
        warnings.push(args.join(" "));
      }
    }
  });

  await flushPromises();
  assert.equal(touched, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /database unavailable/);
});

test("session activity helper rejects arbitrary table names", () => {
  assert.throws(
    () => touchSessionActivityBestEffort({
      pool: { query() {} },
      tableName: "residents",
      tokenHash: "x",
      lastUsedAt: null
    }),
    /Unsupported session activity table/
  );
});
