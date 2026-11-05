// pi as a lane harness. One `pi -p --mode json` process per call.
//
// Sessions: pi looks up `--session-id` per project (cwd), and a writer moves
// from its lane worktree to the final one. So the first call creates the
// session in the run's own session folder, and later calls pass the session
// file itself with `--session`, which works from any cwd. A resumed session's
// tools keep running in the session's first cwd; stage prompts name the
// directory to work in.
//
// pi exits 0 even when the model call fails; failure shows up as an
// assistant message with stopReason "error".
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

const WRITE_TOOLS = "read,grep,find,ls,bash,edit,write";
const READ_TOOLS = "read,grep,find,ls,bash";

export function piArgs(req, { sessionDir, sessionFile }) {
  const argv = ["-p", "--mode", "json", "--model", req.model];
  if (req.effort) argv.push("--thinking", req.effort);
  argv.push("--tools", req.readOnly ? READ_TOOLS : WRITE_TOOLS, "--no-skills");
  if (req.system) argv.push("--append-system-prompt", req.system);
  if (req.resume) argv.push("--session", sessionFile);
  else argv.push("--session-dir", sessionDir, "--session-id", req.session);
  argv.push("--", req.prompt);
  return argv;
}

export function parsePiOutput(stdout) {
  let sessionId = null;
  let last = null;
  let aborted = false;
  for (const raw of String(stdout).split("\n")) {
    if (!raw.trim()) continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === "session" && event.id) sessionId = event.id;
    if (event.type === "message_end" && event.message && event.message.role === "assistant") last = event.message;
    if (event.type === "agent_settled" && event.aborted) aborted = true;
  }
  if (!last) return { ok: false, text: "", sessionId, error: "pi returned no assistant reply" };
  const text = (last.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  if (last.stopReason === "error") return { ok: false, text, sessionId, error: last.errorMessage || "pi reported an error" };
  if (aborted || last.stopReason === "aborted") return { ok: false, text, sessionId, error: "pi run was aborted" };
  return { ok: true, text, sessionId, error: null };
}

async function findSessionFile(sessionDir, session) {
  let names = [];
  try { names = await readdir(sessionDir); } catch { /* no folder yet */ }
  const match = names.filter((n) => n.endsWith("_" + session + ".jsonl")).sort().pop();
  return match ? join(sessionDir, match) : null;
}

export function createPiHarness({ bin = "pi" } = {}) {
  return {
    name: "pi",

    detect() {
      return new Promise((resolve) => {
        const child = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (d) => { out += d; });
        child.on("error", () => resolve({ installed: false }));
        child.on("close", (code) => resolve({ installed: code === 0, version: out.trim() }));
      });
    },

    async run(req) {
      let sessionFile = null;
      if (req.resume) {
        sessionFile = await findSessionFile(req.sessionDir, req.session);
        if (!sessionFile) return { ok: false, text: "", sessionId: req.session, error: "no pi session file for " + req.session + " in " + req.sessionDir };
      } else {
        await mkdir(req.sessionDir, { recursive: true });
      }
      let log = null;
      if (req.logFile) {
        await mkdir(dirname(req.logFile), { recursive: true });
        log = createWriteStream(req.logFile, { flags: "a" });
      }
      const argv = piArgs(req, { sessionDir: req.sessionDir, sessionFile });
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          if (log) log.end();
          resolve(result);
        };
        const child = spawn(bin, argv, { cwd: req.cwd, stdio: ["ignore", "pipe", "pipe"], signal: req.signal });
        child.stdout.on("data", (d) => { stdout += d; if (log) log.write(d); });
        child.stderr.on("data", (d) => { stderr += d; });
        child.on("error", (error) => finish({ ok: false, text: "", sessionId: req.session, error: "could not start pi (" + bin + "): " + error.message }));
        child.on("close", (code) => {
          const parsed = parsePiOutput(stdout);
          const sessionId = parsed.sessionId || req.session;
          if (code !== 0) {
            finish({ ok: false, text: parsed.text, sessionId, error: "pi exited with code " + code + ": " + stderr.trim().slice(-1000) });
          } else {
            finish({ ...parsed, sessionId });
          }
        });
      });
    }
  };
}
