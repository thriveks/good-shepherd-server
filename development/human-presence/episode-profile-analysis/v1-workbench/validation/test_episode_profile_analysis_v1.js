"use strict";

const assert = require("assert");

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION,
  HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS,
  parseProfile,
  analyzeEpisodeProfile,
} = require("../../../../../lib/human_presence_episode_profile_analysis_v1");

const fields = HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS;

function profile(base) {
  return Object.fromEntries(
    fields.map((name, index) => [name, base + index])
  );
}

assert.strictEqual(fields.length, 12);

const zeroHistory = analyzeEpisodeProfile({
  evidenceEventId: "event-zero",
  evidenceSchemaVersion: "1.1",
  episodeProfile: profile(10),
  evidenceReceivedAt: "2026-09-06T00:00:00Z",
  history: [],
});

assert.strictEqual(
  zeroHistory.episodeProfileAnalysisVersion,
  HUMAN_PRESENCE_EPISODE_PROFILE_ANALYSIS_VERSION
);
assert.strictEqual(zeroHistory.observerOnly, true);
assert.strictEqual(zeroHistory.dimensionCount, 12);
assert.strictEqual(zeroHistory.historyCount, 0);
assert.strictEqual(zeroHistory.profileMeanRelativeDelta, null);

for (const name of fields) {
  assert.strictEqual(
    zeroHistory.dimensions[name]
      .currentVsHistoryMeanRelativeDelta,
    null
  );
}

const result = analyzeEpisodeProfile({
  evidenceEventId: "event-current",
  evidenceSchemaVersion: "1.1",
  episodeProfile: profile(20),
  evidenceReceivedAt: "2026-09-06T00:03:00Z",
  history: [
    {
      episodeProfile: profile(10),
      receivedAt: "2026-09-06T00:01:00Z",
    },
    {
      episodeProfile: profile(14),
      receivedAt: "2026-09-06T00:02:00Z",
    },
  ],
});

assert.strictEqual(result.historyCount, 2);
assert.strictEqual(result.dimensionCount, 12);
assert.strictEqual(result.observerOnly, true);
assert.ok(Number.isFinite(result.profileMeanRelativeDelta));

const first = result.dimensions[fields[0]];
assert.strictEqual(first.current, 20);
assert.strictEqual(first.historyMin, 10);
assert.strictEqual(first.historyMax, 14);
assert.strictEqual(first.historyMean, 12);
assert.strictEqual(first.historyMedian, 12);
assert.strictEqual(first.historyRange, 4);
assert.ok(
  Math.abs(first.currentVsHistoryMeanRelativeDelta - 0.4) <
    1e-12
);

assert.throws(
  () =>
    analyzeEpisodeProfile({
      evidenceEventId: "bad-schema",
      evidenceSchemaVersion: "1.0",
      episodeProfile: profile(1),
    }),
  /Schema 1.1/
);

const missing = profile(1);
delete missing[fields[3]];

assert.throws(
  () =>
    analyzeEpisodeProfile({
      evidenceEventId: "missing-field",
      evidenceSchemaVersion: "1.1",
      episodeProfile: missing,
    }),
  /invalid finite numeric dimension/
);

const invalid = profile(1);
invalid[fields[4]] = "not-a-number";

assert.throws(
  () =>
    analyzeEpisodeProfile({
      evidenceEventId: "invalid-field",
      evidenceSchemaVersion: "1.1",
      episodeProfile: invalid,
    }),
  /invalid finite numeric dimension/
);

for (const forbidden of [
  "operationalClassification",
  "alertLevel",
  "monitoringAction",
  "fall",
  "emergency",
  "medical",
  "dispatch",
]) {
  assert.strictEqual(
    JSON.stringify(result).includes(forbidden),
    false
  );
}

console.log("PASS: 12-dimensional profile contract");
console.log("PASS: zero-history behavior");
console.log("PASS: descriptive history statistics");
console.log("PASS: normalized profile delta");
console.log("PASS: invalid evidence rejection");
console.log("PASS: operational fields absent");
console.log("PASS: Episode Profile Analysis v1 pure module");

{
  const strictNumericProfile = {};

  for (const key of HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS) {
    strictNumericProfile[key] = 1;
  }

  for (const invalidValue of [
    null,
    "",
    "1",
    undefined,
    NaN,
    Infinity,
    -Infinity
  ]) {
    const invalidProfile = {
      ...strictNumericProfile,
      movingPctMean: invalidValue
    };

    assert.throws(
      () => parseProfile(invalidProfile),
      /invalid finite numeric dimension/,
      `strict numeric rejection failed for ${String(invalidValue)}`
    );
  }

  console.log("PASS: strict numeric evidence contract");
}
