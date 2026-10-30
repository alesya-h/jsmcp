// Runs one execute_code script, then exits. Each script gets its own worker thread (its own V8 heap,
// so a memory bomb only kills this worker) and, inside it, a fresh JavaScript realm that contains
// nothing from Node.js: no process, require, fetch or host functions of any kind.
//
// The realm and this worker only ever exchange strings. Everything the script can call (server
// namespaces, console, jsmcp.memory, timers, TextEncoder/TextDecoder) is built inside the realm from
// the source of `bootstrap` below. If a host object reached the realm, its constructor would be
// Node's Function and the script could reach `process`; keeping every value realm-native closes that.
import { parentPort } from "node:worker_threads";
import vm from "node:vm";

// A rejected promise the script never handled must not take the worker down with a host error.
process.on("unhandledRejection", () => {});

// Prepared while this worker waits as the spare, so a request only installs namespaces and data.
const BOOTSTRAP_TIMEOUT_MS = 5000;
const context = vm.constants?.DONT_CONTEXTIFY
  ? vm.createContext(vm.constants.DONT_CONTEXTIFY, {
      name: "execute_code",
      codeGeneration: { strings: false, wasm: false },
      // Promise jobs run inside runInContext, so the timeout covers async code too.
      microtaskMode: "afterEvaluate",
    })
  : undefined;
if (context) {
  vm.runInContext(`(${bootstrap.toString()})();`, context, { timeout: BOOTSTRAP_TIMEOUT_MS });
}

let execution;

parentPort.on("message", (message) => {
  if (message?.type === "execute" && !execution) {
    execution = new Execution(message);
    execution.start();
  } else if (message?.type === "settle") {
    execution?.receive({ e: "settle", id: message.id, ok: message.ok, has: message.hasValue, json: message.json });
  }
});
parentPort.postMessage({ type: "ready" });

class Execution {
  constructor({ code, dataJson, namespacesJson, timeoutMs }) {
    this.code = code;
    this.dataJson = dataJson;
    this.namespacesJson = namespacesJson;
    this.timeoutMs = timeoutMs;
    this.deadline = Date.now() + timeoutMs;
    this.inbox = [];
    this.scheduled = false;
    this.finished = false;
    this.timers = new Map();
  }

  start() {
    this.deadlineTimer = setTimeout(() => {
      this.finish({ error: `Code execution exceeded ${this.timeoutMs}ms.` });
    }, this.timeoutMs);

    try {
      if (!context) {
        throw new Error("execute_code needs Node.js 22.8 or later.");
      }
      this.context = context;
      // The code is wrapped in an async function below. Parse it on its own first, as a function body
      // (in this worker, never run), so it can't close that wrapper early and run outside it.
      try {
        new AsyncFunction(this.code);
      } catch (error) {
        if (messageOf(error) === "Single function literal required") {
          throw new SyntaxError("Unexpected end of the script's function body: brackets in the code don't balance.");
        }
        throw error;
      }
      this.run(`__jsmcp.install(${JSON.stringify(this.namespacesJson)}, ${JSON.stringify(this.dataJson)});`);
      const script = new vm.Script(`__jsmcp.start(async () => {\n"use strict";\n${this.code}\n});`, {
        filename: "execute_code.js",
      });
      script.runInContext(this.context, { timeout: this.remaining() });
      this.turn();
    } catch (error) {
      this.finish({ error: messageOf(error) });
    }
  }

