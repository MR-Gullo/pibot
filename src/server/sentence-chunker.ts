export interface SentenceChunker {
	push: (delta: string) => string[];
	flush: () => string | undefined;
}

export function createSentenceChunker(options: {
	sentencesPerChunk: number;
	firstChunkSentences?: number;
}): SentenceChunker {
	const sentencesPerChunk = Math.max(1, options.sentencesPerChunk);
	const firstChunkSentences = Math.max(1, options.firstChunkSentences ?? sentencesPerChunk);
	const completeSentences: string[] = [];
	let pendingText = "";
	let emittedFirstChunk = false;

	function collectCompleteSentences(): void {
		const matches = [...pendingText.matchAll(/[^.!?…]+[.!?…]+["')\]]*(?=\s|$)/g)];
		const last = matches.at(-1);
		if (!last) return;
		for (const match of matches) {
			const sentence = match[0].trim();
			if (sentence) completeSentences.push(sentence);
		}
		pendingText = pendingText.slice(last.index + last[0].length).trimStart();
	}

	function drainChunks(): string[] {
		const chunks: string[] = [];
		while (completeSentences.length >= (emittedFirstChunk ? sentencesPerChunk : firstChunkSentences)) {
			const count = emittedFirstChunk ? sentencesPerChunk : firstChunkSentences;
			chunks.push(completeSentences.splice(0, count).join(" "));
			emittedFirstChunk = true;
		}
		return chunks;
	}

	return {
		push(delta) {
			pendingText += delta;
			collectCompleteSentences();
			return drainChunks();
		},
		flush() {
			collectCompleteSentences();
			const text = [...completeSentences.splice(0), pendingText.trim()].filter((part) => part.length > 0).join(" ");
			pendingText = "";
			return text || undefined;
		},
	};
}
