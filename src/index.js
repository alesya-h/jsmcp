#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import vm from "node:vm";
import { inspect } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "programmatic-mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PRESET = "default";
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const DEFAULT_CODE_TIMEOUT_MS = 30000;

class MetaMcpRuntime {
  constructor({ configPath, presetName, serverEntries }) {
    this.configPath = configPath;
    this.presetName = presetName;
    this.serverEntries = serverEntries;
    this.startedServers = new Map();
  }

  static async load(presetName) {
    const configPath = resolveConfigPath();
    const configDirectory = path.dirname(configPath);
    const rawConfig = await readConfigFile(configPath);
    const parsedConfig = parseJsonConfig(rawConfig, configPath);
    const resolvedConfig = await substituteVariables(parsedConfig, configDirectory);
    const serversConfig = getPlainObject(resolvedConfig.servers, "Config field \"servers\"");
    const presetsConfig = getPlainObject(resolvedConfig.presets, "Config field \"presets\"");
    const presetConfig = presetsConfig[presetName];

    if (presetConfig === undefined) {
      throw new Error(
        `Preset \"${presetName}\" was not found in ${configPath}. Available presets: ${Object.keys(
          presetsConfig,
        ).join(", ") || "none"}`,
      );
    }

    const normalizedPreset = normalizePreset(presetName, presetConfig, serversConfig);
    return new MetaMcpRuntime({
      configPath,
      presetName,
      serverEntries: normalizedPreset,
    });
  }

  listServerSummaries() {
    return [...this.serverEntries.values()].map((entry) => this.buildServerSummary(entry.name));
  }

  buildServerSummary(name) {
    const entry = this.requireServerEntry(name);
    const started = this.startedServers.get(name);

    return {
      name,
      type: entry.serverConfig.type,
      enabled: entry.serverConfig.enabled !== false,
      started: Boolean(started),
      allowedTools: describeAllowedTools(entry.toolPolicy),
      availableTools: started ? started.tools.map(sanitizeTool) : [],
      missingAllowedTools: started ? [...started.missingAllowedTools] : [],
      command:
        entry.serverConfig.type === "local" ? [...entry.serverConfig.command] : undefined,
      url: entry.serverConfig.type === "remote" ? entry.serverConfig.url : undefined,
      timeoutMs:
        typeof entry.serverConfig.timeout === "number"
          ? entry.serverConfig.timeout
          : DEFAULT_DISCOVERY_TIMEOUT_MS,
    };
  }

  async startServers(names) {
    const uniqueNames = [...new Set(names)];
    const started = [];
    const failed = [];

    for (const name of uniqueNames) {
      try {
        started.push(await this.startServer(name));
      } catch (error) {
        failed.push({ name, error: getErrorMessage(error) });
      }
    }

    return { started, failed };
  }

  async startServer(name) {
    const entry = this.requireServerEntry(name);
    const existing = this.startedServers.get(name);

    if (existing) {
      return this.buildServerSummary(name);
    }

    if (entry.serverConfig.enabled === false) {
      throw new Error(`Server \"${name}\" is disabled in config.`);
    }

    const client = new Client({
      name: `${SERVER_NAME}-client`,
      version: SERVER_VERSION,
    });
    const transport = createClientTransport(entry.serverConfig);

    const startedServer = {
      name,
      client,
      transport,
      tools: [],
      missingAllowedTools: [],
    };

    transport.onclose = () => {
      const current = this.startedServers.get(name);
      if (current === startedServer) {
        this.startedServers.delete(name);
      }
    };

    transport.onerror = (error) => {
      console.error(`[${SERVER_NAME}] transport error from ${name}: ${getErrorMessage(error)}`);
    };

    client.onerror = (error) => {
      console.error(`[${SERVER_NAME}] client error from ${name}: ${getErrorMessage(error)}`);
    };

    try {
      await client.connect(transport);

      const listToolsResult = await client.listTools(undefined, {
        timeout: getDiscoveryTimeout(entry.serverConfig),
      });

      startedServer.tools = filterTools(listToolsResult.tools, entry.toolPolicy);
      startedServer.missingAllowedTools =
        entry.toolPolicy.mode === "all"
          ? []
          : [...entry.toolPolicy.tools].filter(
              (toolName) => !startedServer.tools.some((tool) => tool.name === toolName),
            );

      this.startedServers.set(name, startedServer);
      return this.buildServerSummary(name);
    } catch (error) {
      await closeClient(client);
      throw new Error(`Failed to start \"${name}\": ${getErrorMessage(error)}`);
    }
  }

