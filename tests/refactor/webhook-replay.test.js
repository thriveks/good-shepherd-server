"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildSignedWebhookReplayFingerprint,
  createWebhookEventService
} = require(
  "../../services/webhookEventService"
);

const root =
  path.resolve(__dirname, "../..");

function read(relativePath) {
  return fs.readFileSync(
    path.join(root, relativePath),
    "utf8"
  );
}

test(
  "signed webhook fingerprint is deterministic and does not store the signature directly",
  () => {
    const signature =
      "a".repeat(64);

    const first =
      buildSignedWebhookReplayFingerprint(
        "1790712000",
        `sha256=${signature}`
      );

    const second =
      buildSignedWebhookReplayFingerprint(
        "1790712000",
        signature
      );

    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, second);
    assert.notEqual(first, signature);

    assert.notEqual(
      buildSignedWebhookReplayFingerprint(
        "1790712001",
        signature
      ),
      first
    );
  }
);

test(
  "known signed webhook replay returns the existing event before side effects",
  async () => {
    const fingerprint = "b".repeat(64);
    const sideEffects = [];

    const existingEvent = {
      id: "existing-event-id",
      nodeId: "esp32-existing",
      message: "Presence detected",
      eventType: "presence_detected"
    };

    const pool = {
      async query(sql, params = []) {
        const normalized =
          String(sql)
            .replace(/\s+/g, " ")
            .trim();

        if (
          normalized.includes(
            "WHERE request_fingerprint = $1"
          )
        ) {
          assert.deepEqual(
            params,
            [fingerprint]
          );

          return {
            rowCount: 1,
            rows: [existingEvent]
          };
        }

        throw new Error(
          `Unexpected SQL in replay test: ${normalized}`
        );
      }
    };

    const failIfCalled =
      async (name) => {
        sideEffects.push(name);
        throw new Error(
          `${name} should not run for a replay`
        );
      };

    const service =
      createWebhookEventService({
        pool,
        cleanText: (value) =>
          String(value ?? "").trim(),
        normalizeJsonObject: (value) =>
          value || {},
        normalizeWebhookEventTypeFromPayload:
          () => "presence_detected",
        normalizeWebhookSensorTypeFromPayload:
          () => "human_presence",
        displaySensorTypeForValue:
          () => "Human Presence",
        getDeviceMapping:
          () => failIfCalled("getDeviceMapping"),
        touchNodeFromWebhook:
          () => failIfCalled("touchNodeFromWebhook"),
        getExistingSensorForDeviceIdentity:
          () => failIfCalled(
            "getExistingSensorForDeviceIdentity"
          ),
        assignmentAuthorityProtectsServerState:
          () => false,
        sensorIsExplicitlyUnassigned:
          () => false,
        isEsp32NodeId:
          () => true,
        findOrCreateResidentFromEvent:
          () => failIfCalled(
            "findOrCreateResidentFromEvent"
          ),
        upsertSensorFromEvent:
          () => failIfCalled(
            "upsertSensorFromEvent"
          ),
        getResidentById:
          () => failIfCalled("getResidentById"),
        recordMotionHistoryEvent:
          () => failIfCalled(
            "recordMotionHistoryEvent"
          ),
        incrementResidentDailyActivity:
          () => failIfCalled(
            "incrementResidentDailyActivity"
          ),
        scheduleAIDashboardRefresh:
          () => sideEffects.push(
            "scheduleAIDashboardRefresh"
          ),
        logStructuredDiagnostic:
          () => sideEffects.push(
            "logStructuredDiagnostic"
          )
      });

    const result =
      await service.processWebhookEvent(
        {
          message: "Presence detected"
        },
        {
          requestFingerprint: fingerprint
        }
      );

    assert.equal(result.duplicate, true);
    assert.equal(
      result.event.id,
      "existing-event-id"
    );

    assert.deepEqual(
      sideEffects,
      []
    );
  }
);

test(
  "replay migration is pre-deploy wired and required before server readiness",
  () => {
    const server = read("server.js");
    const migrate = read("scripts/migrate.js");
    const migration = read(
      "scripts/migrations/" +
      "2026-09-30-webhook-replay-fingerprint-v1.js"
    );
    const service = read(
      "services/webhookEventService.js"
    );

    assert.match(
      server,
      /2026-09-30-webhook-replay-fingerprint-v1/
    );

    assert.match(
      migrate,
      /webhookReplayFingerprintV1Migration/
    );

    assert.match(
      migration,
      /ADD COLUMN IF NOT EXISTS\s+request_fingerprint TEXT/
    );

    assert.match(
      migration,
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+webhook_events_request_fingerprint_unique_idx/
    );

    assert.match(
      service,
      /request_fingerprint/
    );

    assert.match(
      service,
      /pg_advisory_xact_lock\(hashtext\(\$1\)\)/
    );

    assert.match(
      service,
      /findWebhookEventByRequestFingerprint\([\s\S]*requestFingerprint,[\s\S]*client/
    );
  }
);
