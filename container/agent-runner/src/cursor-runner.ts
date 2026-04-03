/**
 * NanoClaw Cursor Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Drives the Cursor CLI (`agent` binary) instead of the Claude Agent SDK.
 *
 * Input protocol:  Same as index.ts — ContainerInput JSON on stdin
 *                  IPC follow-up messages as JSON files in /workspace/ipc/input/
 *                  Sentinel: /workspace/ipc/input/_close — signals session end
 * Output protocol: Same as index.ts — OUTPUT_START/END markers wrapping ContainerOutput JSON
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[cursor-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// --- IPC functions (copied from index.ts) ---

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// --- MCP config ---

/**
 * Write .cursor/mcp.json to the workspace so the Cursor agent can use
 * nanoclaw IPC tools (send_message, schedule_task, etc.).
 * Best-effort: if Cursor doesn't read this file, the tools are simply unavailable.
 */
function writeMcpConfig(containerInput: ContainerInput): void {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  const config = {
    mcpServers: {
      nanoclaw: {
        command: 'node',
        args: [mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: containerInput.chatJid,
          NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
          NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
        },
      },
    },
  };

  const cursorDir = path.join(process.cwd(), '.cursor');
  try {
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(path.join(cursorDir, 'mcp.json'), JSON.stringify(config, null, 2));
    log(`Wrote MCP config to ${cursorDir}/mcp.json`);
  } catch (err) {
    log(`Failed to write MCP config (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- Stream-json parsing ---

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  result?: string;
  is_error?: boolean;
}

/**
 * Spawn the Cursor agent CLI and parse its stream-json output.
 * Returns the final assistant text and session ID.
 */
function runCursorAgent(
  prompt: string,
  chatId: string | undefined,
  model: string | undefined,
  secrets: Record<string, string>,
): Promise<{ result: string | null; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--trust',
      '--force',
      '--approve-mcps',
      '--workspace', process.cwd(),
    ];
    if (chatId) args.push('--resume', chatId);
    if (model) args.push('--model', model);

    log(`Spawning: agent ${args.map(a => a.length > 100 ? a.slice(0, 100) + '...' : a).join(' ')}`);

    const proc = spawn('agent', args, {
      env: { ...process.env, CURSOR_API_KEY: secrets.CURSOR_API_KEY ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let sessionId: string | undefined;
    let lastAssistantText: string | null = null;
    let lineBuf = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      lineBuf += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, newlineIdx).trim();
        lineBuf = lineBuf.slice(newlineIdx + 1);
        if (!line) continue;

        try {
          const event: StreamEvent = JSON.parse(line);

          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            sessionId = event.session_id;
            log(`Session initialized: ${sessionId}`);
          }

          if (event.type === 'assistant' && event.message?.content) {
            const text = event.message.content
              .filter(c => c.type === 'text' && c.text)
              .map(c => c.text!)
              .join('');
            if (text) {
              lastAssistantText = text;
            }
          }

          if (event.type === 'result') {
            // Prefer the result field from the result event if present
            if (event.result) {
              lastAssistantText = event.result;
            }
            log(`Result event: subtype=${event.subtype}, is_error=${event.is_error}`);
          }
        } catch {
          log(`Non-JSON stdout line: ${line.slice(0, 200)}`);
        }
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      // Process any remaining data in the buffer
      if (lineBuf.trim()) {
        try {
          const event: StreamEvent = JSON.parse(lineBuf.trim());
          if (event.type === 'result' && event.result) {
            lastAssistantText = event.result;
          }
        } catch { /* ignore partial line */ }
      }

      if (code !== 0) {
        log(`Agent exited with code ${code}`);
        if (stderr) log(`Stderr: ${stderr.slice(0, 1000)}`);
        reject(new Error(`Cursor agent exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      resolve({ result: lastAssistantText, sessionId });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn agent: ${err.message}`));
    });
  });
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    // Delete the temp file the entrypoint wrote — it contains secrets
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const secrets = containerInput.secrets || {};

  // Build prompt (same scheduled task prefix as index.ts)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Cursor models tend to dump chain-of-thought into the response.
  // Prepend a system instruction to keep output clean.
  const systemPrefix = `[SYSTEM] Your output is sent directly to users in a group chat via a messaging app. Rules:\n- Only include your final response — never narrate your reasoning, intermediate steps, tool usage, or what you are about to do. If you need to think, use <internal> tags which are hidden from the user.\n- Be warm, friendly, and conversational — you are a member of this group chat, not a formal assistant. Use casual tone, respond naturally to greetings, jokes, and small talk.\n- Keep responses concise and natural — match the energy of the conversation.\n\n`;
  prompt = systemPrefix + prompt;

  const model = process.env.CURSOR_MODEL || undefined;
  let chatId = containerInput.sessionId;

  // Write .cursor/mcp.json so the agent can use nanoclaw IPC tools (best-effort)
  writeMcpConfig(containerInput);

  // Set up IPC
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Drain any pending IPC messages into the initial prompt
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  try {
    while (true) {
      log(`Starting Cursor agent query (session: ${chatId || 'new'}, model: ${model || 'default'})...`);
      let queryResult: { result: string | null; sessionId?: string };
      try {
        queryResult = await runCursorAgent(prompt, chatId, model, secrets);
      } catch (err) {
        // If resume failed (e.g. stale Claude session ID), retry without resume
        if (chatId) {
          log(`Query with --resume failed, retrying without session: ${err instanceof Error ? err.message : String(err)}`);
          chatId = undefined;
          queryResult = await runCursorAgent(prompt, chatId, model, secrets);
        } else {
          throw err;
        }
      }
      const { result, sessionId } = queryResult;

      if (sessionId) {
        chatId = sessionId;
      }

      writeOutput({
        status: 'success',
        result: result,
        newSessionId: chatId,
      });
      log(`Query done. Session: ${chatId || 'none'}, result: ${result ? result.slice(0, 200) : 'null'}`);

      // Check if _close arrived during the query
      if (shouldClose()) {
        log('Close sentinel found after query, exiting');
        break;
      }

      log('Waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: chatId,
      error: errorMessage,
    });
    process.exit(1);
  }
}

main();
