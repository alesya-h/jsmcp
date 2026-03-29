# programmatic-mcp

A meta MCP server that can:

- list the MCP servers available in a preset
- start selected servers on demand
- run JavaScript that calls tools from the started servers

It reads config from `$XDG_CONFIG_HOME/programmatic-mcp/config.json`. If `XDG_CONFIG_HOME` is not set, it falls back to `~/.config/programmatic-mcp/config.json`.

## Run

```bash
node src/index.js
node src/index.js my-preset
```

The only optional argument is the preset name. If omitted, `default` is used.

## Config

`servers` uses the same local/remote format as OpenCode MCP config.

`presets` controls which servers are exposed and which tools from those servers are allowed.

Example:

```json
{
  "servers": {
    "math": {
      "type": "local",
      "command": ["node", "/absolute/path/to/math-server.js"]
    },
    "docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer {env:DOCS_TOKEN}"
      }
    }
  },
  "presets": {
    "default": {
      "servers": {
        "math": true,
        "docs": {
          "tools": ["search", "fetch_page"]
        }
      }
    },
    "math-only": ["math"]
  }
}
```

Accepted preset forms:

- `"preset": ["server-a", "server-b"]`
- `"preset": { "servers": { "server-a": true } }`
- `"preset": { "servers": { "server-a": { "tools": ["tool1"] } } }`

Tool rules:

- `true`, omitted `tools`, or `"*"` means all tools from that server
- `tools: ["name"]` restricts access to the listed tools
- `false` or `enabled: false` removes that server from the preset

OpenCode-style `{env:NAME}` and `{file:path}` substitutions are supported.

## Exposed Tools

- `list_servers`
- `start_servers`
- `execute_code`

## `execute_code`

`execute_code` runs JavaScript as the body of an async function.

Available helpers inside the code:

- `listServers()`
- `listStartedServers()`
- `startServers(names)`
- `listTools(serverName)`
- `getServer(serverName)`
- `callTool(serverName, toolName, args?, options?)`
- `sleep(ms)`
- `console.log(...)`

Example body:

```js
const math = getServer("math");
const result = await math.callTool("add", { a: 2, b: 5 });
console.log(result.text);
return result.structuredContent;
```
