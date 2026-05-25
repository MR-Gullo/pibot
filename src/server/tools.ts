import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import {
	type ImageContent,
	type TextContent,
	type ToolResultMessage,
	Type,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { MotorCommand, PhotoCapture } from "../types.js";
import { memoryTool } from "./memory.js";
import { pageContentTool, webSearchTool } from "./websearch.js";

interface MotorToolDetails {
	command: string;
	durationMs: number;
	error?: string;
}

interface TurnDegreesDetails extends MotorToolDetails {
	degrees: number;
}

interface PhotoToolDetails {
	mimeType: string;
	bytes: number;
}

export interface RobotToolsDeps {
	broadcast: (data: object) => void;
	executeMotorOnClient: (command: MotorCommand, durationMs: number, degrees?: number) => Promise<void>;
	capturePhotoFromClient: () => Promise<PhotoCapture>;
	motorLog: Array<{ t: number; command: string; durationMs: number }>;
}

const motorParameters = Type.Object({
	durationMs: Type.Number({ description: "Duration in milliseconds. Required. No default is assumed." }),
});

const turnDegreesParameters = Type.Object({
	degrees: Type.Optional(
		Type.Number({ description: "Counter-clockwise turn amount in degrees. Max 359. Defaults to 45." }),
	),
});

const emptyParameters = Type.Object({});

type ImageBearingMessage = UserMessage | ToolResultMessage;
type ImageBearingContent = Array<TextContent | ImageContent>;

interface ImagePruneState {
	remainingImages: number;
	prunedImages: number;
}

function isImageBearingMessage(message: AgentMessage): message is ImageBearingMessage {
	return message.role === "user" || message.role === "toolResult";
}

function pruneImageContent(content: ImageBearingContent, state: ImagePruneState): ImageBearingContent {
	let changed = false;
	const nextContent = [...content];
	for (let partIndex = nextContent.length - 1; partIndex >= 0; partIndex--) {
		const part = nextContent[partIndex]!;
		if (part.type !== "image") continue;
		if (state.remainingImages > 0) {
			state.remainingImages--;
			continue;
		}
		changed = true;
		state.prunedImages++;
		nextContent[partIndex] = {
			type: "text",
			text: "[Older robot camera image omitted from model context to keep the conversation small.]",
		};
	}
	return changed ? nextContent : content;
}

function pruneImageBearingMessage(message: ImageBearingMessage, state: ImagePruneState): ImageBearingMessage {
	if (message.role === "user") {
		if (typeof message.content === "string") return message;
		const content = pruneImageContent(message.content, state);
		return content === message.content ? message : { ...message, content };
	}
	const content = pruneImageContent(message.content, state);
	return content === message.content ? message : { ...message, content };
}

export function pruneImagesForContext(messages: AgentMessage[], maxImages: number): AgentMessage[] {
	const state: ImagePruneState = { remainingImages: Math.max(0, maxImages), prunedImages: 0 };
	const nextMessages = [...messages];
	for (let messageIndex = nextMessages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = nextMessages[messageIndex]!;
		if (!isImageBearingMessage(message)) continue;
		nextMessages[messageIndex] = pruneImageBearingMessage(message, state);
	}
	if (state.prunedImages > 0) console.log(`[context] pruned ${state.prunedImages} old image(s), kept ${maxImages}`);
	return nextMessages;
}

function motorTool(
	name: "move_forward" | "turn_left",
	command: "forward" | "turn_left",
	description: string,
	deps: RobotToolsDeps,
): AgentTool<typeof motorParameters, MotorToolDetails> {
	return {
		name,
		label: name,
		description,
		executionMode: "sequential",
		parameters: motorParameters,
		execute: async (_id, params) => {
			const durationMs = Math.max(0, params.durationMs);
			deps.motorLog.push({ t: Date.now(), command: name, durationMs });
			deps.broadcast({ type: "sim_motor", command: name, durationMs });
			try {
				await deps.executeMotorOnClient(command, durationMs);
				return {
					content: [{ type: "text", text: `Executed ${name} for ${durationMs}ms.` }],
					details: { command: name, durationMs },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Motor ${name} failed: ${message}` }],
					details: { command: name, durationMs, error: message },
				};
			}
		},
	};
}

function turnLeftDegreesTool(deps: RobotToolsDeps): AgentTool<typeof turnDegreesParameters, TurnDegreesDetails> {
	return {
		name: "turn_left_degrees",
		label: "Turn Left Degrees",
		description:
			"Rotate counter-clockwise by an approximate number of degrees using the phone orientation sensor. Use this when the user asks for a specific angle.",
		executionMode: "sequential",
		parameters: turnDegreesParameters,
		execute: async (_id, params) => {
			const degrees = Math.max(1, Math.min(359, params.degrees ?? 45));
			const durationMs = Math.max(1200, Math.min(18000, Math.round(degrees * 65)));
			deps.motorLog.push({ t: Date.now(), command: "turn_left_degrees", durationMs });
			deps.broadcast({ type: "sim_motor", command: `turn_left_degrees ${degrees}°`, durationMs });
			try {
				await deps.executeMotorOnClient("turn_left_degrees", durationMs, degrees);
				return {
					content: [{ type: "text", text: `Executed approximate left turn by ${degrees} degrees.` }],
					details: { command: "turn_left_degrees", degrees, durationMs },
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Motor turn_left_degrees failed: ${message}` }],
					details: { command: "turn_left_degrees", degrees, durationMs, error: message },
				};
			}
		},
	};
}

function takePhotoTool(deps: RobotToolsDeps): AgentTool<typeof emptyParameters, PhotoToolDetails> {
	return {
		name: "take_photo",
		label: "Take Photo",
		description: "Take a photo of your surroundings using the phone front-facing camera.",
		parameters: emptyParameters,
		execute: async () => {
			const capture = await deps.capturePhotoFromClient();
			return {
				content: [
					{ type: "text", text: "Aktuelles Kamerabild vom Roboter." },
					{ type: "image", data: capture.base64, mimeType: capture.mimeType },
				],
				details: { mimeType: capture.mimeType, bytes: capture.base64.length },
			};
		},
	};
}

export function createRobotTools(deps: RobotToolsDeps): AgentTool[] {
	return [
		motorTool(
			"move_forward",
			"forward",
			"Drive forward for the requested duration in milliseconds. Hardware supports forward motion only.",
			deps,
		),
		motorTool(
			"turn_left",
			"turn_left",
			"Rotate counter-clockwise (left) in place for the requested duration in milliseconds. Hardware supports rotation in this direction only.",
			deps,
		),
		turnLeftDegreesTool(deps),
		takePhotoTool(deps),
		webSearchTool,
		pageContentTool,
		memoryTool,
	];
}
