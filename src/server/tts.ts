import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";

type TtsProvider = "elevenlabs" | "qwen3";

export class TtsError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "TtsError";
	}
}

export type TtsEvent =
	| { type: "speech_registered"; id: string; chars: number }
	| { type: "speech_resolved"; id: string };

export interface TtsServiceDeps {
	qwen3WorkerPath: string;
	logger: Logger;
	onEvent: (event: TtsEvent) => void | Promise<void>;
}

export interface TtsService {
	fetchTtsAudio: (
		id: string,
		providerValue: string | undefined,
	) => Promise<{ response: Response; contentType: string }>;
	registerSpeech: (text: string) => Promise<{ id: string; url: string } | undefined>;
	resolveSpeech: (id: string) => Promise<void>;
	resolveAllSpeech: () => Promise<void>;
	stopChildProcess: () => void;
}

type Qwen3WorkerMessage =
	| { type: "server_ready"; backend: string; model: string }
	| { type: "ready"; backend: string; model: string; modelType: string; chunkSize: number; maxNewTokens: number }
	| { type: "ttfa"; seconds: number; label: string }
	| { type: "generated"; seconds: number; audioSeconds: number; rtf: number; label: string }
	| { type: "output"; path: string }
	| { type: "audio_chunk"; id: string; data: string }
	| { type: "request_done"; id: string; contentType: string }
	| { type: "request_error"; id?: string | null; message: string }
	| { type: "error"; message: string };

interface Qwen3PendingRequest {
	controller: ReadableStreamDefaultController<Uint8Array>;
}

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

function envNumber(name: string, fallback: number): number {
	const value = process.env[name];
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) throw new TtsError(`${name} must be a number`, 500);
	return parsed;
}

function createStreamingWavHeader(sampleRate: number): Uint8Array {
	const header = new ArrayBuffer(44);
	const view = new DataView(header);
	const writeAscii = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 0xffffffff, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, 0xffffffff, true);
	return new Uint8Array(header);
}

