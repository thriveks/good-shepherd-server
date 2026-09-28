"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REQUIRED_TABLES,
  REQUIRED_COLUMNS,
  REQUIRED_INDEXES
} = require(
  "../../scripts/migrations/schema_requirements"
);

test(
  "staff application session migration is part of required production schema",
  () => {
    assert.ok(
      REQUIRED_TABLES.includes(
        "staff_app_sessions"
      )
    );

    for (
      const column of [
        "token_hash",
        "created_at",
        "expires_at"
      ]
    ) {
      assert.ok(
        REQUIRED_COLUMNS.some(
          ([table, name]) =>
            table ===
              "staff_app_sessions" &&
            name === column
        ),
        `missing staff_app_sessions.${column}`
      );
    }

    assert.ok(
      REQUIRED_INDEXES.includes(
        "staff_app_sessions_expires_at_idx"
      )
    );
  }
);
