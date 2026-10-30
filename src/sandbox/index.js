import { Worker } from "node:worker_threads";

// Each execute_code script runs in its own single-use worker (see worker.js). A few spare workers
// (about 13 MB each) are kept started, so scripts from several agents at once don't wait for one.
const SPARE_WORKERS = 4;
// Stops one runaway script without taking the daemon (and every other agent's script) down.
const MEMORY_LIMIT_MB = 512;
// The worker enforces the script's timeout itself; this only catches a worker that stopped responding.
const BACKSTOP_GRACE_MS = 2000;
const WORKER_URL = new URL("./worker.js", import.meta.url);

export class ScriptSandbox {
  constructor({ memoryLimitMb = MEMORY_LIMIT_MB } = {}) {
    this.memoryLimitMb = memoryLimitMb;
    this.spares = [];
    this.closed = false;
  }

  spawn() {
    const worker = new Worker(WORKER_URL, {
      // Don't inherit the daemon's Node.js flags (some, like --input-type, break the worker).
      execArgv: [],
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: this.memoryLimitMb },
      stdout: true,
      stderr: true,
    });
    const ready = new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type === "ready") {
          cleanup();
          resolve(worker);
        }
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const onExit = (code) => {
        cleanup();
        reject(new Error(`Code execution worker exited during startup (code ${code}).`));
      };
      const cleanup = () => {
        worker.off("message", onMessage);
        worker.off("error", onError);
        worker.off("exit", onExit);
      };
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
    // A spare that fails to start is replaced on the next execution.
    ready.catch(() => {});
    // An idle spare must not keep the process alive; a worker in use must.
    worker.unref();
    return { worker, ready };
  }

  async takeWorker() {
    let next = this.spares.shift() ?? this.spawn();
    while (!this.closed && this.spares.length < SPARE_WORKERS) {
      this.spares.push(this.spawn());
    }
    next.worker.ref();
    try {
      return await next.ready;
    } catch {
      next = this.spawn();
      next.worker.ref();
      return await next.ready;
    }
  }

  // Runs `code` and resolves with its JSON-safe return value. `onRequest` handles tool and memory
  // calls (its result must be JSON-safe; undefined is allowed); `onLog` receives console output.
  async execute({ code, data, namespaces, timeoutMs, onRequest, onLog }) {
    if (this.closed) {
      throw new Error("The code execution sandbox is closed.");
    }

    const worker = await this.takeWorker();

    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(backstop);
        worker.removeAllListeners("message");
        worker.removeAllListeners("error");
        worker.removeAllListeners("exit");
        void worker.terminate();
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      const backstop = setTimeout(() => {
        finish(new Error(`Code execution exceeded ${timeoutMs}ms.`));
      }, timeoutMs + BACKSTOP_GRACE_MS);

      worker.on("message", (message) => {
        if (message?.type === "request") {
          void answer(message.request);
        } else if (message?.type === "log") {
          try {
            onLog(String(message.level), JSON.parse(message.valuesJson));
          } catch {
          }
        } else if (message?.type === "done") {
          if (!message.ok) {
            finish(new Error(String(message.error)));
            return;
          }
          let value;
          try {
            value = JSON.parse(message.valueJson);
          } catch {
            finish(new Error("Code execution returned a value that could not be read."));
            return;
          }
          finish(undefined, value);
        }
      });
      worker.on("error", (error) => {
        finish(
          error?.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new Error(`Code execution ran out of memory (limit ${this.memoryLimitMb} MB).`)
            : error,
        );
      });
      worker.on("exit", (code) => {
        finish(new Error(`Code execution stopped unexpectedly (code ${code}).`));
      });

      const answer = async (request) => {
        let reply;
        try {
          const value = await onRequest(request);
          reply = {
            type: "settle",
            id: request.id,
            ok: true,
            hasValue: value !== undefined,
            json: value === undefined ? undefined : JSON.stringify(value),
          };
        } catch (error) {
          reply = { type: "settle", id: request.id, ok: false, json: error instanceof Error ? error.message : String(error) };
        }
        if (!settled) {
          worker.postMessage(reply);
        }
      };

      worker.postMessage({
        type: "execute",
        code,
        dataJson: JSON.stringify(data ?? null),
        namespacesJson: JSON.stringify(namespaces),
        timeoutMs,
      });
    });
  }

  async close() {
    this.closed = true;
    const spares = this.spares;
    this.spares = [];
    await Promise.all(spares.map((spare) => spare.worker.terminate()));
  }
}
