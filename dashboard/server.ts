import express from "express";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  start as startAgent,
  stop as stopAgent,
  sendMessage,
  isRunning,
  getMessages,
  addSSEClient,
} from "./agent-runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "../state");
const OUTPUT_DIR = path.resolve(__dirname, "../output");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── API: Status ──────────────────────────────────────────────

app.get("/api/status", async (_req, res) => {
  try {
    const stateFiles = await safeReaddir(STATE_DIR);
    const outputFiles = await safeReaddir(OUTPUT_DIR);

    let phase = "idle";
    let hasState = false;

    if (stateFiles.length > 0) {
      hasState = true;
      if (outputFiles.includes("keyword-map.md")) phase = "complete";
      else if (stateFiles.includes("keywords-draft.json")) phase = "keyword-review";
      else if (stateFiles.includes("icp-draft.json") && stateFiles.includes("icp-feedback.json")) phase = "icp-review";
      else if (stateFiles.includes("icp-draft.json")) phase = "icp-research";
      else if (stateFiles.includes("search-sources.json")) phase = "search-sources";
      else if (stateFiles.includes("product-definition.json")) phase = "product-definition";
      else if (stateFiles.includes("intake.json")) phase = "intake";
    }

    res.json({ phase, hasState, stateFiles, outputFiles, agentRunning: isRunning(), updatedAt: new Date().toISOString() });
  } catch {
    res.status(500).json({ error: "Failed to read status" });
  }
});

// ── API: State + Output files ────────────────────────────────

app.get("/api/state/:filename", async (req, res) => {
  const filePath = path.join(STATE_DIR, path.basename(req.params.filename));
  try {
    const content = await fs.readFile(filePath, "utf-8");
    req.params.filename.endsWith(".json") ? res.json(JSON.parse(content)) : res.type("text/plain").send(content);
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

app.get("/api/output/:filename", async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, path.basename(req.params.filename));
  try {
    res.type("text/plain").send(await fs.readFile(filePath, "utf-8"));
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

// ── API: Agent control ───────────────────────────────────────

app.post("/api/start", (_req, res) => {
  if (isRunning()) return res.status(409).json({ error: "Already running" });
  startAgent();
  res.json({ ok: true });
});

app.post("/api/stop", (_req, res) => {
  stopAgent();
  res.json({ ok: true });
});

app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== "string") return res.status(400).json({ error: "Message required" });
  if (!isRunning()) return res.status(409).json({ error: "Not running" });
  sendMessage(message);
  res.json({ ok: true });
});

app.get("/api/messages", (_req, res) => {
  res.json(getMessages());
});

// ── SSE ──────────────────────────────────────────────────────

app.get("/api/stream", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "connected", running: isRunning(), messages: getMessages() })}\n\n`);
  const remove = addSSEClient((data: string) => { res.write(`data: ${data}\n\n`); });
  req.on("close", remove);
});

// ── Helpers ──────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
