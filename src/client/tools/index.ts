import type { RobotRpcMap, RobotRpcType } from "../../types.js";
import type { ClientLogger } from "../logger.js";
import { createMotorTool, type MotorTool } from "./motor.js";
import { createPhotoTool, type PhotoTool } from "./photo.js";
import { type ConversationPhase, createSpeechTool, type SpeechTool } from "./speech.js";

export type RobotToolHandler<T extends RobotRpcType> = (
	payload: RobotRpcMap[T]["request"],
	signal: AbortSignal,
) => Promise<RobotRpcMap[T]["response"]> | RobotRpcMap[T]["response"];

export interface RobotToolHandlers {
	take_photo: RobotToolHandler<"take_photo">;
	motor: RobotToolHandler<"motor">;
	speak: RobotToolHandler<"speak">;
	cancel_speech: RobotToolHandler<"cancel_speech">;
}

export interface RobotTools {
	handlers: RobotToolHandlers;
	photo: PhotoTool;
	motor: MotorTool;
	speech: SpeechTool;
}

export function createRobotTools(deps: {
	logger: ClientLogger;
	ttsProviderControl: HTMLSelectElement;
	face: HTMLElement;
	setPhase: (phase: ConversationPhase) => void;
	resetToListeningOrIdle: () => void;
	resetRecognitionAfterTts: () => void;
	setMicInputBlockedUntil: (time: number) => void;
	onSpeakingChange: (speaking: boolean) => void;
}): RobotTools {
	const photo = createPhotoTool({ logger: deps.logger });
	const motor = createMotorTool({ logger: deps.logger });
	const speech = createSpeechTool({
		logger: deps.logger,
		ttsProviderControl: deps.ttsProviderControl,
		face: deps.face,
		setPhase: deps.setPhase,
		resetToListeningOrIdle: deps.resetToListeningOrIdle,
		resetRecognitionAfterTts: deps.resetRecognitionAfterTts,
		setMicInputBlockedUntil: deps.setMicInputBlockedUntil,
		onSpeakingChange: deps.onSpeakingChange,
	});
	return {
		handlers: {
			take_photo: photo.handle,
			motor: motor.handle,
			speak: speech.handleSpeak,
			cancel_speech: speech.handleCancelSpeech,
		},
		photo,
		motor,
		speech,
	};
}
