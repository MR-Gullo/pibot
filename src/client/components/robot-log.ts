import type { LogOrigin } from "../../types.js";

const tagColors = ["#45d9ff", "#d783ff", "#ffd166", "#6ee7a8", "#7aa2ff", "#ff6b7a", "#9ca3af"];

function tagColor(tag: string): string {
	let hash = 0;
	for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
	return tagColors[Math.abs(hash) % tagColors.length]!;
}

export class RobotLogElement extends HTMLElement {
	appendLine(origin: LogOrigin, tags: string[], message: string): void {
		const line = document.createElement("div");
		const displayTags = [origin, ...tags.filter((tag, index) => index !== 0 || tag !== origin)];
		line.append(`${new Date().toLocaleTimeString()} `);
		for (const tag of displayTags) {
			const span = document.createElement("span");
			span.textContent = `[${tag}]`;
			span.style.color = tagColor(tag);
			line.append(span);
		}
		line.append(` ${message}`);
		line.className = displayTags.join(" ");
		this.append(line);
		this.scrollTop = this.scrollHeight;
	}
}

customElements.define("robot-log", RobotLogElement);
