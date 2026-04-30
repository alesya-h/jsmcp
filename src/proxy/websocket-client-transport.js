import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";

import { API_KEY_HEADER } from "../constants.js";

const MCP_SUBPROTOCOL = "mcp";

export class WebSocketClientTransport {
  constructor(url, apiKey) {
    this.url = url;
    this.apiKey = apiKey;
    this.socket = null;
  }

  async start() {
    if (this.socket) {
      throw new Error("WebSocketClientTransport already started.");
    }

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url, MCP_SUBPROTOCOL, {
        headers: {
          [API_KEY_HEADER]: this.apiKey,
        },
      });

      socket.once("open", () => resolve());
      socket.once("error", reject);
      socket.on("error", (error) => this.onerror?.(error));
      socket.on("close", () => this.onclose?.());
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          this.onerror?.(new Error("Binary WebSocket messages are not supported."));
          return;
        }

        try {
          const raw = typeof data === "string" ? data : data.toString("utf8");
          this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(raw)));
        } catch (error) {
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        }
      });

      this.socket = socket;
    });
  }

  async send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
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
    this.socket?.close();
  }
}
