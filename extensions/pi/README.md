# Pi extension for jsmcp

This directory is the source of the Pi extension. It talks to a running `jsmcp server` over HTTP and registers:

- `jsmcp_list_servers`
- `jsmcp_list_tools`
- `jsmcp_execute_code`
- `jsmcp_fetch_logs`
- `jsmcp_clear_logs`

## Install from a checkout

From the jsmcp repository root:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/extensions/pi" ~/.pi/agent/extensions/jsmcp
```

If that destination already contains an older copy, move it aside first rather than keeping two active copies. Pi discovers the symlinked directory's `index.ts`; edits in this repository are picked up by `/reload`. Do not also load the same extension via settings or `-e`.

Start the daemon separately with `jsmcp server` (or `node src/index.js server` from this checkout). Run `/reload` in an existing Pi session after updating the extension. The `/jsmcp` command shows the endpoint and current daemon session ID.

## Configuration

Environment variables:

- `PI_JSMCP_URL` or `STRAP_JSMCP_URL` (default `http://127.0.0.1:41528`)
- `PI_JSMCP_API_KEY` or `STRAP_JSMCP_API_KEY`
- `PI_JSMCP_API_KEY_FILE` or `STRAP_JSMCP_API_KEY_FILE` (default `~/.config/jsmcp/api-key.txt`)
- `PI_JSMCP_PROFILE` or `STRAP_JSMCP_PROFILE` (otherwise the daemon's default profile)

## Execution

`jsmcp_execute_code` accepts:

- `code`: JavaScript async-function body that returns the desired value.
- `data`: optional object available as the global `data`.
- `timeout_ms`: timeout in milliseconds, default `120000`; forwarded as the daemon's `timeoutMs`.
- `rawText`: optional boolean, default `true`. Returned strings appear directly as text with a separate timing line. Set `false` to show the JSON result envelope instead.

Successful daemon responses contain `structuredContent: { value, executionMs }`; failures contain `{ error, executionMs }`. The extension prefers the daemon's text content for the model and retains the complete successful response in Pi's result `details`. Execution errors are thrown to mark the Pi tool call as failed, preserving the daemon's error text and execution timing.

Inside code, connected MCP calls already resolve to their `structuredContent`, or to a string for text-only output. Mixed/non-text results without structured content resolve to `{ text, content, meta }`. No manual `.structuredContent` access is needed. To display a string without JSON escaping, return it directly instead of returning its containing object.

`jsmcp.memory` provides `get`, `set`, `has`, `delete`, `keys`, `entries`, `clear`, and `update` for JSON-safe data across calls. The extension reuses one daemon session ID across its requests; memory is scoped to that ID and profile. It is not durable: daemon restarts clear memory, and reloading/restarting the extension can generate a new session ID.

Before execution, the extension asks whether to allow the request once, allow all requests until Pi is restarted, or reject it. It then refreshes discovered server/tool lists and rejects execution if capabilities changed. The allow-all choice is process-scoped and survives `/reload` and session switches, but not a Pi restart.

## Tests

From the repository root, on Node >=22.6:

```bash
npm run test:pi
```

Tests load the TypeScript extension using Node's type stripping and mock the daemon HTTP responses and Pi registration/UI. They do not require a Pi install, a running daemon, or credentials.