  async executeCode(code, timeoutMs) {
    const logs = [];
    const startedAt = Date.now();
    const api = this.buildExecutionApi();
    const context = vm.createContext({
      ...api,
      console: createCapturedConsole(logs),
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });

    try {
      const script = new vm.Script(`(async () => {\n${code}\n})()`, {
        filename: "execute_code.js",
      });
      const execution = Promise.resolve(script.runInContext(context, { timeout: timeoutMs }));
      const result = await withTimeout(
        execution,
        timeoutMs,
        `Code execution exceeded ${timeoutMs}ms.`,
      );

      return {
        ok: true,
        result: toJsonSafe(result),
        logs,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        ok: false,
        error: getErrorMessage(error),
        logs,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  buildExecutionApi() {
    return {
      preset: this.presetName,
      listServers: () => this.listServerSummaries(),
      listStartedServers: () =>
        [...this.startedServers.keys()].map((name) => this.buildServerSummary(name)),
      startServers: async (names) => {
        const normalizedNames = Array.isArray(names) ? names : [names];
        return this.startServers(normalizedNames);
      },
      listTools: async (serverName) => {
        const started = this.requireStartedServer(serverName);
        return started.tools.map(sanitizeTool);
      },
      getServer: (serverName) => ({
        name: serverName,
        listTools: async () => {
          const started = this.requireStartedServer(serverName);
          return started.tools.map(sanitizeTool);
        },
        callTool: async (toolName, args = {}, options = {}) =>
          this.callTool(serverName, toolName, args, options),
      }),
      callTool: async (serverName, toolName, args = {}, options = {}) =>
        this.callTool(serverName, toolName, args, options),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    };
  }

  async callTool(serverName, toolName, args = {}, options = {}) {
    const entry = this.requireServerEntry(serverName);
    const started = this.requireStartedServer(serverName);

    if (!isToolAllowed(entry.toolPolicy, toolName)) {
      throw new Error(`Tool \"${toolName}\" is not allowed for server \"${serverName}\".`);
    }

    const advertisedTool = started.tools.find((tool) => tool.name === toolName);
    if (!advertisedTool) {
      throw new Error(`Tool \"${toolName}\" is not available on started server \"${serverName}\".`);
    }

    const requestOptions = {};
    if (typeof options.timeoutMs === "number") {
      requestOptions.timeout = options.timeoutMs;
    }

    const result = await started.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      requestOptions,
    );

    return normalizeToolResult(serverName, toolName, result);
  }

  requireServerEntry(name) {
    const entry = this.serverEntries.get(name);
    if (!entry) {
      throw new Error(
        `Server \"${name}\" is not part of preset \"${this.presetName}\". Allowed servers: ${[
          ...this.serverEntries.keys(),
        ].join(", ") || "none"}`,
      );
    }
    return entry;
  }

  requireStartedServer(name) {
    const started = this.startedServers.get(name);
    if (!started) {
      throw new Error(`Server \"${name}\" has not been started. Use start_servers first.`);
    }
    return started;
  }

  async close() {
    const servers = [...this.startedServers.values()];
    this.startedServers.clear();
    await Promise.allSettled(servers.map((server) => closeClient(server.client)));
  }
}

function resolveConfigPath() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configHome, SERVER_NAME, "config.json");
}

async function readConfigFile(configPath) {
  try {
    return await readFile(configPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(`Config file not found at ${configPath}.`);
    }
    throw error;
  }
}

function parseJsonConfig(rawConfig, configPath) {
  try {
    return JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`Failed to parse JSON config at ${configPath}: ${getErrorMessage(error)}`);
  }
}

