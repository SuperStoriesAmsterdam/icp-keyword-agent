import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";
import * as path from "path";
import { SYSTEM_PROMPT } from "../src/system-prompt.js";

const STATE_DIR = path.resolve("state");
const OUTPUT_DIR = path.resolve("output");

// ── Types ────────────────────────────────────────────────────

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
};

type ApiMessage = {
  role: "user" | "assistant";
  content: string | Anthropic.ContentBlockParam[];
};

// ── State ────────────────────────────────────────────────────

let running = false;
let messages: ChatMessage[] = [];
let conversationHistory: ApiMessage[] = [];
let sseClients: Set<(data: string) => void> = new Set();
let waitingForUser = false;
let pendingResolve: ((text: string) => void) | null = null;

const client = new Anthropic();

// ── Tool Definitions ─────────────────────────────────────────

const tools: Anthropic.Tool[] = [
  {
    name: "save_state",
    description:
      "Save workflow state to a JSON file. Use for intake data, ICP drafts, keyword maps, feedback, workflow progress.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "e.g. 'intake.json', 'icp-draft.json', 'workflow.json'",
        },
        data: {
          type: "string",
          description: "JSON string of the data to save",
        },
      },
      required: ["filename", "data"],
    },
  },
  {
    name: "load_state",
    description:
      "Load workflow state from a JSON file. Read previously saved intake data, ICP drafts, keyword maps, or feedback.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "e.g. 'intake.json', 'icp-draft.json'",
        },
      },
      required: ["filename"],
    },
  },
  {
    name: "save_output",
    description:
      "Save a final deliverable file (markdown) to the output directory. For ICP profile and keyword map documents.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: {
          type: "string",
          description: "e.g. 'icp-profile.md', 'keyword-map.md'",
        },
        content: {
          type: "string",
          description: "Markdown content to save",
        },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "list_state",
    description: "List all saved state files to check what data has been saved so far.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ── Tool Execution ───────────────────────────────────────────

async function executeTool(
  name: string,
  input: Record<string, string>
): Promise<string> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  switch (name) {
    case "save_state": {
      const filePath = path.join(STATE_DIR, path.basename(input.filename));
      await fs.writeFile(filePath, input.data, "utf-8");
      return `Saved to ${filePath}`;
    }
    case "load_state": {
      const filePath = path.join(STATE_DIR, path.basename(input.filename));
      try {
        return await fs.readFile(filePath, "utf-8");
      } catch {
        return "File not found";
      }
    }
    case "save_output": {
      const filePath = path.join(OUTPUT_DIR, path.basename(input.filename));
      await fs.writeFile(filePath, input.content, "utf-8");
      return `Saved to ${filePath}`;
    }
    case "list_state": {
      try {
        const files = await fs.readdir(STATE_DIR);
        return files.length ? files.join("\n") : "No state files yet";
      } catch {
        return "No state files yet";
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

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
  if (!running || !pendingResolve) return;

  pushMessage({ role: "user", content: text, timestamp: now() });

  const resolve = pendingResolve;
  pendingResolve = null;
  waitingForUser = false;
  broadcast({ type: "thinking" });
  resolve(text);
}

export async function start(): Promise<void> {
  if (running) return;

  running = true;
  messages = [];
  conversationHistory = [];
  waitingForUser = false;
  pendingResolve = null;
  broadcast({ type: "started" });

  try {
    // Initial prompt
    await processUserMessage(
      "Start the ICP & Keyword Research workflow. Check if there's existing state to resume, then proceed."
    );

    // Conversation loop — runs until stopped
    while (running) {
      const userText = await waitForUserInput();
      if (!running) break;
      await processUserMessage(userText);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Agent Error]", msg);
    pushMessage({ role: "system", content: `Error: ${msg}`, timestamp: now() });
    broadcast({ type: "error", content: msg });
  } finally {
    running = false;
    pendingResolve = null;
    broadcast({ type: "stopped" });
  }
}

export function stop(): void {
  running = false;
  if (pendingResolve) {
    pendingResolve("");
    pendingResolve = null;
  }
  broadcast({ type: "stopped" });
}

// ── Core: Process a user message ─────────────────────────────

async function processUserMessage(userText: string): Promise<void> {
  // Add to conversation history
  conversationHistory.push({ role: "user", content: userText });

  // Call Claude
  let response = await client.messages.create({
    model: "claude-sonnet-4-5-latest",
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    tools,
    messages: conversationHistory,
  });

  // Handle tool use loop — agent may call multiple tools before responding
  while (response.stop_reason === "tool_use") {
    const assistantContent = response.content;

    // Show any text blocks before tool use
    for (const block of assistantContent) {
      if (block.type === "text" && block.text.trim()) {
        pushMessage({ role: "assistant", content: block.text, timestamp: now() });
      }
    }

    // Add assistant message to history
    conversationHistory.push({ role: "assistant", content: assistantContent as any });

    // Execute all tool calls
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        console.log(`[Tool] ${block.name}`, JSON.stringify(block.input).slice(0, 100));
        const result = await executeTool(block.name, block.input as Record<string, string>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    // Add tool results to history
    conversationHistory.push({ role: "user", content: toolResults as any });

    // Call Claude again with tool results
    response = await client.messages.create({
      model: "claude-sonnet-4-5-latest",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools,
      messages: conversationHistory,
    });
  }

  // Final response — extract text
  const assistantContent = response.content;
  conversationHistory.push({ role: "assistant", content: assistantContent as any });

  for (const block of assistantContent) {
    if (block.type === "text" && block.text.trim()) {
      pushMessage({ role: "assistant", content: block.text, timestamp: now() });
    }
  }
}

// ── Wait for user ────────────────────────────────────────────

function waitForUserInput(): Promise<string> {
  return new Promise((resolve) => {
    waitingForUser = true;
    pendingResolve = resolve;
    broadcast({ type: "waiting" });
  });
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
