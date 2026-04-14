import {
  unstable_v2_createSession,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "readline";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import { saveState, loadState, saveOutput, listState } from "./tools/state.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function getUserInput(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

const toolServer = createSdkMcpServer({
  name: "icp-agent-tools",
  tools: [saveState, loadState, saveOutput, listState],
});

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║   ICP & Keyword Research Agent                  ║");
  console.log("║   Type your responses when prompted.            ║");
  console.log("║   Type 'quit' to save and exit.                 ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  const session = unstable_v2_createSession({
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

  // Send initial prompt with system instructions
  await session.send({
    type: "user",
    message: {
      role: "user",
      content: `${SYSTEM_PROMPT}\n\n---\n\nStart the ICP & Keyword Research workflow. First check if there's existing state to resume, then proceed accordingly.`,
    },
    parent_tool_use_id: null,
  });

  // Read and display agent messages, then prompt for input
  const stream = session.stream();

  for await (const message of stream) {
    if (message.type === "assistant") {
      const textBlocks = message.message.content.filter(
        (block: { type: string }) => block.type === "text"
      );
      for (const block of textBlocks) {
        if ("text" in block) {
          console.log("\n" + (block as { text: string }).text);
        }
      }
    }

    if (message.type === "result") {
      // Agent finished this turn — get user input
      const input = await getUserInput("\n> ");

      if (input.toLowerCase() === "quit" || input.toLowerCase() === "exit") {
        console.log("\nSession ended. Your work is saved in state/ and output/.\n");
        session.close();
        break;
      }

      await session.send(input);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error("Agent error:", err);
  process.exit(1);
});
