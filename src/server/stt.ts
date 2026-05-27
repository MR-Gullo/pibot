import { type ChildProcess, spawn } from "node:child_process";
import type { Logger } from "./logger.js";

export interface SttServiceDeps {
	workerPath: string;
	logger: Logger;
	onEvent: (event: SttEvent) => void;
}

export interface SttService {
	handleAudioFrame: (data: Buffer) => void;
	stopChildProcess: () => void;
}

export type SttEvent =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
	  }
	| { type: "speech_start"; index: number }
	| { type: "speech_end"; index: number; duration: number }
	| { type: "speech_drop"; index: number; duration: number; reason: string }
	| { type: "interim"; index: number; text: string; audioMs: number; decodeMs: number }
	| { type: "final"; index: number; text: string; decodeMs: number }
	| { type: "error"; message: string };

type SttWorkerMsg =
	| {
			type: "ready";
			sampleRate: number;
			vadChunkMs: number;
			vadThreshold: number;
			minSilenceMs: number;
			speechPadMs: number;
			prerollMs: number;
			interimIntervalMs?: number;
	  }
	| { type: "speech_start"; index: number; time: number }
	| { type: "speech_end"; index: number; duration: number }
	| { type: "speech_drop"; index: number; duration: number; reason: string }
	| { type: "interim"; index: number; text: string; audioMs: number; decodeMs: number }
	| { type: "final"; index: number; text: string; duration: number; decodeMs: number }
	| { type: "error"; message: string };

function streamLines(stream: NodeJS.ReadableStream | null | undefined, onLine: (line: string) => void): void {
	if (!stream) return;
	let buffered = "";
	stream.on("data", (chunk: Buffer | string) => {
		buffered += chunk.toString();
		while (true) {
			const newline = buffered.indexOf("\n");
			if (newline < 0) return;
			const line = buffered.slice(0, newline).trim();
			buffered = buffered.slice(newline + 1);
			if (line) onLine(line);
		}
	});
	stream.on("end", () => {
		const line = buffered.trim();
		buffered = "";
		if (line) onLine(line);
	});
}

export function createSttService(deps: SttServiceDeps): SttService {
	let process: ChildProcess | undefined;
	let stdout = "";
	const logger = deps.logger.tag("stt");
	const emit = deps.onEvent;

	function startWorker(): void {
		if (process && !process.killed) return;
		stdout = "";
		logger.log("loading Parakeet/Silero worker");
		const child = spawn("uvx", ["--with", "parakeet-mlx", "--with", "silero-vad", "python", deps.workerPath], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		process = child;
		child.stdout?.on("data", (data: Buffer) => handleStdout(data));
		streamLines(child.stderr, (line) => logger.log(line));
		child.once("error", (error) => emit({ type: "error", message: error.message }));
		child.once("exit", (code, signal) => {
			if (process === child) process = undefined;
			logger.log(`Parakeet worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
		});
	}

	function handleStdout(data: Buffer): void {
		stdout += data.toString("utf8");
		while (true) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) return;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (!line) continue;
			try {
				handleMessage(JSON.parse(line) as SttWorkerMsg);
			} catch (error) {
				logger.log(
					`failed to parse worker line: ${line}; ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	function handleMessage(message: SttWorkerMsg): void {
		if (message.type === "ready") {
			emit({
				type: "ready",
				sampleRate: message.sampleRate,
				vadChunkMs: message.vadChunkMs,
				vadThreshold: message.vadThreshold,
				minSilenceMs: message.minSilenceMs,
				prerollMs: message.prerollMs,
				interimIntervalMs: message.interimIntervalMs,
			});
			return;
		}
		if (message.type === "speech_start") {
			emit({ type: "speech_start", index: message.index });
			return;
		}
		if (message.type === "speech_end") {
			emit({ type: "speech_end", index: message.index, duration: message.duration });
			return;
		}
		if (message.type === "speech_drop") {
			emit({ type: "speech_drop", index: message.index, duration: message.duration, reason: message.reason });
			return;
		}
		if (message.type === "interim") {
			emit({
				type: "interim",
				index: message.index,
				text: message.text.trim(),
				audioMs: message.audioMs,
				decodeMs: message.decodeMs,
			});
			return;
		}
		if (message.type === "final") {
			emit({ type: "final", index: message.index, text: message.text.trim(), decodeMs: message.decodeMs });
			return;
		}
		emit({ type: "error", message: message.message });
	}

	function handleAudioFrame(data: Buffer): void {
		if (!process?.stdin || process.stdin.destroyed) return;
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(data.byteLength, 0);
		process.stdin.write(header);
		process.stdin.write(data);
	}

	function stopChildProcess(): void {
		process?.kill();
	}

	startWorker();
	return { handleAudioFrame, stopChildProcess };
}
