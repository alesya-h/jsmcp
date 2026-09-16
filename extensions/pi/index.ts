import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DEFAULT_URL = "http://127.0.0.1:41528";
const DEFAULT_KEY_FILE = `${process.env.HOME ?? ""}/.config/jsmcp/api-key.txt`;

const sessionId = randomUUID();
let cachedListServers: unknown | undefined;
const cachedListTools = new Map<string, unknown>();

interface JsmcpProcessState {
	allowAnyRequests: boolean;
}

const processStateKey = Symbol.for("pi.extension.jsmcp.process-state");
const processStateStore = globalThis as unknown as { [key: symbol]: unknown };
const processState =
	(processStateStore[processStateKey] as JsmcpProcessState | undefined) ?? { allowAnyRequests: false };
processStateStore[processStateKey] = processState;

const emptySchema = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const listToolsSchema = {
	type: "object",
	properties: {
		server: { type: "string", description: "Server name from jsmcp_list_servers." },
	},
	required: ["server"],
	additionalProperties: false,
} as const;

const executeCodeSchema = {
	type: "object",
	properties: {
		code: { type: "string", description: "JavaScript code to execute. It should return the desired value." },
		timeout_ms: { type: "number", description: "Execution timeout in milliseconds. Default: 120000." },
		data: { type: "object", description: "Optional input exposed as the global variable data." },
		rawText: {
			type: "boolean",
			default: true,
			description: "Show returned strings directly as text (default: true). Set false for a JSON result envelope instead.",
		},
	},
	required: ["code"],
	additionalProperties: false,
} as const;

function endpoint(): string {
	return (process.env.PI_JSMCP_URL ?? process.env.STRAP_JSMCP_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

function apiKey(): string {
	if (process.env.PI_JSMCP_API_KEY) return process.env.PI_JSMCP_API_KEY;
	if (process.env.STRAP_JSMCP_API_KEY) return process.env.STRAP_JSMCP_API_KEY;
	const file = process.env.PI_JSMCP_API_KEY_FILE ?? process.env.STRAP_JSMCP_API_KEY_FILE ?? DEFAULT_KEY_FILE;
	return readFileSync(file, "utf8").trim();
}

function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, val) => {
		if (!val || typeof val !== "object" || Array.isArray(val)) return val;
		return Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
	});
}

function resultText(body: any): string {
	const textParts = Array.isArray(body?.content)
		? body.content.filter((part: any) => part?.type === "text")
		: [];
	if (textParts.length > 0) return textParts.map((part: any) => part.text).join("\n");
	if (body?.structuredContent !== undefined) return JSON.stringify(body.structuredContent, null, 2);
	return JSON.stringify(body, null, 2);
}

async function callJsmcp(tool: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
	const url = new URL(`${endpoint()}/api/call`);
	url.searchParams.set("tool", tool);
	url.searchParams.set("sessionId", sessionId);
	const profile = process.env.PI_JSMCP_PROFILE ?? process.env.STRAP_JSMCP_PROFILE;
	if (profile) url.searchParams.set("profile", profile);

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"X-JSMCP-API-Key": apiKey(),
		},
		body: JSON.stringify(input ?? {}),
		signal,
	});

	let body: any;
	const raw = await response.text();
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {
		body = { content: [{ type: "text", text: raw }] };
	}

	if (!response.ok) {
		throw new Error(body?.error ?? body?.message ?? `jsmcp HTTP ${response.status}`);
	}
	if (body?.isError) {
		throw new Error(resultText(body));
	}
	return body;
}

async function refreshDiscovery(signal?: AbortSignal): Promise<void> {
	const changes: string[] = [];

	if (cachedListServers !== undefined) {
		const next = await callJsmcp("list_servers", {}, signal);
		if (stableJson(next) !== stableJson(cachedListServers)) changes.push("list_servers changed");
		cachedListServers = next;
	}

	for (const [server, cached] of cachedListTools) {
		const next = await callJsmcp("list_tools", { server }, signal);
		if (stableJson(next) !== stableJson(cached)) changes.push(`list_tools changed for server ${server}`);
		cachedListTools.set(server, next);
	}

	if (changes.length > 0) {
		throw new Error(`jsmcp capabilities changed; inspect them again before executing code: ${changes.join(", ")}`);
	}
}

function piResult(body: any) {
	return {
		content: [{ type: "text" as const, text: resultText(body) }],
		details: body,
	};
}

