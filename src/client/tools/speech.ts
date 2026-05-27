import type { RobotRpcMap } from "../../types.js";
import type { ClientLogger } from "../logger.js";

export type TtsProvider = "elevenlabs" | "qwen3";
export type ConversationPhase = "inactive" | "listening" | "thinking" | "speaking";

interface ActiveSpeech {
	generation: number;
	resolve: (response: RobotRpcMap["speak"]["response"]) => void;
	signal: AbortSignal;
	onAbort: () => void;
	finished: boolean;
}

export interface SpeechTool {
	enableTts: () => void;
	selectedTtsProvider: () => TtsProvider;
	ttsProviderLabel: (provider: TtsProvider) => string;
	handleProviderChange: () => void;
	cancelSpeech: (reason: string) => void;
	handleSpeak: (
		payload: RobotRpcMap["speak"]["request"],
		signal: AbortSignal,
	) => Promise<RobotRpcMap["speak"]["response"]>;
	handleCancelSpeech: (
		payload: RobotRpcMap["cancel_speech"]["request"],
		signal: AbortSignal,
	) => RobotRpcMap["cancel_speech"]["response"];
}

export function createSpeechTool(deps: {
	logger: ClientLogger;
	ttsProviderControl: HTMLSelectElement;
	face: HTMLElement;
	setPhase: (phase: ConversationPhase) => void;
	resetToListeningOrIdle: () => void;
	resetRecognitionAfterTts: () => void;
	setMicInputBlockedUntil: (time: number) => void;
	onSpeakingChange: (speaking: boolean) => void;
}): SpeechTool {
	const logger = deps.logger.tag("stt");
	const ttsEnabledKey = "robot-tts-enabled";
	const ttsProviderKey = "robot-tts-provider";
	let ttsEnabled = localStorage.getItem(ttsEnabledKey) === "true";
	let currentTtsAudio: HTMLAudioElement | undefined;
	let robotVoiceEffectCleanup: (() => void) | undefined;
	let audioContext: AudioContext | undefined;
	let ttsGeneration = 0;
	let activeSpeech: ActiveSpeech | undefined;
	deps.ttsProviderControl.value = localStorage.getItem(ttsProviderKey) === "qwen3" ? "qwen3" : "elevenlabs";

	function startFaceAmpLoop(analyser: AnalyserNode): () => void {
		const data = new Uint8Array(analyser.fftSize);
		let smoothed = 0;
		let frameHandle = 0;
		let stopped = false;
		const tick = () => {
			if (stopped) return;
			analyser.getByteTimeDomainData(data);
			let sum = 0;
			for (const sample of data) {
				const centered = (sample - 128) / 128;
				sum += centered * centered;
			}
			const rms = Math.sqrt(sum / data.length);
			const amp = Math.min(1, rms * 3.4);
			smoothed = smoothed * 0.55 + amp * 0.45;
			deps.face.style.setProperty("--amp", smoothed.toFixed(3));
			frameHandle = requestAnimationFrame(tick);
		};
		frameHandle = requestAnimationFrame(tick);
		return () => {
			stopped = true;
			cancelAnimationFrame(frameHandle);
			deps.face.style.setProperty("--amp", "0");
		};
	}

	function clearCurrentTtsAudio(): void {
		robotVoiceEffectCleanup?.();
		robotVoiceEffectCleanup = undefined;
		if (!currentTtsAudio) return;
		currentTtsAudio.onplay = null;
		currentTtsAudio.onended = null;
		currentTtsAudio.onerror = null;
		currentTtsAudio.pause();
		currentTtsAudio.removeAttribute("src");
		currentTtsAudio.load();
		currentTtsAudio = undefined;
	}

	function createRobotVoiceEffect(audio: HTMLAudioElement): void {
		try {
			audioContext ??= new AudioContext();
			void audioContext.resume();
			const source = audioContext.createMediaElementSource(audio);
			const highpass = audioContext.createBiquadFilter();
			highpass.type = "highpass";
			highpass.frequency.value = 150;
			const lowpass = audioContext.createBiquadFilter();
			lowpass.type = "lowpass";
			lowpass.frequency.value = 7200;
			const presence = audioContext.createBiquadFilter();
			presence.type = "peaking";
			presence.frequency.value = 2600;
			presence.Q.value = 0.9;
			presence.gain.value = 3.5;
			const compressor = audioContext.createDynamicsCompressor();
			compressor.threshold.value = -24;
			compressor.knee.value = 18;
			compressor.ratio.value = 3;
			compressor.attack.value = 0.006;
			compressor.release.value = 0.12;
			const dry = audioContext.createGain();
			dry.gain.value = 0.9;
			const ringModulator = audioContext.createGain();
			ringModulator.gain.value = 0;
			const ringWet = audioContext.createGain();
			ringWet.gain.value = 0.09;
			const ringOsc = audioContext.createOscillator();
			ringOsc.type = "sine";
			ringOsc.frequency.value = 42;
			ringOsc.connect(ringModulator.gain);
			ringOsc.start();
			const slap = audioContext.createDelay(0.25);
			slap.delayTime.value = 0.075;
			const slapWet = audioContext.createGain();
			slapWet.gain.value = 0.045;
			const output = audioContext.createGain();
			output.gain.value = 0.98;
			const analyser = audioContext.createAnalyser();
			analyser.fftSize = 512;
			analyser.smoothingTimeConstant = 0.55;

			source.connect(highpass);
			highpass.connect(lowpass);
			lowpass.connect(presence);
			presence.connect(compressor);
			compressor.connect(dry);
			compressor.connect(ringModulator);
			ringModulator.connect(ringWet);
			dry.connect(output);
			ringWet.connect(output);
			dry.connect(slap);
			slap.connect(slapWet);
			slapWet.connect(output);
			output.connect(audioContext.destination);
			output.connect(analyser);

			const stopAmpLoop = startFaceAmpLoop(analyser);

			robotVoiceEffectCleanup = () => {
				stopAmpLoop();
				try {
					ringOsc.stop();
				} catch {
					// already stopped
				}
				for (const node of [
					source,
					highpass,
					lowpass,
					presence,
					compressor,
					dry,
					ringModulator,
					ringWet,
					ringOsc,
					slap,
					slapWet,
					output,
					analyser,
				]) {
					node.disconnect();
				}
			};
			logger.log("Robot voice effect enabled");
		} catch (error) {
			robotVoiceEffectCleanup = undefined;
			logger.log(`Robot voice effect unavailable: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function interruptTtsOnly(): void {
		ttsGeneration++;
		clearCurrentTtsAudio();
		if ("speechSynthesis" in window) window.speechSynthesis.cancel();
	}

	function completeActiveSpeech(response: RobotRpcMap["speak"]["response"]): void {
		const active = activeSpeech;
		if (!active || active.finished) return;
		active.finished = true;
		active.signal.removeEventListener("abort", active.onAbort);
		activeSpeech = undefined;
		active.resolve(response);
	}

	function cancelSpeech(reason: string): void {
		interruptTtsOnly();
		deps.onSpeakingChange(false);
		completeActiveSpeech({ ok: true });
		deps.setMicInputBlockedUntil(Date.now() + 500);
		deps.resetToListeningOrIdle();
		logger.log(`TTS cancelled: ${reason}`);
	}

	function enableTts(): void {
		ttsEnabled = true;
		localStorage.setItem(ttsEnabledKey, "true");
	}

	function finishTts(message: string): void {
		clearCurrentTtsAudio();
		deps.onSpeakingChange(false);
		completeActiveSpeech({ ok: true });
		deps.setMicInputBlockedUntil(Date.now() + 500);
		deps.resetToListeningOrIdle();
		deps.resetRecognitionAfterTts();
		logger.log(message);
	}

	function selectedTtsProvider(): TtsProvider {
		return deps.ttsProviderControl.value === "qwen3" ? "qwen3" : "elevenlabs";
	}

	function ttsProviderLabel(provider: TtsProvider): string {
		return provider === "qwen3" ? "Qwen3 local clone" : "ElevenLabs pibot";
	}

	function startSpeech(url: string, text: string, generation: number): void {
		const trimmed = text.trim();
		if (!trimmed) {
			finishTts("TTS skipped: empty text");
			return;
		}

		const provider = selectedTtsProvider();
		const providerLabel = ttsProviderLabel(provider);
		clearCurrentTtsAudio();
		deps.onSpeakingChange(true);
		deps.setPhase("speaking");
		deps.setMicInputBlockedUntil(0);

		const audio = new Audio(`${url}&provider=${encodeURIComponent(provider)}`);
		currentTtsAudio = audio;
		createRobotVoiceEffect(audio);
		audio.onplay = () => logger.log(`${providerLabel} playing streamed response ${trimmed.length} chars`);
		audio.onended = () => {
			if (generation !== ttsGeneration) return;
			finishTts(`${providerLabel} finished, resetting STT`);
		};
		audio.onerror = () => {
			if (generation !== ttsGeneration) return;
			finishTts(`${providerLabel} failed, resetting STT`);
		};
		audio.play().catch((error: unknown) => {
			if (generation !== ttsGeneration) return;
			finishTts(
				`${providerLabel} play failed, resetting STT: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}

	async function handleSpeak(
		payload: RobotRpcMap["speak"]["request"],
		signal: AbortSignal,
	): Promise<RobotRpcMap["speak"]["response"]> {
		if (!ttsEnabled) return { ok: true };
		if (activeSpeech) cancelSpeech("new speech request");
		return await new Promise<RobotRpcMap["speak"]["response"]>((resolve) => {
			const generation = ++ttsGeneration;
			const onAbort = () => cancelSpeech(String(signal.reason ?? "aborted"));
			activeSpeech = { generation, resolve, signal, onAbort, finished: false };
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) {
				onAbort();
				return;
			}
			startSpeech(payload.url, payload.text, generation);
		});
	}

	function handleCancelSpeech(
		payload: RobotRpcMap["cancel_speech"]["request"],
		_signal: AbortSignal,
	): RobotRpcMap["cancel_speech"]["response"] {
		cancelSpeech(payload.reason);
		return { ok: true };
	}

	function handleProviderChange(): void {
		localStorage.setItem(ttsProviderKey, selectedTtsProvider());
		logger.log(`TTS provider selected: ${ttsProviderLabel(selectedTtsProvider())}`);
	}

	return {
		enableTts,
		selectedTtsProvider,
		ttsProviderLabel,
		handleProviderChange,
		cancelSpeech,
		handleSpeak,
		handleCancelSpeech,
	};
}
