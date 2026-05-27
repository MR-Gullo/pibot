#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const defaultReferenceText = `Hello, I am Pipi, your small robot friend. I can talk with you, remember useful details, take photos, and drive around the room. Please listen to the natural rhythm, tone, and personality of this voice, because this recording will be used as a clean voice reference for open source speech synthesis.`;

function parseArgs() {
	const args = process.argv.slice(2);
	const options = {
		outputDir: "data/voices",
		name: "elevenlabs-pibot-reference",
		text: undefined,
		textFile: undefined,
		voiceId: process.env.ELEVENLABS_VOICE_ID,
		voiceName: process.env.ELEVENLABS_VOICE_NAME ?? "pibot",
		modelId: process.env.ELEVENLABS_MODEL_ID ?? "eleven_v3",
		wav: true,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = () => {
			const value = args[++i];
			if (!value) throw new Error(`Missing value for ${arg}`);
			return value;
		};
		if (arg === "--output-dir") options.outputDir = next();
		else if (arg === "--name") options.name = next();
		else if (arg === "--text") options.text = next();
		else if (arg === "--text-file") options.textFile = next();
		else if (arg === "--voice-id") options.voiceId = next();
		else if (arg === "--voice-name") options.voiceName = next();
		else if (arg === "--model-id") options.modelId = next();
		else if (arg === "--no-wav") options.wav = false;
		else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

function printHelp() {
	console.log(`Usage: node scripts/elevenlabs-reference.mjs [options]

Generates a clean ElevenLabs reference recording and matching transcript for Qwen3 voice cloning.
Qwen3 can clone from about 3 seconds, but this default text gives a safer ~12-18 second reference.

Options:
  --output-dir DIR   Output directory (default: data/voices)
  --name NAME        Output basename (default: elevenlabs-pibot-reference)
  --text TEXT        Reference transcript to synthesize
  --text-file FILE   Read reference transcript from a file
  --voice-id ID      ElevenLabs voice id (default: ELEVENLABS_VOICE_ID)
  --voice-name NAME  Voice name lookup if no voice id is set (default: ELEVENLABS_VOICE_NAME or pibot)
  --model-id ID      ElevenLabs model id (default: ELEVENLABS_MODEL_ID or eleven_v3)
  --no-wav           Skip ffmpeg mp3 -> wav conversion
`);
}

async function resolveVoiceId(apiKey, options) {
	if (options.voiceId) return options.voiceId;
	const response = await fetch("https://api.elevenlabs.io/v1/voices", {
		headers: { "xi-api-key": apiKey },
	});
	if (!response.ok) throw new Error(`ElevenLabs voice lookup failed: ${response.status} ${await response.text()}`);
	const data = await response.json();
	const voices = Array.isArray(data.voices) ? data.voices : [];
	const voice = voices.find((entry) => entry?.name === options.voiceName);
	if (!voice?.voice_id) throw new Error(`ElevenLabs voice not found by name: ${options.voiceName}`);
	return voice.voice_id;
}

async function loadReferenceText(options) {
	if (options.textFile) return (await readFile(options.textFile, "utf8")).trim();
	return (options.text ?? defaultReferenceText).trim();
}

async function synthesizeReference(apiKey, voiceId, modelId, text) {
	const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_128`;
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "audio/mpeg",
			"content-type": "application/json",
			"xi-api-key": apiKey,
		},
		body: JSON.stringify({ text, model_id: modelId }),
	});
	if (!response.ok) throw new Error(`ElevenLabs TTS failed: ${response.status} ${await response.text()}`);
	return Buffer.from(await response.arrayBuffer());
}

function convertToWav(mp3Path, wavPath) {
	const result = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", mp3Path, "-ac", "1", "-ar", "24000", wavPath], {
		encoding: "utf8",
	});
	if (result.error) return `ffmpeg unavailable: ${result.error.message}`;
	if (result.status !== 0) return result.stderr.trim() || `ffmpeg exited with status ${result.status}`;
	return undefined;
}

async function main() {
	const apiKey = process.env.ELEVENLABS_API_KEY;
	if (!apiKey) throw new Error("ELEVENLABS_API_KEY missing");

	const options = parseArgs();
	const text = await loadReferenceText(options);
	if (!text) throw new Error("Reference text is empty");

	const outputDir = resolve(options.outputDir);
	await mkdir(outputDir, { recursive: true });

	const voiceId = await resolveVoiceId(apiKey, options);
	const safeName = basename(options.name).replace(/[^a-zA-Z0-9._-]/g, "-");
	const textPath = join(outputDir, `${safeName}.txt`);
	const mp3Path = join(outputDir, `${safeName}.mp3`);
	const wavPath = join(outputDir, `${safeName}.wav`);

	console.log(`Generating ElevenLabs reference voice=${voiceId} model=${options.modelId}`);
	const audio = await synthesizeReference(apiKey, voiceId, options.modelId, text);
	await writeFile(textPath, `${text}\n`);
	await writeFile(mp3Path, audio);
	console.log(`Wrote ${mp3Path}`);
	console.log(`Wrote ${textPath}`);

	if (options.wav) {
		const error = convertToWav(mp3Path, wavPath);
		if (error) console.warn(`Could not write wav reference: ${error}`);
		else console.log(`Wrote ${wavPath}`);
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
