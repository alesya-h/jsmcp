import { randomUUID } from "node:crypto";

import { getErrorMessage } from "../utils.js";

export function isRequest(message) {
  return message && typeof message.method === "string" && Object.hasOwn(message, "id");
}

export function isResponse(message) {
  return (
    message &&
    Object.hasOwn(message, "id") &&
    (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
  );
}

export function isInitializeRequest(message) {
  return isRequest(message) && message.method === "initialize";
}

export function isInitializedNotification(message) {
  return (
    message &&
    typeof message.method === "string" &&
    !Object.hasOwn(message, "id") &&
    message.method === "notifications/initialized"
  );
}

export function isResponseForId(message, id) {
  return isResponse(message) && message.id === id;
}

export function classifyRequest(message) {
  if (message.method === "tools/call" && message.params?.name === "execute_code") {
    return { kind: "execute_code" };
  }

  if (message.method === "tools/call" && message.params?.name === "list_servers") {
    return {
      kind: "list_servers",
      originalMessage: cloneMessage(message),
    };
  }

  if (message.method === "tools/call" && message.params?.name === "list_tools") {
    return {
      kind: "list_tools",
      originalMessage: cloneMessage(message),
      serverName: message.params?.arguments?.server,
    };
  }

  return { kind: "generic", method: message.method };
}

export function createInternalRequest(message) {
  const request = cloneMessage(message);
  request.id = `internal-${randomUUID()}`;
  return request;
}

export function createDisconnectErrorResponse(id, request) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message:
        request.kind === "execute_code"
          ? "The jsmcp daemon disconnected while execute_code was running. The MCP session was re-established, but this specific call failed. If the code might have changed external state, inspect the current state before deciding how to retry; do not assume the operation either fully succeeded or fully failed."
          : `The jsmcp daemon disconnected while handling this request${request.method ? ` (${request.method})` : ""}. The MCP session will reconnect on the next call, but this request failed and may need to be retried.`,
    },
  };
}

export function createRequestFailureResponse(id, request, error) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32002,
      message:
        request.kind === "execute_code"
          ? `execute_code could not be sent to the jsmcp daemon: ${getErrorMessage(error)} If the earlier attempt may have changed external state, inspect the current state before deciding how to retry.`
          : `Failed to reach the jsmcp daemon for this request: ${getErrorMessage(error)}`,
    },
  };
}

export function createCapabilityChangeErrorResponse(id, change) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32003,
      message: buildCapabilityChangeMessage(change),
      data: change,
    },
  };
}

export function diffListServers(previousResponse, nextResponse) {
  const previous = getStructuredContent(previousResponse)?.servers ?? [];
  const next = getStructuredContent(nextResponse)?.servers ?? [];
  return buildCollectionDiff("list_servers", previous, next, (item) => item.name);
}

export function diffListTools(serverName, previousResponse, nextResponse) {
  const previous = getStructuredContent(previousResponse)?.tools ?? [];
  const next = getStructuredContent(nextResponse)?.tools ?? [];
  const diff = buildCollectionDiff("list_tools", previous, next, (item) => item.name);
  return diff ? { ...diff, serverName } : null;
}

export function cloneMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

function buildCapabilityChangeMessage(change) {
  return [
    "The jsmcp daemon reconnected and cached discovery results changed.",
    "Review these changes before retrying execute_code.",
    "",
    ...change.changes.flatMap(formatCapabilityChange),
  ].join("\n");
}

function formatCapabilityChange(change) {
  if (change.kind === "list_servers") {
    return formatCapabilitySection("list_servers", change.summary, "server");
  }

  return formatCapabilitySection(`list_tools(${change.serverName})`, change.summary, "tool");
}

function formatCapabilitySection(label, summary, itemLabel) {
  const lines = [`${label} changed:`];

  if (summary.added.length > 0) {
    lines.push(`- added ${itemLabel}${summary.added.length === 1 ? "" : "s"}: ${summary.added.join(", ")}`);
  }
  if (summary.removed.length > 0) {
    lines.push(
      `- removed ${itemLabel}${summary.removed.length === 1 ? "" : "s"}: ${summary.removed.join(", ")}`,
    );
  }
  if (summary.changed.length > 0) {
    lines.push(`- updated ${itemLabel}${summary.changed.length === 1 ? "" : "s"}: ${summary.changed.join(", ")}`);
  }

  return lines;
}

function buildCollectionDiff(kind, previous, next, getKey) {
  const previousMap = new Map(previous.map((item) => [getKey(item), item]));
  const nextMap = new Map(next.map((item) => [getKey(item), item]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, item] of nextMap) {
    if (!previousMap.has(key)) {
      added.push(key);
      continue;
    }

    if (!jsonEquals(previousMap.get(key), item)) {
      changed.push(key);
    }
  }

  for (const key of previousMap.keys()) {
    if (!nextMap.has(key)) {
      removed.push(key);
    }
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return null;
  }

  return {
    kind,
    summary: {
      added: added.sort(),
      removed: removed.sort(),
      changed: changed.sort(),
    },
    before: previous,
    after: next,
  };
}

function getStructuredContent(response) {
  return response?.result?.structuredContent;
}

function jsonEquals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
