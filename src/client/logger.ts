import type { ClientLogMsg } from "../types.js";

export interface ClientLogger {
	tag: (tag: string) => ClientLogger;
	log: (message: string) => void;
}

export type ClientLogSender = (message: ClientLogMsg) => void;

export class BrowserClientLogger implements ClientLogger {
	private sender: ClientLogSender | undefined;
	private readonly tags: string[];

	constructor(tags: string[] = [], sender?: ClientLogSender) {
		this.tags = tags;
		this.sender = sender;
	}

	setSender(sender: ClientLogSender): void {
		this.sender = sender;
	}

	tag(tag: string): ClientLogger {
		return new BrowserClientLogger([...this.tags, tag], (message) => this.sender?.(message));
	}

	log(message: string): void {
		this.sender?.({
			type: "client_log",
			tags: this.tags,
			message: message.slice(0, 4000),
			time: Date.now(),
		});
	}
}
