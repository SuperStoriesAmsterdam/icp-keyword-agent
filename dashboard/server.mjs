import express from "express";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(__dirname, "../state");
const OUTPUT_DIR = path.resolve(__dirname, "../output");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", async (_req, res) => {
  try {
    const stateFiles = await safeReaddir(STATE_DIR);
    const outputFiles = await safeReaddir(OUTPUT_DIR);
    let phase = "idle";
    let hasState = false;
    if (stateFiles.length > 0) {
      hasState = true;
      try {
        const workflow = await fs.readFile(path.join(STATE_DIR, "workflow.json"), "utf-8");
        phase = JSON.parse(workflow).phase || "unknown";
      } catch {
        if (outputFiles.includes("keyword-map.md")) phase = "complete";
        else if (stateFiles.includes("keywords-draft.json")) phase = "keyword-review";
        else if (stateFiles.includes("keywords-feedback.json")) phase = "keyword-review";
        else if (stateFiles.includes("icp-draft.json") && stateFiles.includes("icp-feedback.json")) phase = "icp-review";
        else if (stateFiles.includes("icp-draft.json")) phase = "icp-research";
        else if (stateFiles.includes("search-sources.json")) phase = "search-sources";
        else if (stateFiles.includes("product-definition.json")) phase = "product-definition";
        else if (stateFiles.includes("intake.json")) phase = "intake";
      }
    }
    res.json({ phase, hasState, stateFiles, outputFiles, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: "Failed to read status" });
  }
});

app.get("/api/state/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(STATE_DIR, filename);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    if (filename.endsWith(".json")) res.json(JSON.parse(content));
    else res.type("text/plain").send(content);
  } catch {
    res.status(404).json({ error: "State file not found" });
  }
});

app.get("/api/output/:filename", async (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, filename);
  try {
    const content = await fs.readFile(filePath, "utf-8");
    res.type("text/plain").send(content);
  } catch {
    res.status(404).json({ error: "Output file not found" });
  }
});

async function safeReaddir(dir) {
  try { return await fs.readdir(dir); } catch { return []; }
}

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
