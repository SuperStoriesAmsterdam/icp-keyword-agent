import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "readline";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { saveState, loadState, saveOutput, listState } from "./tools/state.js";

// ── Terminal input ───────────────────────────────────────────

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getUserInput(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer);
    });
  });
}

// ── MCP server with our custom tools ─────────────────────────

const toolServer = createSdkMcpServer({
  name: "icp-agent-tools",
  tools: [saveState, loadState, saveOutput, listState],
});

// ── Conversation loop ────────────────────────────────────────

async function* conversationStream(): AsyncGenerator<SDKUserMessage> {
  // First message: kick off the workflow
  yield {
    type: "user",
    message: {
      role: "user",
      content:
        "Start the ICP & Keyword Research workflow. First check if there's existing state to resume, then proceed accordingly.",
    },
    parent_tool_use_id: null,
  };

  // Loop: wait for agent to finish a turn, then get human input
  while (true) {
    const input = await getUserInput("\n> ");

    if (input.toLowerCase() === "quit" || input.toLowerCase() === "exit") {
      console.log("\nSession ended. Your work is saved in state/ and output/.\n");
      process.exit(0);
    }

    yield {
      type: "user",
      message: {
        role: "user",
        content: input,
      },
      parent_tool_use_id: null,
    };
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   ICP & Keyword Research Agent                  ║");
  console.log("║   Type your responses when prompted.            ║");
  console.log("║   Type 'quit' to save and exit.                 ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const conversation = query({
    prompt: conversationStream(),
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-sonnet-4-5",
      maxTurns: 200,
      permissionMode: "acceptEdits",
      allowedTools: [
        "WebSearch",
        "save_state",
        "load_state",
        "save_output",
        "list_state",
      ],
      mcpServers: { "icp-agent-tools": toolServer },
    },
  });

  // Stream agent messages to the terminal
  for await (const message of conversation) {
    if (message.type === "assistant") {
      // Extract text from the assistant message
      const textBlocks = message.message.content.filter(
        (block: { type: string }) => block.type === "text"
      );
      for (const block of textBlocks) {
        if ("text" in block) {
          console.log("\n" + block.text);
        }
      }
    }

    if (message.type === "result") {
      if (message.subtype === "success") {
        console.log(`\n[Session complete — cost: $${message.total_cost_usd.toFixed(4)}]`);
      } else {
        console.log("\n[Session ended with error]");
        if ("error" in message) {
          console.error(message.error);
        }
      }
      break;
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
