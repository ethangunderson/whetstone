#!/usr/bin/env node
// Spike (throwaway): can a code engine coordinate two live, interactive agent
// lanes over hc? The engine runs in its own hc terminal, starts the lanes as
// its children, receives "done" messages on stdin (hc send), validates result
// files, and lets the lanes critique each other directly with hc send.
//
//   node spike.mjs <repo> <runDir> <space-id>
//
// Everything it observes goes to <runDir>/timeline.jsonl.

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const sh = promisify(execFile);
const [repo, runDir, space] = process.argv.slice(2);
mkdirSync(runDir, { recursive: true });
const me = process.env.HC_TERMINAL_ID;
const LANES = {
  claude: { name: "ws-spike-claude", model: "claude-bridge/claude-sonnet-5-5", thinking: "medium" },
  codex: { name: "ws-spike-codex", model: "openai-codex/gpt-6-luna", thinking: "medium" },
};
const peerOf = { claude: "codex", codex: "claude" };
const ENGINE = "ws-spike-engine";
const PI = process.env.WHETSTONE_PI || "pi";

function log(kind, data = {}) {
  const entry = { at: new Date().toISOString(), kind, ...data };
  appendFileSync(join(runDir, "timeline.jsonl"), `${JSON.stringify(entry)}\n`);
  console.log(entry.at.slice(11, 19), kind, JSON.stringify(data).slice(0, 300));
}

async function hc(...args) {
  try {
    const { stdout } = await sh("hc", args, { maxBuffer: 8 << 20 });
    return stdout.trim();
  } catch (e) {
    log("hc-error", { args: args.slice(0, 3), stderr: String(e.stderr || e.message).slice(0, 400) });
    return null;
  }
}

// ---- Inbox: every line typed into this terminal ------------------------------
const inbox = [];
const waiters = [];
createInterface({ input: process.stdin }).on("line", (line) => {
  log("inbox", { line });
  inbox.push(line);
  waiters.splice(0).forEach((w) => w());
});
function nextMatching(re, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const i = inbox.findIndex((l) => re.test(l));
      if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
      if (Date.now() > deadline) return resolve(null);
      waiters.push(check);
      setTimeout(check, Math.min(5000, deadline - Date.now()));
    };
    check();
  });
}

// ---- Result files -----------------------------------------------------------
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
const valid = {
  draft: (v) =>
    v &&
    typeof v.approach === "string" &&
    Array.isArray(v.choices) &&
    Array.isArray(v.weakSpots) &&
    typeof v.commit === "string",
  debate: (v) =>
    v &&
    Array.isArray(v.peerBetter) &&
    Array.isArray(v.mineBetter) &&
    typeof v.middleRoad === "string" &&
    typeof v.peerSaid === "string" &&
    ["claude", "codex"].includes(v.base),
};

async function collect(stage, lane, timeoutMs) {
  const file = join(runDir, `${stage}-${lane}.json`);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const msg = await nextMatching(new RegExp(`done ${stage} ${lane}\\b`), timeoutMs);
    const v = readJson(file);
    log("collect", {
      stage,
      lane,
      attempt,
      gotMessage: Boolean(msg),
      fileExists: existsSync(file),
      valid: Boolean(valid[stage](v)),
    });
    if (valid[stage](v)) return v;
    const status = await hc("get", LANES[lane].name, "--json");
    log("lane-state", { lane, status: status && JSON.parse(status).status });
    if (attempt === 1) {
      await hc(
        "send",
        LANES[lane].name,
        `[whetstone] ${file} is missing or doesn't match the format I asked for. Rewrite it exactly in that format, then run: hc send ${ENGINE} "done ${stage} ${lane}"`,
      );
      log("asked-to-fix", { stage, lane });
    }
  }
  return null;
}

// ---- Lanes --------------------------------------------------------------------
const TASK =
  "Add a wordCount(text) function to text.mjs that counts words separated by any whitespace (empty or whitespace-only input is 0). Export it and test it.";

