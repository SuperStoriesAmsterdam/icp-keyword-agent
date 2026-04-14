import {
  unstable_v2_createSession,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKSession } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "../src/system-prompt.js";
import { saveState, loadState, saveOutput, listState } from "../src/tools/state.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};

const toolServer = createSdkMcpServer({
  name: "icp-agent-tools",
  tools: [saveState, loadState, saveOutput, listState],
});

let running = false;
let messages: ChatMessage[] = [];
let sseClients: Set<(data: string) => void> = new Set();
let session: SDKSession | null = null;
let readingStream = false;

// ── Public API ───────────────────────────────────────────────

export function isRunning(): boolean {
  return running;
}

export function getMessages(): ChatMessage[] {
  return messages;
}

export function addSSEClient(send: (data: string) => void): () => void {
  sseClients.add(send);
  return () => sseClients.delete(send);
}

export async function sendMessage(text: string): Promise<void> {
  if (!session || !running) return;

  pushMessage({ role: "user", content: text, timestamp: now() });

  try {
    await session.send(text);
    // After sending, drain any new messages from the stream
    // (the stream reader loop handles this automatically)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Send Error]", msg);
    pushMessage({ role: "system", content: `Send error: ${msg}`, timestamp: now() });
  }
}

export async function start(): Promise<void> {
  if (running) return;

  running = true;
  messages = [];
  broadcast({ type: "started" });

  try {
    session = unstable_v2_createSession({
      model: "claude-sonnet-4-5",
      permissionMode: "bypassPermissions",
      allowedTools: [
        "WebSearch",
        "WebFetch",
        "mcp__icp-agent-tools__save_state",
        "mcp__icp-agent-tools__load_state",
        "mcp__icp-agent-tools__save_output",
        "mcp__icp-agent-tools__list_state",
      ],
    });

    // Start reading the stream in the background
    readStream();

    // Send the initial prompt + system prompt
    await session.send({
      type: "user",
      message: {
        role: "user",
        content: `${SYSTEM_PROMPT}\n\n---\n\nStart the ICP & Keyword Research workflow. First check if there's existing state to resume, then proceed accordingly.`,
      },
      parent_tool_use_id: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Start Error]", msg);
    pushMessage({ role: "system", content: `Start error: ${msg}`, timestamp: now() });
    broadcast({ type: "error", content: msg });
    running = false;
    session = null;
  }
}

export function stop(): void {
  running = false;
  if (session) {
    session.close();
    session = null;
  }
  broadcast({ type: "stopped" });
}

// ── Stream reader ────────────────────────────────────────────

async function readStream(): Promise<void> {
  if (!session || readingStream) return;
  readingStream = true;

  try {
    const stream = session.stream();
    for await (const message of stream) {
      handleMessage(message);
    }
  } catch (err) {
    if (running) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[Stream Error]", msg);
      pushMessage({ role: "system", content: `Stream error: ${msg}`, timestamp: now() });
    }
  } finally {
    readingStream = false;
    // Session stream ended — agent is waiting for input
    if (running) {
      broadcast({ type: "waiting" });
    }
  }
}

// ── Message handling ─────────────────────────────────────────

function handleMessage(message: SDKMessage): void {
  if (message.type === "assistant") {
    const textBlocks = message.message.content.filter(
      (block: { type: string }) => block.type === "text"
    );
    for (const block of textBlocks) {
      if ("text" in block) {
        pushMessage({ role: "assistant", content: block.text as string, timestamp: now() });
      }
    }
  }

  if (message.type === "result") {
    // In v2 sessions, result means the agent finished processing
    // the current turn — NOT that the session is over.
    // The session stays alive for more send() calls.
    broadcast({ type: "waiting" });
  }
}

// ── Helpers ──────────────────────────────────────────────────

function pushMessage(msg: ChatMessage): void {
  messages.push(msg);
  broadcast({ type: "message", message: msg });
}

function broadcast(data: Record<string, unknown>): void {
  const json = JSON.stringify(data);
  for (const send of sseClients) {
    send(json);
  }
}

function now(): string {
  return new Date().toISOString();
}
