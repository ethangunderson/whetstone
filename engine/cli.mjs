#!/usr/bin/env node
// whetstone: run two coding agents against the same task and let them sharpen
// each other's work. The `run` process is the engine; everything else reads a
// run's state.json or writes its control.json, which the engine checks
// between stages.
//
//   whetstone run [options] <task…>      start a run in the foreground
//   whetstone run [options] --issue <key|url> [--notes <text>]
//                                        the task is a Linear issue (read through herdr-linear)
//   whetstone issue <key|url> [--json]   print that issue without starting anything
//   whetstone list                       runs, newest first
//   whetstone status <id> [--json]
//   whetstone pause <id> [--now]         hold before the next stage (--now: also stop running lanes; phase 3)
//   whetstone resume <id>                lift a pause, or restart a run whose process died
//   whetstone stop <id>
//   whetstone approve <id> [step]        step mode: allow up to <step> (default: the waiting one)
//   whetstone answer <id> <text…>        answer the open question from a writer
//   whetstone check [--repo <path>] [--base <ref>] [--json]
//                                        can a run start here? (repo, base ref, active runs, config, harnesses, tier models)
//   whetstone doctor                     config and harness check
//
// run options: --repo <path> (default: this git repo), --slug, --base <ref>,
//   --difficulty easy|medium|hard, --rounds 1|2, --fallback / --no-fallback,
//   --step-mode, --isolation <text>, --notes <text> (with --issue: added to the task)
//
// WHETSTONE_HOME (default ~/.whetstone) holds config.json and runs/<id>/.
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync } from "node:fs";
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
import { createHerdrHarness, terminalName } from "./harness/herdr.mjs";
import { createInbox } from "./inbox.mjs";
import { createLinearReader, issueSlug, issueTask } from "./linear.mjs";
import { harnessChecks, preflight } from "./check.mjs";

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
      case "--issue": out.issue = value(++i, a); break;
      case "--notes": out.notes = value(++i, a); break;
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
  if (out.issue && words.length) throw new Error("pass either task text or --issue, not both (add instructions with --notes)");
  if (out.notes !== undefined && !out.issue) throw new Error("--notes requires --issue");
  if (out.issue) return out;
  if (!words.length) throw new Error("whetstone run needs a task");
  out.task = words.join(" ");
  return out;
}

const HC = process.env.WHETSTONE_HC || "hc";
const HERDR_APP = process.env.WHETSTONE_HERDR_APP || "herdr-app";
const CLI_PATH = fileURLToPath(import.meta.url);

async function hc(args) {
  const { stdout } = await promisify(execFile)(HC, args, { maxBuffer: 8 << 20 });
  return stdout.trim();
}

// The first executable named `name` on PATH, as an absolute path: lanes start
// under Herdr Core, whose own PATH is minimal.
function which(name) {
  for (const dir of String(process.env.PATH || "").split(":")) {
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch { /* next */ }
  }
  return name;
}

// Lanes get no herdr.* labels: started from the engine's terminal, they are
// its sub-agents and show nested under it, not as tabs of their own.
export function laneLabels(state) {
  return ["whetstone=" + state.id];
}

const usesHerdr = (config) => config.lanes.some((l) => l.harness === "herdr");

// In the engine's own terminal (see launchEngine), its input carries the lanes' messages.
function harnesses(state) {
  const all = { pi: createPiHarness() };
  if (process.env.WHETSTONE_ENGINE && state) {
    all.herdr = createHerdrHarness({
      hc,
      inbox: createInbox({ stream: process.stdin }),
      engine: process.env.HC_TERMINAL_ID,
      path: process.env.PATH,
      bins: { pi: which("pi") },
      labels: laneLabels(state)
    });
  }
  return all;
}

// Live lanes report to the engine with `hc send`, so the engine runs in a
// Herdr terminal of its own, not the caller's shell, which may close. With a
// Herdr window it gets one named tab in the caller's space; without one, a
// hidden hc terminal.
async function launchEngine(store, args) {
  let space = null;
  if (process.env.HC_TERMINAL_ID) {
    try { space = JSON.parse(await hc(["get", "--json", process.env.HC_TERMINAL_ID])).labels?.["herdr.space"] ?? null; } catch { /* not in Herdr */ }
  }
  const id = store.state.id;
  const argv = ["/usr/bin/env", "PATH=" + process.env.PATH, "WHETSTONE_HOME=" + HOME, "WHETSTONE_ENGINE=" + id,
    process.execPath, CLI_PATH, "__engine", id];
  let terminal;
  try {
    const spec = { name: "Whetstone · " + args.slug, folder: args.repo, argv, ...(space ? { space } : {}) };
    const { stdout } = await promisify(execFile)(HERDR_APP, ["do", "tab.new", JSON.stringify(spec)]);
    terminal = JSON.parse(stdout).terminal;
  } catch {
    const out = JSON.parse(await hc(["run", "--bg", "--json", "--name", terminalName(id, "engine"), "--cwd", args.repo, "--no-parent",
      "--label", "whetstone=" + id, "--", ...argv]));
    terminal = out.address;
  }
  await store.update((s) => { s.args = args; s.engineTerminal = terminal; s.space = space; });
  console.log("Whetstone run " + id);
  console.log("  engine  " + terminal + (space ? " (tab \"Whetstone · " + args.slug + "\")" : ""));
  console.log("  state   " + store.dir);
  console.log("Follow it in Herdr's Whetstone panel, or: whetstone status " + id);
  return 0;
}

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