function draftTask(lane) {
  const wt = join(runDir, "wt", lane);
  return [
    `[whetstone] You are the ${lane.toUpperCase()} lane in a two-agent implementation. Another agent builds the same task in parallel; don't coordinate yet.`,
    `Task: ${TASK}`,
    `Work only in ${wt} (a git worktree on branch spike/${lane}). Run the tests. Commit.`,
    `When finished, write ${join(runDir, `draft-${lane}.json`)} containing exactly:`,
    `{"approach": "one or two sentences", "choices": ["key design choices"], "weakSpots": ["what you're least sure about"], "commit": "<sha>"}`,
    `Then run this shell command so the coordinator knows: hc send ${ENGINE} "done draft ${lane}"`,
    "Do not start other agents. Messages starting with [whetstone] come from the coordinator; messages starting with [peer] come from the other lane.",
  ].join("\n");
}

function debateTask(lane) {
  const peer = peerOf[lane];
  return [
    `[whetstone] Both drafts are done. Debate step.`,
    `The ${peer.toUpperCase()} lane's summary is in ${join(runDir, `draft-${peer}.json`)}; its code is on branch spike/${peer} (worktree ${join(runDir, "wt", peer)}). Read its diff.`,
    `1. Send your critique of its version DIRECTLY to it, in under 1200 characters, with: hc send ${LANES[peer].name} "[peer] <your critique>"`,
    `2. Its critique of your version will arrive as a message starting with [peer]. Don't reply to it.`,
    `3. Once you have its critique, write ${join(runDir, `debate-${lane}.json`)} containing exactly:`,
    `{"peerBetter": ["where its version is better"], "mineBetter": ["where yours is better"], "middleRoad": "one or two sentences", "peerSaid": "one sentence summary of its critique of you", "base": "claude" | "codex"}`,
    `4. Then run: hc send ${ENGINE} "done debate ${lane}"`,
    "Don't edit any code in this step.",
  ].join("\n");
}

async function main() {
  log("engine-start", { me, repo, runDir });
  for (const lane of Object.keys(LANES)) {
    await sh("git", ["-C", repo, "worktree", "add", "-q", "-b", `spike/${lane}`, join(runDir, "wt", lane), "HEAD"]);
  }
  for (const [lane, l] of Object.entries(LANES)) {
    const out = await hc(
      "run",
      "--bg",
      "--json",
      "--name",
      l.name,
      "--cwd",
      join(runDir, "wt", lane),
      "--label",
      `herdr.space=${space}`,
      "--label",
      `whetstone=spike`,
      // The core's PATH is minimal: pass ours so pi, node, npm and hc resolve inside the lane.
      "--",
      "/usr/bin/env",
      `PATH=${process.env.PATH}`,
      PI,
      "--model",
      l.model,
      "--thinking",
      l.thinking,
      "--tools",
      "read,grep,find,ls,bash,edit,write",
      "--no-skills",
      draftTask(lane),
    );
    log("lane-started", { lane, out: out && JSON.parse(out) });
  }

  const drafts = {};
  await Promise.all(
    Object.keys(LANES).map(async (lane) => {
      drafts[lane] = await collect("draft", lane, 10 * 60_000);
    }),
  );
  log("drafts", { ok: Object.fromEntries(Object.entries(drafts).map(([k, v]) => [k, Boolean(v)])) });
  if (!drafts.claude || !drafts.codex) return log("abort", { why: "missing drafts" });

  for (const lane of Object.keys(LANES)) {
    const out = await hc("send", "--json", LANES[lane].name, debateTask(lane));
    log("debate-sent", { lane, out });
  }
  const debates = {};
  await Promise.all(
    Object.keys(LANES).map(async (lane) => {
      debates[lane] = await collect("debate", lane, 10 * 60_000);
    }),
  );
  log("debates", { debates });

  for (const lane of Object.keys(LANES)) {
    const got = await hc("get", LANES[lane].name, "--json");
    log("final-lane-state", { lane, state: got && JSON.parse(got) });
  }
  log("engine-done");
}

main().catch((e) => log("engine-crash", { error: String(e.stack || e) }));
