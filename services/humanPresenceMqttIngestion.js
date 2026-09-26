"use strict";

const { randomUUID } = require("crypto");

const {
  HUMAN_PRESENCE_INTERPRETATION_VERSION,
  interpretHumanPresenceCandidateEvidenceV1
} = require("../lib/human_presence_interpretation_v1");

const {
  resolveHumanPresenceInterpretationAuthorityV1
} = require("../lib/human_presence_interpretation_authority_v1");

const {
  HUMAN_PRESENCE_INTERPRETATION_VERSION:
    HUMAN_PRESENCE_PERSISTENCE_VERSION,
  HUMAN_PRESENCE_INTERPRETATION_INSERT_SQL
} = require("../lib/human_presence_interpretation_persistence_v1");

const {
  buildAndPersistHumanPresenceDecisionReadinessV1
} = require("../lib/human_presence_decision_readiness_persistence_v1");

const {
  buildAndPersistHumanPresenceBehavioralObservationV1
} = require("../lib/human_presence_behavioral_observation_persistence_v1");

const {
  buildAndPersistHumanPresenceBehavioralPatternAnalysisV1
} = require("../lib/human_presence_behavioral_pattern_analysis_persistence_v1");

const {
  buildAndPersistHumanPresenceEpisodeProfileAnalysisV1
} = require("../lib/human_presence_episode_profile_analysis_persistence_v1");

const {
  buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1
} = require("../lib/human_presence_episode_profile_pattern_analysis_persistence_v1");

const {
  buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1
} = require("../lib/human_presence_episode_profile_temporal_context_analysis_persistence_v1");

const {
  buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1
} = require("../lib/human_presence_temporal_context_data_sufficiency_persistence_v1");

const {
  buildAndPersistHumanPresenceCandidateInterpretationRulesV1
} = require("../lib/human_presence_candidate_interpretation_rules_persistence_v1");

const {
  buildAndPersistHumanPresenceNonOperationalInterpretationV1
} = require("../lib/human_presence_non_operational_interpretation_persistence_v1");

const {
  buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1
} = require("../lib/human_presence_longitudinal_interpretation_validation_persistence_v1");

const {
  buildAndPersistHumanPresenceEngineeringFeatureV1
} = require("../lib/human_presence_engineering_feature_persistence_v1");

const {
  buildAndPersistHumanPresenceSpatialSignatureV1
} = require("../lib/human_presence_spatial_signature_persistence_v1");

const {
  buildAndPersistHumanPresenceSpatialStateLearningV1
} = require("../lib/human_presence_spatial_state_learning_persistence_v1");

const {
  buildAndPersistHumanPresenceSpatialTemporalLearningV1
} = require("../lib/human_presence_spatial_temporal_learning_persistence_v1");

const {
  buildAndPersistHumanPresenceSpatialRhythmLearningV1
} = require("../lib/human_presence_spatial_rhythm_learning_persistence_v1");

function candidateHistoryEvidenceInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0
    ? number
    : null;
}

