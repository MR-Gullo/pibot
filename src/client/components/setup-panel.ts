export type SetupPanelMode = "idle" | "starting" | "started";

export class RobotSetupPanelElement extends HTMLElement {
	private startButton: HTMLButtonElement | undefined;
	private resetButton: HTMLButtonElement | undefined;
	private providerSelect: HTMLSelectElement | undefined;

	connectedCallback(): void {
		if (!this.startButton) this.render();
	}

	get ttsProviderControl(): HTMLSelectElement {
		if (!this.providerSelect) throw new Error("Setup panel is not connected");
		return this.providerSelect;
	}

	set mode(mode: SetupPanelMode) {
		if (!this.startButton) return;
		this.startButton.disabled = mode === "starting";
		this.startButton.textContent =
			mode === "starting" ? "Starting..." : mode === "started" ? "Show face" : "Start robot";
	}

	private render(): void {
		this.classList.add("panel");
		this.startButton = document.createElement("button");
		this.startButton.className = "primary";
		this.startButton.textContent = "Start robot";
		this.startButton.addEventListener("click", () => this.dispatchEvent(new Event("start-robot")));

		const controls = document.createElement("div");
		controls.className = "controls";
		const label = document.createElement("label");
		label.append("Voice");
		this.providerSelect = document.createElement("select");
		this.providerSelect.id = "ttsProvider";
		this.providerSelect.append(this.option("elevenlabs", "ElevenLabs pibot"), this.option("pocket", "Kyutai Pocket"));
		this.providerSelect.addEventListener("change", () => this.dispatchEvent(new Event("tts-provider-change")));
		label.append(this.providerSelect);
		this.resetButton = document.createElement("button");
		this.resetButton.textContent = "Reset session";
		this.resetButton.addEventListener("click", () => this.dispatchEvent(new Event("reset-session")));
		controls.append(label, this.resetButton);
		this.replaceChildren(this.startButton, controls);
	}

	private option(value: string, label: string): HTMLOptionElement {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = label;
		return option;
	}
}

customElements.define("robot-setup-panel", RobotSetupPanelElement);
