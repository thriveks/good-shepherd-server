"use strict";

function createSensorCommandResultService({
  pool,
  nodeCommandSelectSQL,
  isTerminalCommandStatus,
  cleanText,
  logStructuredDiagnostic,
  finalizeSuccessfulFactoryReset
}) {
  async function saveSensorCommandResult({
    commandId,
    status,
    resultPayload,
    error = null,
    route = "sensor-command-result"
  }) {
    const client = await pool.connect();
    let didBegin = false;

    try {
      await client.query("BEGIN");
      didBegin = true;

      const existingResult = await client.query(
        `${nodeCommandSelectSQL()} WHERE command_id = $1 FOR UPDATE`,
        [commandId]
      );
      const existingCommand = existingResult.rows[0] || null;

      if (!existingCommand) {
        await client.query("ROLLBACK");
        didBegin = false;
        return {
          outcome: "not_found",
          statusCode: 404,
          message: `Command not found: ${commandId}`,
          command: null
        };
      }

      if (isTerminalCommandStatus(existingCommand.status)) {
        const sameTerminalStatus = existingCommand.status === status;
        const wasAutoExpiredRunning =
          existingCommand.status === "failed" &&
          cleanText(existingCommand.error) === "Expired running sensor command" &&
          Boolean(existingCommand.pickedUpAt);

        if (sameTerminalStatus) {
          await client.query("COMMIT");
          didBegin = false;
          return {
            outcome: "already_recorded",
            statusCode: 200,
            message: "Sensor command result already recorded",
            command: existingCommand
          };
        }

        if (!wasAutoExpiredRunning || status !== "success") {
          await client.query("COMMIT");
          didBegin = false;

          logStructuredDiagnostic("COMMAND_LATE_RESULT", "warning", {
            commandId,
            nodeId: existingCommand.nodeId,
            commandType: existingCommand.commandType,
            oldStatus: existingCommand.status,
            submittedStatus: status,
            route,
            accepted: false,
            late: true
          });

          return {
            outcome: "late_ignored",
            statusCode: 200,
            message: "Late sensor command result ignored",
            command: existingCommand
          };
        }

        logStructuredDiagnostic("COMMAND_LATE_RESULT", "warning", {
          commandId,
          nodeId: existingCommand.nodeId,
          commandType: existingCommand.commandType,
          oldStatus: existingCommand.status,
          submittedStatus: status,
          route,
          accepted: true,
          late: true
        });
      }

      if (status === "running" && existingCommand.status !== "running") {
        await client.query("ROLLBACK");
        didBegin = false;
        return {
          outcome: "invalid_running_transition",
          statusCode: 400,
          message: "running is only valid for a command already claimed as running",
          command: existingCommand
        };
      }

      const result = await client.query(
        `
        UPDATE node_commands
        SET
          status = $2,
          picked_up_at = COALESCE(picked_up_at, NOW()),
          completed_at = CASE WHEN $2 IN ('success', 'failed') THEN NOW() ELSE NULL END,
          result = $3::jsonb,
          error = $4
        WHERE command_id = $1
        RETURNING
          command_id AS "commandId",
          node_id AS "nodeId",
          command_type AS "commandType",
          payload,
          status,
          requested_by AS "requestedBy",
          requested_at AS "requestedAt",
          picked_up_at AS "pickedUpAt",
          completed_at AS "completedAt",
          result,
          error
        `,
        [
          commandId,
          status,
          JSON.stringify(resultPayload || {}),
          error
        ]
      );

      const completedCommand = result.rows[0] || null;
      if (!completedCommand) {
        await client.query("ROLLBACK");
        didBegin = false;
        return {
          outcome: "not_found",
          statusCode: 404,
          message: `Command not found: ${commandId}`,
          command: null
        };
      }

      if (
        completedCommand.commandType === "factory_reset" &&
        status === "success"
      ) {
        await finalizeSuccessfulFactoryReset(
          client,
          completedCommand.nodeId
        );
      }

      await client.query("COMMIT");
      didBegin = false;

      logStructuredDiagnostic("COMMAND_RESULT", "info", {
        commandId,
        nodeId: completedCommand.nodeId,
        commandType: completedCommand.commandType,
        oldStatus: existingCommand.status,
        newStatus: status,
        route,
        accepted: true,
        late: false
      });

      return {
        outcome: "saved",
        statusCode: 200,
        message: "Sensor command result saved",
        command: completedCommand
      };
    } catch (errorObject) {
      if (didBegin) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }
      throw errorObject;
    } finally {
      client.release();
    }
  }

  return {
    saveSensorCommandResult
  };
}

module.exports = {
  createSensorCommandResultService
};
