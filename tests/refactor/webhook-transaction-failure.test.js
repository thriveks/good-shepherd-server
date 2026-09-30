"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWebhookEventService
} = require(
  "../../services/webhookEventService"
);

function baseDependencies(
  overrides = {}
) {
  return {
    cleanText(value) {
      return String(
        value ?? ""
      ).trim();
    },

    normalizeJsonObject(value) {
      return value || {};
    },

    normalizeWebhookEventTypeFromPayload() {
      return "motion";
    },

    normalizeWebhookSensorTypeFromPayload() {
      return "motion";
    },

    displaySensorTypeForValue() {
      return "Motion Sensor";
    },

    assignmentAuthorityProtectsServerState() {
      return false;
    },

    sensorIsExplicitlyUnassigned() {
      return false;
    },

    isEsp32NodeId() {
      return false;
    },

    logStructuredDiagnostic() {},

    logger: {
      error() {}
    },

    ...overrides
  };
}

function webhookBody() {
  return {
    nodeId: "node-test",
    sourceKey: "sensor-test",
    sourceName: "Motion Sensor",
    residentName: "Test Resident",
    locationName: "Test Home",
    alertLevel: "Normal",
    message: "Motion detected",
    eventType: "motion",
    sensorType: "motion"
  };
}

test(
  "late ingestion failure escapes transaction and suppresses post-commit work",
  async () => {
    const fingerprint =
      "c".repeat(64);

    const transactionClient = {
      async query(sql) {
        const normalized =
          String(sql)
            .replace(/\s+/g, " ")
            .trim();

        if (
          normalized.includes(
            "pg_advisory_xact_lock"
          )
        ) {
          return {
            rowCount: 1,
            rows: []
          };
        }

        if (
          normalized.includes(
            "WHERE request_fingerprint = $1"
          )
        ) {
          return {
            rowCount: 0,
            rows: []
          };
        }

        if (
          normalized.includes(
            "INSERT INTO webhook_events"
          )
        ) {
          return {
            rowCount: 1,
            rows: []
          };
        }

        throw new Error(
          `Unexpected transaction SQL: ${normalized}`
        );
      }
    };

    const pool = {
      async query(sql) {
        const normalized =
          String(sql)
            .replace(/\s+/g, " ")
            .trim();

        if (
          normalized.includes(
            "WHERE request_fingerprint = $1"
          )
        ) {
          return {
            rowCount: 0,
            rows: []
          };
        }

        throw new Error(
          `Unexpected pool SQL: ${normalized}`
        );
      }
    };

    let transactionFailed = false;
    let postCommitRefreshes = 0;
    let dailyAttempts = 0;
    const helperClients = [];

    const service =
      createWebhookEventService(
        baseDependencies({
          pool,

          async withTransaction(work) {
            try {
              return await work(
                transactionClient
              );
            } catch (error) {
              transactionFailed = true;
              throw error;
            }
          },

          async getDeviceMapping(
            sourceKey,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return null;
          },

          async touchNodeFromWebhook(
            nodeId,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return {
              nodeId
            };
          },

          async getExistingSensorForDeviceIdentity(
            identity,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return null;
          },

          async findOrCreateResidentFromEvent(
            payload,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return {
              id: "resident-test",
              name: payload.residentName,
              location:
                payload.locationName
            };
          },

          async upsertSensorFromEvent(
            payload,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return {
              id: "sensor-row",
              nodeId: payload.nodeId,
              sourceKey:
                payload.sourceKey,
              sourceName:
                payload.sourceName,
              residentId:
                "resident-test",
              residentName:
                payload.residentName,
              locationName:
                payload.locationName,
              roomName:
                "Test Room"
            };
          },

          async getResidentById() {
            throw new Error(
              "getResidentById should not be needed"
            );
          },

          async recordMotionHistoryEvent(
            payload,
            queryable
          ) {
            helperClients.push(
              queryable
            );

            return {
              id: "motion-test"
            };
          },

          async incrementResidentDailyActivity(
            payload,
            queryable
          ) {
            dailyAttempts += 1;

            helperClients.push(
              queryable
            );

            throw new Error(
              "forced daily aggregation failure"
            );
          },

          scheduleAIDashboardRefresh() {
            postCommitRefreshes += 1;
          }
        })
      );

    await assert.rejects(
      service.processWebhookEvent(
        webhookBody(),
        {
          requestFingerprint:
            fingerprint
        }
      ),
      /forced daily aggregation failure/
    );

    assert.equal(
      transactionFailed,
      true
    );

    assert.equal(
      dailyAttempts,
      1
    );

    assert.equal(
      postCommitRefreshes,
      0
    );

    assert.equal(
      service.getAcceptedWebhookCount(),
      0
    );

    assert.ok(
      helperClients.length >= 5
    );

    assert.equal(
      helperClients.every(
        (client) =>
          client ===
          transactionClient
      ),
      true
    );
  }
);

