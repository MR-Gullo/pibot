export type RobotFaceState = "inactive" | "listening" | "hearing" | "thinking" | "speaking" | "tool" | "error";

const states: RobotFaceState[] = ["inactive", "listening", "hearing", "thinking", "speaking", "tool", "error"];
const baseWidth = 720;
const baseHeight = 460;
const vertexSource = `
	attribute vec2 a_pos;
	attribute vec2 a_uv;
	varying vec2 v_uv;
	void main() {
		gl_Position = vec4(a_pos, 0.0, 1.0);
		v_uv = a_uv;
	}
`;
const fragmentSource = `
	precision mediump float;
	uniform sampler2D u_tex;
	uniform float u_alpha;
	uniform float u_brightness;
	varying vec2 v_uv;
	void main() {
		vec4 c = texture2D(u_tex, v_uv);
		gl_FragColor = vec4(c.rgb * u_brightness * u_alpha, c.a * u_alpha);
	}
`;

interface Palette {
	eyeTop: string;
	eyeMid: string;
	eyeBottom: string;
	eyeInset: string;
	eyeGlow: string;
	eyeGlowSoft: string;
	browMid: string;
	browGlow: string;
	aura: string;
}

interface Sprite {
	texture: WebGLTexture;
	width: number;
	height: number;
}

interface SpriteSet {
	eye: Sprite;
	brow: Sprite;
	aura: Sprite;
}

interface DrawPose {
	x: number;
	y: number;
	rotation: number;
	scaleX: number;
	scaleY: number;
	alpha: number;
	brightness: number;
	additive?: boolean;
}

const palettes: Record<RobotFaceState, Palette> = {
	inactive: cyanPalette(),
	listening: cyanPalette(),
	hearing: cyanPalette(),
	thinking: purplePalette(),
	speaking: pinkPalette(),
	tool: purplePalette(),
	error: redPalette(),
};

function cyanPalette(): Palette {
	return {
		eyeTop: "#d7ffff",
		eyeMid: "#58e8ff",
		eyeBottom: "#33a8ff",
		eyeInset: "rgba(0, 68, 120, 0.30)",
		eyeGlow: "rgba(102, 244, 255, 0.85)",
		eyeGlowSoft: "rgba(57, 216, 255, 0.45)",
		browMid: "#9ff5ff",
		browGlow: "rgba(190, 250, 255, 0.6)",
		aura: "96, 236, 255",
	};
}

function purplePalette(): Palette {
	return {
		eyeTop: "#f1eaff",
		eyeMid: "#b89aff",
		eyeBottom: "#6a4cff",
		eyeInset: "rgba(50, 25, 120, 0.30)",
		eyeGlow: "rgba(205, 184, 255, 0.85)",
		eyeGlowSoft: "rgba(150, 120, 255, 0.46)",
		browMid: "#d8c7ff",
		browGlow: "rgba(200, 180, 255, 0.55)",
		aura: "150, 120, 255",
	};
}

function pinkPalette(): Palette {
	return {
		eyeTop: "#fff0f7",
		eyeMid: "#ff8ec1",
		eyeBottom: "#ff3d8b",
		eyeInset: "rgba(130, 20, 70, 0.30)",
		eyeGlow: "rgba(255, 183, 218, 0.85)",
		eyeGlowSoft: "rgba(255, 120, 180, 0.48)",
		browMid: "#ffd0e6",
		browGlow: "rgba(255, 190, 220, 0.55)",
		aura: "255, 120, 180",
	};
}

function redPalette(): Palette {
	return {
		eyeTop: "#fff0f0",
		eyeMid: "#ff8a8a",
		eyeBottom: "#ff2b4f",
		eyeInset: "rgba(130, 20, 35, 0.30)",
		eyeGlow: "rgba(255, 154, 160, 0.85)",
		eyeGlowSoft: "rgba(255, 80, 100, 0.5)",
		browMid: "#ffc1c1",
		browGlow: "rgba(255, 175, 175, 0.55)",
		aura: "255, 90, 110",
	};
}

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function createShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type);
	if (!shader) throw new Error("failed to create WebGL shader");
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		throw new Error(gl.getShaderInfoLog(shader) ?? "WebGL shader compile failed");
	}
	return shader;
}

