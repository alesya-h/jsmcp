import { loadApiKey } from "./api-key.js";
import { API_KEY_HEADER, DEFAULT_CLIENT_HOST, DEFAULT_PROXY_PORT, SERVER_NAME } from "./constants.js";

export async function handleRestartCommand(args) {
  const options = parseRestartArgs(args);
  const apiKey = await loadApiKey();
  const url = new URL(`http://${formatHostForUrl(options.host)}:${options.port}/api/restart`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      [API_KEY_HEADER]: apiKey,
    },
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Restart request failed with HTTP ${response.status}: ${responseBody.error ?? responseBody.text ?? response.statusText}`);
  }

  console.log(responseBody.message ?? "Restart requested.");
}

function parseRestartArgs(args) {
  let host = DEFAULT_CLIENT_HOST;
  let port = DEFAULT_PROXY_PORT;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--host") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --host.\n${getRestartUsage()}`);
      }
      host = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --port.\n${getRestartUsage()}`);
      }

      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port "${value}".\n${getRestartUsage()}`);
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown option "${argument}".\n${getRestartUsage()}`);
  }

  return { host, port };
}

async function readResponseBody(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function getRestartUsage() {
  return `Usage: ${SERVER_NAME} restart [--host <host>] [--port <number>]`;
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
