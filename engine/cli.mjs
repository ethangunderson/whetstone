#!/usr/bin/env node
// whetstone: run two coding agents against the same task and let them sharpen
// each other's work. The `run` process is the engine; everything else reads a
// run's state.json or writes its control.json, which the engine checks
// between stages.
//
//   whetstone run [options] <task…>      start a run in the foreground
//   whetstone list                       runs, newest first
//   whetstone status <id> [--json]
//   whetstone pause <id> [--now]         hold before the next stage (--now: also stop running lanes; phase 3)
//   whetstone resume <id>                lift a pause, or restart a run whose process died
//   whetstone stop <id>
//   whetstone approve <id> [step]        step mode: allow up to <step> (default: the waiting one)
//   whetstone answer <id> <text…>        answer the open question from a writer
//   whetstone doctor                     config and harness check
//
// run options: --repo <path> (default: this git repo), --slug, --base <ref>,
//   --difficulty easy|medium|hard, --rounds 1|2, --fallback / --no-fallback,
//   --step-mode, --isolation <text>
//
// WHETSTONE_HOME (default ~/.whetstone) holds config.json and runs/<id>/.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, resolveConfig } from "./config.mjs";
import { openStore, writeControl } from "./store.mjs";
import { runWhetstone, slugify, STEPS } from "./run.mjs";
import { gitWorkspace } from "./workspace.mjs";
import { createPiHarness } from "./harness/pi.mjs";

const HOME = process.env.WHETSTONE_HOME || join(homedir(), ".whetstone");
const RUNS = join(HOME, "runs");
const DIFFICULTIES = ["easy", "medium", "hard"];

export function parseRunArgs(argv) {
  const out = {};
  const words = [];
  const value = (i, flag) => {
    if (i >= argv.length) throw new Error(flag + " needs a value");
    return argv[i];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { words.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("--")) { words.push(a); continue; }
    switch (a) {
      case "--repo": out.repo = value(++i, a); break;
      case "--slug": out.slug = value(++i, a); break;
      case "--base": out.baseRef = value(++i, a); break;
      case "--isolation": out.isolation = value(++i, a); break;
      case "--difficulty":
        out.difficulty = value(++i, a);
        if (!DIFFICULTIES.includes(out.difficulty)) throw new Error("--difficulty must be easy, medium or hard");
        break;
      case "--rounds":
        out.maxRounds = Number(value(++i, a));
        if (![1, 2].includes(out.maxRounds)) throw new Error("--rounds must be 1 or 2");
        break;
      case "--fallback": out.fallback = true; break;
      case "--no-fallback": out.fallback = false; break;
      case "--step-mode": out.stepMode = true; break;
      default: throw new Error("unknown option " + a);
    }
  }
  if (!words.length) throw new Error("whetstone run needs a task");
  out.task = words.join(" ");
  return out;
}

const harnesses = () => ({ pi: createPiHarness() });

async function loadConfig() {
  const path = join(HOME, "config.json");
  return resolveConfig(existsSync(path) ? JSON.parse(await readFile(path, "utf8")) : DEFAULT_CONFIG);
}

async function readState(dir) {
  try { return JSON.parse(await readFile(join(dir, "state.json"), "utf8")); } catch { return null; }
}

async function allRuns() {
  if (!existsSync(RUNS)) return [];
  const runs = [];
  for (const id of await readdir(RUNS)) {
    const state = await readState(join(RUNS, id));
    if (state) runs.push({ id, dir: join(RUNS, id), state });
  }
  return runs.sort((a, b) => String(b.state.startedAt || "").localeCompare(String(a.state.startedAt || "")));
}

