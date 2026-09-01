const AUTHORITY_RESOLUTION_VERSION =
  "human_presence_authority_resolution_v1";

function clean(value) {
  return String(value ?? "").trim();
}

function resolveHumanPresenceInterpretationAuthorityV1({
  evidence,
  sensor,
  resident,
  node
}) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error("evidence is required");
  }

  const evidenceNodeId = clean(evidence.nodeId || evidence.node_id);
  const evidenceSourceKey = clean(
    evidence.sourceKey || evidence.source_key
  );

  if (!evidenceNodeId) {
    throw new Error("evidence nodeId is required");
  }

  const firmwareProvenance = {
    residentName: clean(
      evidence.residentName || evidence.resident_name
    ) || null,
    locationName: clean(
      evidence.locationName || evidence.location_name
    ) || null
  };

  if (!sensor) {
    return {
      authorityResolutionVersion: AUTHORITY_RESOLUTION_VERSION,
      status: "unresolved_sensor",
      evidenceNodeId,
      evidenceSourceKey: evidenceSourceKey || null,

      authoritativeSensorId: null,
      authoritativeSourceKey: null,
      authoritativeResidentId: null,
      authoritativeResidentName: null,
      authoritativeRoomOrLocation: null,
      assignmentAuthority: null,

      firmwareProvenance,
      nodeProvenance: node
        ? {
            nodeId: clean(node.nodeId || node.node_id) || null,
            locationName:
              clean(node.locationName || node.location_name) || null
          }
        : null
    };
  }

  const sensorId = clean(sensor.id);
  const sensorNodeId = clean(sensor.nodeId || sensor.node_id);
  const sensorSourceKey = clean(
    sensor.sourceKey || sensor.source_key
  );

  const isDeleted =
    sensor.isDeleted === true ||
    sensor.is_deleted === true;

  if (isDeleted) {
    return {
      authorityResolutionVersion: AUTHORITY_RESOLUTION_VERSION,
      status: "unresolved_deleted_sensor",
      evidenceNodeId,
      evidenceSourceKey: evidenceSourceKey || null,
      authoritativeSensorId: sensorId || null,
      authoritativeSourceKey: sensorSourceKey || null,
      authoritativeResidentId: null,
      authoritativeResidentName: null,
      authoritativeRoomOrLocation: null,
      assignmentAuthority:
        clean(sensor.assignmentAuthority ||
              sensor.assignment_authority) || null,
      firmwareProvenance
    };
  }

  if (evidenceSourceKey &&
      sensorSourceKey &&
      evidenceSourceKey !== sensorSourceKey) {
    throw new Error("evidence/source authority mismatch");
  }

  if (sensorNodeId &&
      evidenceNodeId &&
      sensorNodeId !== evidenceNodeId) {
    throw new Error("evidence/node authority mismatch");
  }

  const residentId = clean(
    sensor.residentId || sensor.resident_id
  );

  const authoritativeResidentName =
    residentId && resident
      ? clean(resident.name) || null
      : null;

  const roomName = clean(
    sensor.roomName || sensor.room_name
  );

  const sensorLocationName = clean(
    sensor.locationName || sensor.location_name
  );

  const roomOrLocation =
    roomName || sensorLocationName || null;

  const setupState = clean(
    sensor.setupState || sensor.setup_state
  );

  const assignmentAuthority = clean(
    sensor.assignmentAuthority ||
    sensor.assignment_authority
  );

  const status =
    residentId && authoritativeResidentName
      ? "resolved_assigned_sensor"
      : "resolved_sensor_without_resident";

  return {
    authorityResolutionVersion: AUTHORITY_RESOLUTION_VERSION,
    status,

    evidenceNodeId,
    evidenceSourceKey: evidenceSourceKey || null,

    authoritativeSensorId: sensorId || null,
    authoritativeSourceKey: sensorSourceKey || null,
    authoritativeResidentId: residentId || null,
    authoritativeResidentName,
    authoritativeRoomOrLocation: roomOrLocation,

    sensorSetupState: setupState || null,
    assignmentAuthority: assignmentAuthority || null,

    firmwareProvenance,

    nodeProvenance: node
      ? {
          nodeId: clean(node.nodeId || node.node_id) || null,
          locationName:
            clean(node.locationName || node.location_name) || null
        }
      : null
  };
}

module.exports = {
  AUTHORITY_RESOLUTION_VERSION,
  resolveHumanPresenceInterpretationAuthorityV1
};
