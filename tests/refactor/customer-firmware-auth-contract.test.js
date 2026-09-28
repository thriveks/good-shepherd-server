"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

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
    const character =
      source[index];

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

test(
  "latest firmware metadata accepts authenticated customer sessions without broadening staff APIs",
  () => {
    const server =
      fs.readFileSync(
        path.resolve(
          __dirname,
          "../../server.js"
        ),
        "utf8"
      );

    const generalAuth =
      extractFunction(
        server,
        "async function requireAuthorizedRequest(req, res)"
      );

    const firmwareAuth =
      extractFunction(
        server,
        "async function requireFirmwareMetadataRequest(req, res)"
      );

    assert.match(
      generalAuth,
      /isAuthorizedStaffOrServiceRequest/
    );

    assert.doesNotMatch(
      generalAuth,
      /authenticatedCustomerSession/
    );

    assert.match(
      firmwareAuth,
      /isAuthorizedStaffOrServiceRequest/
    );

    assert.match(
      firmwareAuth,
      /authenticatedCustomerSession/
    );

    assert.match(
      server,
      /app\.get\("\/firmware\/latest"[\s\S]{0,500}await requireFirmwareMetadataRequest/
    );

    assert.match(
      server,
      /app\.get\("\/ai\/dashboard"[\s\S]{0,500}await requireAuthorizedRequest/
    );

    assert.match(
      server,
      /app\.get\("\/ai\/human-presence-learning"[\s\S]{0,500}await requireAuthorizedRequest/
    );
  }
);
