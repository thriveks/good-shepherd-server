"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadRuntimeConfig
} = require("../../config/runtimeConfig");

function extractFunction(source, signature) {
  const start = source.indexOf(signature);

  assert.notEqual(
    start,
    -1,
    `Missing function: ${signature}`
  );

  const openBrace =
    source.indexOf("{", start);

  assert.notEqual(
    openBrace,
    -1,
    `Missing opening brace: ${signature}`
  );

  let depth = 0;

  for (
    let index = openBrace;
    index < source.length;
    index += 1
  ) {
    const character = source[index];

    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(
          start,
          index + 1
        );
      }
    }
  }

  assert.fail(
    `Unable to extract function: ${signature}`
  );
}

function compileFunction(
  source,
  signature,
  dependencies
) {
  const functionSource =
    extractFunction(
      source,
      signature
    );

  const names =
    Object.keys(dependencies);

  const values =
    Object.values(dependencies);

  return Function(
    ...names,
    `"use strict"; return (${functionSource});`
  )(...values);
}

function requestWith(headers = {}) {
  const normalized =
    Object.fromEntries(
      Object.entries(headers).map(
        ([key, value]) => [
          key.toLowerCase(),
          value
        ]
      )
    );

  return {
    header(name) {
      return normalized[
        String(name).toLowerCase()
      ] || "";
    }
  };
}

test(
  "runtime configuration loads a distinct service API secret",
  () => {
    const config =
      loadRuntimeConfig({
        NODE_ENV: "test",
        MQTT_BRIDGE_ENABLED: "false",
        WEBHOOK_SECRET: "device-secret",
        SERVICE_API_SECRET: "service-secret"
      });

    assert.equal(
      config.webhookSecret,
      "device-secret"
    );

    assert.equal(
      config.serviceApiSecret,
      "service-secret"
    );
  }
);

test(
  "configured service secret prevents the device secret from authorizing service APIs",
  () => {
    const server =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../server.js"
        ),
        "utf8"
      );

    const dependencies = {
      SERVICE_API_SECRET: "service-secret",
      WEBHOOK_SECRET: "device-secret",
      runtimeConfig: {
        isProduction: true
      },
      cleanText(value) {
        return String(
          value ?? ""
        ).trim();
      },
      constantTimeTextEqual(
        first,
        second
      ) {
        return (
          String(first || "") ===
          String(second || "") &&
          String(first || "").length > 0
        );
      }
    };

    const serviceAuth =
      compileFunction(
        server,
        "function isAuthorizedServiceRequest(req)",
        dependencies
      );

    const deviceAuth =
      compileFunction(
        server,
        "function isAuthorizedDeviceSecretRequest(req)",
        dependencies
      );

    assert.equal(
      serviceAuth(
        requestWith({
          "x-service-secret":
            "service-secret"
        })
      ),
      true
    );

    assert.equal(
      serviceAuth(
        requestWith({
          "x-webhook-secret":
            "device-secret"
        })
      ),
      false
    );

    assert.equal(
      deviceAuth(
        requestWith({
          "x-webhook-secret":
            "device-secret"
        })
      ),
      true
    );

    assert.equal(
      deviceAuth(
        requestWith({
          "x-service-secret":
            "service-secret"
        })
      ),
      false
    );
  }
);

test(
  "device secret remains limited to explicitly device-facing compatibility paths",
  () => {
    const server =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../server.js"
        ),
        "utf8"
      );

    const webhookAuth =
      extractFunction(
        server,
        "function isAuthorizedWebhook(req)"
      );

    const firmwareAuth =
      extractFunction(
        server,
        "async function requireFirmwareMetadataRequest(req, res)"
      );

    assert.match(
      webhookAuth,
      /isAuthorizedDeviceSecretRequest/
    );

    assert.match(
      firmwareAuth,
      /isAuthorizedDeviceSecretRequest/
    );

    assert.match(
      server,
      /app\.get\("\/sensor-commands\/:nodeId\/pending"[\s\S]{0,300}requireDeviceAuthorizedRequest/
    );

    assert.match(
      server,
      /app\.post\("\/sensor-commands\/:commandId\/result"[\s\S]{0,300}requireDeviceAuthorizedRequest/
    );

    assert.match(
      server,
      /app\.get\("\/ai\/dashboard"[\s\S]{0,300}requireAuthorizedRequest/
    );

    assert.match(
      server,
      /app\.patch\("\/nodes\/:nodeId"[\s\S]{0,300}requireAuthorizedRequest/
    );
  }
);
