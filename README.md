# jsmcp

`jsmcp` exists for cases where an agent needs to do more than a single MCP tool call.

Most MCP clients are great at one tool call at a time, but awkward when work requires:

- several related tool calls
- branching logic based on earlier results
- loops, retries, or result aggregation
- transforming tool output before the next call

`jsmcp` solves that by exposing approved MCP tools as JavaScript namespaces. Instead of forcing the model to juggle many separate tool invocations, it can discover what is available and then write a small amount of JavaScript to use those tools programmatically.

In practice, this means:

- the agent first learns what servers and tools are available, while `jsmcp` constrains access to whatever servers and tools you allow in a preset
- the agent can then write JavaScript for multi-step work
- logs stay separate from return values so the code stays easier to reason about

Config is read from `$XDG_CONFIG_HOME/jsmcp/` or, if `XDG_CONFIG_HOME` is not set, `~/.config/jsmcp/`. Exactly one of `config.json`, `config.yaml`, or `config.yml` must exist there.

## Why

Use `jsmcp` when you want agents to treat MCP tools more like a small programmable API surface than a sequence of isolated button presses.

This is especially useful when an agent needs to:

- combine results from several MCP tools
- script workflows across one or more MCP servers
- make decisions in code instead of repeatedly re-planning between tool calls
- keep tool access constrained to a reviewed preset

## Install

```bash
npm install -g @alesya_h/jsmcp
```

Requires Node.js 22.8 or later.

Or run it without installing globally:

```bash
npx @alesya_h/jsmcp run
```

## Run

```bash
jsmcp run
jsmcp run work
jsmcp server work --port 3000 --bind 0.0.0.0
jsmcp client --profile work --host 127.0.0.1 --port 3000
jsmcp client --profile work --port 3000 --session-id my-agent-session
jsmcp client --profile work --host remote.example.com --api-key "$JSMCP_API_KEY"
jsmcp status --profile work --host 127.0.0.1 --port 3000
jsmcp status kagi --tools --profile work --port 3000
jsmcp restart --host 127.0.0.1 --port 3000
jsmcp auth
jsmcp auth firefox_devtools
```

If you are running from a source checkout instead of an installed package, replace `jsmcp` with `node src/index.js`, for example `node src/index.js run`.

`run` starts the meta-MCP server directly over stdio.

`server` starts a long-lived daemon on `ws://<bind>:<port>/mcp`, starts every globally enabled MCP server once, and keeps those underlying connections warm. The chosen preset becomes the default profile for connections that do not request one. It binds to `127.0.0.1` by default, so only clients on the same machine can connect. To accept connections from other machines, set `jsmcp.bind` in the config (for example `"0.0.0.0"`) or pass `--bind <host>`, which takes precedence over the config. Anyone who can reach the port and has the API key can run code as the daemon's user, so only expose it on networks you trust. Before 1.8.0 the default was `0.0.0.0`: if you relied on that, add `bind: "0.0.0.0"` under `jsmcp` in the config before upgrading.

`client` exposes a stdio MCP server that proxies raw MCP/JSON-RPC messages to `server` over WebSocket. It accepts `--host <host>` and `--port <number>` to choose which daemon to connect to, can optionally pass `--profile <name>` to select that daemon-side profile, accepts `--session-id <id>` to reuse the same daemon-side log session across client reconnects, and accepts `--api-key <key>` to authenticate with a daemon whose API key differs from the local key file.

`status` connects to the daemon over HTTP, retrying until it is reachable, and prints the configured servers in the selected profile with their startup status or startup errors. Pass a server name to show only that server, and pass `--tools` to include each healthy server's allowed tools and descriptions. It accepts `--host <host>`, `--port <number>`, and `--profile <name>`.

`restart` asks a running daemon over HTTP to exit with a restart-request status. Run it under a supervisor such as the included systemd user service so the daemon is started again automatically. It accepts `--host <host>` and `--port <number>`.

`run`, `server`, and `client` all accept an optional preset as either a positional argument or `--profile <name>`. The default daemon port is `41528`. If `client --session-id` is omitted, the client generates a random session id and reuses it for reconnects during that client process.

On first `server` start, `jsmcp` creates an API key at `$XDG_CONFIG_HOME/jsmcp/api-key.txt`, or `~/.config/jsmcp/api-key.txt` if `XDG_CONFIG_HOME` is not set. Daemon WebSocket and HTTP API requests must include it in the `X-JSMCP-API-Key` header; unauthenticated requests receive `401`. CLI commands that connect to the daemon read the key from `JSMCP_API_KEY` when it is set, otherwise from the local key file. `jsmcp client` also accepts `--api-key <key>`, which takes precedence over `JSMCP_API_KEY`.

