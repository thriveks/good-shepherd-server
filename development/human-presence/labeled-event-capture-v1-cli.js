"use strict";

const fs =
  require("fs");

const os =
  require("os");

const path =
  require("path");

const crypto =
  require("crypto");

const {
  execFileSync
} = require("child_process");

const {
  ALLOWED_EVENT_TYPES,
  validateHumanPresenceLabeledEventCaptureV1
} = require(
  "../../lib/human_presence_labeled_event_capture_v1"
);

const DB_ID =
  process.env.GS_LABEL_DB_ID ||
  "dpg-d7h6nh28qa3s73cvl42g-a";

const DEFAULT_RESIDENT =
  process.env.GS_LABEL_RESIDENT ||
  "Good shepherd office";

const DEFAULT_ROOM =
  process.env.GS_LABEL_ROOM ||
  "mmWave prototype";

const STATE_FILE =
  process.env.GS_LABEL_STATE_FILE ||
  path.join(
    os.tmpdir(),
    "good-shepherd-human-presence-label-session-v1.json"
  );

function nowIso() {
  return new Date().toISOString();
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      STATE_FILE,
      "utf8"
    )
  );
}

function writeState(state) {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      state,
      null,
      2
    ) + "\n"
  );
}

function removeState() {
  if (fs.existsSync(STATE_FILE)) {
    fs.unlinkSync(STATE_FILE);
  }
}

function shellPsql(sql) {
  return execFileSync(
    "render",
    [
      "psql",
      DB_ID,
      `--command=${sql}`,
      "-o",
      "text"
    ],
    {
      encoding:
        "utf8"
    }
  );
}

function resolveResident(
  residentName,
  room
) {
  const safeResident =
    residentName.replace(
      /'/g,
      "''"
    );

  const safeRoom =
    room.replace(
      /'/g,
      "''"
    );

  const sql = `
COPY (
  SELECT COALESCE(
    json_agg(row_to_json(x)),
    '[]'::json
  )::text

  FROM (
    SELECT DISTINCT
      authoritative_resident_id AS resident_id,
      authoritative_resident_name AS resident_name,
      authoritative_room_or_location AS room_or_location

    FROM human_presence_non_operational_interpretations

    WHERE
      non_operational_interpretation_version =
        'human_presence_non_operational_interpretation_v1'

      AND authoritative_resident_name =
        '${safeResident}'

      AND authoritative_room_or_location =
        '${safeRoom}'

      AND authority_resolution_status =
        'resolved_assigned_sensor'

    LIMIT 2
  ) x
) TO STDOUT;
`;

  const output =
    shellPsql(sql).trim();

  const rows =
    JSON.parse(output);

  if (rows.length !== 1) {
    throw new Error(
      `Expected one authoritative resident mapping; found ${rows.length}`
    );
  }

  return rows[0];
}

function insertLabel(value) {
  const id =
    `hp-label-${crypto.randomUUID()}`;

  const payloadB64 =
    Buffer
      .from(
        JSON.stringify(value),
        "utf8"
      )
      .toString("base64");

  const safeId =
    id.replace(
      /'/g,
      "''"
    );

  const sql = `
WITH payload AS (
  SELECT
    convert_from(
      decode(
        '${payloadB64}',
        'base64'
      ),
      'UTF8'
    )::jsonb AS j
)

INSERT INTO human_presence_labeled_events (
  labeled_event_id,
  labeled_event_capture_version,

  event_type,
  capture_source,

  resident_id,
  resident_name,

  room_or_location,

  observer_name,
  test_session_id,

  started_at,
  ended_at,
  duration_ms,

  notes,

  ground_truth_only,
  sensor_derived,

  labeled_event_payload
)

SELECT
  '${safeId}',

  j->>'labeledEventCaptureVersion',

  j->>'eventType',
  j->>'captureSource',

  (j->>'residentId')::uuid,
  j->>'residentName',

  j->>'roomOrLocation',

  j->>'observerName',
  j->>'testSessionId',

  (j->>'startedAt')::timestamptz,
  (j->>'endedAt')::timestamptz,
  (j->>'durationMs')::bigint,

  j->>'notes',

  TRUE,
  FALSE,

  j

FROM payload

RETURNING
  labeled_event_id,
  event_type,
  started_at,
  ended_at,
  duration_ms;
`;

  const output =
    shellPsql(sql);

  return {
    id,
    output
  };
}

function usage() {
  console.log(`
Good Shepherd Human Presence
Labeled Event Capture v1

Commands:

  start-session "Observer Name"

  start-event EVENT_TYPE [notes]

  stop-event

  status

  end-session

  types

Environment overrides:

  GS_LABEL_RESIDENT
  GS_LABEL_ROOM
  GS_LABEL_DB_ID

Default resident:
  ${DEFAULT_RESIDENT}

Default room:
  ${DEFAULT_ROOM}
`);
}

