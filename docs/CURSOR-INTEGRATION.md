# Cursor CLI Integration Plan

Research into adding Cursor as an alternative agent backend to NanoClaw.

## Motivation

Cost reduction and model coverage. Cursor CLI routes to GPT-4o, GPT-5, Gemini, and other
non-Anthropic models via a single API key, which may be cheaper or more capable for certain
use cases.

---

## How the Current Agent Backend Works

The `claude-agent-sdk` `query()` function spawns the `claude` CLI binary and communicates
with it over a stream-JSON protocol:

```
claude --output-format stream-json --input-format stream-json --verbose ...
```

Input and output are both JSONL streams over stdin/stdout. The SDK manages session state,
MCP server config, hooks, and tool permissions.

The SDK exposes two official escape hatches in `QueryOptions`:
- `pathToClaudeCodeExecutable` — point to a different binary path
- `spawnClaudeCodeProcess` — fully custom spawn function

However, these can't be used to hot-swap in Cursor because the **input protocol differs**:
Claude Code accepts `--input-format stream-json` for streaming multi-turn input, while Cursor
only accepts a prompt via `-p`. A parallel runner is needed instead.

---

## Cursor CLI Capabilities

Cursor CLI (`agent` binary) has a headless mode nearly identical to Claude Code's `-p` mode.

### Key flags

| Flag | Description |
|---|---|
| `-p "prompt"` | Non-interactive print mode |
| `--output-format stream-json` | NDJSON streaming output |
| `--stream-partial-output` | Character-level delta streaming |
| `--resume [chatId]` | Resume a previous session |
| `--continue` | Resume the last session |
| `--model <model>` | Model selection |
| `--force` / `--yolo` | Skip file modification confirmations |
| `--trust` | Trust workspace without prompting (headless) |
| `--approve-mcps` | Auto-approve MCP servers |
| `--api-key <key>` | Auth (or `CURSOR_API_KEY` env var) |
| `--workspace <path>` | Working directory |

### stream-json event types

Nearly identical to Claude Code's format:

```json
{"type":"system","subtype":"init","session_id":"...","model":"..."}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]},"session_id":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}]},"session_id":"..."}
{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"..."}}}}
{"type":"tool_call","subtype":"completed","tool_call":{...,"result":{"success":{...}}}}
{"type":"result","subtype":"success","duration_ms":...}
```

---

## Claude Code vs Cursor — Feature Comparison

| Feature | Claude Code | Cursor |
|---|---|---|
| Non-interactive mode | `-p "prompt"` | `-p "prompt"` |
| Output format | `--output-format stream-json` | `--output-format stream-json` |
| Session resume | `--resume <sessionId>` | `--resume <chatId>` |
| Model selection | `--model <model>` | `--model <model>` |
| Skip confirmations | `--dangerously-skip-permissions` | `--force` / `--yolo` |
| Auth env var | `ANTHROPIC_API_KEY` / OAuth | `CURSOR_API_KEY` |
| Binary name | `claude` | `agent` |
| Input format | `--input-format stream-json` (streaming) | `-p` flag only |
| Custom MCP servers | Full CLI config | `--approve-mcps` only |
| Hooks | ✅ PreCompact, PreToolUse, etc. | ❌ |
| `allowedTools` | ✅ | ❌ |
| `permissionMode` | ✅ bypassPermissions etc. | ❌ (`--force` only) |

---

## Implementation Plan

### 1. `cursor-runner.ts` (new file in `container/agent-runner/src/`)

Replaces the `claude-agent-sdk` `query()` call with direct `agent` CLI invocation. Reuses
the same `MessageStream`, IPC polling, and `OUTPUT_START/END` marker protocol so the host
(`container-runner.ts`) needs no changes.

```typescript
// Core invocation
spawn('agent', [
  '-p', prompt,
  '--output-format', 'stream-json',
  '--trust',
  '--force',
  '--workspace', '/workspace/group',
  ...(sessionId ? ['--resume', sessionId] : []),
  ...(model ? ['--model', model] : []),
], { env: { ...process.env, CURSOR_API_KEY: secrets.CURSOR_API_KEY } })
```

- Parse `stream-json` stdout, extract assistant text from `type=assistant` events
- Capture `session_id` from `type=system,subtype=init` for next invocation
- Follow-up messages: new spawn with `--resume <chatId>` (since Cursor has no streaming
  input, each follow-up is a new process invocation)
- Emit `OUTPUT_START/END` markers in the same format as the Claude runner

### 2. `index.ts` — backend selection

Branch at startup based on `AGENT_BACKEND` env var:

```typescript
const runner = process.env.AGENT_BACKEND === 'cursor' ? cursorRunner : claudeRunner;
```

### 3. Dockerfile — install Cursor CLI

```dockerfile
RUN curl https://cursor.com/install -fsS | bash
```

Pass `CURSOR_API_KEY` through the existing secrets mechanism alongside `ANTHROPIC_API_KEY`.
(`container-runner.ts` already reads allowed vars from `.env`; add `CURSOR_API_KEY` to the
allowlist.)

### 4. Session persistence

Cursor's `--resume <chatId>` works identically to Claude Code's `--resume <sessionId>`.
Store the chat ID from the `system/init` event in SQLite under the group folder. The
existing `sessions` table and `setSession`/`getAllSessions` DB functions work unchanged.

### 5. IPC MCP shim (limitation)

The `ipc-mcp-stdio.ts` MCP server (lets the agent proactively send messages, manage tasks,
register groups) relies on custom MCP server config passed to the SDK. Cursor only exposes
`--approve-mcps` with no way to specify MCP server addresses via CLI flags.

**Workaround options (TBD):**
- Check if Cursor CLI reads `.cursor/mcp.json` from the workspace — if so, write the config
  there before invoking
- Alternatively, accept the limitation: in Cursor mode, agents can only reply to messages
  and cannot proactively send messages or manage tasks

---

## What You Lose in Cursor Mode

- **Hooks**: No PreCompact transcript archiving, no PreToolUse Bash sanitization
- **`allowedTools`**: Cursor controls its own tool set; no restriction to specific tools
- **Full MCP support**: Outbound IPC (proactive messaging, task scheduling) may be unavailable
- **Claude-specific features**: extended thinking, agent teams, etc.

## What You Gain

- Access to GPT-4o, GPT-5, Gemini, and other models via Cursor's routing
- Potentially lower cost for high-volume groups
- Same session memory and conversation continuity

---

## References

- [Cursor CLI Overview](https://cursor.com/docs/cli/overview)
- [Cursor CLI Headless](https://cursor.com/docs/cli/headless)
- [Cursor CLI Output Format](https://cursor.com/docs/cli/reference/output-format)
- [Cursor CLI Parameters](https://cursor.com/docs/cli/reference/parameters)
- [Prettifying Cursor CLI Agent's Stream Format](https://tarq.net/posts/cursor-agent-stream-format/)
