export type RobotFaceState = "inactive" | "listening" | "hearing" | "thinking" | "speaking" | "tool" | "error";

const states: RobotFaceState[] = ["inactive", "listening", "hearing", "thinking", "speaking", "tool", "error"];

export class RobotFaceElement extends HTMLElement {
	private currentState: RobotFaceState = "inactive";
	private glanceTimer: ReturnType<typeof setTimeout> | undefined;

	connectedCallback(): void {
		this.classList.add("face");
		if (!this.hasChildNodes()) {
			this.replaceChildren(
				this.createPart("brow left"),
				this.createPart("brow right"),
				this.createPart("eye left"),
				this.createPart("eye right"),
			);
		}
		this.state = this.parseState(this.getAttribute("state"));
	}

	disconnectedCallback(): void {
		this.stopIdleGlance();
	}

	get state(): RobotFaceState {
		return this.currentState;
	}

	set state(state: RobotFaceState) {
		this.currentState = state;
		this.setAttribute("state", state);
		for (const entry of states) this.classList.toggle(entry, entry === state);
		if (state === "inactive") this.startIdleGlance();
		else this.stopIdleGlance();
	}

	set amplitude(value: number) {
		this.style.setProperty("--amp", Math.max(0, Math.min(1, value)).toFixed(3));
	}

	static get observedAttributes(): string[] {
		return ["state"];
	}

	attributeChangedCallback(name: string, _oldValue: string | null, newValue: string | null): void {
		if (name === "state" && newValue !== this.currentState) this.state = this.parseState(newValue);
	}

	private createPart(className: string): HTMLDivElement {
		const element = document.createElement("div");
		element.className = className;
		return element;
	}

	private startIdleGlance(): void {
		if (this.glanceTimer) return;
		this.setRandomLook();
	}

	private stopIdleGlance(): void {
		if (this.glanceTimer) clearTimeout(this.glanceTimer);
		this.glanceTimer = undefined;
		this.style.setProperty("--look-x", "0%");
		this.style.setProperty("--look-y", "0%");
	}

	private setRandomLook(): void {
		if (this.currentState !== "inactive") return;
		this.style.setProperty("--look-x", `${(Math.random() * 18 - 9).toFixed(1)}%`);
		this.style.setProperty("--look-y", `${(Math.random() * 8 - 4).toFixed(1)}%`);
		this.glanceTimer = setTimeout(
			() => {
				this.glanceTimer = undefined;
				this.setRandomLook();
			},
			700 + Math.random() * 2400,
		);
	}

	private parseState(value: string | null): RobotFaceState {
		return states.includes(value as RobotFaceState) ? (value as RobotFaceState) : "inactive";
	}
}

customElements.define("robot-face", RobotFaceElement);