async function substituteVariables(value, configDirectory) {
  if (typeof value === "string") {
    return substituteString(value, configDirectory);
  }

  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      items.push(await substituteVariables(item, configDirectory));
    }
    return items;
  }

  if (value && typeof value === "object") {
    const object = {};
    for (const [key, childValue] of Object.entries(value)) {
      object[key] = await substituteVariables(childValue, configDirectory);
    }
    return object;
  }

  return value;
}

async function substituteString(value, configDirectory) {
  let nextValue = value.replaceAll(/\{env:([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  const fileMatches = [...nextValue.matchAll(/\{file:([^}]+)\}/g)];

  for (const match of fileMatches) {
    const token = match[0];
    const filePath = resolveReferencedFile(match[1], configDirectory);
    const fileContents = await readFile(filePath, "utf8");
    nextValue = nextValue.replace(token, fileContents);
  }

  return nextValue;
}

function resolveReferencedFile(filePath, configDirectory) {
  if (filePath === "~" || filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(configDirectory, filePath);
}

function normalizePreset(presetName, presetConfig, serversConfig) {
  const presetSource =
    Array.isArray(presetConfig) || typeof presetConfig === "string"
      ? presetConfig
      : getPlainObject(presetConfig, `Preset \"${presetName}\"`).servers ?? presetConfig;

  const normalizedEntries = new Map();

  if (typeof presetSource === "string") {
    addPresetEntry(normalizedEntries, presetSource, true);
  } else if (Array.isArray(presetSource)) {
    for (const serverName of presetSource) {
      addPresetEntry(normalizedEntries, serverName, true);
    }
  } else {
    const presetObject = getPlainObject(presetSource, `Preset \"${presetName}\" servers`);
    for (const [serverName, rule] of Object.entries(presetObject)) {
      addPresetEntry(normalizedEntries, serverName, rule);
    }
  }

  for (const [serverName, entry] of normalizedEntries) {
    const serverConfig = parseServerConfig(serverName, serversConfig[serverName]);
    entry.serverConfig = serverConfig;
  }

  return normalizedEntries;
}

function addPresetEntry(target, serverName, rule) {
  if (typeof serverName !== "string" || !serverName) {
    throw new Error(`Preset contains an invalid server name: ${inspect(serverName)}`);
  }

  const toolPolicy = parseToolPolicy(serverName, rule);
  if (!toolPolicy) {
    return;
  }

  target.set(serverName, {
    name: serverName,
    toolPolicy,
    serverConfig: undefined,
  });
}

function parseServerConfig(serverName, config) {
  const serverConfig = getPlainObject(config, `Server \"${serverName}\" config`);

  if (serverConfig.type === "local") {
    if (!Array.isArray(serverConfig.command) || serverConfig.command.length === 0) {
      throw new Error(`Local server \"${serverName}\" must define a non-empty command array.`);
    }

    return {
      type: "local",
      command: serverConfig.command.map((item) => String(item)),
      environment: normalizeStringMap(serverConfig.environment, `Server \"${serverName}\" environment`),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      cwd: typeof serverConfig.cwd === "string" ? serverConfig.cwd : undefined,
    };
  }

  if (serverConfig.type === "remote") {
    if (typeof serverConfig.url !== "string" || !serverConfig.url) {
      throw new Error(`Remote server \"${serverName}\" must define a url.`);
    }

    return {
      type: "remote",
      url: serverConfig.url,
      headers: normalizeStringMap(serverConfig.headers, `Server \"${serverName}\" headers`),
      enabled: serverConfig.enabled,
      timeout: serverConfig.timeout,
      oauth: serverConfig.oauth,
    };
  }

  throw new Error(
    `Server \"${serverName}\" must have type \"local\" or \"remote\", got ${inspect(
      serverConfig.type,
    )}.`,
  );
}

function normalizeStringMap(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const object = getPlainObject(value, label);
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, String(item)]));
}

function parseToolPolicy(serverName, rule) {
  if (rule === false) {
    return null;
  }

  if (rule === true || rule === undefined || rule === null) {
    return { mode: "all" };
  }

  if (typeof rule === "string") {
    return rule === "*" ? { mode: "all" } : { mode: "subset", tools: new Set([rule]) };
  }

  if (Array.isArray(rule)) {
    if (rule.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(rule.map(String)) };
  }

  const ruleObject = getPlainObject(rule, `Preset rule for server \"${serverName}\"`);

  if (ruleObject.enabled === false) {
    return null;
  }

  if (ruleObject.tools === undefined || ruleObject.tools === true) {
    return { mode: "all" };
  }

  if (ruleObject.tools === "*" || ruleObject.tools === null) {
    return { mode: "all" };
  }

  if (typeof ruleObject.tools === "string") {
    return { mode: "subset", tools: new Set([ruleObject.tools]) };
  }

  if (Array.isArray(ruleObject.tools)) {
    if (ruleObject.tools.includes("*")) {
      return { mode: "all" };
    }
    return { mode: "subset", tools: new Set(ruleObject.tools.map(String)) };
  }

  throw new Error(
    `Preset rule for server \"${serverName}\" must use tools as \"*\" or an array of tool names.`,
  );
}

function getPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function createClientTransport(serverConfig) {
  if (serverConfig.type === "local") {
    const environment = {
      ...getDefaultEnvironment(),
      ...(serverConfig.environment ?? {}),
    };

    return new StdioClientTransport({
      command: serverConfig.command[0],
      args: serverConfig.command.slice(1),
      env: environment,
      cwd: serverConfig.cwd,
      stderr: "inherit",
    });
  }

  const requestInit = serverConfig.headers
    ? {
        headers: serverConfig.headers,
      }
    : undefined;

  return new StreamableHTTPClientTransport(new URL(serverConfig.url), {
    requestInit,
  });
}

function getDiscoveryTimeout(serverConfig) {
  return typeof serverConfig.timeout === "number"
    ? serverConfig.timeout
    : DEFAULT_DISCOVERY_TIMEOUT_MS;
}

function filterTools(tools, toolPolicy) {
  const filtered = toolPolicy.mode === "all"
    ? tools
    : tools.filter((tool) => toolPolicy.tools.has(tool.name));

  return [...filtered].sort((left, right) => left.name.localeCompare(right.name));
}

function sanitizeTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  };
}

