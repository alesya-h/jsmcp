import { loadApiKey } from "./api-key.js";
import { API_KEY_HEADER, DEFAULT_CLIENT_HOST, DEFAULT_PRESET, DEFAULT_PROXY_PORT, SERVER_NAME } from "./constants.js";

export async function handleStatusCommand(args) {
  const options = parseStatusArgs(args);
  const apiKey = await loadApiKey();
  const serversBody = await callApiTool(options, apiKey, "list_servers", {});

  if (!Array.isArray(serversBody.structuredContent?.servers)) {
    console.log(JSON.stringify(serversBody.structuredContent ?? serversBody, null, 2));
    return;
  }

  const servers = serversBody.structuredContent.servers;
  if (options.serverName) {
    const server = servers.find((item) => item.name === options.serverName);
    if (!server) {
      throw new Error(`Server "${options.serverName}" was not found.`);
    }

    if (options.showTools && server.ok === true) {
      const tools = await loadServerTools(options, apiKey, server.name);
      console.log(formatToolList(tools));
      return;
    }

    console.log(formatSingleServerStatus(server));
    return;
  }

  if (options.showTools) {
    const toolsByServer = new Map();
    for (const server of servers) {
      if (server.ok === true) {
        toolsByServer.set(server.name, await loadServerTools(options, apiKey, server.name));
      }
    }
    console.log(formatServerStatus(servers, toolsByServer));
    return;
  }

  console.log(formatServerStatus(servers));
}

async function callApiTool(options, apiKey, toolName, requestBody) {
  const url = new URL(`http://${formatHostForUrl(options.host)}:${options.port}/api/call`);
  url.searchParams.set("tool", toolName);

  if (options.profileProvided) {
    url.searchParams.set("profile", options.profile);
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [API_KEY_HEADER]: apiKey,
    },
    body: JSON.stringify(requestBody),
  });
  const responseBody = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Status request failed with HTTP ${response.status}: ${responseBody.error ?? responseBody.text ?? response.statusText}`);
  }

  return responseBody;
}

async function loadServerTools(options, apiKey, serverName) {
  const body = await callApiTool(options, apiKey, "list_tools", { server: serverName });
  return [...(body.structuredContent?.tools ?? [])].sort((left, right) => left.name.localeCompare(right.name));
}

function formatServerStatus(servers, toolsByServer = new Map()) {
  return servers
    .map((server) => {
      if (server.ok === true) {
        const lines = [`${server.name}: ok`];
        const tools = toolsByServer.get(server.name);
        if (tools) {
          lines.push("  tools:");
          for (const line of formatToolList(tools).split("\n")) {
            lines.push(`    ${line}`);
          }
        }
        return lines.join("\n");
      }

      const lines = [`${server.name}: ${formatErrorLine(server)}`];
      if (server.error?.stderr) {
        lines.push("  stderr:");
        for (const line of String(server.error.stderr).split("\n")) {
          lines.push(`    ${line}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n");
}

function formatSingleServerStatus(server) {
  if (server.ok === true) {
    return "ok";
  }

  const lines = [formatErrorLine(server)];
  if (server.error?.stderr) {
    lines.push("stderr:");
    for (const line of String(server.error.stderr).split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

function formatErrorLine(server) {
  return `error${server.error?.message ? `: ${server.error.message}` : ""}`;
}

function formatToolList(tools) {
  if (tools.length === 0) {
    return "No tools.";
  }

  return tools
    .map((tool) => {
      const description = String(tool.description ?? "").trim().replaceAll(/\s+/g, " ");
      return description ? `- ${tool.name}: ${description}` : `- ${tool.name}`;
    })
    .join("\n");
}

function parseStatusArgs(args) {
  let host = DEFAULT_CLIENT_HOST;
  let port = DEFAULT_PROXY_PORT;
  let profile = DEFAULT_PRESET;
  let profileProvided = false;
  let serverName;
  let showTools = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--host") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --host.\n${getStatusUsage()}`);
      }
      host = value;
      index += 1;
      continue;
    }

    if (argument === "--port") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --port.\n${getStatusUsage()}`);
      }

      port = Number.parseInt(value, 10);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port "${value}".\n${getStatusUsage()}`);
      }

      index += 1;
      continue;
    }

    if (argument === "--profile") {
      const value = args[index + 1];
      if (!value) {
        throw new Error(`Missing value for --profile.\n${getStatusUsage()}`);
      }
      if (profileProvided) {
        throw new Error(`Profile specified more than once.\n${getStatusUsage()}`);
      }
      profile = value;
      profileProvided = true;
      index += 1;
      continue;
    }

    if (argument === "--tools") {
      showTools = true;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option "${argument}".\n${getStatusUsage()}`);
    }

    if (serverName !== undefined) {
      throw new Error(`Server name specified more than once.\n${getStatusUsage()}`);
    }

    serverName = argument;
  }

  return { host, port, profile, profileProvided, serverName, showTools };
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

function getStatusUsage() {
  return `Usage: ${SERVER_NAME} status [server] [--tools] [--profile <name>] [--host <host>] [--port <number>]`;
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
