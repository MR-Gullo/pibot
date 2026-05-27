import type { MotorCommand, RobotRpcMap } from "../../types.js";
import type { ClientLogger } from "../logger.js";
import { abortError, delay, throwIfAborted } from "./common.js";

interface USBControlTransferParameters {
	requestType: "standard" | "class" | "vendor";
	recipient: "device" | "interface" | "endpoint" | "other";
	request: number;
	value: number;
	index: number;
}

interface USBOutTransferResult {
	status: "ok" | "stall" | "babble";
	bytesWritten: number;
}

interface USBEndpoint {
	endpointNumber: number;
	direction: "in" | "out";
	type: "bulk" | "interrupt" | "isochronous";
}

interface USBAlternateInterface {
	endpoints: USBEndpoint[];
}

interface USBInterface {
	interfaceNumber?: number;
	alternate: USBAlternateInterface;
}

interface USBConfiguration {
	interfaces: USBInterface[];
}

interface USBDevice {
	vendorId: number;
	productId: number;
	productName?: string;
	configuration: USBConfiguration | null;
	open(): Promise<void>;
	selectConfiguration(value: number): Promise<void>;
	claimInterface(value: number): Promise<void>;
	controlTransferOut(setup: USBControlTransferParameters): Promise<USBOutTransferResult>;
	transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
}

interface USB {
	getDevices(): Promise<USBDevice[]>;
	requestDevice(options: { filters: Array<{ vendorId?: number; productId?: number }> }): Promise<USBDevice>;
}

declare global {
	interface Navigator {
		readonly usb?: USB;
	}
}

export interface MotorTool {
	connectFt232h: (promptIfMissing: boolean) => Promise<boolean>;
	startOrientationTracking: () => Promise<boolean>;
	stopLocalMotorsNow: () => void;
	handle: (payload: RobotRpcMap["motor"]["request"], signal: AbortSignal) => Promise<RobotRpcMap["motor"]["response"]>;
}

const FTDI_VENDOR = 0x0403;
const FT232H_PRODUCT = 0x6014;
const SIO_RESET = 0x00;
const SIO_SET_BITMODE = 0x0b;
const BITMODE_RESET = 0x00;
const BITMODE_BITBANG = 0x01;
const FT232H_INTERFACE_A = 1;
const FT232H_D4 = 0x10;
const FT232H_D5 = 0x20;
const FT232H_FORWARD_PIN = FT232H_D5;
const FT232H_TURN_LEFT_PIN = FT232H_D4;
const FT232H_DIRECTION_MASK = FT232H_D4 | FT232H_D5;

type TurnDirection = 1 | -1;

function normalizeDegrees(value: number): number {
	return ((value % 360) + 360) % 360;
}

function turnProgressDegrees(start: number, current: number, direction: TurnDirection): number {
	return direction === 1 ? normalizeDegrees(current - start) : normalizeDegrees(start - current);
}