function describeAllowedTools(toolPolicy) {
  if (toolPolicy.mode === "all") {
    return "all";
  }

  return [...toolPolicy.tools].sort();
}

function isToolAllowed(toolPolicy, toolName) {
  return toolPolicy.mode === "all" || toolPolicy.tools.has(toolName);
}

function normalizeToolResult(serverName, toolName, result) {
  return {
    server: serverName,
    tool: toolName,
    isError: Boolean(result.isError),
    text: renderToolContent(result.content ?? []),
    content: result.content ?? [],
    structuredContent: result.structuredContent,
    meta: result._meta,
  };
}

function renderToolContent(content) {
  return content
    .map((item) => {
      if (item.type === "text") {
        return item.text;
      }
      if (item.type === "image") {
        return `[image:${item.mimeType}]`;
      }
      if (item.type === "audio") {
        return `[audio:${item.mimeType}]`;
      }
      if (item.type === "resource") {
        return `[resource:${item.resource.uri}]`;
      }
      if (item.type === "resource_link") {
        return `[resource_link:${item.uri}]`;
      }
      return inspect(item, { depth: 4, breakLength: 120 });
    })
    .join("\n");
}

function createCapturedConsole(logs) {
  const push = (level, values) => {
    logs.push({
      level,
      message: values.map((value) => inspect(value, { depth: 6, breakLength: 120 })).join(" "),
    });
  };

  return {
    log: (...values) => push("log", values),
    info: (...values) => push("info", values),
    warn: (...values) => push("warn", values),
    error: (...values) => push("error", values),
  };
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function toJsonSafe(value, seen = new WeakSet()) {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const output = {};

    for (const [key, item] of Object.entries(value)) {
      output[key] = toJsonSafe(item, seen);
    }

    seen.delete(value);
    return output;
  }

  return inspect(value, { depth: 4, breakLength: 120 });
}

