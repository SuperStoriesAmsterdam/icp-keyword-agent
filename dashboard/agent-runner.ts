import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage, SDKMessage, Query } from "@anthropic-ai/claude-agent-sdk";
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
let agentQuery: Query | null = null;

// Queue for user messages — the input stream reads from this
let messageQueue: SDKUserMessage[] = [];
let messageWaiter: (() => void) | null = null;

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

export function sendMessage(text: string): void {
  if (!running) return;

  // Add user message to history
  pushMessage({ role: "user", content: text, timestamp: new Date().toISOString() });

  // Push to queue — the input stream will pick it up
  messageQueue.push({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });

  // Wake up the input stream if it's waiting
  if (messageWaiter) {
    const wake = messageWaiter;
    messageWaiter = null;
    wake();
  }
}

export async function start(): Promise<void> {
  if (running) return;

  running = true;
  messages = [];
  messageQueue = [];
  messageWaiter = null;
  broadcast({ type: "started" });

  // Async iterable that the SDK consumes for user input.
  // It never completes on its own — it yields messages from the queue
  // and waits indefinitely when the queue is empty.
  async function* inputStream(): AsyncGenerator<SDKUserMessage> {
    while (running) {
      // Wait until there's a message in the queue
      while (messageQueue.length === 0 && running) {
        broadcast({ type: "waiting" });
        await new Promise<void>((resolve) => {
          messageWaiter = resolve;
        });
      }

      if (!running) return;

      // Drain the queue
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      }
    }
  }

  try {
    // Start the query with the initial prompt
    agentQuery = query({
      prompt: "Start the ICP & Keyword Research workflow. First check if there's existing state to resume, then proceed accordingly.",
      options: {
        systemPrompt: SYSTEM_PROMPT,
        model: "claude-sonnet-4-5",
        maxTurns: 200,
        permissionMode: "bypassPermissions",
        allowedTools: [
          "WebSearch",
          "WebFetch",
          "mcp__icp-agent-tools__save_state",
          "mcp__icp-agent-tools__load_state",
          "mcp__icp-agent-tools__save_output",
          "mcp__icp-agent-tools__list_state",
        ],
        mcpServers: { "icp-agent-tools": toolServer },
      },
    });

    // Start streaming input in the background — this keeps the session alive
    // and feeds user messages as they come in from the browser
    agentQuery.streamInput(inputStream());

    // Read agent output
    for await (const message of agentQuery) {
      handleAgentMessage(message);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[Agent Error]", errorMsg);
    pushMessage({ role: "system", content: `Agent error: ${errorMsg}`, timestamp: new Date().toISOString() });
    broadcast({ type: "error", content: errorMsg });
  } finally {
    running = false;
    messageWaiter = null;
    messageQueue = [];
    agentQuery = null;
    broadcast({ type: "stopped" });
  }
}

export function stop(): void {
  running = false;
  if (agentQuery) {
    agentQuery.close();
    agentQuery = null;
  }
  // Wake up any waiting input stream so it can exit
  if (messageWaiter) {
    const wake = messageWaiter;
    messageWaiter = null;
    wake();
  }
}

// ── Internal ─────────────────────────────────────────────────

function handleAgentMessage(message: SDKMessage): void {
  if (message.type === "assistant") {
    const textBlocks = message.message.content.filter(
      (block: { type: string }) => block.type === "text"
    );
    for (const block of textBlocks) {
      if ("text" in block) {
        const text = block.text as string;
        pushMessage({ role: "assistant", content: text, timestamp: new Date().toISOString() });
      }
    }
  }

  if (message.type === "result") {
    const subtype = "subtype" in message ? message.subtype : "unknown";
    if (subtype === "success") {
      const cost = "total_cost_usd" in message ? (message as any).total_cost_usd : 0;
      pushMessage({
        role: "system",
        content: `Session complete — cost: $${cost.toFixed(4)}`,
        timestamp: new Date().toISOString(),
      });
    }
    broadcast({ type: "complete" });
  }
}

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
