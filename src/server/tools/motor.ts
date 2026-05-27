import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { MotorCommand } from "../../types.js";
import type { RobotClient } from "../robot-client.js";

interface MotorToolDetails {
	command: string;
	durationMs: number;
}

interface TurnDegreesDetails extends MotorToolDetails {
	degrees: number;
}

const motorParameters = Type.Object({
	durationMs: Type.Number({ description: "Duration in milliseconds. Required. No default is assumed." }),
});

const turnDegreesParameters = Type.Object({
	degrees: Type.Optional(
		Type.Number({ description: "Counter-clockwise turn amount in degrees. Max 359. Defaults to 45." }),
	),
});

async function executeMotor(
	robot: RobotClient,
	payload: { command: MotorCommand; durationMs: number; degrees?: number },
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	const result = await robot.execute({ type: "motor", payload, timeoutMs, signal });
	if (!result.ok) throw new Error(result.error);
}

export function createMotorTools(robot: RobotClient): AgentTool[] {
	const moveForward: AgentTool<typeof motorParameters, MotorToolDetails> = {
		name: "move_forward",
		label: "Move Forward",
		description: "Drive forward for the requested duration in milliseconds. Hardware supports forward motion only.",
		executionMode: "sequential",
		parameters: motorParameters,
		execute: async (_id, params, signal) => {
			const durationMs = Math.max(0, params.durationMs);
			await executeMotor(robot, { command: "forward", durationMs }, durationMs + 6000, signal);
			return {
				content: [{ type: "text", text: `Executed move_forward for ${durationMs}ms.` }],
				details: { command: "move_forward", durationMs },
			};
		},
	};

	const turnLeft: AgentTool<typeof motorParameters, MotorToolDetails> = {
		name: "turn_left",
		label: "Turn Left",
		description:
			"Rotate counter-clockwise (left) in place for the requested duration in milliseconds. Hardware supports rotation in this direction only.",
		executionMode: "sequential",
		parameters: motorParameters,
		execute: async (_id, params, signal) => {
			const durationMs = Math.max(0, params.durationMs);
			await executeMotor(robot, { command: "turn_left", durationMs }, durationMs + 6000, signal);
			return {
				content: [{ type: "text", text: `Executed turn_left for ${durationMs}ms.` }],
				details: { command: "turn_left", durationMs },
			};
		},
	};

	const turnLeftDegrees: AgentTool<typeof turnDegreesParameters, TurnDegreesDetails> = {
		name: "turn_left_degrees",
		label: "Turn Left Degrees",
		description:
			"Rotate counter-clockwise by an approximate number of degrees using the phone orientation sensor. Use this when the user asks for a specific angle.",
		executionMode: "sequential",
		parameters: turnDegreesParameters,
		execute: async (_id, params, signal) => {
			const degrees = Math.max(1, Math.min(359, params.degrees ?? 45));
			const durationMs = Math.max(1200, Math.min(18000, Math.round(degrees * 65)));
			await executeMotor(robot, { command: "turn_left_degrees", durationMs, degrees }, durationMs + 6000, signal);
			return {
				content: [{ type: "text", text: `Executed approximate left turn by ${degrees} degrees.` }],
				details: { command: "turn_left_degrees", degrees, durationMs },
			};
		},
	};

	return [moveForward, turnLeft, turnLeftDegrees];
}