  receive(event) {
    if (this.finished) {
      return;
    }
    this.inbox.push(event);
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.turn());
    }
  }

  // One step of the loop: deliver events to the realm, then collect what it wants done.
  turn() {
    this.scheduled = false;
    if (this.finished) {
      return;
    }

    try {
      const events = this.inbox;
      this.inbox = [];
      if (events.length > 0) {
        this.run(`__jsmcp.pump(${JSON.stringify(JSON.stringify(events))});`);
      }
      const collected = this.run("__jsmcp.collect();");
      if (typeof collected !== "string") {
        throw new Error("Code execution produced an invalid internal message.");
      }
      const { status, outbox } = JSON.parse(collected);
      for (const item of outbox) {
        this.handle(item);
      }
      if (status) {
        this.finish(status);
      }
    } catch (error) {
      this.finish({ error: messageOf(error) });
    }
  }

  handle(item) {
    switch (item.k) {
      case "call":
      case "memory":
        parentPort.postMessage({ type: "request", request: item });
        break;
      case "log":
        parentPort.postMessage({ type: "log", level: String(item.level), valuesJson: String(item.values) });
        break;
      case "timer": {
        const fire = () => {
          if (!item.repeat) {
            this.timers.delete(item.id);
          }
          this.receive({ e: "timer", id: item.id });
        };
        const delay = Math.min(Math.max(Number(item.ms) || 0, 0), 2 ** 31 - 1);
        this.timers.set(item.id, item.repeat ? setInterval(fire, delay) : setTimeout(fire, delay));
        break;
      }
      case "clear": {
        const handle = this.timers.get(item.id);
        clearTimeout(handle);
        clearInterval(handle);
        this.timers.delete(item.id);
        break;
      }
      default:
        throw new Error("Code execution produced an invalid internal message.");
    }
  }

  run(source) {
    return vm.runInContext(source, this.context, { timeout: this.remaining() });
  }

  remaining() {
    return Math.max(1, this.deadline - Date.now());
  }

  finish(status) {
    if (this.finished) {
      return;
    }
    this.finished = true;
    clearTimeout(this.deadlineTimer);
    for (const handle of this.timers.values()) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    parentPort.postMessage(
      "error" in status
        ? { type: "done", ok: false, error: String(status.error) }
        : { type: "done", ok: true, valueJson: status.value },
    );
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Errors may come from the script's context (Node creates its timeout error there). Read only an own
// data property, which runs none of the script's code.
function messageOf(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    return descriptor && typeof descriptor.value === "string" ? descriptor.value : "Code execution failed.";
  }
  return String(error);
}

