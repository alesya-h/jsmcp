#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const fixtureServerPath = path.join(projectRoot, "test", "fixtures", "arithmetic-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

await testYamlConfig();
await testDuplicateConfigsFail();

async function testYamlConfig() {
  const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-yaml-"));

  try {
    await mkdir(path.join(tempConfigHome, "jsmcp"), { recursive: true });
    await writeFile(
      path.join(tempConfigHome, "jsmcp", "config.yaml"),
      [
        "servers:",
        "  math:",
        "    type: stdio",
        "    description: Arithmetic test server",
        "    command: node",
        "    args:",
        `      - ${JSON.stringify(fixtureServerPath)}`,
      ].join("\n") + "\n",
    );

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === "string"),
    );
    env.XDG_CONFIG_HOME = tempConfigHome;

    const client = new Client({
      name: "config-file-test",
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
      assert.deepEqual(listResult.structuredContent.servers, [
        {
          name: "math",
          description: "Arithmetic test server",
          ok: true,
        },
      ]);
    } finally {
      await client.close();
    }
  } finally {
    await rm(tempConfigHome, { recursive: true, force: true });
  }
}

async function testDuplicateConfigsFail() {
  const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-duplicate-config-"));

  try {
    await mkdir(path.join(tempConfigHome, "jsmcp"), { recursive: true });
    await writeFile(
      path.join(tempConfigHome, "jsmcp", "config.json"),
      JSON.stringify({ servers: {} }, null, 2),
    );
    await writeFile(
      path.join(tempConfigHome, "jsmcp", "config.yaml"),
      "servers: {}\n",
    );

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === "string"),
    );
    env.XDG_CONFIG_HOME = tempConfigHome;

    await assert.rejects(
      execFileAsync("node", [metaServerPath], { env }),
      (error) => {
        assert.match(error.stderr, /Multiple config files found/);
        assert.match(error.stderr, /config\.json/);
        assert.match(error.stderr, /config\.yaml/);
        return true;
      },
    );
  } finally {
    await rm(tempConfigHome, { recursive: true, force: true });
  }
}
