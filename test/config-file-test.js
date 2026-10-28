#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createNetServer } from "node:net";
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
await testServerBindPrecedence();
await testInvalidBindFails();

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
      args: [metaServerPath, "run"],
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
      execFileAsync("node", [metaServerPath, "run"], { env }),
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

async function testServerBindPrecedence() {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-bind-"));

  try {
    const env = await writeServerConfig(tempHome, { bind: "localhost" });
    const port = await getAvailablePort();

    // The config's jsmcp.bind replaces the loopback default.
    const fromConfig = await startServer(env, ["--port", String(port)]);
    try {
      assert.match(fromConfig.stderr, new RegExp(`listening on ws://localhost:${port}/mcp`));
      assert.doesNotMatch(fromConfig.stderr, /reachable from other machines/);
    } finally {
      await fromConfig.stop();
    }

    // --bind on the command line wins over the config.
    const fromFlag = await startServer(env, ["--port", String(port), "--bind", "127.0.0.1"]);
    try {
      assert.match(fromFlag.stderr, new RegExp(`listening on ws://127\\.0\\.0\\.1:${port}/mcp`));
    } finally {
      await fromFlag.stop();
    }
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function testInvalidBindFails() {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-bad-bind-"));

  try {
    const env = await writeServerConfig(tempHome, { bind: " " });
    await assert.rejects(
      execFileAsync("node", [metaServerPath, "server", "--port", String(await getAvailablePort())], { env }),
      (error) => {
        assert.match(error.stderr, /Config field "jsmcp\.bind" must be a non-empty string/);
        return true;
      },
    );
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function writeServerConfig(tempHome, jsmcpSettings) {
  await mkdir(path.join(tempHome, "config", "jsmcp"), { recursive: true });
  await writeFile(
    path.join(tempHome, "config", "jsmcp", "config.json"),
    JSON.stringify(
      {
        jsmcp: jsmcpSettings,
        servers: {
          math: { type: "stdio", command: "node", args: [fixtureServerPath] },
        },
      },
      null,
      2,
    ),
  );

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([, value]) => typeof value === "string"),
  );
  env.XDG_CONFIG_HOME = path.join(tempHome, "config");
  env.XDG_DATA_HOME = path.join(tempHome, "data");
  return env;
}

async function startServer(env, args) {
  const child = spawn("node", [metaServerPath, "server", ...args], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = once(child, "exit");
  let stderr = "";

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for server.\n${stderr}`)), 10000);
    const onData = (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.includes("server listening on")) {
        // Give a possible exposure warning on the next line time to arrive.
        setTimeout(() => finish(), 100);
      }
    };
    const onExit = (code) => finish(new Error(`Server exited early (code=${code}).\n${stderr}`));
    const finish = (error) => {
      clearTimeout(timer);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolve();
    };
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });

  return {
    stderr,
    async stop() {
      child.kill("SIGTERM");
      await exited.catch(() => null);
    },
  };
}

async function getAvailablePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
