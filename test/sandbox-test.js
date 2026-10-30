#!/usr/bin/env node
// execute_code isolation: scripts must not reach Node.js, whatever they try, and a script that
// exhausts CPU or memory must not take the daemon with it.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const fixtureServerPath = path.join(projectRoot, "test", "fixtures", "arithmetic-server.js");
const metaServerPath = path.join(projectRoot, "src", "index.js");

const tempConfigHome = await mkdtemp(path.join(os.tmpdir(), "jsmcp-sandbox-"));

try {
  await mkdir(path.join(tempConfigHome, "jsmcp"), { recursive: true });
  await writeFile(
    path.join(tempConfigHome, "jsmcp", "config.json"),
    JSON.stringify({
      servers: { math: { type: "stdio", command: "node", args: [fixtureServerPath] } },
      presets: { default: { math: ["add"] } },
    }),
  );
  const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string"));
  env.XDG_CONFIG_HOME = tempConfigHome;

  const client = new Client({ name: "sandbox-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: "node", args: [metaServerPath, "run"], env, stderr: "inherit" }));

  try {
    await client.callTool({ name: "list_servers", arguments: {} });
    const run = async (code, extra = {}) => {
      const result = await client.callTool({ name: "execute_code", arguments: { code, ...extra } });
      return result.structuredContent;
    };
    const failsWith = async (code, pattern, extra) => {
      const result = await run(code, extra);
      assert.equal(typeof result.error, "string", `script should have failed:\n${code}`);
      assert.match(result.error, pattern);
    };
    const value = async (code, extra) => {
      const result = await run(code, extra);
      assert.equal(result.error, undefined, `script failed: ${result.error}\n${code}`);
      return result.value;
    };

    // Tools still work, through the sandbox.
    assert.deepEqual(await value("return await math.add({ a: 2, b: 5 });"), { sum: 7 });

    // Nothing from Node.js is in scope.
    assert.deepEqual(
      await value(
        "return [typeof process, typeof require, typeof module, typeof Buffer, typeof fetch, typeof URL, typeof globalThis.process, typeof __dirname];",
      ),
      Array(8).fill("undefined"),
    );

    // Every object a script can touch belongs to the sandbox: walking up any constructor chain reaches
    // only the sandbox's own Function, which can't compile code and has no process in scope anyway.
    const routes = {
      "a tool function": "math.add",
      "a tool call promise": "math.add({ a: 1, b: 1 })",
      "a failed tool call": "await math.add({ a: 'not a number' }).catch((error) => error)",
      "a disallowed tool": "math.repeat",
      "console.log": "console.log",
      "jsmcp.memory": "jsmcp.memory.get",
      "a memory promise": "jsmcp.memory.keys()",
      "setTimeout": "setTimeout",
      "TextDecoder": "TextDecoder",
      "data": "data",
      "globalThis": "globalThis",
      "an async function": "(async () => {})",
      "a generator": "(function* () {})()",
    };
    for (const [name, expression] of Object.entries(routes)) {
      const outcome = await value(`
        const target = ${expression};
        if (target === undefined || target === null) return "unreachable";
        const constructors = [target.constructor, target.constructor?.constructor, Object.getPrototypeOf(target)?.constructor?.constructor];
        const results = [];
        for (const Fn of constructors) {
          if (typeof Fn !== "function") continue;
          try {
            results.push(Fn("return typeof process")());
          } catch (error) {
            results.push(error.message);
          }
        }
        return results;
      `, { data: { probe: true } });
      const text = JSON.stringify(outcome);
      assert.doesNotMatch(text, /"(object|function)"/, `${name} must not reach process: ${text}`);
    }

    // eval and wasm are switched off, and built-ins can't be tampered with.
    await failsWith('return eval("1 + 1");', /Code generation from strings disallowed/);
    assert.deepEqual(
      await value("return [typeof WebAssembly, typeof SharedArrayBuffer, typeof Atomics, typeof FinalizationRegistry];"),
      Array(4).fill("undefined"),
    );
    // Code must be a function body: it can't close the wrapper it runs in.
    await failsWith('}); globalThis.outside = 1; (async () => {', /brackets in the code don't balance/);
    await failsWith("Error.prepareStackTrace = (error, frames) => frames; return 1;", /read only|not extensible|Cannot assign/);
    await failsWith("JSON.parse = () => 1; return 1;", /read only|Cannot assign/);
    await failsWith("globalThis.Error = { prepareStackTrace: (error, frames) => frames }; return 1;", /read only|Cannot assign/);
    await failsWith("Promise = function () {}; return 1;", /read only|Cannot assign|constant/);
    await failsWith("Object.prototype.then = () => 1; return 1;", /not extensible|Cannot add/);

    // Built-in prototypes are frozen, including ones reachable only through the objects they produce.
    const unfrozen = await value(`
      const samples = [[].values(), new Map().entries(), "a".matchAll(/a/g), Promise.resolve(), new Uint8Array(1),
        [].values().map((x) => x), Iterator.from({ next: () => ({ done: true }) }), new Intl.Segmenter().segment("ab"),
        new Intl.Segmenter().segment("ab")[Symbol.iterator](), new TypeError("x"), /a/, new Date(0)];
      return samples.filter((sample) => {
        for (let p = Object.getPrototypeOf(sample); p; p = Object.getPrototypeOf(p)) if (!Object.isFrozen(p)) return true;
        return false;
      }).map((sample) => Object.prototype.toString.call(sample));`);
    assert.deepEqual(unfrozen, []);

    // Each script starts from a clean environment.
    assert.equal(await value("globalThis.leaked = 1; return typeof leaked;"), "number");
    assert.equal(await value("return typeof leaked;"), "undefined");

    // Runaway scripts stop, and the daemon carries on.
    await failsWith("while (true) {}", /timed out/, { timeoutMs: 200 });
    await failsWith("await null; while (true) {}", /timed out/, { timeoutMs: 200 });
    await failsWith("const hoard = []; for (;;) hoard.push(new Array(1e6).fill(1));", /ran out of memory/, { timeoutMs: 60000 });
    assert.deepEqual(await value("return await math.add({ a: 20, b: 22 });"), { sum: 42 });

    // Scripts can fan out widely.
    assert.equal(
      await value("const all = []; for (let i = 0; i < 300; i += 1) all.push(math.add({ a: i, b: 0 })); return (await Promise.all(all)).length;"),
      300,
    );

    // Many scripts at once, as when many agents share one daemon.
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, index) => value(`return (await math.add({ a: ${index}, b: 1 })).sum;`)),
    );
    assert.deepEqual(burst, Array.from({ length: 40 }, (_, index) => index + 1));

    // Timers left running by a script stop when it finishes.
    await client.callTool({ name: "clear_logs", arguments: {} });
    assert.equal(await value('setInterval(() => console.log("tick"), 5); return 1;'), 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const logs = await client.callTool({ name: "fetch_logs", arguments: {} });
    assert.deepEqual(logs.structuredContent.logs, []);

    // An unhandled rejection inside a script doesn't break the execution.
    assert.equal(await value("math.add({ a: 'x' }); return 'still here';"), "still here");

    // TextEncoder/TextDecoder match Node's, including invalid input.
    const samples = ["", "plain", "Snow ☃ and 🦋", "lone \ud800 surrogate", "\ufeffwith BOM"];
    const byteSamples = [
      [0xff, 0x61], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf0, 0x9f, 0x98, 0x80], [0xc0, 0xaf], [0xe0, 0x80, 0xaf],
      [0xf4, 0x90, 0x80, 0x80], [0x61, 0xf0, 0x9f, 0x98], [0xef, 0xbb, 0xbf, 0x68, 0x69],
    ];
    let seed = 7;
    for (let index = 0; index < 40; index += 1) {
      byteSamples.push(Array.from({ length: 12 }, () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 256));
    }
    const sandboxed = await value(
      "return { encoded: data.samples.map((s) => [...new TextEncoder().encode(s)]), decoded: data.bytes.map((b) => new TextDecoder().decode(new Uint8Array(b))) };",
      { data: { samples, bytes: byteSamples } },
    );
    assert.deepEqual(sandboxed.encoded, samples.map((sample) => [...new TextEncoder().encode(sample)]));
    assert.deepEqual(sandboxed.decoded, byteSamples.map((bytes) => new TextDecoder().decode(new Uint8Array(bytes))));
    await failsWith("return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff]));", /not valid utf-8/);
  } finally {
    await client.close();
  }
} finally {
  await rm(tempConfigHome, { recursive: true, force: true });
}

console.log("sandbox tests passed");
