#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "prefixed-server",
  version: "1.0.0",
});

server.registerTool(
  "tool__read-value",
  {
    description: "Read a test value",
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: "text", text: "read-value" }],
    structuredContent: { value: "read-value" },
  }),
);

server.registerTool(
  "tool__repeat-text",
  {
    description: "Repeat text",
    inputSchema: z.object({
      text: z.string(),
    }),
  },
  async ({ text }) => ({
    content: [{ type: "text", text: text.repeat(2) }],
    structuredContent: { value: text.repeat(2) },
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