export default function jsmcpExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "jsmcp_list_servers",
		label: "jsmcp.list_servers",
		description: "List MCP servers configured in the local jsmcp daemon.",
		promptSnippet: "Use jsmcp_list_servers to inspect which external MCP servers are available through local jsmcp.",
		parameters: emptySchema,
		async execute(_toolCallId, _params, signal) {
			const body = await callJsmcp("list_servers", {}, signal);
			cachedListServers = body;
			return piResult(body);
		},
	});

	pi.registerTool({
		name: "jsmcp_list_tools",
		label: "jsmcp.list_tools",
		description: "List tools exposed by one jsmcp server.",
		promptSnippet: "Use jsmcp_list_tools after jsmcp_list_servers to inspect a server's available tool names and schemas.",
		parameters: listToolsSchema,
		async execute(_toolCallId, params, signal) {
			const body = await callJsmcp("list_tools", { server: params.server }, signal);
			cachedListTools.set(params.server, body);
			return piResult(body);
		},
	});

	pi.registerTool({
		name: "jsmcp_execute_code",
		label: "jsmcp.execute_code",
		description: "Execute JavaScript against the configured jsmcp servers. Use only after inspecting available servers/tools. Connected tool calls automatically resolve to structuredContent when present, otherwise to a string for text-only results or { text, content, meta } for mixed content; do not manually access .structuredContent. Session- and profile-scoped JSON-safe memory is available as jsmcp.memory with get/set/has/delete/keys/entries/clear/update methods; it is in-memory only and is lost on daemon restart. Successful execute_code responses use { value, executionMs }; errors use { error, executionMs }. executionMs measures wall-clock time including awaited tool calls. Returned strings appear as raw text by default, followed by timing; set rawText: false for JSON-formatted content. Return a string field directly to avoid escaping its containing object.",
		promptSnippet: "Use jsmcp_execute_code to call jsmcp tools from JavaScript, e.g. `return await kagi.some_tool({query: \"...\"})`. First inspect servers/tools with jsmcp_list_servers and jsmcp_list_tools.",
		promptGuidelines: [
			"Call jsmcp_list_servers and jsmcp_list_tools before using jsmcp_execute_code.",
			"Keep jsmcp_execute_code small and explicit. Connected tool results are already unwrapped; return the desired value or string field.",
			"Use jsmcp.memory inside jsmcp_execute_code to preserve JSON-safe data across calls in the same session and profile. Memory is lost on daemon restart.",
			"Pay attention to the execution time reported by jsmcp_execute_code, including time spent awaiting tools.",
			"If jsmcp capabilities changed, inspect them again before retrying jsmcp_execute_code.",
		],
		parameters: executeCodeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const timeoutMs = params.timeout_ms ?? 120000;
			if (!processState.allowAnyRequests) {
				const dataNote = params.data === undefined ? "" : `\n\ndata:\n${JSON.stringify(params.data, null, 2)}`;
				const choice = await ctx.ui.select(
					`Allow jsmcp.execute_code?\n\ntimeout: ${timeoutMs}ms\n\ncode:\n${params.code}${dataNote}`,
					["Allow once", "Allow any requests until pi is restarted", "Reject"],
				);
				if (choice === "Allow any requests until pi is restarted") {
					processState.allowAnyRequests = true;
				} else if (choice !== "Allow once") {
					throw new Error("jsmcp.execute_code rejected by user");
				}
			}

			await refreshDiscovery(signal);
			const input: Record<string, unknown> = {
				code: params.code,
				timeoutMs,
			};
			if (params.data !== undefined) input.data = params.data;
			if (params.rawText !== undefined) input.rawText = params.rawText;
			const body = await callJsmcp("execute_code", input, signal);
			return piResult(body);
		},
	});

	pi.registerTool({
		name: "jsmcp_fetch_logs",
		label: "jsmcp.fetch_logs",
		description: "Fetch logs from the local jsmcp daemon/session.",
		parameters: emptySchema,
		async execute(_toolCallId, _params, signal) {
			return piResult(await callJsmcp("fetch_logs", {}, signal));
		},
	});

	pi.registerTool({
		name: "jsmcp_clear_logs",
		label: "jsmcp.clear_logs",
		description: "Clear logs in the local jsmcp daemon/session.",
		parameters: emptySchema,
		async execute(_toolCallId, _params, signal) {
			return piResult(await callJsmcp("clear_logs", {}, signal));
		},
	});

	pi.registerCommand("jsmcp", {
		description: "Show jsmcp extension configuration",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`jsmcp: ${endpoint()} session=${sessionId}`, "info");
		},
	});
}
