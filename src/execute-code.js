import { performance } from "node:perf_hooks";

import { DEFAULT_CODE_TIMEOUT_MS } from "./constants.js";
import { formatExecutionValue } from "./rendering.js";
import { getErrorMessage } from "./utils.js";

// Shared by the MCP and HTTP entry points so their result envelopes stay identical.
export async function executeCodeTool(runtime, { code, data, timeoutMs, rawText = true }, sessionId, profileName) {
  const startedAt = performance.now();

  try {
    const timeout = validateOptionalTimeoutMs(timeoutMs) ?? DEFAULT_CODE_TIMEOUT_MS;
    if (typeof rawText !== "boolean") {
      throw new Error('Field "rawText" must be a boolean.');
    }

    const value = await runtime.executeCode(code, timeout, sessionId, data, profileName);
    const executionMs = Math.round(performance.now() - startedAt);
    const structuredContent = { value, executionMs };
    const content = rawText && typeof value === "string"
      ? [{ type: "text", text: value }, executionTimingContent(executionMs)]
      : [{ type: "text", text: formatExecutionValue(structuredContent) }];

    return { content, structuredContent };
  } catch (error) {
    const executionMs = Math.round(performance.now() - startedAt);
    const message = getErrorMessage(error);
    return {
      content: [{ type: "text", text: message }, executionTimingContent(executionMs)],
      structuredContent: { error: message, executionMs },
      isError: true,
    };
  }
}

function executionTimingContent(executionMs) {
  return { type: "text", text: `Execution time: ${executionMs}ms` };
}

function validateOptionalTimeoutMs(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) {
    return undefined;
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new Error('Field "timeoutMs" must be an integer from 1 to 300000.');
  }

  return timeoutMs;
}