function createHumanPresenceMqttIngestion({
  pool,
  cleanText,
  normalizeJsonObject,
  logger = console
}) {
  if (!pool || typeof pool.query !== "function") {
    throw new Error("Human Presence MQTT ingestion requires a database pool");
  }

  async function insertCandidateHistoryEvidence(nodeId, payload) {
    const normalizedPayload = normalizeJsonObject(payload);
    const eventType = cleanText(normalizedPayload.eventType).toLowerCase();

    if (eventType !== "candidate_history_evidence") {
      throw new Error(
        `Unexpected candidate-history evidence event type: ${eventType || "missing"}`
      );
    }

    const eventId = cleanText(normalizedPayload.eventId);
    const resolvedNodeId = cleanText(nodeId || normalizedPayload.nodeId);
    const protocolVersion = cleanText(normalizedPayload.protocolVersion);
    const evidenceSchemaVersion = cleanText(
      normalizedPayload.evidenceSchemaVersion
    );

    const episodeId = candidateHistoryEvidenceInteger(
      normalizedPayload.episodeId
    );
    const historyCount = candidateHistoryEvidenceInteger(
      normalizedPayload.historyCount
    );
    const priorCount = candidateHistoryEvidenceInteger(
      normalizedPayload.priorCount
    );
    const dimensions = candidateHistoryEvidenceInteger(
      normalizedPayload.dimensions
    );

    if (!eventId) {
      throw new Error("candidate_history_evidence missing eventId");
    }
    if (!resolvedNodeId) {
      throw new Error("candidate_history_evidence missing nodeId");
    }
    if (protocolVersion !== "2.0") {
      throw new Error(
        `candidate_history_evidence unsupported protocolVersion: ${
          protocolVersion || "missing"
        }`
      );
    }
    if (!["1.0", "1.1"].includes(evidenceSchemaVersion)) {
      throw new Error(
        `candidate_history_evidence unsupported evidenceSchemaVersion: ${
          evidenceSchemaVersion || "missing"
        }`
      );
    }
    if (episodeId === null) {
      throw new Error("candidate_history_evidence invalid episodeId");
    }
    if (historyCount === null || historyCount < 3) {
      throw new Error("candidate_history_evidence invalid historyCount");
    }
    if (priorCount === null || priorCount < 2) {
      throw new Error("candidate_history_evidence invalid priorCount");
    }
    if (dimensions !== 10) {
      throw new Error(
        `candidate_history_evidence dimensions must equal 10; received ${
          dimensions === null ? "invalid" : dimensions
        }`
      );
    }

    const insertResult = await pool.query(
      `
      INSERT INTO candidate_history_evidence_events (
        event_id,
        node_id,
        source_key,
        source_name,
        resident_name,
        location_name,
        software_version,
        protocol_version,
        evidence_schema_version,
        episode_id,
        history_count,
        prior_count,
        dimensions,
        event_payload,
        received_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13,
        $14::jsonb, NOW()
      )
      ON CONFLICT (event_id)
      DO NOTHING
      RETURNING *
      `,
      [
        eventId,
        resolvedNodeId,
        cleanText(normalizedPayload.sourceKey) || null,
        cleanText(normalizedPayload.sourceName) || null,
        cleanText(normalizedPayload.residentName) || null,
        cleanText(normalizedPayload.locationName) || null,
        cleanText(normalizedPayload.softwareVersion) || null,
        protocolVersion,
        evidenceSchemaVersion,
        episodeId,
        historyCount,
        priorCount,
        dimensions,
        JSON.stringify(normalizedPayload)
      ]
    );

    let persistedEvidence = insertResult.rows[0] || null;

    if (!persistedEvidence) {
      const existingResult = await pool.query(
        `
        SELECT *
        FROM candidate_history_evidence_events
        WHERE event_id = $1
          AND node_id = $2
        LIMIT 1
        `,
        [eventId, resolvedNodeId]
      );
      persistedEvidence = existingResult.rows[0] || null;
    }

    if (!persistedEvidence) {
      throw new Error(
        `candidate_history_evidence persistence failed for ${eventId}`
      );
    }

    return {
      eventId,
      inserted: insertResult.rowCount === 1,
      persistedEvidence
    };
  }

  async function interpretAndPersistCandidate(persistedEvidence) {
    if (!persistedEvidence) {
      throw new Error("Interpretation v1 requires persisted candidate evidence");
    }

    const rawPayload =
      persistedEvidence.event_payload &&
      typeof persistedEvidence.event_payload === "object"
        ? persistedEvidence.event_payload
        : {};

    const interpretation =
      interpretHumanPresenceCandidateEvidenceV1(rawPayload);

    if (
      interpretation.interpretationVersion !==
      HUMAN_PRESENCE_INTERPRETATION_VERSION
    ) {
      throw new Error("Interpretation v1 version mismatch");
    }

    const sourceKey = cleanText(persistedEvidence.source_key);
    const nodeId = cleanText(persistedEvidence.node_id);

    const sensorPromise = sourceKey
      ? pool.query(
          `
          SELECT
            s.id,
            s.node_id AS "nodeId",
            s.source_key AS "sourceKey",
            s.source_name AS "sourceName",
            s.sensor_type AS "sensorType",
            s.resident_id AS "residentId",
            s.resident_name AS "residentName",
            s.location_name AS "locationName",
            s.room_name AS "roomName",
            s.setup_state AS "setupState",
            s.assignment_authority AS "assignmentAuthority",
            s.is_active AS "isActive",
            s.is_deleted AS "isDeleted",
            r.id AS "joinedResidentId",
            r.name AS "joinedResidentName",
            r.is_deleted AS "joinedResidentIsDeleted"
          FROM sensors s
          LEFT JOIN residents r
            ON r.id = s.resident_id
          WHERE s.source_key = $1
          LIMIT 1
          `,
          [sourceKey]
        )
      : Promise.resolve({ rows: [] });

    const nodePromise = pool.query(
      `
      SELECT
        node_id AS "nodeId",
        location_name AS "locationName",
        setup_state AS "setupState",
        is_archived AS "isArchived"
      FROM nodes
      WHERE node_id = $1
      LIMIT 1
      `,
      [nodeId]
    );

    const [sensorResult, nodeResult] = await Promise.all([
      sensorPromise,
      nodePromise
    ]);

    const sensor = sensorResult.rows[0] || null;
    const resident = sensor?.residentId
      ? {
          id: sensor.joinedResidentId || sensor.residentId,
          name: sensor.joinedResidentName || sensor.residentName,
          isDeleted: sensor.joinedResidentIsDeleted === true
        }
      : null;
    const node = nodeResult.rows[0] || null;

    const authority =
      resolveHumanPresenceInterpretationAuthorityV1({
        evidence: {
          eventId: persistedEvidence.event_id,
          nodeId,
          sourceKey,
          sourceName: persistedEvidence.source_name,
          residentName: persistedEvidence.resident_name,
          locationName: persistedEvidence.location_name,
          softwareVersion: persistedEvidence.software_version
        },
        sensor,
        resident,
        node
      });

    const insertResult = await pool.query(
      HUMAN_PRESENCE_INTERPRETATION_INSERT_SQL,
      [
        persistedEvidence.event_id,
        HUMAN_PRESENCE_PERSISTENCE_VERSION,
        nodeId,
        sourceKey || null,
        authority.authoritativeSensorId || null,
        authority.authoritativeResidentId || null,
        authority.authoritativeResidentName || null,
        authority.authoritativeRoomOrLocation || null,
        authority.assignmentAuthority || null,
        authority.status,
        JSON.stringify({
          ...interpretation,
          authorityResolutionVersion:
            authority.authorityResolutionVersion,
          authorityResolutionStatus: authority.status,
          firmwareProvenance: authority.firmwareProvenance || null,
          nodeProvenance: authority.nodeProvenance || null,
          descriptiveOnly: true,
          operationalClassification: null,
          alertLevel: null,
          monitoringAction: null
        }),
        persistedEvidence.received_at || null
      ]
    );

    let persistedInterpretation = insertResult.rows[0] || null;

    if (!persistedInterpretation) {
      const existingResult = await pool.query(
        `
        SELECT *
        FROM human_presence_candidate_interpretations
        WHERE evidence_event_id = $1
          AND interpretation_version = $2
        LIMIT 1
        `,
        [
          persistedEvidence.event_id,
          HUMAN_PRESENCE_PERSISTENCE_VERSION
        ]
      );
      persistedInterpretation = existingResult.rows[0] || null;
    }

    if (!persistedInterpretation) {
      throw new Error(
        `Decision Readiness v1 cannot locate persisted interpretation ${persistedEvidence.event_id}`
      );
    }

    return {
      inserted: insertResult.rowCount > 0,
      authorityResolutionStatus: authority.status,
      persistedInterpretation
    };
  }

  async function loadPersistedDecisionReadiness(
    eventId,
    interpretationVersion,
    buildResult
  ) {
    if (buildResult?.persistence?.row) {
      return buildResult.persistence.row;
    }

    const result = await pool.query(
      `
      SELECT *
      FROM human_presence_decision_readiness
      WHERE evidence_event_id = $1
        AND interpretation_version = $2
        AND decision_readiness_version = $3
      LIMIT 1
      `,
      [
        eventId,
        interpretationVersion,
        "human_presence_decision_readiness_v1"
      ]
    );

    return result.rows[0] || null;
  }

  async function loadPersistedBehavioralObservation(eventId, buildResult) {
    if (buildResult?.persistence?.row) {
      return buildResult.persistence.row;
    }

    const result = await pool.query(
      `
      SELECT *
      FROM human_presence_behavioral_observations
      WHERE evidence_event_id = $1
        AND interpretation_version =
            'human_presence_candidate_interpretation_v1'
        AND decision_readiness_version =
            'human_presence_decision_readiness_v1'
        AND behavioral_observation_version =
            'human_presence_behavioral_observation_v1'
      LIMIT 1
      `,
      [eventId]
    );

    return result.rows[0] || null;
  }

  function evidenceWithAuthority(persistedEvidence, persistedInterpretation) {
    return {
      ...persistedEvidence,
      evidence_event_id: persistedEvidence.event_id,
      authoritative_sensor_id:
        persistedInterpretation.authoritative_sensor_id,
      authoritative_resident_id:
        persistedInterpretation.authoritative_resident_id,
      authoritative_resident_name:
        persistedInterpretation.authoritative_resident_name,
      authoritative_room_or_location:
        persistedInterpretation.authoritative_room_or_location,
      authority_resolution_status:
        persistedInterpretation.authority_resolution_status,
      assignment_authority:
        persistedInterpretation.assignment_authority,
      evidence_received_at: persistedEvidence.received_at
    };
  }

  async function runEpisodeProfileChain(eventId, persistedEvidence) {
    if (
      String(persistedEvidence.evidence_schema_version || "") !== "1.1" ||
      !persistedEvidence.event_payload?.episodeProfile
    ) {
      return null;
    }

    const profile =
      await buildAndPersistHumanPresenceEpisodeProfileAnalysisV1(
        pool,
        persistedEvidence
      );

    const pattern =
      await buildAndPersistHumanPresenceEpisodeProfilePatternAnalysisV1(
        pool,
        eventId
      );

    const temporal =
      await buildAndPersistHumanPresenceEpisodeProfileTemporalContextAnalysisV1(
        pool,
        eventId
      );

    const [sufficiency, rules] = await Promise.all([
      buildAndPersistHumanPresenceTemporalContextDataSufficiencyV1(
        pool,
        eventId
      ),
      buildAndPersistHumanPresenceCandidateInterpretationRulesV1(
        pool,
        eventId
      )
    ]);

    const nonOperational =
      await buildAndPersistHumanPresenceNonOperationalInterpretationV1(
        pool,
        eventId
      );

    const longitudinal =
      await buildAndPersistHumanPresenceLongitudinalInterpretationValidationV1(
        pool,
        eventId
      );

    return {
      profileInserted: profile.persistence.inserted,
      patternInserted: pattern.persistence.inserted,
      temporalInserted: temporal.persistence.inserted,
      sufficiencyInserted: sufficiency.persistence.inserted,
      rulesInserted: rules.persistence.inserted,
      nonOperationalInserted: nonOperational.persistence.inserted,
      longitudinalInserted: longitudinal.persistence.inserted,
      empiricalCalibrationStatus:
        sufficiency.temporalContextDataSufficiencyAnalysis
          ?.empiricalCalibrationStatus || null
    };
  }

  async function ingestCandidateHistoryEvidence(nodeId, payload) {
    const evidenceResult = await insertCandidateHistoryEvidence(
      nodeId,
      payload
    );

    const interpretationResult = await interpretAndPersistCandidate(
      evidenceResult.persistedEvidence
    );

    const persistedEvidence = evidenceWithAuthority(
      evidenceResult.persistedEvidence,
      interpretationResult.persistedInterpretation
    );

    const decisionReadinessResult =
      await buildAndPersistHumanPresenceDecisionReadinessV1(
        pool,
        interpretationResult.persistedInterpretation
      );

    const persistedDecisionReadiness =
      await loadPersistedDecisionReadiness(
        evidenceResult.eventId,
        interpretationResult.persistedInterpretation.interpretation_version,
        decisionReadinessResult
      );

    if (!persistedDecisionReadiness) {
      throw new Error(
        `Human Presence Behavioral Observation v1 parent Decision Readiness row missing for ${evidenceResult.eventId}`
      );
    }

    const behavioralObservationResult =
      await buildAndPersistHumanPresenceBehavioralObservationV1(
        pool,
        persistedDecisionReadiness
      );

    const persistedBehavioralObservation =
      await loadPersistedBehavioralObservation(
        evidenceResult.eventId,
        behavioralObservationResult
      );

    if (!persistedBehavioralObservation) {
      throw new Error(
        `Behavioral Observation v1 persisted row missing for ${evidenceResult.eventId}`
      );
    }

    const [behavioralPatternAnalysisResult, episodeProfile] =
      await Promise.all([
        buildAndPersistHumanPresenceBehavioralPatternAnalysisV1(
          pool,
          persistedBehavioralObservation
        ),
        runEpisodeProfileChain(
          evidenceResult.eventId,
          persistedEvidence
        )
      ]);

    const summary = {
      eventId: evidenceResult.eventId,
      evidenceInserted: evidenceResult.inserted,
      interpretationInserted: interpretationResult.inserted,
      decisionReadinessInserted:
        decisionReadinessResult.persistence.inserted,
      behavioralObservationInserted:
        behavioralObservationResult.persistence.inserted,
      behavioralPatternInserted:
        behavioralPatternAnalysisResult.persistence.inserted,
      episodeProfile
    };

    logger.log?.("Human Presence candidate pipeline complete:", summary);
    return summary;
  }

  function validateHighResolutionActivityEvidence(nodeId, payload) {
    const normalizedPayload = normalizeJsonObject(payload);
    const eventType = cleanText(normalizedPayload.eventType).toLowerCase();

    if (eventType !== "high_resolution_activity_evidence") {
      throw new Error(
        `Unexpected high-resolution activity evidence event type: ${
          eventType || "missing"
        }`
      );
    }

    const resolvedNodeId = cleanText(nodeId || normalizedPayload.nodeId);
    if (!resolvedNodeId) {
      throw new Error("high_resolution_activity_evidence missing nodeId");
    }

    if (cleanText(normalizedPayload.protocolVersion) !== "2.0") {
      throw new Error(
        "high_resolution_activity_evidence unsupported protocolVersion"
      );
    }

    const evidenceSchemaVersion = cleanText(
      normalizedPayload.evidenceSchemaVersion
    );
    if (!["1.0", "2.0"].includes(evidenceSchemaVersion)) {
      throw new Error(
        "high_resolution_activity_evidence unsupported evidenceSchemaVersion"
      );
    }

    if (normalizedPayload.observerOnly !== true) {
      throw new Error(
        "high_resolution_activity_evidence requires observerOnly=true"
      );
    }
    if (normalizedPayload.developmentOnly !== true) {
      throw new Error(
        "high_resolution_activity_evidence requires developmentOnly=true"
      );
    }

    const expectedSampleEncoding =
      evidenceSchemaVersion === "2.0"
        ? "compact-array-v2"
        : "compact-array-v1";
    if (cleanText(normalizedPayload.sampleEncoding) !== expectedSampleEncoding) {
      throw new Error(
        "high_resolution_activity_evidence unsupported sampleEncoding"
      );
    }

    const samples = normalizedPayload.samples;
    if (!Array.isArray(samples)) {
      throw new Error(
        "high_resolution_activity_evidence samples must be an array"
      );
    }
    if (samples.length < 1 || samples.length > 12) {
      throw new Error(
        `high_resolution_activity_evidence sample count out of range: ${samples.length}`
      );
    }

    const declaredSampleCount = Number(normalizedPayload.sampleCount);
    if (
      !Number.isInteger(declaredSampleCount) ||
      declaredSampleCount !== samples.length
    ) {
      throw new Error(
        "high_resolution_activity_evidence sampleCount mismatch"
      );
    }

    const expectedSampleLength =
      evidenceSchemaVersion === "2.0" ? 19 : 12;

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (!Array.isArray(sample) || sample.length !== expectedSampleLength) {
        throw new Error(
          `high_resolution_activity_evidence invalid sample at index ${i}`
        );
      }

      const scalarFieldCount =
        evidenceSchemaVersion === "2.0" ? 17 : 12;
      for (let j = 0; j < scalarFieldCount; j += 1) {
        if (
          typeof sample[j] !== "number" ||
          !Number.isFinite(sample[j])
        ) {
          throw new Error(
            `high_resolution_activity_evidence non-numeric sample value at ${i}:${j}`
          );
        }
      }

      if (evidenceSchemaVersion === "2.0") {
        for (const gateIndex of [17, 18]) {
          const gateValues = sample[gateIndex];
          if (!Array.isArray(gateValues) || gateValues.length !== 9) {
            throw new Error(
              `high_resolution_activity_evidence invalid gate array at ${i}:${gateIndex}`
            );
          }
          for (let gate = 0; gate < gateValues.length; gate += 1) {
            if (
              typeof gateValues[gate] !== "number" ||
              !Number.isFinite(gateValues[gate])
            ) {
              throw new Error(
                `high_resolution_activity_evidence non-numeric gate value at ${i}:${gateIndex}:${gate}`
              );
            }
          }
        }
      }
    }

    return {
      ...normalizedPayload,
      nodeId: resolvedNodeId
    };
  }

  async function persistHighResolutionActivityEvidence(payload) {
    const eventId = randomUUID();
    const receivedAt = new Date().toISOString();

    const resolvedNodeId = cleanText(payload?.nodeId);
    const resolvedLocationName = cleanText(payload?.locationName) || null;
    const resolvedSourceKey = cleanText(payload?.sourceKey) || null;
    const resolvedResidentName =
      cleanText(payload?.residentName) || "Unassigned";

    await pool.query(
      `
      INSERT INTO webhook_events (
        id,
        node_id,
        location_name,
        source_key,
        source_name,
        resident_name,
        message,
        alert_level,
        time_text,
        timestamp,
        event_type,
        sensor_type,
        event_payload,
        acknowledged,
        acknowledged_at,
        resolution_note
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13::jsonb,
        TRUE, $10,
        'Development-only observer evidence; not an operational alert'
      )
      `,
      [
        eventId,
        resolvedNodeId || null,
        resolvedLocationName,
        resolvedSourceKey,
        "LD2410 High Resolution Observer",
        resolvedResidentName,
        "High-resolution activity evidence batch",
        "observer_only",
        "Development Observer Evidence",
        receivedAt,
        "high_resolution_activity_evidence",
        "human_presence",
        JSON.stringify(payload)
      ]
    );

    return { eventId, receivedAt };
  }

  async function ingestHighResolutionActivityEvidence(nodeId, payload) {
    const validatedPayload = validateHighResolutionActivityEvidence(
      nodeId,
      payload
    );
    const persistence = await persistHighResolutionActivityEvidence(
      validatedPayload
    );

    let engineeringFeatureResult = null;
    let spatialSignatureResult = null;
    let spatialStateResult = null;
    let spatialTemporalResult = null;
    let spatialRhythmResult = null;

    if (cleanText(validatedPayload.evidenceSchemaVersion) === "2.0") {
      const current = {
        evidence_event_id: persistence.eventId,
        node_id: validatedPayload.nodeId,
        evidence_schema_version: "2.0",
        observer_only: validatedPayload.observerOnly === true,
        development_only: validatedPayload.developmentOnly === true,
        event_payload: validatedPayload,
        evidence_received_at: persistence.receivedAt
      };

      engineeringFeatureResult =
        await buildAndPersistHumanPresenceEngineeringFeatureV1(
          pool,
          current
        );

      spatialSignatureResult =
        await buildAndPersistHumanPresenceSpatialSignatureV1(
          pool,
          current,
          engineeringFeatureResult.feature
        );

      spatialStateResult =
        await buildAndPersistHumanPresenceSpatialStateLearningV1(
          pool,
          current,
          spatialSignatureResult.signature
        );

      [spatialTemporalResult, spatialRhythmResult] = await Promise.all([
        buildAndPersistHumanPresenceSpatialTemporalLearningV1(
          pool,
          current
        ),
        buildAndPersistHumanPresenceSpatialRhythmLearningV1(
          pool,
          current
        )
      ]);
    }

    const summary = {
      nodeId: validatedPayload.nodeId,
      batchSequence: validatedPayload.batchSequence,
      sampleCount: validatedPayload.sampleCount,
      eventId: persistence.eventId,
      engineeringFeatureVersion:
        engineeringFeatureResult?.persistence?.engineeringFeatureVersion || null,
      spatialStateInserted:
        spatialStateResult?.persistence?.inserted ?? null,
      spatialTemporalInserted:
        spatialTemporalResult?.persistence?.inserted ?? null,
      spatialRhythmInserted:
        spatialRhythmResult?.persistence?.inserted ?? null
    };

    logger.log?.("Human Presence high-resolution pipeline complete:", summary);
    return summary;
  }

  return {
    ingestCandidateHistoryEvidence,
    ingestHighResolutionActivityEvidence,
    validateHighResolutionActivityEvidence
  };
}

module.exports = {
  candidateHistoryEvidenceInteger,
  createHumanPresenceMqttIngestion
};
