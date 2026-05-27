import type {
	ClientMessage,
	LogEntry,
	RobotRpcMap,
	RobotRpcType,
	RobotState,
	RobotWireCancel,
	RobotWireRequest,
	ServerMessage,
} from "../types.js";
import type { ClientLogger } from "./logger.js";
import type { RobotToolHandlers } from "./tools/index.js";

interface ActiveRobotRequest {
	type: RobotRpcType;
	controller: AbortController;
}

export interface RobotServerEvents {
	onState: (state: RobotState) => void;
	onLog: (entry: LogEntry) => void;
	onRejected: (reason: string) => void;
}

export class RobotServer {
	private readonly ws: WebSocket;
	private readonly logger: ClientLogger;
	private readonly tools: RobotToolHandlers;
	private readonly events: RobotServerEvents;
	private readonly activeRobotRequests = new Map<string, ActiveRobotRequest>();

	constructor(deps: { url: string; logger: ClientLogger; tools: RobotToolHandlers; events: RobotServerEvents }) {
		this.logger = deps.logger;
		this.tools = deps.tools;
		this.events = deps.events;
		this.ws = new WebSocket(deps.url);
		this.ws.onopen = () => this.logger.tag("network").log("connected to robot server");
		this.ws.onclose = (event) => this.handleClose(event);
		this.ws.onerror = () => this.logger.tag("network").log("robot server connection error");
		this.ws.onmessage = (event) => this.handleMessage(event);
	}

	send(message: ClientMessage): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(JSON.stringify(message));
	}

	sendBinary(data: BufferSource): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		this.ws.send(data);
	}

	isOpen(): boolean {
		return this.ws.readyState === WebSocket.OPEN;
	}

	private handleClose(event: CloseEvent): void {
		if (event.code === 1008) {
			this.events.onRejected(event.reason || "another client is already connected");
			return;
		}
		this.logger
			.tag("network")
			.log(`disconnected from robot server code=${event.code} reason=${event.reason || "none"}`);
	}

	private handleMessage(event: MessageEvent): void {
		const message = JSON.parse(String(event.data)) as ServerMessage;

		if (message.type === "robot_request") {
			void this.handleRequest(message);
			return;
		}
		if (message.type === "robot_cancel") {
			this.handleCancel(message);
			return;
		}
		if (message.type === "state") {
			this.events.onState(message.state);
			return;
		}
		if (message.type === "log") this.events.onLog(message.entry);
	}

	private async handleRequest(message: RobotWireRequest): Promise<void> {
		const controller = new AbortController();
		this.activeRobotRequests.set(message.id, { type: message.request.type, controller });
		try {
			const payload = await this.executeRequest(message, controller.signal);
			this.sendResponse(message.id, message.request.type, payload);
		} catch (error) {
			this.sendError(message.id, message.request.type, error instanceof Error ? error.message : String(error));
		} finally {
			this.activeRobotRequests.delete(message.id);
		}
	}

	private async executeRequest(
		message: RobotWireRequest,
		signal: AbortSignal,
	): Promise<RobotRpcMap[RobotRpcType]["response"]> {
		if (message.request.type === "take_photo") return await this.tools.take_photo(message.request.payload, signal);
		if (message.request.type === "motor") return await this.tools.motor(message.request.payload, signal);
		if (message.request.type === "speak") return await this.tools.speak(message.request.payload, signal);
		return await this.tools.cancel_speech(message.request.payload, signal);
	}

	private handleCancel(message: RobotWireCancel): void {
		const active = this.activeRobotRequests.get(message.id);
		if (!active) {
			this.logger.tag("robot").log(`cancel ignored for inactive robot request ${message.id}`);
			return;
		}
		this.logger.tag("robot").log(`cancel ${active.type} request ${message.id}: ${message.reason}`);
		active.controller.abort(message.reason);
	}

	private sendResponse<T extends RobotRpcType>(id: string, requestType: T, payload: RobotRpcMap[T]["response"]): void {
		this.send({ type: "robot_response", id, requestType, payload } as ClientMessage);
	}

	private sendError(id: string, requestType: RobotRpcType, error: string): void {
		if (requestType === "take_photo") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		if (requestType === "motor") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		if (requestType === "speak") {
			this.send({ type: "robot_response", id, requestType, error });
			return;
		}
		this.send({ type: "robot_response", id, requestType, error });
	}
}