function createProgram(gl: WebGLRenderingContext): WebGLProgram {
	const program = gl.createProgram();
	if (!program) throw new Error("failed to create WebGL program");
	gl.attachShader(program, createShader(gl, gl.VERTEX_SHADER, vertexSource));
	gl.attachShader(program, createShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		throw new Error(gl.getProgramInfoLog(program) ?? "WebGL program link failed");
	}
	return program;
}

function createTextureSprite(
	gl: WebGLRenderingContext,
	width: number,
	height: number,
	dpr: number,
	draw: (ctx: CanvasRenderingContext2D) => void,
): Sprite {
	const canvas = document.createElement("canvas");
	canvas.width = Math.ceil(width * dpr);
	canvas.height = Math.ceil(height * dpr);
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("2D canvas context unavailable");
	ctx.scale(dpr, dpr);
	draw(ctx);

	const texture = gl.createTexture();
	if (!texture) throw new Error("failed to create WebGL texture");
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	return { texture, width, height };
}

function createEyeSprite(gl: WebGLRenderingContext, palette: Palette, dpr: number): Sprite {
	return createTextureSprite(gl, 360, 340, dpr, (ctx) => {
		const cx = 180;
		const cy = 170;
		const rx = 92;
		const ry = 82;
		const ellipse = (): void => {
			ctx.beginPath();
			ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
			ctx.fill();
		};
		ctx.shadowColor = palette.eyeGlowSoft;
		ctx.shadowBlur = 64;
		ctx.fillStyle = palette.eyeGlowSoft;
		ellipse();
		ctx.shadowColor = palette.eyeGlow;
		ctx.shadowBlur = 26;
		ctx.fillStyle = palette.eyeGlow;
		ellipse();
		ctx.shadowBlur = 0;
		const fill = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
		fill.addColorStop(0, palette.eyeTop);
		fill.addColorStop(0.58, palette.eyeMid);
		fill.addColorStop(1, palette.eyeBottom);
		ctx.fillStyle = fill;
		ellipse();
		const shade = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
		shade.addColorStop(0, "rgba(255, 255, 255, 0.28)");
		shade.addColorStop(0.5, "rgba(255, 255, 255, 0)");
		shade.addColorStop(1, palette.eyeInset);
		ctx.fillStyle = shade;
		ellipse();
		const highlight = ctx.createRadialGradient(
			cx - rx * 0.32,
			cy - ry * 0.46,
			4,
			cx - rx * 0.32,
			cy - ry * 0.46,
			rx * 0.7,
		);
		highlight.addColorStop(0, "rgba(255, 255, 255, 0.55)");
		highlight.addColorStop(1, "rgba(255, 255, 255, 0)");
		ctx.fillStyle = highlight;
		ellipse();
	});
}

function createBrowSprite(gl: WebGLRenderingContext, palette: Palette, dpr: number): Sprite {
	return createTextureSprite(gl, 300, 140, dpr, (ctx) => {
		const x = 48;
		const y = 54;
		const w = 204;
		const h = 32;
		ctx.shadowColor = palette.browGlow;
		ctx.shadowBlur = 26;
		ctx.fillStyle = palette.browGlow;
		roundedRect(ctx, x, y, w, h, 16);
		ctx.fill();
		ctx.shadowBlur = 0;
		const fill = ctx.createLinearGradient(x, 0, x + w, 0);
		fill.addColorStop(0, "#ffffff");
		fill.addColorStop(1, palette.browMid);
		ctx.fillStyle = fill;
		roundedRect(ctx, x, y, w, h, 16);
		ctx.fill();
	});
}

function createAuraSprite(gl: WebGLRenderingContext, palette: Palette, dpr: number): Sprite {
	return createTextureSprite(gl, 260, 240, dpr, (ctx) => {
		const cx = 130;
		const cy = 120;
		const radius = 116;
		const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
		gradient.addColorStop(0, `rgba(${palette.aura}, 0.85)`);
		gradient.addColorStop(0.4, `rgba(${palette.aura}, 0.22)`);
		gradient.addColorStop(1, `rgba(${palette.aura}, 0)`);
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, 260, 240);
	});
}

