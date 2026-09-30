"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  internalServiceAuthorization
} = require(
  "../../lib/human_presence_adaptive_capture_controller_v1"
);

test(
  "adaptive capture prefers the dedicated service API credential",
  () => {
    const auth =
      internalServiceAuthorization({
        serviceApiSecret:
          "service-secret",
        webhookSecret:
          "device-secret"
      });

    assert.deepEqual(
      auth,
      {
        headerName:
          "x-service-secret",
        secret:
          "service-secret",
        mode:
          "service"
      }
    );
  }
);

test(
  "adaptive capture retains webhook-secret compatibility before service-secret activation",
  () => {
    const auth =
      internalServiceAuthorization({
        serviceApiSecret: "",
        webhookSecret:
          "device-secret"
      });

    assert.deepEqual(
      auth,
      {
        headerName:
          "x-webhook-secret",
        secret:
          "device-secret",
        mode:
          "compatibility"
      }
    );

    assert.equal(
      internalServiceAuthorization({
        serviceApiSecret: "",
        webhookSecret: ""
      }),
      null
    );
  }
);

test(
  "adaptive capture internal HTTP and startup paths use the shared credential selector",
  () => {
    const controller =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../lib/human_presence_adaptive_capture_controller_v1.js"
        ),
        "utf8"
      );

    const postStart =
      controller.indexOf(
        "function postSensorCommand(body)"
      );

    const postEnd =
      controller.indexOf(
        "\nasync function",
        postStart
      );

    assert.notEqual(
      postStart,
      -1
    );

    assert.notEqual(
      postEnd,
      -1
    );

    const postBlock =
      controller.slice(
        postStart,
        postEnd
      );

    assert.match(
      postBlock,
      /internalServiceAuthorization\(\)/
    );

    assert.match(
      postBlock,
      /\[authorization\.headerName\]/
    );

    assert.match(
      postBlock,
      /authorization\.secret/
    );

    assert.doesNotMatch(
      postBlock,
      /"x-webhook-secret"\s*:/
    );

    const runTickStart =
      controller.indexOf(
        "async function runTick()"
      );

    const runTickEnd =
      controller.indexOf(
        "\nfunction startHumanPresenceAdaptiveCaptureControllerV1",
        runTickStart
      );

    const runTickBlock =
      controller.slice(
        runTickStart,
        runTickEnd
      );

    assert.match(
      runTickBlock,
      /!internalServiceAuthorization\(\)/
    );

    const startupStart =
      controller.indexOf(
        "function startHumanPresenceAdaptiveCaptureControllerV1()"
      );

    const startupBlock =
      controller.slice(
        startupStart
      );

    assert.match(
      startupBlock,
      /!internalServiceAuthorization\(\)/
    );

    const renderYaml =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../render.yaml"
        ),
        "utf8"
      );

    assert.match(
      renderYaml,
      /- key: SERVICE_API_SECRET\s+sync: false/
    );
  }
);