The daemon also exposes the five meta tools through one JSON HTTP endpoint, plus a restart endpoint:

```text
POST /api/call?tool=list_servers&profile=<name>
POST /api/call?tool=list_tools&profile=<name>
POST /api/call?tool=execute_code&sessionId=<id>&profile=<name>
POST /api/call?tool=fetch_logs&sessionId=<id>
POST /api/call?tool=clear_logs&sessionId=<id>
POST /api/restart
```

The `/api/call` request body is a JSON object matching the selected MCP tool arguments. HTTP callers may include `sessionId` in the query string to use a stable daemon-side log session. They may include `profile` to select which profile filters the server and tool view for that request.

Use `jsmcp auth` to manage OAuth for remote servers. With no arguments it lists remote servers that have OAuth enabled. With a server name it starts the OAuth flow for that server.

If no graphical environment is detected, or if you pass `--no-browser`, `jsmcp auth <server>` prints the authorization URL and waits for either the localhost callback or a pasted callback URL/code.

## Pi Extension

The Pi extension lives in [`extensions/pi/`](extensions/pi/README.md). To load it directly from this checkout, run from the repository root:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/pi" ~/.pi/agent/extensions/jsmcp
```

Move any existing standalone copy aside before creating the link. Start `jsmcp server` separately, then run `/reload` in Pi. The extension exposes the five meta tools with a `jsmcp_` prefix, including `jsmcp_execute_code` with `rawText`, timing, and session memory support. See its README for configuration and tests.

## systemd User Service

This repo includes `systemd/jsmcp.service`, a user unit that starts `jsmcp server` from the globally installed CLI.

Install it with:

```bash
npm install -g .
mkdir -p ~/.config/systemd/user
ln -sfn "$PWD/systemd/jsmcp.service" ~/.config/systemd/user/jsmcp.service
systemctl --user daemon-reload
systemctl --user enable --now jsmcp.service
```

Useful commands:

```bash
systemctl --user status jsmcp.service
journalctl --user -u jsmcp.service -f
systemctl --user restart jsmcp.service
```

The checked-in unit starts the default preset on the default daemon port and resolves `jsmcp` through the user's actual login shell from `getent passwd`.

## Config

The config file may be JSON or YAML and uses these top-level keys:

- `servers`: server definitions
- `jsmcp`: optional jsmcp-specific settings
- `presets`: optional overrides for which servers and tools are exposed to the agent

Server names must be valid JavaScript identifiers because `execute_code()` exposes them directly as globals.

`jsmcp` accepts both OpenCode MCP config style and the overlapping Claude Code MCP style for the common fields:

- local servers: `type: "local"` or `type: "stdio"`
- remote servers: `type: "remote"`, `type: "http"`, or `type: "sse"`
- commands: either `command: ["cmd", "arg1"]` or `command: "cmd"` with `args: ["arg1"]`
- environment variables: either `environment` or `env`

Supported `servers.<name>` fields:

- `type`: required; one of `local`, `stdio`, `remote`, `http`, `sse`
- `description`: optional string shown in `list_servers()`
- `enabled`: optional boolean; defaults to `true`
- `timeout`: optional number in milliseconds used for initial tool discovery
- `strip_tool_prefix`: optional string, `true`, or `false`; strings are removed from exposed tool names, `true` infers a shared prefix, and `false` disables prefix stripping for that server
- `normalize_tool_names`: optional boolean; converts exposed tool names to `snake_case` after prefix stripping
- `blocked_tools`: optional server-level deny list; a tool name string or array of exact tool names, `{ glob: "..." }`, and `{ regex: "..." }` selectors. Selectors match final exposed tool names after prefix stripping and normalization, and blocked tools cannot be re-enabled by presets.

Supported `jsmcp` fields:

- `auto_strip_tool_prefixes`: optional boolean; default `false`; if `true`, servers infer and strip shared tool-name prefixes unless overridden by `servers.<name>.strip_tool_prefix`
- `normalize_tool_names`: optional boolean; default `false`; if `true`, servers expose tool names as `snake_case` unless overridden by `servers.<name>.normalize_tool_names`
- `bind`: optional string; the address `jsmcp server` listens on when `--bind` is not given. Default `127.0.0.1`. Use `"0.0.0.0"` to accept connections from other machines.

For local / stdio servers:

- `command`: required; non-empty string or non-empty array
- `args`: optional array; appended to `command` when `command` is a string, and also accepted when `command` is an array
- `env`: optional object of environment variables
- `environment`: optional object of environment variables; merged with `env`, and wins on duplicate keys
- `cwd`: optional working directory

For remote / HTTP / SSE servers:

- `url`: required string
- `headers`: optional object of request headers
- `oauth`: optional OAuth config

Supported `oauth` forms:

- omitted, `null`, or `true`: enable OAuth with default behavior
- `false`: disable OAuth for that server
- object with any of:
  - `clientId`
  - `clientSecret`
  - `scope`

Supported value substitutions in string fields:

- `{env:NAME}`: expand from the current environment
- `${NAME}`: Claude Code-style environment expansion
- `${NAME:-default}`: Claude Code-style expansion with fallback
- `{file:path}`: replace with file contents

For `{file:path}`:

- relative paths are resolved relative to the config file directory
- `~/...` resolves from the user home directory
- absolute paths are used as-is

If `presets` is omitted, the default preset includes every server with `enabled !== false` and allows all of that server's tools.

If `presets` is present, it is an object of preset names. Each preset is an object of per-server overrides layered on top of the server definitions:

- `presets.default`: optional overrides for the default preset
- any other preset name, such as `presets.work`: additional named preset overrides

If a server strips prefixes or normalizes names, preset tool selectors match the final exposed tool names that agents see.

Server-level `blocked_tools` selectors are applied before preset allowlists. Use them for globally unsafe tools, and use presets for profile-specific whitelists.

Within a preset, server rules work like this:

- omitted server rule: use the server definition as-is
- `true`: include that server and allow all its tools
- `false`: exclude that server from that preset
- `"tool_name"`: include only that exact tool
- array entries may be:
  - exact tool name strings
  - `{ "regex": "..." }` selectors
  - `{ "glob": "..." }` selectors

If a server has `enabled: false` in `servers`, it is globally disabled and is not started or exposed by any preset.

Example:

```json
{
  "servers": {
    "math": {
      "type": "stdio",
      "description": "Basic arithmetic tools",
      "command": "node",
      "args": ["/absolute/path/to/math-server.js"],
      "env": {
        "LOG_LEVEL": "debug"
      },
      "cwd": "${PWD}"
    },
    "docs": {
      "type": "http",
      "description": "Documentation search and retrieval",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${DOCS_TOKEN}"
      },
      "oauth": {
        "scope": "docs.read"
      }
    }
  },
  "presets": {
    "default": {
      "math": ["add", { "glob": "mul_*" }],
      "docs": [{ "regex": "(search|fetch)" }]
    },
    "work": {
      "docs": true
    }
  }
}
```

Compatibility notes:

- Claude Code-style `env`, `type: "stdio"`, `type: "http"`, `type: "sse"`, and `command` plus `args` are supported
- OpenCode-style `type: "local"`, `type: "remote"`, command arrays, and `environment` are also supported
- Claude Code-specific features such as `headersHelper` and advanced OAuth fields like `callbackPort` or `authServerMetadataUrl` are not supported yet

OAuth tokens and registration state are stored in `$XDG_DATA_HOME/jsmcp/oauth.json` or `~/.local/share/jsmcp/oauth.json`.

## Exposed Tools

- `list_servers`
- `list_tools`
- `execute_code`
- `fetch_logs`
- `clear_logs`

## Behavior

- every server with `enabled !== false` is started once when `jsmcp` starts
- `list_servers()` is the required first step so the agent can learn what capabilities are available
- you must call `list_tools(server)` before using a server in `execute_code()` so you know the exact tool names, aliases, and schemas
- `list_servers()` and `list_tools(server)` return only the servers and tools allowed in the connection's selected profile
- `execute_code({ code, data?, timeoutMs?, rawText? })` does not manage server lifecycle; it can only use servers that are already started
- prefer `execute_code({ code, ... })` whenever the work would require more than a single tool call
- `execute_code()` exposes session-scoped in-memory JSON storage at `jsmcp.memory`
- `console.log`, `console.info`, `console.warn`, and `console.error` inside `execute_code()` are stored for `fetch_logs()`
- `fetch_logs()` drains the log buffer on read

## `execute_code`

`execute_code` runs JavaScript as the body of an async function.

Started servers are injected as globals. Each allowed MCP tool becomes a function on that server object. Prefer underscore aliases when available.

If you pass `data`, it is exposed to the script as the global variable `data`. This is useful for strings or structured values that would otherwise need escaping inside the code string.

You should call `list_tools(server)` before using a server in `execute_code()`. For multi-step work, prefer writing JavaScript instead of trying to mentally chain several tool calls.

### The script environment

Each script runs in its own worker thread, inside a fresh JavaScript environment that contains nothing from Node.js: no `process`, `require`, `fetch`, `Buffer` or `URL`; no `eval`, `new Function` or WebAssembly; and no `SharedArrayBuffer`, `Atomics` or `FinalizationRegistry`. Besides the standard JavaScript built-ins, a script has:

- the allowed servers, as globals, and `data`
- `console.log`, `console.info`, `console.warn` and `console.error`
- `jsmcp.memory`
- `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`; timers still pending when the script finishes are cancelled
- `TextEncoder` and `TextDecoder` (UTF-8)

The environment and jsmcp exchange only JSON, so a script can't reach jsmcp's own objects, files, credentials or the tools outside its profile. Built-ins and their global names are frozen, so a script can't tamper with them. Each script starts from a clean environment: globals don't carry over between calls (use `jsmcp.memory` for that).

A script is stopped at its timeout, or if it uses more than 512 MB of memory; either way the daemon and other scripts carry on.

The environment is a boundary within one process: it doesn't protect against bugs in V8 itself. To limit what jsmcp as a whole can reach, run it under a sandbox such as [bubblewrap](https://github.com/containers/bubblewrap).

Example:

```js
return await math.add({ a: 2, b: 5 });
```

With data:

```js
return data.message;
```

With in-memory session storage:

```js
await jsmcp.memory.set("search_results", await search.query({ q: "example" }));
return await jsmcp.memory.keys();
```

A later `execute_code()` call in the same profile and session can read it:

```js
const results = await jsmcp.memory.get("search_results", []);
return results.slice(0, 3);
```

Available methods are `get(key, defaultValue?)`, `set(key, value)`, `has(key)`, `delete(key)`, `keys()`, `entries()`, `clear()`, and `update(key, updater)`. Stored values are converted with the same JSON-safe conversion used for `execute_code()` results. Memory is in-process only and is cleared when `jsmcp` exits.

### Results and execution time

Successful `execute_code` responses always put the JSON-safe return value in `structuredContent.value`, including objects, arrays, strings, and primitives. Returning nothing produces `value: null`. For example, `return await math.add({ a: 2, b: 5 });` produces:

```json
{
  "value": { "sum": 7 },
  "executionMs": 12
}
```

`executionMs` is elapsed wall-clock time in rounded milliseconds, measured around runtime execution (including awaited tool calls and result conversion, but not response formatting or transport). Execution errors use `{ "error": "message", "executionMs": 12 }` with `isError: true`, including syntax errors and timeouts.

**Compatibility:** object results used to appear directly in `structuredContent`. Callers must now read `structuredContent.value` instead. Other meta tools' response shapes are unchanged.

The optional boolean `rawText` defaults to `true`. When the returned value is a string, `content[0].text` contains that string verbatim, without JSON quoting or escaped newlines. A separate text block reports `Execution time: <n>ms`. The structured envelope is still provided for programmatic callers.

For example, call:

```json
{
  "code": "return data.message;",
  "data": { "message": "Hello\nworld" }
}
```

The first text block is:

```text
Hello
world
```

Pass `rawText: false` to render the entire `{ value, executionMs }` envelope as JSON text instead. Non-string results always use JSON text. Errors retain plain error text with a separate timing block. These options behave identically over stdio, WebSocket, and HTTP. Clients that display `structuredContent` rather than `content` may still show JSON.

### Connected MCP tool results

Calls inside your JavaScript are automatically unwrapped; agents do **not** need to access `.structuredContent` themselves:

- If an upstream tool returns `structuredContent`, the call resolves to that object.
- Otherwise, text-only content resolves to a string (multiple text blocks are joined with newlines). JSON-looking text is not automatically parsed.
- Otherwise, mixed/non-text content resolves to `{ text, content, meta }`, preserving the content blocks.
- Upstream `isError` results throw an error.

```js
const result = await math.add({ a: 2, b: 5 });
return result.sum; // 7, not result.structuredContent.sum
```

Only the outer `execute_code` response adds `{ value, executionMs }`; upstream objects are not otherwise flattened. To display a string field directly, return that field rather than its containing object.

If a tool name is not a valid JavaScript identifier, prefer its underscore alias:

```js
return await math.tool_name({ value: 1 });
```

The original tool name still works with bracket access:

```js
return await math["tool-name"]({ value: 1 });
```
