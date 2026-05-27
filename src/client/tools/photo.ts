import type { RobotRpcMap } from "../../types.js";
import type { ClientLogger } from "../logger.js";
import { throwIfAborted } from "./common.js";

export interface PhotoTool {
	ensureCameraStream: () => Promise<MediaStream>;
	startIfPreviouslyEnabled: () => void;
	handle: (
		payload: RobotRpcMap["take_photo"]["request"],
		signal: AbortSignal,
	) => Promise<RobotRpcMap["take_photo"]["response"]>;
}

export function createPhotoTool(deps: { logger: ClientLogger }): PhotoTool {
	const logger = deps.logger.tag("camera");
	const cameraEnabledKey = "robot-camera-enabled";
	let cameraStream: MediaStream | undefined;
	let cameraVideo: HTMLVideoElement | undefined;
	let cameraEnabled = localStorage.getItem(cameraEnabledKey) === "true";

	async function ensureCameraStream(): Promise<MediaStream> {
		if (cameraStream?.getVideoTracks().every((track) => track.readyState === "live")) return cameraStream;
		if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera API unavailable");
		const stream = await navigator.mediaDevices.getUserMedia({
			video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
			audio: false,
		});
		cameraStream = stream;
		localStorage.setItem(cameraEnabledKey, "true");
		cameraEnabled = true;
		if (!cameraVideo) {
			cameraVideo = document.createElement("video");
			cameraVideo.muted = true;
			cameraVideo.playsInline = true;
			cameraVideo.autoplay = true;
			cameraVideo.style.position = "fixed";
			cameraVideo.style.width = "1px";
			cameraVideo.style.height = "1px";
			cameraVideo.style.opacity = "0";
			cameraVideo.style.pointerEvents = "none";
			document.body.append(cameraVideo);
		}
		cameraVideo.srcObject = stream;
		await cameraVideo.play().catch(() => undefined);
		return stream;
	}

	async function capturePhotoDataUrl(): Promise<string> {
		await ensureCameraStream();
		const video = cameraVideo;
		if (!video) throw new Error("Camera video element missing");
		if (video.readyState < 2) {
			await new Promise<void>((resolve) => {
				const handler = () => {
					video.removeEventListener("loadeddata", handler);
					resolve();
				};
				video.addEventListener("loadeddata", handler);
			});
		}
		const width = video.videoWidth || 640;
		const height = video.videoHeight || 480;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Canvas 2d context unavailable");
		ctx.drawImage(video, 0, 0, width, height);
		return canvas.toDataURL("image/jpeg", 0.82);
	}

	async function handle(
		_payload: RobotRpcMap["take_photo"]["request"],
		signal: AbortSignal,
	): Promise<RobotRpcMap["take_photo"]["response"]> {
		throwIfAborted(signal);
		const dataUrl = await capturePhotoDataUrl();
		throwIfAborted(signal);
		logger.log(`Captured photo (${dataUrl.length} chars)`);
		return { dataUrl };
	}

	function startIfPreviouslyEnabled(): void {
		if (cameraEnabled) void ensureCameraStream().catch(() => undefined);
	}

	return { ensureCameraStream, startIfPreviouslyEnabled, handle };
}
