"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAIBriefingService } = require("../../services/aiBriefingService");

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

test("AI briefing preserves priority grouping, counts, and resident payloads", () => {
  const { buildAIBriefingFromSummary } = createAIBriefingService({
    cleanText,
    normalizeInteger
  });

  const result = buildAIBriefingFromSummary({
    generatedAt: "2026-09-26T12:00:00.000Z",
    residents: [
      {
        residentId: "resident-normal",
        residentName: "Alice",
        actionLevel: "normal",
        aiLevel: "normal",
        followUpStatus: "logged",
        sensorCount: 2,
        onlineSensorCount: 2,
        offlineSensorCount: 0,
        motionCountToday: 10,
        motionCountLastHour: 2,
        latestPresenceState: true
      },
      {
        residentId: "resident-technical",
        residentName: "Bob",
        actionLevel: "technical",
        aiLevel: "sensor issue",
        followUpStatus: "logged",
        sensorCount: 2,
        onlineSensorCount: 1,
        offlineSensorCount: 1,
        motionCountToday: 4,
        motionCountLastHour: 1,
        latestPresenceState: false
      },
      {
        residentId: "resident-immediate",
        residentName: "Cara",
        actionLevel: "immediate",
        aiLevel: "critical",
        followUpStatus: "due now",
        sensorCount: 1,
        onlineSensorCount: 1,
        offlineSensorCount: 0,
        motionCountToday: 7,
        motionCountLastHour: 3,
        latestPresenceState: true,
        recentCriticalOpenAlertCount: 2
      },
      {
        residentId: "resident-setup",
        residentName: "Dan",
        actionLevel: "setup",
        aiLevel: "setup needed",
        followUpStatus: "not logged",
        sensorCount: 0,
        onlineSensorCount: 0,
        offlineSensorCount: 0,
        motionCountToday: 0,
        motionCountLastHour: 0,
        latestPresenceState: null
      }
    ]
  });

  assert.equal(result.success, true);
  assert.equal(result.sourceGeneratedAt, "2026-09-26T12:00:00.000Z");
  assert.equal(result.overallLevel, "Immediate");
  assert.equal(result.headline, "1 follow-up item(s) are due now or overdue.");

  assert.deepEqual(result.counts, {
    residentCount: 4,
    normalCount: 1,
    nonNormalActionCount: 3,
    followUpDueCount: 1,
    unloggedFollowUpCount: 1,
    technicalCount: 1,
    setupNeededCount: 1,
    residentReviewCount: 1,
    offlineSensorCount: 1,
    motionCountToday: 21,
    motionCountLastHour: 6,
    activePresenceCount: 2
  });

  assert.equal(result.topPriorities[0].residentId, "resident-immediate");
  assert.equal(result.topPriorities[0].priorityLevel, "Immediate");
  assert.equal(result.technicalResidents[0].residentId, "resident-technical");
  assert.equal(result.technicalResidents[0].sensorSummary, "1 online / 1 offline");
  assert.equal(result.setupResidents[0].residentId, "resident-setup");
  assert.equal(result.setupResidents[0].sensorSummary, "No ESP32 motion sensors assigned");
});
