export type MotorCommand = "forward" | "turn_left" | "turn_left_degrees" | "stop";

export interface PhotoCapture {
	dataUrl: string;
	mimeType: string;
	base64: string;
}

export type ClientLogLevel = "log" | "info" | "warn" | "error" | "debug" | "app";

export interface ClientLogMsg {
	type: "client_log";
	level: ClientLogLevel;
	message: string;
	url: string;
	userAgent: string;
	time: number;
}

export type AgentMessageLike = {
	role: string;
	content?: unknown;
};

export type AgentEvent =
	| { type: "message_start"; message: AgentMessageLike }
	| { type: "message_update"; assistantMessageEvent?: { type: string; delta?: string } }
	| { type: "message_end"; message: AgentMessageLike }
	| { type: "tool_execution_start"; toolName: string; args: unknown }
	| { type: "other"; eventType: string };

export type SttEventName = "loading" | "ready" | "speech_start" | "speech_end" | "speech_drop" | "error";

export type ServerMessage =
	| { type: "hello"; motorLog: Array<{ t: number; command: string; durationMs: number }> }
	| { type: "sim_motor"; command: string; durationMs: number }
	| { type: "take_photo_request"; id: string }
	| { type: "motor_request"; id: string; command: MotorCommand; durationMs: number; degrees?: number }
	| { type: "error"; message: string }
	| { type: "speak_request"; id: string; text: string }
	| { type: "cancel_speech"; reason: string; sttIndex?: number }
	| { type: "stt_event"; event: SttEventName; index?: number; message?: string }
	| { type: "stt_interim"; index: number; text: string }
	| { type: "stt_final"; index: number; text: string; accepted: boolean; ignoredReason?: string }
	| { type: "session_reset" }
	| { type: "agent_event"; event: AgentEvent };

export type ClientMessage =
	| { type: "prompt"; text: string }
	| { type: "photo_result"; id: string; dataUrl?: string; error?: string }
	| { type: "motor_result"; id: string; ok: boolean; error?: string }
	| { type: "speak_done"; id: string }
	| { type: "speak_cancelled"; id: string }
	| ClientLogMsg
	| { type: "abort" }
	| { type: "reset_session" };
