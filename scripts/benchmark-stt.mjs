#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const DEFAULT_WORKER = "native/pibot-stt/target/release/pibot-stt-worker";
const DEFAULT_MODEL_DIR = `${process.env.HOME}/models/parakeet-tdt-0.6b-v3-onnx-int8`;
const DEFAULT_AUDIO = "data/voices/elevenlabs-pibot-reference.wav";

function parseArgs(argv) {
	const args = {
		worker: process.env.PARAKEET_WORKER_PATH ?? DEFAULT_WORKER,
		modelDir: process.env.PARAKEET_TDT_MODEL_DIR ?? DEFAULT_MODEL_DIR,
		audio: DEFAULT_AUDIO,
		runs: 3,
		minSilenceMs: 2000,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--worker" && next) {
			args.worker = next;
			i++;
			continue;
		}
		if (arg === "--model-dir" && next) {
			args.modelDir = next;
			i++;
			continue;
		}
		if (arg === "--audio" && next) {
			args.audio = next;
			i++;
			continue;
		}
		if (arg === "--runs" && next) {
			args.runs = Number(next);
			i++;
			continue;
		}
		if (arg === "--min-silence-ms" && next) {
			args.minSilenceMs = Number(next);
			i++;
			continue;
		}
		if (arg === "--help") {
			printHelp();
			process.exit(0);
		}
		throw new Error(`unknown or incomplete argument: ${arg}`);
	}
	if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs must be an integer >= 1");
	if (!Number.isInteger(args.minSilenceMs) || args.minSilenceMs < 1) throw new Error("--min-silence-ms must be an integer >= 1");
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/benchmark-stt.mjs [options]

Options:
  --worker PATH       STT worker path
  --model-dir PATH    Parakeet model directory
  --audio PATH        mono 16-bit WAV input (default: ${DEFAULT_AUDIO})
  --runs N            number of utterance decodes (default: 3)
  --min-silence-ms N  VAD end-of-speech silence (default: 2000)
`);
}

function parseWav(buffer) {
	if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("expected RIFF/WAVE file");
	let offset = 12;
	let format;
	let data;
	while (offset + 8 <= buffer.byteLength) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const start = offset + 8;
		const end = start + size;
		if (id === "fmt ") {
			format = {
				audioFormat: buffer.readUInt16LE(start),
				channels: buffer.readUInt16LE(start + 2),
				sampleRate: buffer.readUInt32LE(start + 4),
				bitsPerSample: buffer.readUInt16LE(start + 14),
			};
		}
		if (id === "data") data = buffer.subarray(start, end);
		offset = end + (size % 2);
	}
	if (!format || !data) throw new Error("missing fmt or data chunk");
	if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error("expected 16-bit PCM WAV");
	return { ...format, data };
}

function resampleLinear(samples, fromRate, toRate) {
	if (fromRate === toRate) return samples;
	const outputLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
	const output = new Int16Array(outputLength);
	const scale = fromRate / toRate;
	for (let i = 0; i < output.length; i++) {
		const position = i * scale;
		const left = Math.floor(position);
		const right = Math.min(samples.length - 1, left + 1);
		const fraction = position - left;
		output[i] = Math.round(samples[left] * (1 - fraction) + samples[right] * fraction);
	}
	return output;
}

function wavToMono16kPcm(wav) {
	const input = new Int16Array(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength / 2);
	const mono = new Int16Array(input.length / wav.channels);
	for (let frame = 0; frame < mono.length; frame++) {
		let sum = 0;
		for (let channel = 0; channel < wav.channels; channel++) sum += input[frame * wav.channels + channel];
		mono[frame] = Math.round(sum / wav.channels);
	}
	return Buffer.from(resampleLinear(mono, wav.sampleRate, 16000).buffer);
}

function writeFrame(stdin, pcm) {
	const header = Buffer.allocUnsafe(4);
	header.writeUInt32LE(pcm.byteLength, 0);
	stdin.write(header);
	stdin.write(pcm);
}

async function runDecode(args, pcm) {
	const child = spawn(args.worker, [args.modelDir], {
		env: { ...process.env, PARAKEET_MIN_SILENCE_MS: String(args.minSilenceMs), PARAKEET_PREROLL_MS: "0" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		for (const line of chunk.split(/\r?\n/)) if (line.trim()) console.error(`[worker] ${line.trim()}`);
	});
	let stdout = "";
	const messages = [];
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
		while (true) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) return;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (line) messages.push(JSON.parse(line));
		}
	});
	await new Promise((resolve, reject) => {
		const timer = setInterval(() => {
			if (messages.some((message) => message.type === "ready")) {
				clearInterval(timer);
				resolve();
			}
		}, 10);
		child.once("error", reject);
		child.once("exit", () => reject(new Error("worker exited before ready")));
	});
	const started = performance.now();
	writeFrame(child.stdin, pcm);
	const silence = Buffer.alloc(Math.ceil((16000 * args.minSilenceMs) / 1000) * 2, 0);
	writeFrame(child.stdin, silence);
	child.stdin.end();
	const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)));
	if (code !== 0) throw new Error(`worker exited with code ${code}`);
	const final = messages.find((message) => message.type === "final");
	if (!final) throw new Error(`no final STT result; messages=${JSON.stringify(messages)}`);
	return { wallMs: performance.now() - started, duration: final.duration, decodeMs: final.decodeMs, text: final.text };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const wav = parseWav(await readFile(args.audio));
	const pcm = wavToMono16kPcm(wav);
	const audioSeconds = pcm.byteLength / 2 / 16000;
	console.log(`worker=${args.worker}`);
	console.log(`modelDir=${args.modelDir}`);
	console.log(`audio=${args.audio}`);
	console.log(`audioSeconds=${audioSeconds.toFixed(2)} runs=${args.runs} minSilenceMs=${args.minSilenceMs}`);
	console.log("run\twall_s\taudio_s\tdecode_ms\tdecode_rtf\twall_rtf");
	for (let run = 1; run <= args.runs; run++) {
		const result = await runDecode(args, pcm);
		const decodeSeconds = result.decodeMs / 1000;
		console.log(`${run}\t${(result.wallMs / 1000).toFixed(2)}\t${result.duration.toFixed(2)}\t${result.decodeMs}\t${(result.duration / decodeSeconds).toFixed(2)}\t${(result.duration / (result.wallMs / 1000)).toFixed(2)}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