const [
  ,
  ,
  command,
  ...args
] = process.argv;

if (!command) {
  usage();
  process.exit(0);
}

if (command === "types") {
  console.log(
    ALLOWED_EVENT_TYPES.join("\n")
  );

  process.exit(0);
}

if (command === "start-session") {
  const observerName =
    (args[0] || "").trim();

  if (!observerName) {
    throw new Error(
      'Usage: start-session "Observer Name"'
    );
  }

  if (readState()) {
    throw new Error(
      "A labeled-event session is already active."
    );
  }

  const mapping =
    resolveResident(
      DEFAULT_RESIDENT,
      DEFAULT_ROOM
    );

  const sessionId =
    `hp-test-${new Date()
      .toISOString()
      .replace(
        /[^0-9]/g,
        ""
      )
      .slice(
        0,
        14
      )}-${crypto
        .randomUUID()
        .slice(
          0,
          8
        )}`;

  const state = {
    version:
      1,

    sessionId,

    observerName,

    residentId:
      mapping.resident_id,

    residentName:
      mapping.resident_name,

    roomOrLocation:
      mapping.room_or_location,

    sessionStartedAt:
      nowIso(),

    activeEvent:
      null
  };

  writeState(state);

  console.log(
    "TEST_SESSION_STARTED=PASS"
  );

  console.log(
    `SESSION_ID=${sessionId}`
  );

  console.log(
    `RESIDENT=${state.residentName}`
  );

  console.log(
    `ROOM=${state.roomOrLocation}`
  );

  process.exit(0);
}

if (command === "start-event") {
  const state =
    readState();

  if (!state) {
    throw new Error(
      "No active session. Run start-session first."
    );
  }

  if (state.activeEvent) {
    throw new Error(
      "An event is already active. Stop it first."
    );
  }

  const eventType =
    (args[0] || "").trim();

  if (
    !ALLOWED_EVENT_TYPES.includes(
      eventType
    )
  ) {
    throw new Error(
      `Invalid event type: ${eventType}`
    );
  }

  const notes =
    args
      .slice(1)
      .join(" ")
      .trim() ||
    null;

  state.activeEvent = {
    eventType,

    notes,

    startedAt:
      nowIso()
  };

  writeState(state);

  console.log(
    "EVENT_STARTED=PASS"
  );

  console.log(
    `EVENT_TYPE=${eventType}`
  );

  console.log(
    `STARTED_AT=${state.activeEvent.startedAt}`
  );

  process.exit(0);
}

if (command === "stop-event") {
  const state =
    readState();

  if (!state) {
    throw new Error(
      "No active session."
    );
  }

  if (!state.activeEvent) {
    throw new Error(
      "No active event."
    );
  }

  const endedAt =
    nowIso();

  const candidate = {
    eventType:
      state.activeEvent.eventType,

    captureSource:
      "controlled_test",

    residentId:
      state.residentId,

    residentName:
      state.residentName,

    roomOrLocation:
      state.roomOrLocation,

    observerName:
      state.observerName,

    testSessionId:
      state.sessionId,

    startedAt:
      state.activeEvent.startedAt,

    endedAt,

    notes:
      state.activeEvent.notes
  };

  const validated =
    validateHumanPresenceLabeledEventCaptureV1(
      candidate
    );

  if (!validated.valid) {
    throw new Error(
      validated.errors.join("; ")
    );
  }

  const saved =
    insertLabel(
      validated.value
    );

  state.activeEvent =
    null;

  writeState(state);

  console.log(
    saved.output.trim()
  );

  console.log(
    "LABELED_EVENT_SAVED=PASS"
  );

  console.log(
    `LABELED_EVENT_ID=${saved.id}`
  );

  process.exit(0);
}

if (command === "status") {
  const state =
    readState();

  if (!state) {
    console.log(
      "SESSION_ACTIVE=FALSE"
    );

    process.exit(0);
  }

  console.log(
    JSON.stringify(
      state,
      null,
      2
    )
  );

  process.exit(0);
}

if (command === "end-session") {
  const state =
    readState();

  if (!state) {
    throw new Error(
      "No active session."
    );
  }

  if (state.activeEvent) {
    throw new Error(
      "An event is still active. Run stop-event first."
    );
  }

  console.log(
    `SESSION_ID=${state.sessionId}`
  );

  removeState();

  console.log(
    "TEST_SESSION_ENDED=PASS"
  );

  process.exit(0);
}

usage();

throw new Error(
  `Unknown command: ${command}`
);
