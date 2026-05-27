import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { ClientMessage } from "../types.js";
import type { Logger } from "./logger.js";

export type WebsocketEvent =
	| { type: "client_connected"; client: WebSocket }
	| { type: "client_disconnected"; client: WebSocket }
	| { type: "audio_frame"; data: Buffer }
	| { type: "client_message"; message: ClientMessage };

export interface WebsocketServer {
	broadcast: (message: object) => void;
}

export function attachWebSockets(deps: {
	server: Server;
	logger: Logger;
	onEvent: (event: WebsocketEvent) => void | Promise<void>;
}): WebsocketServer {
	let activeClient: WebSocket | undefined;
	const logger = deps.logger.tag("server");
	const emit = (event: WebsocketEvent) => {
		void Promise.resolve(deps.onEvent(event)).catch((error) => {
			console.error(`[websocket] event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	};
	const robotWss = new WebSocketServer({ noServer: true });
	const reloadWss = new WebSocketServer({ noServer: true });

	deps.server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const target = url.pathname === "/__reload" ? reloadWss : robotWss;
		target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
	});

	robotWss.on("connection", (ws) => {
		if (activeClient?.readyState === WebSocket.OPEN) {
			logger.log("rejected extra ws client");
			ws.close(1008, "Only one client may connect");
			return;
		}
		activeClient = ws;
		emit({ type: "client_connected", client: ws });
		ws.on("message", (data, isBinary) => {
			try {
				if (isBinary) {
					emit({
						type: "audio_frame",
						data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
					});
					return;
				}
				emit({ type: "client_message", message: JSON.parse(String(data)) as ClientMessage });
			} catch (error) {
				logger.tag("error").log(error instanceof Error ? error.message : String(error));
			}
		});
		ws.on("close", () => {
			if (activeClient === ws) activeClient = undefined;
			emit({ type: "client_disconnected", client: ws });
		});
	});

	reloadWss.on("connection", () => {
		// The client reloads when this socket reconnects after the dev supervisor restarts the server.
	});

	return {
		broadcast: (message: object) => {
			if (activeClient?.readyState === WebSocket.OPEN) activeClient.send(JSON.stringify(message));
		},
	};
}
