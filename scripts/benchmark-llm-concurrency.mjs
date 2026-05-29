#!/usr/bin/env node

const DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";
const KID_PROMPTS = [
	"I am 8 and I found a weird bug under a rock. It has many legs and runs fast. Is it dangerous? Tell me what it might be, what I should do, and give me a tiny nature detective mission.",
	"Can you invent a bedtime adventure where my robot and I go to the moon, meet a lost rover, solve a problem with science, and come home safely? Make it exciting but not scary.",
	"Why do airplanes stay in the air? Explain it like I am 9, use a simple experiment I can do with paper, and then ask me one question to check if I understood.",
	"I had a fight with my friend because they took my toy robot without asking. What should I say to them? Give me kind words, angry words I should not use, and a plan.",
];

function parseArgs(argv) {
	const args = {
		baseUrl: process.env.LLAMA_BASE_URL ?? DEFAULT_BASE_URL,
		model: process.env.LLAMA_MODEL ?? "",
		maxConcurrency: 4,
		maxTokens: 768,
		runs: 1,
		prompt: "",
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--base-url" && next) {
			args.baseUrl = next;
			i++;
			continue;
		}
		if (arg === "--model" && next) {
			args.model = next;
			i++;
			continue;
		}
		if (arg === "--max-concurrency" && next) {
			args.maxConcurrency = Number(next);
			i++;
			continue;
		}
		if (arg === "--max-tokens" && next) {
			args.maxTokens = Number(next);
			i++;
			continue;
		}
		if (arg === "--runs" && next) {
			args.runs = Number(next);
			i++;
			continue;
		}
		if (arg === "--prompt" && next) {
			args.prompt = next;
			i++;
			continue;
		}
		if (arg === "--help") {
			printHelp();
			process.exit(0);
		}
		throw new Error(`unknown or incomplete argument: ${arg}`);
	}
	if (!Number.isInteger(args.maxConcurrency) || args.maxConcurrency < 1) throw new Error("--max-concurrency must be an integer >= 1");
	if (!Number.isInteger(args.maxTokens) || args.maxTokens < 1) throw new Error("--max-tokens must be an integer >= 1");
	if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error("--runs must be an integer >= 1");
	return args;
}

function printHelp() {
	console.log(`Usage: node scripts/benchmark-llm-concurrency.mjs [options]

Options:
  --base-url URL          OpenAI-compatible base URL (default: ${DEFAULT_BASE_URL})
  --model ID              model ID (default: first model from /models)
  --max-concurrency N     test concurrency 1..N (default: 4)
  --max-tokens N          completion tokens per request (default: 768)
  --runs N                runs per concurrency level (default: 1)
  --prompt TEXT           prompt text (default: rotating kid-style prompts)
`);
}

async function requestJson(url, init) {
	const response = await fetch(url, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${url} failed: HTTP ${response.status}: ${text}`);
	return JSON.parse(text);
}

function asRecord(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} was not an object`);
	return value;
}

function asNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function completionText(response) {
	const root = asRecord(response, "completion response");
	const choices = root.choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0];
	if (typeof first !== "object" || first === null) return "";
	const message = first.message;
	if (typeof message !== "object" || message === null) return "";
	const content = message.content;
	return typeof content === "string" ? content : "";
}

function tokenUsage(response, text) {
	const root = asRecord(response, "completion response");
	const usage = root.usage;
	if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
		return {
			completionTokens: asNumber(usage.completion_tokens) ?? Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.35)),
			promptTokens: asNumber(usage.prompt_tokens) ?? 0,
		};
	}
	return { completionTokens: Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length * 1.35)), promptTokens: 0 };
}

async function modelId(baseUrl, configuredModel) {
	if (configuredModel) return configuredModel;
	const response = asRecord(await requestJson(`${baseUrl}/models`), "models response");
	const data = response.data;
	if (!Array.isArray(data) || data.length === 0) throw new Error("/models returned no models; pass --model explicitly");
	const first = data[0];
	if (typeof first !== "object" || first === null || typeof first.id !== "string") throw new Error("/models response did not include data[0].id");
	return first.id;
}

async function runOne(baseUrl, model, maxTokens, prompt, concurrency, run, index) {
	const nonce = `${Date.now()}-${concurrency}-${run}-${index}`;
	const selectedPrompt = prompt || KID_PROMPTS[(run + index - 2) % KID_PROMPTS.length];
	const started = performance.now();
	const response = await requestJson(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{
					role: "system",
					content:
						"You are Pipi, a warm, safe robot friend for children. Answer clearly, age-appropriately, and with practical next steps. Do not be terse unless asked.",
				},
				{ role: "user", content: `${selectedPrompt}\n\nBenchmark nonce: ${nonce}` },
			],
			max_tokens: maxTokens,
			temperature: 0,
			stream: false,
		}),
	});
	const elapsedMs = performance.now() - started;
	const text = completionText(response);
	return { elapsedMs, ...tokenUsage(response, text) };
}

function summarize(samples) {
	const wallMs = Math.max(...samples.map((sample) => sample.elapsedMs));
	const completionTokensTotal = samples.reduce((sum, sample) => sum + sample.completionTokens, 0);
	const promptTokensTotal = samples.reduce((sum, sample) => sum + sample.promptTokens, 0);
	return {
		wallMs,
		completionTokensTotal,
		promptTokensTotal,
		completionTokensPerSecond: completionTokensTotal / (wallMs / 1000),
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const model = await modelId(args.baseUrl, args.model);
	console.log(`baseUrl=${args.baseUrl}`);
	console.log(`model=${model}`);
	console.log(`maxTokens=${args.maxTokens} runs=${args.runs}`);
	console.log(`prompt=${args.prompt ? "custom" : "rotating kid-style prompts"}`);
	console.log("");
	console.log("conc\trun\twall_s\tin_tok\tout_tok\tout_tok_s");

	for (let concurrency = 1; concurrency <= args.maxConcurrency; concurrency++) {
		for (let run = 1; run <= args.runs; run++) {
			const samples = await Promise.all(
				Array.from({ length: concurrency }, (_, index) =>
					runOne(args.baseUrl, model, args.maxTokens, args.prompt, concurrency, run, index + 1),
				),
			);
			const summary = summarize(samples);
			console.log(
				`${concurrency}\t${run}\t${(summary.wallMs / 1000).toFixed(2)}\t${summary.promptTokensTotal}\t${summary.completionTokensTotal}\t${summary.completionTokensPerSecond.toFixed(2)}`,
			);
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
