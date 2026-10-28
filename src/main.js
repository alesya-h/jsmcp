import process from "node:process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { handleAuthCommand } from "./auth.js";
import {
  DEFAULT_CLIENT_HOST,
  DEFAULT_PRESET,
  DEFAULT_PROXY_PORT,
  SERVER_NAME,
  SESSION_ID_PATTERN,
} from "./constants.js";
import { createMetaServer } from "./meta-server.js";
import { runProxyClient, runProxyServer } from "./proxy.js";
import { handleRestartCommand } from "./restart-command.js";
import { MetaMcpRuntime } from "./runtime.js";
import { handleStatusCommand } from "./status-command.js";

const RUN_COMMANDS = new Set(["run", "server", "client"]);

export async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    throw new Error(getMainUsage());
  }

  if (command === "auth") {
    await handleAuthCommand(args.slice(1));
    return;
  }

  if (command === "status") {
    await handleStatusCommand(args.slice(1));
    return;
  }

  if (command === "restart") {
    await handleRestartCommand(args.slice(1));
    return;
  }

  if (!RUN_COMMANDS.has(command)) {
    throw new Error(`Unknown command \"${command}\".\n${getMainUsage()}`);
  }

  const options = parseRunCommandArgs(command, args.slice(1));

  if (command === "run") {
    await runMetaServer(options.presetName);
    return;
  }

  if (command === "server") {
    await runProxyServer({ presetName: options.presetName, port: options.port, bindHost: options.bindHost });
    return;
  }

  await runProxyClient({
    host: options.host,
    port: options.port,
    requestedProfile: options.profileProvided ? options.presetName : undefined,
    sessionId: options.sessionId,
    apiKey: options.apiKey,
  });
}

async function runMetaServer(presetName) {
  const runtime = await MetaMcpRuntime.load(presetName);
  await runtime.startAllServers();
  const server = await createMetaServer(runtime, presetName);
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
  console.error(`[${SERVER_NAME}] ready with preset "${presetName}"`);
}

function parseRunCommandArgs(command, args) {
  let presetName = DEFAULT_PRESET;
  let profileProvided = false;
  let port = DEFAULT_PROXY_PORT;
  let sessionId;
  let apiKey;
  // Undefined unless --bind is given, so the server can fall back to jsmcp.bind in the config.
  let bindHost;
  let host = DEFAULT_CLIENT_HOST;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --profile.\n${getRunUsage(command)}`);
      }
      if (profileProvided) {
        throw new Error(`Profile specified more than once.\n${getRunUsage(command)}`);
      }
      presetName = value;
      profileProvided = true;
      index += 1;
      continue;
    }

    if (argument === "--bind") {
      if (command !== "server") {
        throw new Error(`--bind is only valid for the server command.\n${getRunUsage(command)}`);
      }

      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --bind.\n${getRunUsage(command)}`);
      }

      bindHost = value;
      index += 1;
      continue;
    }

    if (argument === "--host") {
      if (command !== "client") {
        throw new Error(`--host is only valid for the client command.\n${getRunUsage(command)}`);
      }

      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --host.\n${getRunUsage(command)}`);
      }

      host = value;
      index += 1;
      continue;
    }

    if (argument === "--session-id") {
      if (command !== "client") {
        throw new Error(`--session-id is only valid for the client command.\n${getRunUsage(command)}`);
      }

      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --session-id.\n${getRunUsage(command)}`);
      }
      if (!SESSION_ID_PATTERN.test(value)) {
        throw new Error(`Invalid session id "${value}". Use 1-128 URL-safe characters.\n${getRunUsage(command)}`);
      }
      if (sessionId !== undefined) {
        throw new Error(`Session id specified more than once.\n${getRunUsage(command)}`);
      }

      sessionId = value;
      index += 1;
      continue;
    }

    if (argument === "--api-key") {
      if (command !== "client") {
        throw new Error(`--api-key is only valid for the client command.\n${getRunUsage(command)}`);
      }

      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --api-key.\n${getRunUsage(command)}`);
      }
      if (apiKey !== undefined) {
        throw new Error(`API key specified more than once.\n${getRunUsage(command)}`);
      }

      apiKey = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --port.\n${getRunUsage(command)}`);
      }

      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port \"${value}\".\n${getRunUsage(command)}`);
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option \"${argument}\".\n${getRunUsage(command)}`);
    }

    if (profileProvided) {
      throw new Error(`Profile specified more than once.\n${getRunUsage(command)}`);
    }

    presetName = argument;
    profileProvided = true;
  }

  return { apiKey, bindHost, host, port, presetName, profileProvided, sessionId };
}

function getMainUsage() {
  return [
    `Usage: ${SERVER_NAME} <command> [options]`,
    `Commands: auth, status, restart, run, server, client`,
    `Run commands accept [profile] [--profile <name>] [--port <number>]`,
    `Server also accepts [--bind <host>]`,
    `Client also accepts [--host <host>] [--session-id <id>] [--api-key <key>]`,
  ].join("\n");
}

function getRunUsage(command) {
  const bindUsage = command === "server" ? " [--bind <host>]" : "";
  const clientUsage = command === "client" ? " [--host <host>] [--session-id <id>] [--api-key <key>]" : "";
  return `Usage: ${SERVER_NAME} ${command} [profile] [--profile <name>] [--port <number>]${bindUsage}${clientUsage}`;
}
