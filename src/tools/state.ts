import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import * as fs from "fs/promises";
import * as path from "path";

const STATE_DIR = path.resolve("state");
const OUTPUT_DIR = path.resolve("output");

async function ensureDirs() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

export const saveState = tool(
  "save_state",
  "Save workflow state to a JSON file. Use this to persist intake data, ICP drafts, keyword maps, feedback, and workflow progress.",
  {
    filename: z.string().describe("Filename without path, e.g. 'intake.json', 'icp-draft.json', 'workflow.json'"),
    data: z.string().describe("JSON string of the data to save"),
  },
  async ({ filename, data }) => {
    await ensureDirs();
    const filePath = path.join(STATE_DIR, filename);
    await fs.writeFile(filePath, data, "utf-8");
    return {
      content: [{ type: "text" as const, text: `Saved state to ${filePath}` }],
    };
  }
);

export const loadState = tool(
  "load_state",
  "Load workflow state from a JSON file. Use this to read previously saved intake data, ICP drafts, keyword maps, or feedback.",
  {
    filename: z.string().describe("Filename without path, e.g. 'intake.json', 'icp-draft.json'"),
  },
  async ({ filename }) => {
    const filePath = path.join(STATE_DIR, filename);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return {
        content: [{ type: "text" as const, text: data }],
      };
    } catch {
      return {
        content: [{ type: "text" as const, text: `No state file found at ${filePath}` }],
      };
    }
  }
);

export const saveOutput = tool(
  "save_output",
  "Save a final deliverable file (markdown) to the output directory. Use this for the final ICP profile and keyword map documents.",
  {
    filename: z.string().describe("Filename, e.g. 'icp-profile.md', 'keyword-map.md'"),
    content: z.string().describe("Markdown content to save"),
  },
  async ({ filename, content }) => {
    await ensureDirs();
    const filePath = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(filePath, content, "utf-8");
    return {
      content: [{ type: "text" as const, text: `Saved output to ${filePath}` }],
    };
  }
);

export const listState = tool(
  "list_state",
  "List all saved state files. Use this to check what data has been saved so far.",
  {},
  async () => {
    await ensureDirs();
    const files = await fs.readdir(STATE_DIR);
    return {
      content: [{ type: "text" as const, text: files.length ? files.join("\n") : "No state files yet" }],
    };
  }
);