async function gitCommit(root, ref) {
  const { stdout } = await promisify(execFile)("git", ["-C", root, "rev-parse", "--verify", "--quiet", "--short", ref + "^{commit}"]);
  return stdout.trim();
}

// Runs record the repo as given; git answers with symlinks resolved (/var → /private/var).
function realPath(path) {
  try { return realpathSync(path); } catch { return path; }
}

function harnessAdapters() {
  return { pi: createPiHarness(), herdr: { detect: async () => { try { await hc(["ls", "--json"]); return { installed: true }; } catch { return { installed: false }; } } } };
}

const checkLine = (c) => [(c.ok ? "ok" : "FAIL").padEnd(4), c.what.padEnd(16), c.detail].join("  ").trimEnd();

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate()) + "-" + p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds());
}

async function execute(store, args) {
  const config = await loadConfig();
  console.log("Whetstone run " + store.state.id);
  console.log("  state   " + store.dir);
  try {
    const result = await runWhetstone({ args, config, harnesses: harnesses(store.state), store, workspace: gitWorkspace });
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
    // Read before anything starts, so a bad key or a signed-out Linear fails here.
    if (args.issue) {
      const issue = await createLinearReader().read(args.issue);
      args.issue = { key: issue.key, title: issue.title, url: issue.url };
      args.task = issueTask(issue, args.notes);
      args.slug ??= issueSlug(issue);
    }
    args.slug = slugify(args.slug || args.task);
    const id = args.slug + "-" + stamp();
    const store = await openStore(join(RUNS, id));
    // state.issue now, not only when the engine starts, so the pane can link it right away.
    await store.update((s) => { s.id = id; s.args = args; s.issue = args.issue ?? null; });
    if (usesHerdr(await loadConfig())) return launchEngine(store, args);
    return execute(store, args);
  },

  // For the start form's preview: the issue a run would get, and its slug.
  async issue([ref, ...rest]) {
    if (!ref || ref.startsWith("--") || rest.some((a) => a !== "--json")) throw new Error("usage: whetstone issue <key|url> [--json]");
    const issue = await createLinearReader().read(ref);
    if (rest.includes("--json")) {
      console.log(JSON.stringify({ ...issue, slug: issueSlug(issue) }, null, 2));
      return 0;
    }
    console.log(issue.key + " · " + issue.title);
    console.log(issue.url);
    if (issue.description) console.log("\n" + issue.description);
    return 0;
  },

  // Run by launchEngine inside the engine's own Herdr terminal.
  async __engine([id]) {
    const run = await findRun(id);
    const code = await execute(await openStore(run.dir), run.state.args);
    process.exit(code);
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
    const store = await openStore(run.dir);
    if (usesHerdr(await loadConfig())) return launchEngine(store, run.state.args);
    return execute(store, run.state.args);
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

  // For the start form. A failed check is still an answer: exit 0, ok:false.
  async check(argv) {
    const usage = "usage: whetstone check [--repo <path>] [--base <ref>] [--json]";
    const opts = { json: false };
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--json") opts.json = true;
      else if ((a === "--repo" || a === "--base") && i + 1 < argv.length) opts[a.slice(2)] = argv[++i];
      else throw new Error(usage);
    }
    const repo = resolve(opts.repo || process.cwd());
    const result = await preflight({
      repo,
      baseRef: opts.base,
      git: { root: async (dir) => realPath(await gitRoot(dir)), commit: gitCommit },
      runs: async () => (await allRuns()).map(({ id, state }) => ({ id, repo: realPath(state.repo || state.args?.repo || ""), status: shownStatus(state) })),
      loadConfig,
      adapters: harnessAdapters()
    });
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else result.checks.forEach((c) => console.log(checkLine(c)));
    return 0;
  },

  async doctor() {
    const config = await loadConfig();
    for (const c of await harnessChecks(config.lanes, harnessAdapters())) console.log(checkLine(c));
    return 0;
  }
};

async function main([command, ...rest]) {
  const handler = commands[command];
  if (!handler) {
    console.error("usage: whetstone run|issue|list|status|pause|resume|stop|approve|answer|check|doctor (see engine/cli.mjs)");
    return 2;
  }
  try {
    return await handler(rest);
  } catch (error) {
    console.error("whetstone: " + error.message);
    return 1;
  }
}

// Run as a program, including through npm link's symlink; not when imported by tests.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}