// Evaluated from its source text inside the realm: it must not refer to anything outside itself.
function bootstrap() {
  "use strict";
  const { stringify, parse } = JSON;
  const { create, freeze, entries, defineProperty, getOwnPropertyNames, getPrototypeOf, fromEntries } = Object;
  const isArray = Array.isArray;
  const outbox = [];
  const pending = new Map();
  const timers = new Map();
  let nextId = 1;
  let status;
  let started = false;
  let installed = false;

  const send = (message) => {
    outbox.push(stringify(message));
  };

  // The same JSON-safe conversion jsmcp has always applied to results, memory and logs.
  const toJsonSafe = (value, seen = new WeakSet()) => {
    if (value === undefined) return null;
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (isArray(value)) return value.map((item) => toJsonSafe(item, seen));
    if (typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const output = {};
      for (const [key, item] of entries(value)) output[key] = toJsonSafe(item, seen);
      seen.delete(value);
      return output;
    }
    return String(value);
  };

  const request = (message) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ ...message, id });
    });

  const namespace = (server, tools) => {
    const library = create(null);
    for (const [name, tool] of entries(tools)) {
      library[name] = (args = {}, options = {}) =>
        request({ k: "call", server, tool, args: toJsonSafe(args), options: toJsonSafe(options) });
    }
    return freeze(library);
  };

  const memoryCall = (op, args, extra = {}) => request({ k: "memory", op, args: toJsonSafe(args), ...extra });
  const memory = freeze({
    get: (...args) => memoryCall("get", [args[0], args[1]], { hasDefault: args.length >= 2 }),
    set: (key, value) => memoryCall("set", [key, value]),
    has: (key) => memoryCall("has", [key]),
    delete: (key) => memoryCall("delete", [key]),
    keys: () => memoryCall("keys", []),
    entries: () => memoryCall("entries", []),
    clear: () => memoryCall("clear", []),
    update: async (key, updater) => {
      if (typeof updater !== "function") {
        throw new Error("jsmcp.memory.update requires an updater function.");
      }
      const next = await updater(await memoryCall("get", [key], { hasDefault: false }));
      return memoryCall("set", [key, next]);
    },
  });

  const log = (level) => (...values) => {
    send({ k: "log", level, values: stringify(toJsonSafe(values)) });
  };

  const addTimer = (repeat) => (callback, ms = 0, ...args) => {
    if (typeof callback !== "function") {
      throw new TypeError("The callback must be a function.");
    }
    const id = nextId++;
    timers.set(id, { callback, args, repeat });
    send({ k: "timer", id, ms: Number(ms) || 0, repeat });
    return id;
  };
  const clearTimer = (id) => {
    if (timers.delete(id)) send({ k: "clear", id });
  };

  // UTF-8 only, as WHATWG specifies for these classes' common use.
  class TextEncoder {
    get encoding() {
      return "utf-8";
    }
    encode(input = "") {
      const bytes = [];
      for (const character of String(input)) {
        let point = character.codePointAt(0);
        if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
        if (point < 0x80) bytes.push(point);
        else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
        else if (point < 0x10000) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
        else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 63), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
      }
      return new Uint8Array(bytes);
    }
  }

  class TextDecoder {
    #fatal;
    #ignoreBOM;
    constructor(label = "utf-8", options = {}) {
      if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(String(label).trim().toLowerCase())) {
        throw new RangeError(`The "${label}" encoding is not supported.`);
      }
      this.#fatal = Boolean(options?.fatal);
      this.#ignoreBOM = Boolean(options?.ignoreBOM);
    }
    get encoding() {
      return "utf-8";
    }
    get fatal() {
      return this.#fatal;
    }
    get ignoreBOM() {
      return this.#ignoreBOM;
    }
    decode(input) {
      if (input === undefined) return "";
      const bytes = ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
        : new Uint8Array(input);
      // The WHATWG UTF-8 decoder: invalid sequences become U+FFFD (or throw when fatal).
      let output = "";
      let point = 0;
      let needed = 0;
      let seen = 0;
      let lower = 0x80;
      let upper = 0xbf;
      const bad = () => {
        if (this.#fatal) throw new TypeError("The encoded data was not valid utf-8.");
        output += "\ufffd";
      };
      for (let index = 0; index <= bytes.length; index += 1) {
        if (index === bytes.length) {
          if (needed !== 0) bad();
          break;
        }
        const byte = bytes[index];
        if (needed === 0) {
          if (byte <= 0x7f) output += String.fromCharCode(byte);
          else if (byte >= 0xc2 && byte <= 0xdf) [needed, point] = [1, byte & 0x1f];
          else if (byte >= 0xe0 && byte <= 0xef) {
            if (byte === 0xe0) lower = 0xa0;
            if (byte === 0xed) upper = 0x9f;
            [needed, point] = [2, byte & 0xf];
          } else if (byte >= 0xf0 && byte <= 0xf4) {
            if (byte === 0xf0) lower = 0x90;
            if (byte === 0xf4) upper = 0x8f;
            [needed, point] = [3, byte & 0x7];
          } else bad();
          continue;
        }
        if (byte < lower || byte > upper) {
          [point, needed, seen, lower, upper] = [0, 0, 0, 0x80, 0xbf];
          bad();
          index -= 1;
          continue;
        }
        [lower, upper] = [0x80, 0xbf];
        point = (point << 6) | (byte & 0x3f);
        seen += 1;
        if (seen === needed) {
          output += String.fromCodePoint(point);
          [point, needed, seen] = [0, 0, 0];
        }
      }
      return !this.#ignoreBOM && output.startsWith("\ufeff") ? output.slice(1) : output;
    }
  }

  // Nothing a tool script needs, and each can run code or wait outside the worker's control:
  // finalizer callbacks run at GC time, Atomics can block or wake from another thread.
  for (const name of ["FinalizationRegistry", "SharedArrayBuffer", "Atomics", "WebAssembly"]) {
    delete globalThis[name];
  }
  globalThis.jsmcp = freeze({ memory });
  globalThis.console = freeze({ log: log("log"), info: log("info"), warn: log("warn"), error: log("error") });
  globalThis.setTimeout = addTimer(false);
  globalThis.setInterval = addTimer(true);
  globalThis.clearTimeout = clearTimer;
  globalThis.clearInterval = clearTimer;
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;

  // Freeze the realm's built-ins and everything reachable from them, so a script can't change the
  // behaviour of what this bootstrap and the worker rely on. The script's own globals stay writable.
  const frozen = new WeakSet();
  const harden = (value) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null || frozen.has(value)) return;
    frozen.add(value);
    freeze(value);
    harden(getPrototypeOf(value));
    for (const name of [...getOwnPropertyNames(value), ...Object.getOwnPropertySymbols(value)]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if ("value" in descriptor) harden(descriptor.value);
      else {
        harden(descriptor.get);
        harden(descriptor.set);
      }
    }
  };
  const intrinsics = [
    getPrototypeOf(async function () {}),
    getPrototypeOf(function* () {}),
    getPrototypeOf(async function* () {}),
    getPrototypeOf([][Symbol.iterator]()),
    getPrototypeOf(new Map()[Symbol.iterator]()),
    getPrototypeOf(new Set()[Symbol.iterator]()),
    getPrototypeOf(""[Symbol.iterator]()),
    getPrototypeOf("".matchAll(/./g)),
  ];
  // Prototypes reachable only through objects that some engine versions don't have.
  for (const make of [
    () => [].values().map((item) => item),
    () => Iterator.from({ next: () => ({ done: true }) }),
    () => new Intl.Segmenter().segment(""),
    () => new Intl.Segmenter().segment("")[Symbol.iterator](),
  ]) {
    try {
      intrinsics.push(getPrototypeOf(make()));
    } catch {}
  }
  for (const name of getOwnPropertyNames(globalThis)) {
    if (name !== "globalThis") harden(globalThis[name]);
  }
  intrinsics.forEach(harden);
  // Lock the built-in global bindings too, so a script can't swap `Error` (and with it Node's
  // stack-trace hook), `Promise` or `JSON` under the code above. Its own new globals stay free.
  for (const name of getOwnPropertyNames(globalThis)) {
    defineProperty(globalThis, name, { writable: false, configurable: false });
  }

  // The worker's interface. A script can see it too, but it only ever affects the script itself.
  const settleStatus = (promise) =>
    promise.then(
      (value) => {
        status = { value: stringify(toJsonSafe(value)) };
      },
      (error) => {
        status = { error: error instanceof Error ? String(error.message) : String(error) };
      },
    );
  defineProperty(globalThis, "__jsmcp", {
    value: freeze({
      install: (namespacesJson, dataJson) => {
        if (installed) return;
        installed = true;
        for (const [server, tools] of entries(parse(namespacesJson))) {
          globalThis[server] = namespace(server, tools);
        }
        globalThis.data = parse(dataJson);
      },
      start: (main) => {
        if (!started) {
          started = true;
          settleStatus(main());
        }
      },
      pump: (eventsJson) => {
        for (const event of parse(eventsJson)) {
          if (event.e === "settle") {
            const entry = pending.get(event.id);
            if (!entry) continue;
            pending.delete(event.id);
            if (event.ok) entry.resolve(event.has ? parse(event.json) : undefined);
            else entry.reject(new Error(event.json));
          } else if (event.e === "timer") {
            const timer = timers.get(event.id);
            if (!timer) continue;
            if (!timer.repeat) timers.delete(event.id);
            try {
              timer.callback(...timer.args);
            } catch (error) {
              send({ k: "log", level: "error", values: stringify([`Uncaught error in timer callback: ${String(error?.message ?? error)}`]) });
            }
          }
        }
      },
      collect: () => `{"status":${status === undefined ? "null" : stringify(status)},"outbox":[${outbox.splice(0).join(",")}]}`,
    }),
  });
}