function stateSprites(gl: WebGLRenderingContext, state: RobotFaceState, dpr: number): SpriteSet {
	const palette = palettes[state];
	return {
		eye: createEyeSprite(gl, palette, dpr),
		brow: createBrowSprite(gl, palette, dpr),
		aura: createAuraSprite(gl, palette, dpr),
	};
}

export class RobotFaceWebglElement extends HTMLElement {
	private canvas: HTMLCanvasElement | undefined;
	private gl: WebGLRenderingContext | undefined;
	private buffer: WebGLBuffer | undefined;
	private alphaLocation: WebGLUniformLocation | null = null;
	private brightnessLocation: WebGLUniformLocation | null = null;
	private currentState: RobotFaceState = "inactive";
	private previousState: RobotFaceState = "inactive";
	private stateChangedAt = 0;
	private currentAmplitude = 0;
	private displayAmplitude = 0;
	private animationFrame = 0;
	private connected = false;
	private dpr = 1;
	private cssWidth = baseWidth;
	private cssHeight = baseHeight;
	private sprites = new Map<string, SpriteSet>();
	private resizeObserver: ResizeObserver | undefined;
	private lookX = 0;
	private lookY = 0;
	private targetLookX = 0;
	private targetLookY = 0;
	private nextLookAt = 0;

	connectedCallback(): void {
		this.classList.add("face", "webgl-face");
		if (!this.canvas) {
			this.canvas = document.createElement("canvas");
			this.canvas.style.display = "block";
			this.canvas.style.width = "100%";
			this.canvas.style.height = "100%";
			this.replaceChildren(this.canvas);
		}
		this.currentState = this.parseState(this.getAttribute("state"));
		this.stateChangedAt = performance.now();
		this.initWebgl();
		this.connected = true;
		this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
		this.resizeObserver.observe(this);
		this.resizeCanvas();
		this.animationFrame = requestAnimationFrame((time) => this.tick(time));
	}

	disconnectedCallback(): void {
		this.connected = false;
		this.resizeObserver?.disconnect();
		this.resizeObserver = undefined;
		if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
		this.animationFrame = 0;
	}

	get state(): RobotFaceState {
		return this.currentState;
	}

	set state(state: RobotFaceState) {
		if (this.currentState !== state) {
			this.previousState = this.currentState;
			this.stateChangedAt = performance.now();
		}
		this.currentState = state;
		this.setAttribute("state", state);
		for (const entry of states) this.classList.toggle(entry, entry === state);
	}

	set amplitude(value: number) {
		this.currentAmplitude = Math.max(0, Math.min(1, value));
	}

	static get observedAttributes(): string[] {
		return ["state"];
	}

	attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
		if (name === "state" && newValue !== this.currentState) this.state = this.parseState(newValue);
	}

	private initWebgl(): void {
		if (this.gl || !this.canvas) return;
		const gl = this.canvas.getContext("webgl", { antialias: false, alpha: true, premultipliedAlpha: true });
		if (!gl) throw new Error("WebGL unavailable");
		const program = createProgram(gl);
		const buffer = gl.createBuffer();
		if (!buffer) throw new Error("failed to create WebGL buffer");
		const positionLocation = gl.getAttribLocation(program, "a_pos");
		const uvLocation = gl.getAttribLocation(program, "a_uv");
		gl.useProgram(program);
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.enableVertexAttribArray(positionLocation);
		gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
		gl.enableVertexAttribArray(uvLocation);
		gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 16, 8);
		gl.enable(gl.BLEND);
		gl.disable(gl.DEPTH_TEST);
		this.gl = gl;
		this.buffer = buffer;
		this.alphaLocation = gl.getUniformLocation(program, "u_alpha");
		this.brightnessLocation = gl.getUniformLocation(program, "u_brightness");
	}

	private parseState(value: string | null): RobotFaceState {
		return states.includes(value as RobotFaceState) ? (value as RobotFaceState) : "inactive";
	}

	private resizeCanvas(): void {
		if (!this.canvas || !this.gl) return;
		const rect = this.getBoundingClientRect();
		this.cssWidth = Math.max(1, rect.width || baseWidth);
		this.cssHeight = Math.max(1, rect.height || baseHeight);
		const nextDpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
		const width = Math.ceil(this.cssWidth * nextDpr);
		const height = Math.ceil(this.cssHeight * nextDpr);
		if (this.canvas.width !== width || this.canvas.height !== height) {
			this.canvas.width = width;
			this.canvas.height = height;
		}
		if (this.dpr !== nextDpr) {
			this.dpr = nextDpr;
			this.sprites.clear();
		}
		this.gl.viewport(0, 0, width, height);
	}

	private spriteSet(state: RobotFaceState): SpriteSet {
		if (!this.gl) throw new Error("WebGL not initialized");
		const key = `${state}:${this.dpr}`;
		const existing = this.sprites.get(key);
		if (existing) return existing;
		const created = stateSprites(this.gl, state, this.dpr);
		this.sprites.set(key, created);
		return created;
	}

	private updateLook(time: number): void {
		if (this.currentState !== "inactive" && this.currentState !== "listening") {
			this.targetLookX = 0;
			this.targetLookY = 0;
		} else if (time >= this.nextLookAt) {
			this.targetLookX = Math.random() * 18 - 9;
			this.targetLookY = Math.random() * 8 - 4;
			this.nextLookAt = time + 700 + Math.random() * 2400;
		}
		this.lookX += (this.targetLookX - this.lookX) * 0.035;
		this.lookY += (this.targetLookY - this.lookY) * 0.035;
	}

	private tick(time: number): void {
		if (!this.connected) return;
		this.resizeCanvas();
		this.updateLook(time);
		this.draw(time / 1000, time - this.stateChangedAt);
		this.animationFrame = requestAnimationFrame((nextTime) => this.tick(nextTime));
	}

	private worldToClip(x: number, y: number): [number, number] {
		const scale = Math.min(this.cssWidth / baseWidth, this.cssHeight / baseHeight);
		const offsetX = (this.cssWidth - baseWidth * scale) / 2;
		const offsetY = (this.cssHeight - baseHeight * scale) / 2;
		const pixelX = offsetX + x * scale;
		const pixelY = offsetY + y * scale;
		return [(pixelX / this.cssWidth) * 2 - 1, 1 - (pixelY / this.cssHeight) * 2];
	}

	private drawSprite(sprite: Sprite, pose: DrawPose): void {
		if (!this.gl || !this.buffer) return;
		const halfWidth = (sprite.width * pose.scaleX) / 2;
		const halfHeight = (sprite.height * pose.scaleY) / 2;
		const cos = Math.cos(pose.rotation);
		const sin = Math.sin(pose.rotation);
		const corners: Array<[number, number, number, number]> = [
			[-halfWidth, -halfHeight, 0, 0],
			[halfWidth, -halfHeight, 1, 0],
			[-halfWidth, halfHeight, 0, 1],
			[-halfWidth, halfHeight, 0, 1],
			[halfWidth, -halfHeight, 1, 0],
			[halfWidth, halfHeight, 1, 1],
		];
		const vertices = new Float32Array(24);
		for (let index = 0; index < corners.length; index++) {
			const [x, y, u, v] = corners[index]!;
			const worldX = pose.x + x * cos - y * sin;
			const worldY = pose.y + x * sin + y * cos;
			const [clipX, clipY] = this.worldToClip(worldX, worldY);
			vertices[index * 4] = clipX;
			vertices[index * 4 + 1] = clipY;
			vertices[index * 4 + 2] = u;
			vertices[index * 4 + 3] = v;
		}
		this.gl.bindTexture(this.gl.TEXTURE_2D, sprite.texture);
		this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
		this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STREAM_DRAW);
		this.gl.uniform1f(this.alphaLocation, pose.alpha);
		this.gl.uniform1f(this.brightnessLocation, pose.brightness);
		this.gl.blendFunc(this.gl.ONE, pose.additive ? this.gl.ONE : this.gl.ONE_MINUS_SRC_ALPHA);
		this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
	}

	private draw(time: number, stateElapsedMs: number): void {
		const gl = this.gl;
		if (!gl) return;
		const state = this.currentState;
		const targetAmp = state === "speaking" ? Math.max(this.currentAmplitude, 0.06) : 0;
		this.displayAmplitude += (targetAmp - this.displayAmplitude) * 0.18;
		const amp = this.displayAmplitude;
		const blink = this.blinkScale(time, state);
		const face = this.facePose(time, state, amp, stateElapsedMs);
		const eye = this.eyePose(time, state, amp);
		const leftBrow = this.browPose(time, state, true, amp);
		const rightBrow = this.browPose(time, state, false, amp);
		gl.clearColor(0, 0, 0, 0);
		gl.clear(gl.COLOR_BUFFER_BIT);
		const transform = (x: number, y: number): { x: number; y: number } => {
			const centeredX = x - baseWidth / 2;
			const centeredY = y - baseHeight / 2;
			const cos = Math.cos(face.rotation);
			const sin = Math.sin(face.rotation);
			return {
				x: baseWidth / 2 + face.x + (centeredX * cos - centeredY * sin) * face.scale,
				y: baseHeight / 2 + face.y + (centeredX * sin + centeredY * cos) * face.scale,
			};
		};
		const leftEye = transform(baseWidth * 0.3 + this.lookX + eye.scanX, baseHeight * 0.53 + this.lookY);
		const rightEye = transform(baseWidth * 0.7 + this.lookX + eye.scanX, baseHeight * 0.53 + this.lookY);
		const leftBrowPoint = transform(baseWidth * 0.29, leftBrow.y);
		const rightBrowPoint = transform(baseWidth * 0.71, rightBrow.y);
		const auraAlpha = 0.08 + amp * 0.4;
		const auraScale = face.scale * (1 + amp * 0.12);

		const renderLayer = (sprites: SpriteSet, fade: number): void => {
			const aura = {
				rotation: 0,
				scaleX: auraScale,
				scaleY: auraScale,
				alpha: auraAlpha * fade,
				brightness: 1,
				additive: true,
			};
			this.drawSprite(sprites.aura, { ...leftEye, ...aura });
			this.drawSprite(sprites.aura, { ...rightEye, ...aura });
			const eyePose = {
				rotation: face.rotation,
				scaleX: face.scale * eye.scaleX,
				scaleY: face.scale * eye.scaleY * blink,
				alpha: eye.alpha * fade,
				brightness: eye.brightness,
			};
			this.drawSprite(sprites.eye, { ...leftEye, ...eyePose });
			this.drawSprite(sprites.eye, { ...rightEye, ...eyePose });
			this.drawSprite(sprites.brow, {
				...leftBrowPoint,
				rotation: face.rotation + leftBrow.rotation,
				scaleX: face.scale,
				scaleY: face.scale,
				alpha: fade,
				brightness: 1,
			});
			this.drawSprite(sprites.brow, {
				...rightBrowPoint,
				rotation: face.rotation + rightBrow.rotation,
				scaleX: face.scale,
				scaleY: face.scale,
				alpha: fade,
				brightness: 1,
			});
		};

		const transitionMs = 380;
		const raw = Math.max(0, Math.min(1, stateElapsedMs / transitionMs));
		const t = raw * raw * (3 - 2 * raw);
		if (t < 1 && this.previousState !== state) renderLayer(this.spriteSet(this.previousState), 1 - t);
		renderLayer(this.spriteSet(state), t < 1 && this.previousState !== state ? t : 1);
	}

	private blinkScale(time: number, state: RobotFaceState): number {
		if (state === "speaking" || state === "hearing" || state === "tool") return 1;
		const period = state === "listening" ? 4 : state === "thinking" ? 6.2 : 3.4;
		const phase = (time % period) / period;
		if (state === "thinking") return phase > 0.94 && phase < 0.98 ? 0.25 : 1;
		return phase > 0.94 ? 0.08 : 1;
	}

	private facePose(
		time: number,
		state: RobotFaceState,
		amp: number,
		stateElapsedMs: number,
	): { x: number; y: number; rotation: number; scale: number } {
		if (state === "inactive")
			return { x: 0, y: 0, rotation: 0, scale: 1 + Math.sin(time * ((Math.PI * 2) / 5.2)) * 0.012 };
		if (state === "listening")
			return { x: 0, y: 0, rotation: 0, scale: 1 + Math.sin(time * ((Math.PI * 2) / 3.8)) * 0.015 };
		if (state === "hearing") return { x: 0, y: Math.sin(time * ((Math.PI * 2) / 0.9)) * -5.5, rotation: 0, scale: 1 };
		if (state === "thinking")
			return { x: 0, y: 0, rotation: Math.sin(time * ((Math.PI * 2) / 4.4)) * 0.021, scale: 1 };
		if (state === "speaking") return { x: 0, y: 0, rotation: 0, scale: 1 + amp * 0.015 };
		if (state === "tool")
			return {
				x: Math.sin(time * ((Math.PI * 2) / 0.84)) * 5.4,
				y: 0,
				rotation: Math.sin(time * ((Math.PI * 2) / 0.84)) * 0.044,
				scale: 1,
			};
		if (stateElapsedMs < 540) return { x: Math.sin(time * ((Math.PI * 2) / 0.18)) * 14, y: 0, rotation: 0, scale: 1 };
		return { x: 0, y: 0, rotation: 0, scale: 1 };
	}

	private eyePose(
		time: number,
		state: RobotFaceState,
		amp: number,
	): { scaleX: number; scaleY: number; brightness: number; alpha: number; scanX: number } {
		if (state === "hearing") {
			const pulse = 1.11 + Math.sin(time * ((Math.PI * 2) / 1.44)) * 0.07;
			return { scaleX: pulse, scaleY: pulse, brightness: 1, alpha: 1, scanX: 0 };
		}
		if (state === "thinking") {
			const pulse = 0.96 + Math.sin(time * ((Math.PI * 2) / 3.6)) * 0.04;
			return { scaleX: 0.92, scaleY: 0.92, brightness: 0.92, alpha: pulse, scanX: 0 };
		}
		if (state === "speaking")
			return { scaleX: 1, scaleY: 0.86 + amp * 0.32, brightness: 0.95 + amp * 0.6, alpha: 1, scanX: 0 };
		if (state === "tool")
			return {
				scaleX: 1.06,
				scaleY: 0.82,
				brightness: 1,
				alpha: 1,
				scanX: Math.sin(time * ((Math.PI * 2) / 1.6)) * 21.6,
			};
		return { scaleX: 1, scaleY: 1, brightness: 1, alpha: 1, scanX: 0 };
	}

	private browPose(time: number, state: RobotFaceState, left: boolean, amp: number): { y: number; rotation: number } {
		if (state === "hearing") {
			const pulse = Math.sin(time * ((Math.PI * 2) / 1.8));
			return { y: baseHeight * 0.21 - pulse * 5, rotation: left ? 0.17 + pulse * 0.05 : -0.17 - pulse * 0.05 };
		}
		if (state === "thinking") {
			const pulse = Math.sin(time * ((Math.PI * 2) / (left ? 3.2 : 3.6)));
			return {
				y: baseHeight * (left ? 0.18 : 0.22) - pulse * 4,
				rotation: left ? -0.38 + pulse * 0.03 : -0.07 + pulse * 0.03,
			};
		}
		if (state === "speaking")
			return { y: baseHeight * 0.24 + 8 - amp * 6, rotation: left ? 0.035 + amp * 0.105 : -0.035 - amp * 0.105 };
		if (state === "tool") return { y: baseHeight * 0.24, rotation: left ? -0.14 : 0.14 };
		if (state === "listening") {
			const pulse = Math.sin(time * ((Math.PI * 2) / 4.2));
			return { y: baseHeight * 0.24 - pulse * 4, rotation: left ? -0.035 - pulse * 0.035 : 0.035 + pulse * 0.035 };
		}
		const drift = Math.sin(time * ((Math.PI * 2) / (left ? 8.5 : 9.2)) + (left ? 0 : -2.5)) * 3.5;
		return { y: baseHeight * 0.24 + drift, rotation: left ? -0.14 : 0.14 };
	}
}

customElements.define("robot-face-webgl", RobotFaceWebglElement);
