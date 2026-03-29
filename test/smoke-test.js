#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const fixtureServerPath = path.join(projectRoot, "test", "fixtures", "arithmetic-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "programmatic-mcp-"));

try {
  await mkdir(path.join(tempConfigHome, "programmatic-mcp"), { recursive: true });
  await writeFile(
    path.join(tempConfigHome, "programmatic-mcp", "config.json"),
    JSON.stringify(
      {
        servers: {
          math: {
            type: "local",
            command: ["node", fixtureServerPath],
            timeout: 5000,
          },
        },
        presets: {
          default: {
            servers: {
              math: {
                tools: ["add"],
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  );
  env.XDG_CONFIG_HOME = tempConfigHome;

  const client = new Client({
    name: "smoke-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: "node",
    args: [metaServerPath],
    env,
    stderr: "inherit",
  });

  try {
    await client.connect(transport);

    const listResult = await client.callTool({ name: "list_servers", arguments: {} });
    assert.equal(listResult.isError, undefined);
    assert.equal(listResult.structuredContent.preset, "default");
    assert.equal(listResult.structuredContent.servers.length, 1);
    assert.equal(listResult.structuredContent.servers[0].name, "math");
    assert.equal(listResult.structuredContent.servers[0].started, false);
    assert.deepEqual(listResult.structuredContent.servers[0].allowedTools, ["add"]);

    const startResult = await client.callTool({
      name: "start_servers",
      arguments: { servers: ["math"] },
    });
    assert.equal(startResult.structuredContent.started.length, 1);
    assert.equal(startResult.structuredContent.failed.length, 0);
    assert.equal(startResult.structuredContent.started[0].started, true);
    assert.deepEqual(
      startResult.structuredContent.started[0].availableTools.map((tool) => tool.name),
      ["add"],
    );

    const executeResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: `const result = await callTool("math", "add", { a: 2, b: 5 }); return { sum: result.structuredContent.sum, text: result.text };`,
      },
    });
    assert.equal(executeResult.isError, false);
    assert.equal(executeResult.structuredContent.ok, true);
    assert.equal(executeResult.structuredContent.result.sum, 7);
    assert.equal(executeResult.structuredContent.result.text, "7");

    const blockedToolResult = await client.callTool({
      name: "execute_code",
      arguments: {
        code: `return callTool("math", "repeat", { text: "x", times: 2 });`,
      },
    });
    assert.equal(blockedToolResult.isError, true);
    assert.equal(blockedToolResult.structuredContent.ok, false);
    assert.match(blockedToolResult.structuredContent.error, /not allowed/);
  } finally {
    await client.close();
  }
} finally {
  await rm(tempConfigHome, { recursive: true, force: true });
}