async function findRun(prefix) {
  if (!prefix) throw new Error("which run? pass a run id (see whetstone list)");
  const runs = await allRuns();
  const exact = runs.find((r) => r.id === prefix);
  if (exact) return exact;
  const matches = runs.filter((r) => r.id.startsWith(prefix));
  if (!matches.length) throw new Error("no run matches " + prefix);
  if (matches.length > 1) throw new Error(prefix + " matches more than one run: " + matches.map((r) => r.id).sort().join(", "));
  return matches[0];
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

// A run whose engine process is gone shows as interrupted, not running.
function shownStatus(state) {
  const active = ["running", "paused", "waiting", "blocked"].includes(state.status);
  return active && !alive(state.pid) ? "interrupted" : state.status || "?";
}

async function gitRoot(dir) {
  const { stdout } = await promisify(execFile)("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return stdout.trim();
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + "-" + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

async function execute(store, args) {
  const config = await loadConfig();
  console.log("Whetstone run " + store.state.id);
  console.log("  state   " + store.dir);
  try {
    const result = await runWhetstone({ args, config, harnesses: harnesses(), store, workspace: gitWorkspace });
    console.log("Done: " + result.finalBranch + " (" + result.finalPath + ")");
    console.log("Report: " + result.report);
    return 0;
  } catch (error) {
    console.error("whetstone: " + error.message);
    return 1;
  }
}

const commands = {
  async run(argv) {
    const args = parseRunArgs(argv);
    args.repo = resolve(args.repo || await gitRoot(process.cwd()));
    args.slug = slugify(args.slug || args.task);
    const id = args.slug + "-" + stamp();
    const store = await openStore(join(RUNS, id));
    await store.update((s) => { s.id = id; });
    return execute(store, args);
  },

  async resume([prefix]) {
    const run = await findRun(prefix);
    if (alive(run.state.pid) && run.state.status !== "done") {
      await writeControl(run.dir, (c) => { c.pause = null; });
      console.log("Resumed " + run.id);
      return 0;
    }
    if (run.state.status === "done") throw new Error(run.id + " already finished");
    if (!run.state.args) throw new Error(run.id + " has no saved args to restart from");
    await writeControl(run.dir, (c) => { c.pause = null; c.stop = false; });
    console.log("Restarting " + run.id + " from its last finished stage");
    return execute(await openStore(run.dir), run.state.args);
  },

  async pause([prefix, ...rest]) {
    const run = await findRun(prefix);
    const now = rest.includes("--now");
    await writeControl(run.dir, (c) => { c.pause = now ? "now" : "after-step"; });
    console.log(now ? "Pausing " + run.id + " now" : "Pausing " + run.id + " after the running stage");
    return 0;
  },

  async stop([prefix]) {
    const run = await findRun(prefix);
    await writeControl(run.dir, (c) => { c.stop = true; });
    console.log("Stopping " + run.id + " at the next stage boundary");
    return 0;
  },

  async approve([prefix, step]) {
    const run = await findRun(prefix);
    const target = Number(step) || (run.state.next && run.state.next.step) || (run.state.step || 1) + 1;
    await writeControl(run.dir, (c) => { c.approved = Math.max(Number(c.approved) || 1, target); });
    console.log("Approved " + run.id + " through step " + target + "/" + STEPS.length);
    return 0;
  },

  async answer([prefix, ...words]) {
    const run = await findRun(prefix);
    const q = run.state.question;
    if (!q) throw new Error(run.id + " has no open question");
    if (!words.length) throw new Error("answer needs text");
    await writeControl(run.dir, (c) => { c.answers = { ...(c.answers || {}), [q.id]: words.join(" ") }; });
    console.log("Answer queued for " + (run.state.lanes?.[q.lane]?.name || q.lane));
    return 0;
  },

  async list() {
    for (const { id, state } of await allRuns()) {
      console.log([id.padEnd(40), shownStatus(state).padEnd(12), ((state.step || 0) + "/" + STEPS.length).padEnd(5), state.latest || ""].join("  ").trimEnd());
    }
    return 0;
  },

  async status([prefix, ...rest]) {
    const run = await findRun(prefix);
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ ...run.state, shownStatus: shownStatus(run.state) }, null, 2));
      return 0;
    }
    const s = run.state;
    console.log(run.id + " · " + shownStatus(s));
    if (s.latest) console.log(s.latest);
    for (const lane of Object.values(s.lanes || {})) {
      console.log("  " + [lane.name.padEnd(8), (lane.role || "").padEnd(10), (lane.status || "").padEnd(8), lane.model || ""].join("  ").trimEnd());
    }
    if (s.question) console.log("\nQuestion from " + (s.lanes?.[s.question.lane]?.name || s.question.lane) + ":\n" + s.question.text);
    if (s.report && s.status === "done") console.log("\nReport: " + s.report);
    return 0;
  },

  async doctor() {
    const config = await loadConfig();
    const available = harnesses();
    for (const lane of config.lanes) {
      const h = available[lane.harness];
      const found = h ? await h.detect() : { installed: false };
      console.log(lane.name.padEnd(8) + " " + lane.harness.padEnd(12) + " " + (h ? (found.installed ? "ok " + (found.version || "") : "not installed") : "no adapter yet"));
    }
    return 0;
  }
};

async function main([command, ...rest]) {
  const handler = commands[command];
  if (!handler) {
    console.error("usage: whetstone run|list|status|pause|resume|stop|approve|answer|doctor (see engine/cli.mjs)");
    return 2;
  }
  try {
    return await handler(rest);
  } catch (error) {
    console.error("whetstone: " + error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