export function createTtsService(deps: TtsServiceDeps): TtsService {
	const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
	const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID ?? "r1pUec9VJPfpUaMUuRX2";
	const elevenLabsVoiceName = process.env.ELEVENLABS_VOICE_NAME ?? "pibot";
	const elevenLabsModelId = process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3";
	const defaultTtsProvider = process.env.TTS_PROVIDER ?? "elevenlabs";

	const qwen3ModelName = process.env.QWEN3_TTS_MODEL_NAME ?? "Qwen/Qwen3-TTS-12Hz-1.7B-Base";
	const qwen3RefAudio = process.env.QWEN3_TTS_REF_AUDIO ?? "data/voices/elevenlabs-pibot-reference-de.wav";
	const qwen3RefTextFile = process.env.QWEN3_TTS_REF_TEXT_FILE ?? "data/voices/elevenlabs-pibot-reference-de.txt";
	const qwen3Language = process.env.QWEN3_TTS_LANGUAGE ?? "de";
	const qwen3OutputSampleRate = envNumber("QWEN3_TTS_OUTPUT_SAMPLE_RATE", 24000);
	const qwen3Temperature = envNumber("QWEN3_TTS_TEMPERATURE", 0.7);
	const qwen3TopK = envNumber("QWEN3_TTS_TOP_K", 30);
	const qwen3Seed = process.env.QWEN3_TTS_SEED ?? "1234";

	const logger = deps.logger.tag("tts");
	const qwen3Logger = logger.tag("qwen3");

	async function emit(event: TtsEvent): Promise<void> {
		try {
			await deps.onEvent(event);
		} catch (error) {
			console.error(`[tts] event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const pendingSpeech = new Map<string, { text: string }>();
	const pendingQwen3 = new Map<string, Qwen3PendingRequest>();
	let qwen3Process: ChildProcess | undefined;
	let qwen3StartPromise: Promise<void> | undefined;
	let qwen3Ready = false;
	let qwen3LastError: Error | undefined;

	function parseTtsProvider(value: string | undefined): TtsProvider {
		if (value === undefined || value === "elevenlabs") return "elevenlabs";
		if (value === "qwen3") return "qwen3";
		throw new TtsError(`Unknown TTS provider: ${value}`, 400);
	}

	async function resolveElevenLabsVoiceId(): Promise<string> {
		if (!elevenLabsApiKey || process.env.ELEVENLABS_VOICE_ID) return elevenLabsVoiceId;
		try {
			const response = await fetch("https://api.elevenlabs.io/v1/voices", {
				headers: { "xi-api-key": elevenLabsApiKey },
			});
			if (!response.ok) return elevenLabsVoiceId;
			const data = (await response.json()) as { voices?: Array<{ name?: string; voice_id?: string }> };
			const voice = data.voices?.find((entry) => entry.name === elevenLabsVoiceName);
			return voice?.voice_id ?? elevenLabsVoiceId;
		} catch (error) {
			logger.log(`ElevenLabs voice lookup failed: ${error instanceof Error ? error.message : String(error)}`);
			return elevenLabsVoiceId;
		}
	}

	async function fetchElevenLabsTts(text: string): Promise<{ response: Response; contentType: string }> {
		if (!elevenLabsApiKey) throw new TtsError("ELEVENLABS_API_KEY missing", 503);
		const voiceId = await resolveElevenLabsVoiceId();
		const response = await fetch(
			`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`,
			{
				method: "POST",
				headers: {
					accept: "audio/mpeg",
					"content-type": "application/json",
					"xi-api-key": elevenLabsApiKey,
				},
				body: JSON.stringify({ text, model_id: elevenLabsModelId }),
			},
		);
		return { response, contentType: "audio/mpeg" };
	}

	function rejectAllQwen3(error: Error): void {
		for (const pending of pendingQwen3.values()) pending.controller.error(error);
		pendingQwen3.clear();
	}

	function handleQwen3Message(message: Qwen3WorkerMessage): void {
		if (message.type === "server_ready") {
			qwen3Ready = true;
			qwen3Logger.log(`ready backend=${message.backend} model=${message.model}`);
			return;
		}
		if (message.type === "ready") {
			qwen3Logger.log(
				`request ready modelType=${message.modelType} chunkSize=${message.chunkSize} maxNewTokens=${message.maxNewTokens}`,
			);
			return;
		}
		if (message.type === "ttfa") {
			qwen3Logger.log(`TTFA ${message.seconds.toFixed(3)}s (${message.label})`);
			return;
		}
		if (message.type === "generated") {
			qwen3Logger.log(
				`generated ${message.audioSeconds.toFixed(2)}s audio in ${message.seconds.toFixed(2)}s (${message.rtf.toFixed(2)}x realtime)`,
			);
			return;
		}
		if (message.type === "audio_chunk") {
			const pending = pendingQwen3.get(message.id);
			if (!pending) return;
			pending.controller.enqueue(new Uint8Array(Buffer.from(message.data, "base64")));
			return;
		}
		if (message.type === "request_done") {
			const pending = pendingQwen3.get(message.id);
			if (!pending) return;
			pendingQwen3.delete(message.id);
			pending.controller.close();
			return;
		}
		if (message.type === "request_error") {
			const error = new Error(message.message);
			if (!message.id) {
				qwen3LastError = error;
				qwen3Logger.log(`error: ${message.message}`);
				return;
			}
			const pending = pendingQwen3.get(message.id);
			if (!pending) return;
			pendingQwen3.delete(message.id);
			pending.controller.error(error);
			return;
		}
		if (message.type === "error") {
			qwen3LastError = new Error(message.message);
			qwen3Logger.log(`error: ${message.message}`);
		}
	}

	function handleQwen3StdoutLine(line: string): void {
		if (!line.startsWith("{")) {
			qwen3Logger.log(line);
			return;
		}
		try {
			handleQwen3Message(JSON.parse(line) as Qwen3WorkerMessage);
		} catch {
			qwen3Logger.log(line);
		}
	}

	function startQwen3Process(): void {
		if (qwen3Process && !qwen3Process.killed) return;
		qwen3Ready = false;
		qwen3LastError = undefined;
		const args = [
			"run",
			"--no-project",
			"--with",
			"speech-to-speech==0.2.9",
			"python",
			deps.qwen3WorkerPath,
			"--serve",
			"--model-name",
			qwen3ModelName,
			"--ref-audio",
			qwen3RefAudio,
			"--ref-text-file",
			qwen3RefTextFile,
			"--language",
			qwen3Language,
			"--output-sample-rate",
			String(qwen3OutputSampleRate),
			"--temperature",
			String(qwen3Temperature),
			"--top-k",
			String(qwen3TopK),
		];
		if (qwen3Seed.trim()) args.push("--seed", qwen3Seed);
		logger.log(`starting Qwen3 TTS worker: uv ${args.join(" ")}`);
		const child = spawn("uv", args, { stdio: ["pipe", "pipe", "pipe"] });
		qwen3Process = child;
		streamLines(child.stdout, handleQwen3StdoutLine);
		streamLines(child.stderr, (line) => qwen3Logger.log(line));
		child.once("error", (error) => {
			qwen3LastError = error;
			rejectAllQwen3(error);
			logger.log(`Qwen3 TTS worker failed to start: ${error.message}`);
		});
		child.once("exit", (code, signal) => {
			if (qwen3Process === child) qwen3Process = undefined;
			qwen3Ready = false;
			const error = new Error(`Qwen3 TTS worker exited code=${code ?? "none"} signal=${signal ?? "none"}`);
			rejectAllQwen3(error);
			if (code !== 0) logger.log(error.message);
		});
	}

	async function ensureQwen3Started(): Promise<void> {
		if (qwen3Process && qwen3Ready) return;
		qwen3StartPromise ??= new Promise<void>((resolveReady, rejectReady) => {
			startQwen3Process();
			const deadline = Date.now() + 180000;
			const check = () => {
				if (qwen3Ready) {
					resolveReady();
					return;
				}
				if (qwen3LastError) {
					rejectReady(qwen3LastError);
					return;
				}
				if (Date.now() > deadline) {
					rejectReady(new Error("Qwen3 TTS worker did not become ready within 180s"));
					return;
				}
				setTimeout(check, 250);
			};
			check();
		});
		try {
			await qwen3StartPromise;
		} finally {
			qwen3StartPromise = undefined;
		}
	}

	async function requestQwen3Tts(text: string): Promise<{ response: Response; contentType: string }> {
		await ensureQwen3Started();
		if (!qwen3Process?.stdin || qwen3Process.stdin.destroyed) throw new TtsError("Qwen3 TTS worker unavailable", 503);
		const id = randomUUID();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				pendingQwen3.set(id, { controller });
				controller.enqueue(createStreamingWavHeader(qwen3OutputSampleRate));
				qwen3Process?.stdin?.write(`${JSON.stringify({ id, text })}\n`, (error) => {
					if (!error) return;
					pendingQwen3.delete(id);
					controller.error(error);
				});
			},
			cancel() {
				pendingQwen3.delete(id);
			},
		});
		return { response: new Response(stream), contentType: "audio/wav" };
	}

	async function fetchTts(
		id: string,
		providerValue: string | undefined,
	): Promise<{ response: Response; contentType: string }> {
		const pending = pendingSpeech.get(id);
		if (!pending) throw new TtsError("speech not found", 404);
		const provider = parseTtsProvider(providerValue ?? defaultTtsProvider);
		return provider === "qwen3" ? await requestQwen3Tts(pending.text) : await fetchElevenLabsTts(pending.text);
	}

	async function resolveSpeech(id: string): Promise<void> {
		if (!pendingSpeech.delete(id)) return;
		await emit({ type: "speech_resolved", id });
	}

	async function resolveAllSpeech(): Promise<void> {
		for (const id of pendingSpeech.keys()) await resolveSpeech(id);
	}

	async function registerSpeech(text: string): Promise<{ id: string; url: string } | undefined> {
		const trimmed = text.trim();
		if (!trimmed) return undefined;
		const id = randomUUID();
		pendingSpeech.set(id, { text: trimmed });
		await emit({ type: "speech_registered", id, chars: trimmed.length });
		return { id, url: `/api/tts?id=${encodeURIComponent(id)}` };
	}

	function stopChildProcess(): void {
		qwen3Process?.kill();
	}

	return {
		fetchTtsAudio: fetchTts,
		registerSpeech,
		resolveSpeech,
		resolveAllSpeech,
		stopChildProcess,
	};
}
