import { randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";

import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";

import { DEFAULT_PROXY_PATH, SERVER_NAME } from "./constants.js";
import { createMetaServer } from "./meta-server.js";
import { MetaMcpRuntime } from "./runtime.js";
import { getErrorMessage } from "./utils.js";

const MCP_SUBPROTOCOL = "mcp";

export async function runProxyServer({ presetName, port }) {
  const runtime = await MetaMcpRuntime.load(presetName);
  await runtime.startAllServers();

  const sessions = new Set();
  const httpServer = createHttpServer((_request, response) => {
    response.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Use WebSocket on /mcp.\n");
  });
  const wsServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(MCP_SUBPROTOCOL) ? MCP_SUBPROTOCOL : false;
    },
  });
  let shuttingDown = false;

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || `127.0.0.1:${port}`}`);

    if (requestUrl.pathname !== DEFAULT_PROXY_PATH) {
      rejectUpgrade(socket, 404, "Not found");
      return;
    }

    const requestedProfile = requestUrl.searchParams.get("profile");
    if (requestedProfile && requestedProfile !== presetName) {
      rejectUpgrade(socket, 409, `Profile mismatch. Server is running preset \"${presetName}\".`);
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit("connection", ws, request);
    });
  });

  wsServer.on("connection", async (socket) => {
    const transport = new WebSocketServerTransport(socket);
    const server = await createMetaServer(runtime);
    const session = { server, transport };
    sessions.add(session);

    server.server.onerror = (error) => {
      console.error(`[${SERVER_NAME}] proxy session error: ${getErrorMessage(error)}`);
    };

    server.server.onclose = () => {
      sessions.delete(session);
      runtime.dropSession(transport.sessionId);
    };

    try {
      await server.connect(transport);
    } catch (error) {
      sessions.delete(session);
      runtime.dropSession(transport.sessionId);
      console.error(`[${SERVER_NAME}] failed to start proxy session: ${getErrorMessage(error)}`);
      await transport.close().catch(() => null);
    }
  });

  wsServer.on("error", (error) => {
    console.error(`[${SERVER_NAME}] websocket server error: ${getErrorMessage(error)}`);
  });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await Promise.allSettled([
      ...[...sessions].map((session) => session.server.close()),
      closeWebSocketServer(wsServer),
      closeHttpServer(httpServer),
      runtime.close(),
    ]);
  };

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });

  await listen(httpServer, port);
  console.error(
    `[${SERVER_NAME}] server listening on ws://127.0.0.1:${port}${DEFAULT_PROXY_PATH} with preset "${presetName}"`,
  );
}

export async function runProxyClient({ port, requestedProfile }) {
  const wsUrl = new URL(`ws://127.0.0.1:${port}${DEFAULT_PROXY_PATH}`);
  if (requestedProfile) {
    wsUrl.searchParams.set("profile", requestedProfile);
  }

  const proxyClient = new ReconnectingProxyClient(wsUrl);
  await proxyClient.start();
}

class ReconnectingProxyClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.localTransport = new StdioServerTransport();
    this.remoteTransport = null;
    this.localClosed = false;
    this.closing = false;
    this.pendingRequests = new Map();
    this.restoreInitializeRequest = null;
    this.restoreInitializedNotification = null;
    this.connectPromise = null;
    this.restorePromise = null;
    this.restoreResolver = null;
    this.restoreRejecter = null;
    this.queue = Promise.resolve();
    this.hasConnected = false;
  }

  async start() {
    this.localTransport.onmessage = (message) => {
      this.queue = this.queue
        .then(() => this.handleLocalMessage(message))
        .catch((error) => this.handleLocalMessageFailure(message, error));
    };
    this.localTransport.onerror = (error) => this.fail(error);
    this.localTransport.onclose = () => {
      this.localClosed = true;
      void this.close();
    };

    process.stdin.on("end", () => {
      this.localClosed = true;
      void this.close();
    });
    process.stdin.on("close", () => {
      this.localClosed = true;
      void this.close();
    });

    await this.localTransport.start();
    await this.ensureRemoteReady();
    await new Promise(() => {});
  }

  async handleLocalMessageFailure(message, error) {
    if (isRequest(message)) {
      await this.localTransport.send(createRequestFailureResponse(message.id, classifyRequest(message), error));
      return;
    }

    this.fail(error);
  }

  async handleLocalMessage(message) {
    if (isInitializeRequest(message)) {
      this.restoreInitializeRequest = message;
    } else if (isInitializedNotification(message)) {
      this.restoreInitializedNotification = message;
    }

    await this.ensureRemoteReady();

    if (isRequest(message)) {
      this.pendingRequests.set(message.id, classifyRequest(message));
    }

    try {
      await this.remoteTransport.send(message);
    } catch (error) {
      if (isRequest(message)) {
        this.pendingRequests.delete(message.id);
      }
      throw error;
    }
  }

  async ensureRemoteReady() {
    if (this.remoteTransport) {
      return;
    }

    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }

    this.connectPromise = this.connectRemote();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connectRemote() {
    const transport = new WebSocketClientTransport(this.wsUrl);
    transport.onmessage = (message) => {
      void this.handleRemoteMessage(message).catch((error) => this.fail(error));
    };
    transport.onerror = (error) => {
      if (!this.closing) {
        console.error(`[${SERVER_NAME}] proxy client transport error: ${getErrorMessage(error)}`);
      }
    };
    transport.onclose = () => {
      this.handleRemoteClose();
    };

    await transport.start();
    this.remoteTransport = transport;

    if (!this.hasConnected) {
      this.hasConnected = true;
      console.error(`[${SERVER_NAME}] client connected to ${this.wsUrl}`);
    } else {
      console.error(`[${SERVER_NAME}] client reconnected to ${this.wsUrl}`);
    }

    if (this.restoreInitializeRequest) {
      await this.restoreRemoteSession();
    }
  }

  async restoreRemoteSession() {
    if (!this.restoreInitializeRequest || !this.remoteTransport) {
      return;
    }

    if (this.restorePromise) {
      await this.restorePromise;
      return;
    }

    this.restorePromise = new Promise((resolve, reject) => {
      this.restoreResolver = resolve;
      this.restoreRejecter = reject;
    });

    try {
      await this.remoteTransport.send(this.restoreInitializeRequest);
      await this.restorePromise;

      if (this.restoreInitializedNotification) {
        await this.remoteTransport.send(this.restoreInitializedNotification);
      }
    } finally {
      this.restorePromise = null;
      this.restoreResolver = null;
      this.restoreRejecter = null;
    }
  }

  async handleRemoteMessage(message) {
    if (this.restoreInitializeRequest && isResponseForId(message, this.restoreInitializeRequest.id) && this.restorePromise) {
      if (message.error) {
        this.restoreRejecter?.(new Error(message.error.message || "Remote initialize failed during reconnect."));
      } else {
        this.restoreResolver?.();
      }
      return;
    }

    if (isResponse(message)) {
      this.pendingRequests.delete(message.id);
    }

    await this.localTransport.send(message);
  }

  handleRemoteClose() {
    const hadRemote = this.remoteTransport !== null;
    this.remoteTransport = null;

    if (!hadRemote || this.closing) {
      return;
    }

    if (this.restoreRejecter) {
      this.restoreRejecter(new Error("Disconnected while restoring MCP session."));
    }

    if (this.pendingRequests.size > 0) {
      void this.failPendingRequests();
    }
  }

  async failPendingRequests() {
    const pending = [...this.pendingRequests.entries()];
    this.pendingRequests.clear();

    for (const [id, request] of pending) {
      await this.localTransport.send(createDisconnectErrorResponse(id, request));
    }
  }

  fail(error) {
    if (this.closing) {
      return;
    }

    console.error(`[${SERVER_NAME}] proxy client fatal error: ${getErrorMessage(error)}`);
    void this.close();
  }

  async close() {
    if (this.closing) {
      return;
    }

    this.closing = true;
    await Promise.allSettled([this.localTransport.close(), this.remoteTransport?.close()]);
    process.stdin.pause();
    process.exit(0);
  }
}

class WebSocketServerTransport {
  constructor(socket) {
    this.socket = socket;
    this.sessionId = randomUUID();
    this.started = false;
    this.closed = false;
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.handleMessage = (data, isBinary) => {
      if (isBinary) {
        this.onerror?.(new Error("Binary WebSocket messages are not supported."));
        return;
      }

      try {
        const raw = typeof data === "string" ? data : data.toString("utf8");
        const message = JSONRPCMessageSchema.parse(JSON.parse(raw));
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    };
    this.handleClose = () => {
      if (this.closed) {
        return;
      }

      this.closed = true;
      this.socket.off("message", this.handleMessage);
      this.socket.off("close", this.handleClose);
      this.socket.off("error", this.handleError);
      this.resolveClosed();
      this.onclose?.();
    };
    this.handleError = (error) => {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    };
  }

  async start() {
    if (this.started) {
      throw new Error(
        "WebSocketServerTransport already started! If using Server class, note that connect() calls start() automatically.",
      );
    }

    this.started = true;
    this.socket.on("message", this.handleMessage);
    this.socket.on("close", this.handleClose);
    this.socket.on("error", this.handleError);
  }

  async send(message) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open.");
    }

    await new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async close() {
    if (this.closed) {
      return;
    }

    if (this.socket.readyState === WebSocket.CLOSED) {
      this.handleClose();
      return;
    }

    this.socket.close();
    await this.closedPromise;
  }
}

function isRequest(message) {
  return message && typeof message.method === "string" && Object.hasOwn(message, "id");
}

function isResponse(message) {
  return message && Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"));
}

function isInitializeRequest(message) {
  return isRequest(message) && message.method === "initialize";
}

function isInitializedNotification(message) {
  return message && typeof message.method === "string" && !Object.hasOwn(message, "id") && message.method === "notifications/initialized";
}

function isResponseForId(message, id) {
  return isResponse(message) && message.id === id;
}

function classifyRequest(message) {
  if (message.method === "tools/call" && message.params?.name === "execute_code") {
    return { kind: "execute_code" };
  }

  return { kind: "generic", method: message.method };
}

function createDisconnectErrorResponse(id, request) {
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

function createRequestFailureResponse(id, request, error) {
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

function rejectUpgrade(socket, statusCode, message) {
  socket.write(
    `HTTP/1.1 ${statusCode} ${getStatusText(statusCode)}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`,
  );
  socket.destroy();
}

function getStatusText(statusCode) {
  if (statusCode === 404) {
    return "Not Found";
  }

  if (statusCode === 409) {
    return "Conflict";
  }

  if (statusCode === 426) {
    return "Upgrade Required";
  }

  return "Error";
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeHttpServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function closeWebSocketServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}
