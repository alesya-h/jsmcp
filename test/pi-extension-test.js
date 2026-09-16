#!/usr/bin/env node

// Run with Node >=22.6: node --experimental-strip-types test/pi-extension-test.js
// The extension's only Pi import is type-only, so these tests need no Pi install.
import assert from "node:assert/strict";

import jsmcpExtension from "../extensions/pi/index.ts";

const tools = new Map();
const commands = new Map();
jsmcpExtension({
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, command) => commands.set(name, command),
});

assert.equal(tools.size, 5);
assert(commands.has("jsmcp"));
const execute = tools.get("jsmcp_execute_code");
assert.equal(execute.parameters.properties.rawText.type, "boolean");
assert.equal(execute.parameters.properties.rawText.default, true);
assert(!execute.parameters.required.includes("rawText"));
assert.match(execute.description, /jsmcp\.memory/);
assert.match(execute.description, /executionMs/);
assert.match(execute.description, /automatically resolve to structuredContent/);

const originalFetch = globalThis.fetch;
const originalEnv = {
  PI_JSMCP_URL: process.env.PI_JSMCP_URL,
  PI_JSMCP_API_KEY: process.env.PI_JSMCP_API_KEY,
  PI_JSMCP_PROFILE: process.env.PI_JSMCP_PROFILE,
};
const replies = [];
const requests = [];
const signal = new AbortController().signal;
let choice = "Allow once";
let approvals = 0;
const ctx = {
  ui: {
    async select() {
      approvals += 1;
      return choice;
    },
  },
};
const servers = { structuredContent: { servers: [{ name: "math", ok: true }] } };
const toolList = { structuredContent: { server: "math", tools: [{ name: "add" }] } };

async function call(name, params = {}) {
  return tools.get(name).execute("test-call", params, signal, undefined, ctx);
}

function queueExecution(body) {
  replies.push(servers, toolList, body);
}

try {
  process.env.PI_JSMCP_URL = "http://jsmcp.test:41528/";
  process.env.PI_JSMCP_API_KEY = "test-key";
  process.env.PI_JSMCP_PROFILE = "work";
  globalThis.fetch = async (url, options) => {
    assert.equal(url.origin, "http://jsmcp.test:41528");
    assert.equal(url.pathname, "/api/call");
    assert.equal(url.searchParams.get("profile"), "work");
    assert.match(url.searchParams.get("sessionId"), /^[A-Za-z0-9._~-]+$/);
    assert.equal(options.headers["X-JSMCP-API-Key"], "test-key");
    assert.equal(options.signal, signal);
    assert.equal(options.method, "POST");
    requests.push({ url, input: JSON.parse(options.body) });
    assert(replies.length > 0, "Unexpected daemon request");
    const body = replies.shift();
    return new Response(JSON.stringify(body));
  };

  replies.push(servers, toolList);
  await call("jsmcp_list_servers");
  await call("jsmcp_list_tools", { server: "math" });

  const value = 'line one\n"quoted" \\path\n雪';
  const rawBody = {
    content: [
      { type: "text", text: value },
      { type: "text", text: "Execution time: 12ms" },
    ],
    structuredContent: { value, executionMs: 12 },
  };
  queueExecution(rawBody);
  const rawResult = await call("jsmcp_execute_code", { code: "return data.value;", data: { value } });
  assert.deepEqual(rawResult.content, [{ type: "text", text: `${value}\nExecution time: 12ms` }]);
  assert.deepEqual(rawResult.details, rawBody);
  assert.deepEqual(requests.at(-1).input, { code: "return data.value;", timeoutMs: 120000, data: { value } });
  assert.equal(approvals, 1);

  for (const rawText of [true, false]) {
    const body = rawText ? rawBody : {
      content: [{ type: "text", text: JSON.stringify(rawBody.structuredContent, null, 2) }],
      structuredContent: rawBody.structuredContent,
    };
    queueExecution(body);
    const result = await call("jsmcp_execute_code", { code: "return data.value;", data: { value }, timeout_ms: 4000, rawText });
    assert.equal(requests.at(-1).input.rawText, rawText);
    assert.equal(requests.at(-1).input.timeoutMs, 4000);
    assert.equal(result.content[0].text, body.content.map((part) => part.text).join("\n"));
  }

  queueExecution({
    content: [{ type: "text", text: "Execution failed" }, { type: "text", text: "Execution time: 34ms" }],
    structuredContent: { error: "Execution failed", executionMs: 34 },
    isError: true,
  });
  await assert.rejects(call("jsmcp_execute_code", { code: "throw new Error();" }), {
    message: "Execution failed\nExecution time: 34ms",
  });

  // Structured-only errors still retain their timing in the fallback text.
  queueExecution({ structuredContent: { error: "Failed", executionMs: 5 }, isError: true });
  await assert.rejects(call("jsmcp_execute_code", { code: "throw new Error();" }), (error) => {
    assert.deepEqual(JSON.parse(error.message), { error: "Failed", executionMs: 5 });
    return true;
  });

  queueExecution({ content: [{ type: "text", text: "" }], structuredContent: { value: "" } });
  assert.equal((await call("jsmcp_execute_code", { code: 'return "";' })).content[0].text, "");

  const requestsBeforeRejection = requests.length;
  choice = "Reject";
  await assert.rejects(call("jsmcp_execute_code", { code: "return 1;" }), /rejected by user/);
  assert.equal(requests.length, requestsBeforeRejection);

  choice = "Allow any requests until pi is restarted";
  queueExecution(rawBody);
  await call("jsmcp_execute_code", { code: "return data.value;", data: { value } });
  const approvalsAfterAllowAll = approvals;
  queueExecution(rawBody);
  await call("jsmcp_execute_code", { code: "return data.value;", data: { value } });
  assert.equal(approvals, approvalsAfterAllowAll);

  assert.equal(new Set(requests.map(({ url }) => url.searchParams.get("sessionId"))).size, 1);

  // Discovery changes must still prevent the execution request from being sent.
  replies.push({ structuredContent: { servers: [] } }, toolList);
  const requestCount = requests.length;
  await assert.rejects(call("jsmcp_execute_code", { code: "return 1;" }), /capabilities changed/);
  assert.equal(requests.length, requestCount + 2);
  assert.equal(replies.length, 0);
} finally {
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

console.log("Pi extension tests passed.");