function formatDegrees(value: number | null | undefined): string {
	return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}°` : "-";
}

function motorCommandPins(command: MotorCommand): number {
	if (command === "forward") return FT232H_FORWARD_PIN;
	if (command === "turn_left" || command === "turn_left_degrees") return FT232H_TURN_LEFT_PIN;
	return 0;
}

function chooseTurnDirection(
	startHeading: number,
	current: number,
	previousDirection: TurnDirection | undefined,
): TurnDirection {
	if (previousDirection) return previousDirection;
	const positive = turnProgressDegrees(startHeading, current, 1);
	const negative = turnProgressDegrees(startHeading, current, -1);
	if (positive < 180 && negative >= 180) return 1;
	if (negative < 180 && positive >= 180) return -1;
	if (positive < 180 && negative < 180) return positive >= negative ? 1 : -1;
	return 1;
}

export function createMotorTool(deps: { logger: ClientLogger; gyroStatus: HTMLElement }): MotorTool {
	const logger = deps.logger.tag("hardware");
	const robotLogger = deps.logger.tag("robot");
	const orientationLogger = deps.logger.tag("orientation");
	let ftDevice: USBDevice | undefined;
	let ftOutEndpoint = 0x02;
	let ftConnected = false;
	let motorStopTimer: ReturnType<typeof setTimeout> | undefined;
	let motorStopResolve: (() => void) | undefined;
	let motorGeneration = 0;
	let orientationTracking = false;
	let currentHeading: number | undefined;
	let currentHeadingAt = 0;
	let currentOrientationAlpha: number | null = null;
	let currentOrientationBeta: number | null = null;
	let currentOrientationGamma: number | null = null;
	let currentCompassHeading: number | undefined;
	let orientationSampleCount = 0;

	async function ftControl(request: number, value: number, index = FT232H_INTERFACE_A): Promise<void> {
		if (!ftDevice) throw new Error("FT232H not connected");
		const result = await ftDevice.controlTransferOut({
			requestType: "vendor",
			recipient: "device",
			request,
			value,
			index,
		});
		if (result.status !== "ok") throw new Error(`FT232H controlTransferOut failed: ${result.status}`);
	}

	async function ftSetBitbang(enabled: boolean): Promise<void> {
		const mode = enabled ? BITMODE_BITBANG : BITMODE_RESET;
		await ftControl(SIO_SET_BITMODE, FT232H_DIRECTION_MASK | (mode << 8));
	}

	async function ftWritePins(value: number): Promise<void> {
		if (!ftDevice) throw new Error("FT232H not connected");
		const result = await ftDevice.transferOut(ftOutEndpoint, new Uint8Array([value]));
		if (result.status !== "ok") throw new Error(`FT232H transferOut failed: ${result.status}`);
	}

	async function connectFt232h(promptIfMissing: boolean): Promise<boolean> {
		const usb = navigator.usb;
		if (!usb) {
			logger.log("WebUSB unavailable; motors cannot run");
			return false;
		}
		try {
			let device = (await usb.getDevices()).find(
				(entry) => entry.vendorId === FTDI_VENDOR && entry.productId === FT232H_PRODUCT,
			);
			if (!device && promptIfMissing) {
				device = await usb.requestDevice({
					filters: [{ vendorId: FTDI_VENDOR, productId: FT232H_PRODUCT }],
				});
			}
			if (!device) return false;
			ftDevice = device;
			await device.open();
			if (device.configuration === null) await device.selectConfiguration(1);
			const interfaces = device.configuration?.interfaces ?? [];
			logger.log(
				`FT232H interfaces: ${interfaces
					.map(
						(iface, index) =>
							`#${index}/n=${iface.interfaceNumber ?? index}/eps=${iface.alternate.endpoints
								.map((endpoint) => `${endpoint.direction}:${endpoint.type}:${endpoint.endpointNumber}`)
								.join(",")}`,
					)
					.join(" | ")}`,
			);

			const claimedInterfaceNumber = interfaces[0]?.interfaceNumber ?? 0;
			await device.claimInterface(claimedInterfaceNumber);
			const endpoint = interfaces[0]?.alternate.endpoints.find(
				(entry) => entry.direction === "out" && entry.type === "bulk",
			);
			if (!endpoint) throw new Error("FT232H bulk OUT endpoint not found after claiming interface");
			ftOutEndpoint = endpoint.endpointNumber;

			await ftControl(SIO_RESET, 0);
			await ftSetBitbang(true);
			await ftWritePins(0);
			ftConnected = true;
			logger.log(
				`FT232H connected: ${device.productName ?? "FT232H"} interface=${claimedInterfaceNumber} ep=${ftOutEndpoint}`,
			);
			return true;
		} catch (error) {
			ftDevice = undefined;
			ftConnected = false;
			logger.log(`FT232H connect failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	async function stopMotorPins(): Promise<void> {
		await ftWritePins(0);
	}

	function updateGyroStatus(): void {
		deps.gyroStatus.textContent = `Gyro: heading=${formatDegrees(currentHeading)} alpha=${formatDegrees(currentOrientationAlpha)} beta=${formatDegrees(currentOrientationBeta)} gamma=${formatDegrees(currentOrientationGamma)} compass=${formatDegrees(currentCompassHeading)}`;
	}

	function handleOrientation(event: DeviceOrientationEvent): void {
		const withCompass = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
		currentOrientationAlpha = event.alpha;
		currentOrientationBeta = event.beta;
		currentOrientationGamma = event.gamma;
		currentCompassHeading =
			typeof withCompass.webkitCompassHeading === "number" && Number.isFinite(withCompass.webkitCompassHeading)
				? normalizeDegrees(withCompass.webkitCompassHeading)
				: undefined;
		const heading = currentCompassHeading ?? event.alpha;
		if (typeof heading === "number" && Number.isFinite(heading)) {
			currentHeading = normalizeDegrees(heading);
			currentHeadingAt = Date.now();
			orientationSampleCount++;
		}
		updateGyroStatus();
	}

	async function waitForHeading(
		timeoutMs: number,
		options: { allowStale?: boolean; afterSample?: number } = {},
		signal?: AbortSignal,
	): Promise<number | undefined> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			throwIfAborted(signal);
			const hasRequestedSample = options.afterSample === undefined || orientationSampleCount > options.afterSample;
			if (currentHeading !== undefined && hasRequestedSample) {
				if (options.allowStale || Date.now() - currentHeadingAt < 1500) return currentHeading;
			}
			await delay(50, signal);
		}
		return options.allowStale ? currentHeading : undefined;
	}

	async function startOrientationTracking(): Promise<boolean> {
		if (orientationTracking) return true;
		if (!("DeviceOrientationEvent" in window)) {
			orientationLogger.log("Device orientation unavailable; degree turns disabled");
			return false;
		}
		const orientationCtor = DeviceOrientationEvent as unknown as {
			requestPermission?: () => Promise<"granted" | "denied" | "prompt">;
		};
		if (orientationCtor.requestPermission) {
			const permission = await orientationCtor.requestPermission();
			if (permission !== "granted") {
				orientationLogger.log(`Device orientation permission not granted: ${permission}`);
				return false;
			}
		}
		window.addEventListener("deviceorientation", handleOrientation);
		orientationTracking = true;
		updateGyroStatus();
		await waitForHeading(1200);
		orientationLogger.log(
			`Orientation tracking ${currentHeading === undefined ? "started without heading yet" : `heading=${currentHeading.toFixed(1)}°`}`,
		);
		return true;
	}

	async function pulseTurnLeft(pulseMs: number, signal?: AbortSignal): Promise<void> {
		await ftWritePins(FT232H_TURN_LEFT_PIN);
		try {
			await delay(pulseMs, signal);
		} finally {
			await stopMotorPins();
		}
	}

	async function pulseTurnFallback(
		untilMs: number,
		generation: number,
		reason: string,
		signal?: AbortSignal,
	): Promise<void> {
		const startedAt = Date.now();
		robotLogger.log(`gyro fallback timed pulse turn: ${reason}`);
		while (generation === motorGeneration && Date.now() - startedAt < untilMs) {
			throwIfAborted(signal);
			await pulseTurnLeft(Math.min(180, Math.max(40, untilMs - (Date.now() - startedAt))), signal);
			await delay(120, signal);
		}
	}

	async function turnLeftByDegrees(
		degrees: number,
		maxDurationMs: number,
		generation: number,
		signal?: AbortSignal,
	): Promise<void> {
		const startHeading = await waitForHeading(1500, { allowStale: true }, signal);
		const targetDegrees = Math.max(1, Math.min(359, degrees));
		const startedAt = Date.now();
		const pulseMs = 140;
		const settleMs = 180;
		let turned = 0;
		let direction: TurnDirection | undefined;
		let missedFreshSamples = 0;
		if (startHeading === undefined) {
			await pulseTurnFallback(maxDurationMs, generation, "no initial heading", signal);
			return;
		}
		try {
			while (generation === motorGeneration && Date.now() - startedAt < maxDurationMs) {
				throwIfAborted(signal);
				const sampleBeforePulse = orientationSampleCount;
				await pulseTurnLeft(pulseMs, signal);
				await delay(settleMs, signal);
				const heading = await waitForHeading(450, { allowStale: true, afterSample: sampleBeforePulse }, signal);
				if (heading === undefined) {
					missedFreshSamples++;
					if (missedFreshSamples >= 3) break;
					continue;
				}
				if (orientationSampleCount <= sampleBeforePulse) missedFreshSamples++;
				else missedFreshSamples = 0;
				direction = chooseTurnDirection(startHeading, heading, direction);
				turned = turnProgressDegrees(startHeading, heading, direction);
				robotLogger.log(
					`gyro pulse target=${targetDegrees.toFixed(1)}° turned≈${turned.toFixed(1)}° heading=${heading.toFixed(1)}° dir=${direction} fresh=${orientationSampleCount > sampleBeforePulse}`,
				);
				if (turned >= targetDegrees || missedFreshSamples >= 3) break;
			}
			if (turned < targetDegrees && generation === motorGeneration) {
				const remainingMs = Math.max(0, maxDurationMs - (Date.now() - startedAt));
				await pulseTurnFallback(
					remainingMs,
					generation,
					`gyro progress stopped at ${turned.toFixed(1)}°/${targetDegrees.toFixed(1)}°`,
					signal,
				);
			}
		} finally {
			await stopMotorPins();
		}
		throwIfAborted(signal);
		if (generation !== motorGeneration) throw new Error("Degree turn aborted");
		robotLogger.log(`gyro turn_left_degrees target=${targetDegrees.toFixed(1)}° actual≈${turned.toFixed(1)}°`);
	}

	function abortMotor(): void {
		motorGeneration++;
		if (motorStopTimer) {
			clearTimeout(motorStopTimer);
			motorStopTimer = undefined;
			motorStopResolve?.();
			motorStopResolve = undefined;
		}
		if (ftConnected) void stopMotorPins().catch(() => undefined);
	}

	function stopLocalMotorsNow(): void {
		abortMotor();
	}

	async function handleMotorRequest(payload: RobotRpcMap["motor"]["request"], signal?: AbortSignal): Promise<void> {
		const { command, durationMs, degrees } = payload;
		const generation = ++motorGeneration;
		if (signal?.aborted) {
			abortMotor();
			throw abortError();
		}
		signal?.addEventListener("abort", abortMotor, { once: true });
		if (motorStopTimer) {
			clearTimeout(motorStopTimer);
			motorStopTimer = undefined;
			motorStopResolve?.();
			motorStopResolve = undefined;
		}
		try {
			if (!ftConnected) throw new Error("FT232H not connected");
			if (command === "turn_left_degrees") {
				await turnLeftByDegrees(Number(degrees ?? 45), durationMs, generation, signal);
				return;
			}
			const pins = motorCommandPins(command);
			await ftWritePins(pins);
			robotLogger.log(`motor ${command} pins=0b${pins.toString(2).padStart(8, "0")} duration=${durationMs}ms`);
			if (durationMs > 0 && pins !== 0) {
				await new Promise<void>((resolve) => {
					motorStopResolve = resolve;
					motorStopTimer = setTimeout(async () => {
						motorStopTimer = undefined;
						motorStopResolve = undefined;
						try {
							await stopMotorPins();
						} catch (error) {
							logger.log(`motor stop failed: ${error instanceof Error ? error.message : String(error)}`);
						}
						resolve();
					}, durationMs);
				});
			}
			throwIfAborted(signal);
			if (generation !== motorGeneration) throw new Error("Motor command aborted");
		} finally {
			signal?.removeEventListener("abort", abortMotor);
		}
	}

	async function handle(
		payload: RobotRpcMap["motor"]["request"],
		signal: AbortSignal,
	): Promise<RobotRpcMap["motor"]["response"]> {
		try {
			await handleMotorRequest(payload, signal);
			return { ok: true };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.log(`motor request failed: ${message}`);
			try {
				if (ftConnected) await stopMotorPins();
			} catch {
				// best-effort
			}
			return { ok: false, error: message };
		}
	}

	window.addEventListener("beforeunload", () => {
		if (!ftDevice) return;
		try {
			void ftDevice.transferOut(ftOutEndpoint, new Uint8Array([0]));
		} catch {
			// best-effort
		}
	});

	return { connectFt232h, startOrientationTracking, stopLocalMotorsNow, handle };
}
