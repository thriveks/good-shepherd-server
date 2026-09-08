"use strict";

const readline = require("readline");
const { spawnSync } = require("child_process");
const path = require("path");

const VERSION =
  "human_presence_controlled_test_runner_v1";

const CLI = path.resolve(
  __dirname,
  "labeled-event-capture-v1-cli.js"
);

const PLAN = [
  {
    eventType: "walk_within_room",
    title: "Walk within room",
    instructions:
      "Walk naturally around the monitored area for about 45-60 seconds.",
    notes:
      "Controlled walk within monitored area"
  },
  {
    eventType: "seated_stationary",
    title: "Seated stationary",
    instructions:
      "Sit normally and remain mostly still for about 45-60 seconds.",
    notes:
      "Controlled seated stationary interval"
  },
  {
    eventType: "stand_up",
    title: "Stand up",
    instructions:
      "Begin seated. Stand normally, then remain standing briefly.",
    notes:
      "Controlled transition from seated to standing"
  },
  {
    eventType: "standing_stationary",
    title: "Standing stationary",
    instructions:
      "Stand normally in the monitored area for about 30-45 seconds.",
    notes:
      "Controlled standing stationary interval"
  },
  {
    eventType: "sit_down",
    title: "Sit down",
    instructions:
      "Begin standing. Sit normally, then remain seated briefly.",
    notes:
      "Controlled transition from standing to seated"
  },
  {
    eventType: "walk_through_room",
    title: "Walk through room",
    instructions:
      "Enter the monitored path, walk naturally through it, and continue through.",
    notes:
      "Controlled walk through monitored room"
  },
  {
    eventType: "exit_room",
    title: "Exit room",
    instructions:
      "Begin inside the monitored room and exit naturally.",
    notes:
      "Controlled exit from monitored room"
  },
  {
    eventType: "enter_room",
    title: "Enter room",
    instructions:
      "Begin outside the monitored room and enter naturally.",
    notes:
      "Controlled entry into monitored room"
  }
];

function runCli(args) {
  const result = spawnSync(
    process.execPath,
    [CLI, ...args],
    {
      stdio: "inherit",
      env: process.env
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `Capture CLI failed: ${args.join(" ")}`
    );
  }
}

function ask(rl, text) {
  return new Promise((resolve) => {
    rl.question(text, resolve);
  });
}

function printPlan() {
  console.log(`VERSION=${VERSION}`);
  console.log(`STEP_COUNT=${PLAN.length}`);
  console.log("");

  PLAN.forEach((step, index) => {
    console.log(
      `${index + 1}. ${step.eventType} — ${step.title}`
    );
    console.log(`   ${step.instructions}`);
  });

  console.log("");
  console.log("GROUND_TRUTH_ONLY=TRUE");
  console.log("SENSOR_DERIVED=FALSE");
  console.log("AUTOMATIC_CLASSIFICATION=NONE");
  console.log("OPERATIONAL_POLICY=NONE");
  console.log("FALL_EMERGENCY_MEDICAL_INFERENCE=NONE");
}

async function main() {
  const args = process.argv.slice(2);

  if (
    args.includes("--plan") ||
    args.includes("--list")
  ) {
    printPlan();
    return;
  }

  const observer =
    args.find((arg) => !arg.startsWith("--"));

  if (!observer) {
    console.error(
      'Usage: node controlled-test-runner-v1.js "Observer Name"'
    );
    console.error(
      'Preview: node controlled-test-runner-v1.js --plan'
    );
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let sessionStarted = false;
  let activeEvent = false;

  try {
    console.log("");
    console.log("======================================");
    console.log("GOOD SHEPHERD CONTROLLED TEST RUNNER");
    console.log("======================================");
    console.log(`VERSION=${VERSION}`);
    console.log(`OBSERVER=${observer}`);
    console.log(`STEP_COUNT=${PLAN.length}`);
    console.log("");
    console.log(
      "The existing frozen capture CLI will record the timestamps."
    );
    console.log(
      "Nothing is inferred from your activity."
    );
    console.log("");

    await ask(
      rl,
      "Press ENTER to create the controlled-test session..."
    );

    runCli(["start-session", observer]);
    sessionStarted = true;

    for (let i = 0; i < PLAN.length; i += 1) {
      const step = PLAN[i];

      console.log("");
      console.log("--------------------------------------");
      console.log(
        `STEP ${i + 1} OF ${PLAN.length}: ${step.title}`
      );
      console.log("--------------------------------------");
      console.log(`EVENT_TYPE=${step.eventType}`);
      console.log(step.instructions);
      console.log("");

      await ask(
        rl,
        "Get into the starting position, then press ENTER exactly when the activity begins..."
      );

      runCli([
        "start-event",
        step.eventType,
        step.notes
      ]);

      activeEvent = true;

      console.log("");
      console.log(">>> EVENT IS NOW BEING TIMED <<<");
      console.log("");

      await ask(
        rl,
        "Perform the activity. Press ENTER exactly when it ends..."
      );

      runCli(["stop-event"]);
      activeEvent = false;

      console.log("");
      console.log(
        `STEP_${i + 1}=SAVED`
      );

      if (i < PLAN.length - 1) {
        await ask(
          rl,
          "Press ENTER when you are ready for the next activity..."
        );
      }
    }

    console.log("");
    console.log("======================================");
    console.log("ALL ACTIVITIES COMPLETE");
    console.log("======================================");

    runCli(["status"]);

    await ask(
      rl,
      "Press ENTER to close the controlled-test session..."
    );

    runCli(["end-session"]);
    sessionStarted = false;

    console.log("");
    console.log("CONTROLLED_TEST_SESSION=COMPLETE");
    console.log(`VERSION=${VERSION}`);
    console.log(`EVENTS_CAPTURED=${PLAN.length}`);
    console.log("GROUND_TRUTH_CAPTURE=COMPLETE");
    console.log("AUTOMATIC_INTERPRETATION=NONE");
    console.log("OPERATIONAL_POLICY_CHANGES=NONE");
  } catch (error) {
    console.error("");
    console.error(
      `CONTROLLED_TEST_RUNNER_ERROR=${error.message}`
    );

    if (activeEvent) {
      console.error(
        "IMPORTANT: An event may still be active."
      );
      console.error(
        "Run the existing capture CLI status command before continuing."
      );
    } else if (sessionStarted) {
      console.error(
        "The session may still be open, but no event is believed active."
      );
    }

    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

main();
