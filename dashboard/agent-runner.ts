import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SYSTEM_PROMPT } from "../src/system-prompt.js";
import { saveState, loadState, saveOutput, listState } from "../src/tools/state.js";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};

type PendingMessage = {
  resolve: (msg: SDKUserMessage) => void;
};

const toolServer = createSdkMcpServer({
  name: "icp-agent-tools",
  tools: [saveState, loadState, saveOutput, listState],
});

let running = false;
let messages: ChatMessage[] = [];
let sseClients: Set<(data: string) => void> = new Set();
let pendingInput: PendingMessage | null = null;
let agentQuery: ReturnType<typeof query> | null = null;

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
  if (!running || !pendingInput) return;

  // Add user message to history
  pushMessage({ role: "user", content: text, timestamp: new Date().toISOString() });

  // Resolve the pending promise so the async generator yields
  const pending = pendingInput;
  pendingInput = null;
  pending.resolve({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  });
}

export async function start(): Promise<void> {
  if (running) return;

  running = true;
  messages = [];
  broadcast({ type: "started" });

  // Create the async generator that bridges HTTP input to the agent
  async function* conversationStream(): AsyncGenerator<SDKUserMessage> {
    // First message: kick off the workflow
    yield {
      type: "user",
      message: {
        role: "user",
        content: "Start the ICP & Keyword Research workflow. First check if there's existing state to resume, then proceed accordingly.",
      },
      parent_tool_use_id: null,
    };

    // Loop: wait for browser input
    while (running) {
      const msg = await waitForInput();
      if (!running) return;
      yield msg;
    }
  }

  try {
    agentQuery = query({
      prompt: conversationStream(),
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

    for await (const message of agentQuery) {
      handleAgentMessage(message);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack || "" : "";
    console.error("[Agent Error]", errorMsg, errorStack);
    pushMessage({ role: "system", content: `Agent error: ${errorMsg}`, timestamp: new Date().toISOString() });
    if (errorStack) {
      pushMessage({ role: "system", content: `Details: ${errorStack.slice(0, 500)}`, timestamp: new Date().toISOString() });
    }
    broadcast({ type: "error", content: errorMsg });
  } finally {
    running = false;
    pendingInput = null;
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
  // Unblock any pending input
  if (pendingInput) {
    pendingInput.resolve({
      type: "user",
      message: { role: "user", content: "" },
      parent_tool_use_id: null,
    });
    pendingInput = null;
  }
}

// ── Internal ─────────────────────────────────────────────────

function waitForInput(): Promise<SDKUserMessage> {
  return new Promise((resolve) => {
    pendingInput = { resolve };
    broadcast({ type: "waiting" });
  });
}

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