test(
  "in-transaction replay check prevents duplicate state mutation when fast check misses",
  async () => {
    const fingerprint =
      "d".repeat(64);

    let storedEvent = null;

    const mutationCounts = {
      mapping: 0,
      node: 0,
      sensorLookup: 0,
      resident: 0,
      sensor: 0,
      motion: 0,
      daily: 0,
      refresh: 0
    };

    const pool = {
      async query(sql) {
        const normalized =
          String(sql)
            .replace(/\s+/g, " ")
            .trim();

        /*
         * Simulate the race window:
         * both request-time fast checks miss.
         */
        if (
          normalized.includes(
            "WHERE request_fingerprint = $1"
          )
        ) {
          return {
            rowCount: 0,
            rows: []
          };
        }

        throw new Error(
          `Unexpected pool SQL: ${normalized}`
        );
      }
    };

    const transactionClient = {
      async query(
        sql,
        params = []
      ) {
        const normalized =
          String(sql)
            .replace(/\s+/g, " ")
            .trim();

        if (
          normalized.includes(
            "pg_advisory_xact_lock"
          )
        ) {
          return {
            rowCount: 1,
            rows: []
          };
        }

        if (
          normalized.includes(
            "WHERE request_fingerprint = $1"
          )
        ) {
          return {
            rowCount:
              storedEvent ? 1 : 0,

            rows:
              storedEvent
                ? [storedEvent]
                : []
          };
        }

        if (
          normalized.includes(
            "INSERT INTO webhook_events"
          )
        ) {
          storedEvent = {
            id: params[0],
            nodeId: params[1],
            locationName: params[2],
            sourceKey: params[3],
            sourceName: params[4],
            residentName: params[5],
            message: params[6],
            alertLevel: params[7],
            timeText: params[8],
            timestamp: params[9],
            eventType: params[10],
            sensorType: params[11],
            eventPayload:
              JSON.parse(params[12])
          };

          return {
            rowCount: 1,
            rows: []
          };
        }

        throw new Error(
          `Unexpected transaction SQL: ${normalized}`
        );
      }
    };

    const service =
      createWebhookEventService(
        baseDependencies({
          pool,

          async withTransaction(work) {
            return work(
              transactionClient
            );
          },

          async getDeviceMapping() {
            mutationCounts.mapping += 1;
            return null;
          },

          async touchNodeFromWebhook() {
            mutationCounts.node += 1;
          },

          async getExistingSensorForDeviceIdentity() {
            mutationCounts.sensorLookup += 1;
            return null;
          },

          async findOrCreateResidentFromEvent(
            payload
          ) {
            mutationCounts.resident += 1;

            return {
              id: "resident-test",
              name:
                payload.residentName,
              location:
                payload.locationName
            };
          },

          async upsertSensorFromEvent(
            payload
          ) {
            mutationCounts.sensor += 1;

            return {
              id: "sensor-test",
              nodeId:
                payload.nodeId,
              sourceKey:
                payload.sourceKey,
              sourceName:
                payload.sourceName,
              residentId:
                "resident-test",
              residentName:
                payload.residentName,
              locationName:
                payload.locationName,
              roomName:
                "Test Room"
            };
          },

          async getResidentById() {
            throw new Error(
              "getResidentById should not run"
            );
          },

          async recordMotionHistoryEvent() {
            mutationCounts.motion += 1;

            return {
              id: "motion-test"
            };
          },

          async incrementResidentDailyActivity() {
            mutationCounts.daily += 1;
          },

          scheduleAIDashboardRefresh() {
            mutationCounts.refresh += 1;
          }
        })
      );

    const first =
      await service.processWebhookEvent(
        webhookBody(),
        {
          requestFingerprint:
            fingerprint
        }
      );

    const second =
      await service.processWebhookEvent(
        webhookBody(),
        {
          requestFingerprint:
            fingerprint
        }
      );

    assert.notEqual(
      first.duplicate,
      true
    );

    assert.equal(
      second.duplicate,
      true
    );

    assert.equal(
      second.event.id,
      first.event.id
    );

    assert.deepEqual(
      mutationCounts,
      {
        mapping: 1,
        node: 1,
        sensorLookup: 1,
        resident: 1,
        sensor: 1,
        motion: 1,
        daily: 1,
        refresh: 1
      }
    );

    assert.equal(
      service.getAcceptedWebhookCount(),
      1
    );
  }
);