function renderServerListText(presetName, servers) {
  const lines = [`Preset: ${presetName}`];

  for (const server of servers) {
    const allowedTools =
      server.allowedTools === "all" ? "all tools" : server.allowedTools.join(", ") || "no tools";
    const status = server.started ? "started" : "not started";
    const discovered = server.availableTools.length
      ? ` discovered: ${server.availableTools.map((tool) => tool.name).join(", ")}`
      : "";
    lines.push(`- ${server.name} [${server.type}] ${status}; allowed: ${allowedTools}${discovered}`);
  }

  return lines.join("\n");
}

function renderStartText(presetName, result) {
  const lines = [`Preset: ${presetName}`];

  if (result.started.length > 0) {
    lines.push("Started:");
    for (const server of result.started) {
      const tools = server.availableTools.map((tool) => tool.name).join(", ") || "no allowed tools discovered";
      lines.push(`- ${server.name}: ${tools}`);
    }
  }

  if (result.failed.length > 0) {
    lines.push("Failed:");
    for (const failure of result.failed) {
      lines.push(`- ${failure.name}: ${failure.error}`);
    }
  }

  return lines.join("\n");
}

function renderExecutionText(executionResult) {
  const lines = [`Duration: ${executionResult.durationMs}ms`];

  if (executionResult.ok) {
    lines.push(`Result: ${formatValue(executionResult.result)}`);
  } else {
    lines.push(`Error: ${executionResult.error}`);
  }

  if (executionResult.logs.length > 0) {
    lines.push("Logs:");
    for (const entry of executionResult.logs) {
      lines.push(`- [${entry.level}] ${entry.message}`);
    }
  }

  return lines.join("\n");
}

function formatValue(value) {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function getErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function closeClient(client) {
  try {
    await client.close();
  } catch {
  }
}

async function createMetaServer(runtime) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "list_servers",
    {
      description: "List preset servers and their current status",
      inputSchema: z.object({}),
    },
    async () => {
      const servers = runtime.listServerSummaries();
      return {
        content: [{ type: "text", text: renderServerListText(runtime.presetName, servers) }],
        structuredContent: {
          preset: runtime.presetName,
          configPath: runtime.configPath,
          servers,
        },
      };
    },
  );

  server.registerTool(
    "start_servers",
    {
      description: "Start one or more servers from the selected preset",
      inputSchema: z.object({
        servers: z.array(z.string().min(1)).min(1),
      }),
    },
    async ({ servers }) => {
      const result = await runtime.startServers(servers);
      return {
        content: [{ type: "text", text: renderStartText(runtime.presetName, result) }],
        structuredContent: {
          preset: runtime.presetName,
          ...result,
        },
      };
    },
  );

  server.registerTool(
    "execute_code",
    {
      description: "Execute JavaScript that can call tools from started servers",
      inputSchema: z.object({
        code: z.string().min(1),
        timeoutMs: z.number().int().positive().max(300000).optional(),
      }),
    },
    async ({ code, timeoutMs }) => {
      const executionResult = await runtime.executeCode(
        code,
        timeoutMs ?? DEFAULT_CODE_TIMEOUT_MS,
      );

      return {
        content: [{ type: "text", text: renderExecutionText(executionResult) }],
        structuredContent: {
          preset: runtime.presetName,
          ...executionResult,
        },
        isError: !executionResult.ok,
      };
    },
  );

  return server;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 1) {
    throw new Error(`Usage: ${SERVER_NAME} [preset]`);
  }

  const presetName = args[0] || DEFAULT_PRESET;
  const runtime = await MetaMcpRuntime.load(presetName);
  const server = await createMetaServer(runtime);
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await Promise.allSettled([server.close(), runtime.close()]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await server.connect(transport);
  console.error(`[${SERVER_NAME}] ready with preset \"${presetName}\"`);
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] fatal error: ${getErrorMessage(error)}`);
  process.exit(1);
});
