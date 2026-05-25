import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const braveApiKey = process.env.BRAVE_API_KEY;

const webSearchParameters = Type.Object({
	query: Type.String({ description: "Search query." }),
	count: Type.Optional(Type.Number({ description: "Number of search results. Defaults to 5, maximum 10." })),
	country: Type.Optional(Type.String({ description: "Two-letter country code. Defaults to DE." })),
	freshness: Type.Optional(
		Type.String({ description: "Optional freshness filter: pd, pw, pm, py, or YYYY-MM-DDtoYYYY-MM-DD." }),
	),
});

const pageContentParameters = Type.Object({
	url: Type.String({ description: "Absolute URL of the page to fetch and summarize/extract." }),
});

interface BraveSearchResult {
	title?: string;
	url?: string;
	description?: string;
	age?: string;
}

interface BraveSearchResponse {
	web?: {
		results?: BraveSearchResult[];
	};
}

interface WebSearchResultDetails {
	query: string;
	count: number;
	country: string;
	freshness?: string;
	results: Array<{ title: string; url: string; snippet: string; age?: string }>;
}

interface PageContentDetails {
	url: string;
	contentType: string;
	chars: number;
	truncated: boolean;
}

function htmlToReadableText(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>/gi, "\n\n")
		.replace(/<\/h[1-6]>/gi, "\n\n")
		.replace(/<\/li>/gi, "\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function formatSearchResults(details: WebSearchResultDetails): string {
	if (details.results.length === 0) return `Keine Suchergebnisse für: ${details.query}`;
	return details.results
		.map((result, index) => {
			const age = result.age ? `\nAge: ${result.age}` : "";
			return `--- Result ${index + 1} ---\nTitle: ${result.title}\nLink: ${result.url}${age}\nSnippet: ${result.snippet}`;
		})
		.join("\n\n");
}

async function searchWebWithBrave(
	query: string,
	count: number,
	country: string,
	freshness?: string,
): Promise<WebSearchResultDetails> {
	if (!braveApiKey) throw new Error("BRAVE_API_KEY is not set");
	const resultCount = Math.max(1, Math.min(10, Math.floor(count)));
	const normalizedCountry = country.trim().toUpperCase().slice(0, 2) || "DE";
	const url = new URL("https://api.search.brave.com/res/v1/web/search");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(resultCount));
	url.searchParams.set("country", normalizedCountry);
	url.searchParams.set("search_lang", "de");
	url.searchParams.set("ui_lang", "de-DE");
	if (freshness) url.searchParams.set("freshness", freshness);
	const response = await fetch(url, {
		headers: {
			accept: "application/json",
			"accept-encoding": "gzip",
			"x-subscription-token": braveApiKey,
		},
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Brave Search failed: HTTP ${response.status}${body ? ` ${body.slice(0, 300)}` : ""}`);
	}
	const data = (await response.json()) as BraveSearchResponse;
	const results = (data.web?.results ?? []).slice(0, resultCount).map((entry) => ({
		title: entry.title ?? "Untitled",
		url: entry.url ?? "",
		snippet: entry.description ?? "",
		age: entry.age,
	}));
	return { query, count: resultCount, country: normalizedCountry, freshness, results };
}

async function fetchPageContent(urlText: string): Promise<{ text: string; details: PageContentDetails }> {
	const url = new URL(urlText);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http/https URLs are supported");
	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
			"user-agent": "pibot/0.0 (+https://github.com/badlogic/pibot)",
		},
	});
	if (!response.ok) throw new Error(`Page fetch failed: HTTP ${response.status}`);
	const contentType = response.headers.get("content-type") ?? "unknown";
	const raw = await response.text();
	const readable = contentType.includes("html") ? htmlToReadableText(raw) : raw.trim();
	const maxChars = 12000;
	const truncated = readable.length > maxChars;
	const text = truncated ? `${readable.slice(0, maxChars)}\n\n[Content truncated]` : readable;
	return { text, details: { url: url.toString(), contentType, chars: readable.length, truncated } };
}

export const webSearchTool: AgentTool<typeof webSearchParameters, WebSearchResultDetails> = {
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web for current information using Brave Search. Use this when you need facts beyond memory.",
	executionMode: "sequential",
	parameters: webSearchParameters,
	execute: async (_id, params) => {
		const details = await searchWebWithBrave(
			params.query,
			params.count ?? 5,
			params.country ?? "DE",
			params.freshness,
		);
		return { content: [{ type: "text", text: formatSearchResults(details) }], details };
	},
};

export const pageContentTool: AgentTool<typeof pageContentParameters, PageContentDetails> = {
	name: "fetch_page_content",
	label: "Fetch Page Content",
	description: "Fetch readable text content from a specific URL found through web_search or provided by the user.",
	executionMode: "sequential",
	parameters: pageContentParameters,
	execute: async (_id, params) => {
		const result = await fetchPageContent(params.url);
		return {
			content: [{ type: "text", text: result.text || "No readable page content found." }],
			details: result.details,
		};
	},
};
