const assert = require("assert");

const {
  HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS
} = require("../../../../../lib/human_presence_episode_profile_analysis_v1");

const {
  buildAndPersistHumanPresenceEpisodeProfileAnalysisV1
} = require("../../../../../lib/human_presence_episode_profile_analysis_persistence_v1");

function profile(base) {
  const p = {};
  HUMAN_PRESENCE_EPISODE_PROFILE_DIMENSIONS.forEach((name, i) => {
    p[name] = base + i;
  });
  return p;
}

const residentId = "11111111-1111-4111-8111-111111111111";
const sensorId = "22222222-2222-4222-8222-222222222222";

const current = {
  evidence_event_id: "current-event",
  authoritative_sensor_id: sensorId,
  authoritative_resident_id: residentId,
  authoritative_resident_name: "Fixture Resident",
  authoritative_room_or_location: "Fixture Room",
  authority_resolution_status: "resolved_assigned_sensor",
  assignment_authority: "resolved_assigned_sensor",
  evidence_schema_version: "1.1",
  evidence_received_at: new Date("2026-09-06T00:10:00Z"),
  event_payload: {
    episodeProfile: profile(10)
  }
};

const goodHistory = {
  evidence_event_id: "prior-good",
  evidence_schema_version: "1.1",
  received_at: new Date("2026-09-06T00:00:00Z"),
  event_payload: {
    episodeProfile: profile(8)
  }
};

const malformedHistory = {
  evidence_event_id: "prior-malformed",
  evidence_schema_version: "1.1",
  received_at: new Date("2026-09-05T23:50:00Z"),
  event_payload: {
    episodeProfile: {
      ...profile(7),
      movingPctMean: null
    }
  }
};

const calls = [];

const db = {
  async query(sql, params = []) {
    calls.push({ sql, params });

    if (
      sql.includes("candidate_history_evidence_events") &&
      sql.includes("SELECT")
    ) {
      assert(sql.includes("authoritative_resident_id = $1"));
      assert(sql.includes("authoritative_room_or_location = $2"));
      assert(sql.includes("resolved_assigned_sensor"));
      assert(sql.includes("evidence_schema_version = '1.1'"));
      assert(!/node_id\s*=/.test(sql));

      assert.strictEqual(params[0], residentId);
      assert.strictEqual(params[1], "Fixture Room");

      return {
        rowCount: 2,
        rows: [malformedHistory, goodHistory]
      };
    }

    if (
      sql.includes("INSERT INTO human_presence_episode_profile_analyses")
    ) {
      assert(sql.includes("ON CONFLICT"));

      const payload = JSON.parse(params.find(
        value =>
          typeof value === "string" &&
          value.includes("episodeProfileAnalysisVersion")
      ));

      assert.strictEqual(payload.observerOnly, true);
      assert.strictEqual(payload.dimensionCount, 12);
      assert.strictEqual(payload.historyCount, 1);
      assert(!("operationalClassification" in payload));
      assert(!("alertLevel" in payload));
      assert(!("monitoringAction" in payload));

      return { rowCount: 1, rows: [] };
    }

    throw new Error("Unexpected SQL in deterministic persistence test");
  }
};

(async () => {
  const result =
    await buildAndPersistHumanPresenceEpisodeProfileAnalysisV1(
      db,
      current
    );

  assert(result);
  assert(result.episodeProfileAnalysis);
  assert.strictEqual(
    result.episodeProfileAnalysis.observerOnly,
    true
  );
  assert.strictEqual(
    result.episodeProfileAnalysis.dimensionCount,
    12
  );
  assert.strictEqual(
    result.episodeProfileAnalysis.historyCount,
    1
  );
  assert.strictEqual(result.persistence.inserted, true);

  console.log("PASS: persistence execution path");
  console.log("PASS: resident/location cohort parameters");
  console.log("PASS: malformed historical profile excluded");
  console.log("PASS: 12-dimensional analysis persisted");
  console.log("PASS: idempotent insert contract");
  console.log("PASS: operational boundary preserved");
})().catch(error => {
  console.error(error);
  process.exit(1);
});
