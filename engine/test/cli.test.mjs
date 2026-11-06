import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseRunArgs } from "../cli.mjs";
import { slugify } from "../run.mjs";

const run = promisify(execFile);
const CLI = new URL("../cli.mjs", import.meta.url).pathname;

async function home() {
  return mkdtemp(join(tmpdir(), "whetstone-home-"));
}

async function fakeRun(dir, id, state) {
  const runDir = join(dir, "runs", id);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify({ id, pid: process.pid, ...state }));
  return runDir;
}

function cli(dir, ...args) {
  return run("node", [CLI, ...args], { env: { ...process.env, WHETSTONE_HOME: dir } });
}

test("parseRunArgs reads flags and the task text", () => {
  assert.deepEqual(
    parseRunArgs(["--repo", "/r/app", "--difficulty", "easy", "--rounds", "1", "--step-mode", "--base", "main", "Add", "CSV", "export"]),
    { repo: "/r/app", difficulty: "easy", maxRounds: 1, stepMode: true, baseRef: "main", task: "Add CSV export" }
  );
  assert.deepEqual(parseRunArgs(["--no-fallback", "--slug", "csv", "--isolation", "shared db", "x"]), { fallback: false, slug: "csv", isolation: "shared db", task: "x" });
  assert.deepEqual(parseRunArgs(["--fallback", "x"]), { fallback: true, task: "x" });
  assert.throws(() => parseRunArgs(["--difficulty", "extreme", "x"]), /difficulty/);
  assert.throws(() => parseRunArgs(["--bogus", "x"]), /unknown option --bogus/);
  assert.throws(() => parseRunArgs([]), /task/);
});

test("slugify matches the engine's branch naming", () => {
  assert.equal(slugify("Add CSV export to the /reports page!"), "add-csv-export-to-the-reports-page");
  assert.equal(slugify("x".repeat(60)).length, 40);
  assert.equal(slugify("!!!"), "task");
});

test("pause, resume, stop, approve and answer write control.json", async () => {
  const dir = await home();
  const runDir = await fakeRun(dir, "csv-export-1", { status: "running", question: { id: "draft-claude-q1", lane: "claude" } });
  const control = async () => JSON.parse(await readFile(join(runDir, "control.json"), "utf8"));

  await cli(dir, "pause", "csv-export-1");
  assert.equal((await control()).pause, "after-step");
  await cli(dir, "pause", "csv", "--now");
  assert.equal((await control()).pause, "now", "id prefixes work");
  await cli(dir, "resume", "csv-export-1");
  assert.equal((await control()).pause, null);
  await cli(dir, "approve", "csv-export-1", "4");
  assert.equal((await control()).approved, 4);
  await cli(dir, "answer", "csv-export-1", "B,", "skip", "archived");
  assert.deepEqual((await control()).answers, { "draft-claude-q1": "B, skip archived" });
  await cli(dir, "stop", "csv-export-1");
  const final = await control();
  assert.equal(final.stop, true);
  assert.equal(final.approved, 4, "earlier requests are kept");
});

test("answer refuses when nothing is being asked", async () => {
  const dir = await home();
  await fakeRun(dir, "quiet-1", { status: "running", question: null });
  await assert.rejects(cli(dir, "answer", "quiet-1", "yes"), /no open question/);
});

test("list and status summarize runs", async () => {
  const dir = await home();
  await fakeRun(dir, "csv-export-1", { slug: "csv-export", status: "running", step: 2, latest: "Step 2/6 · Drafting", startedAt: "2026-11-05T10:00:00Z", lanes: { claude: { name: "Claude", status: "working", role: "writer", model: "m1" } } });
  await fakeRun(dir, "auth-fix-2", { slug: "auth-fix", status: "done", step: 6, latest: "Done", startedAt: "2026-11-04T10:00:00Z" });
  const { stdout: list } = await cli(dir, "list");
  const lines = list.trim().split("\n");
  assert.match(lines[0], /csv-export-1\s+running\s+2\/6/);
  assert.match(lines[1], /auth-fix-2\s+done/);
  const { stdout: status } = await cli(dir, "status", "csv");
  assert.match(status, /Step 2\/6 · Drafting/);
  assert.match(status, /Claude\s+writer\s+working\s+m1/);
  const { stdout: json } = await cli(dir, "status", "csv", "--json");
  assert.equal(JSON.parse(json).id, "csv-export-1");
});

test("ambiguous or unknown ids fail with a clear message", async () => {
  const dir = await home();
  await fakeRun(dir, "csv-export-1", { status: "done" });
  await fakeRun(dir, "csv-import-2", { status: "done" });
  await assert.rejects(cli(dir, "status", "csv"), /matches more than one run: csv-export-1, csv-import-2/);
  await assert.rejects(cli(dir, "status", "nope"), /no run matches nope/);
});

test("a run whose engine process died shows as interrupted", async () => {
  const dir = await home();
  await fakeRun(dir, "gone-1", { status: "running", pid: 2 ** 22 + 12345, step: 3 });
  const { stdout } = await cli(dir, "list");
  assert.match(stdout, /gone-1\s+interrupted/);
});

test("the CLI runs when started through a symlink, as npm link installs it", async () => {
  const dir = await home();
  await fakeRun(dir, "linked-1", { status: "done", step: 6 });
  const { symlink } = await import("node:fs/promises");
  const link = join(dir, "whetstone");
  await symlink(CLI, link);
  const { stdout } = await run("node", [link, "list"], { env: { ...process.env, WHETSTONE_HOME: dir } });
  assert.match(stdout, /linked-1/);
});

// A stand-in for hc: records its arguments, answers like hc would.
async function fakeHc(dir) {
  const { writeFile: write, chmod } = await import("node:fs/promises");
  const bin = join(dir, "fake-hc.mjs");
  await write(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "hc-calls.jsonl"))}, JSON.stringify(args) + "\\n");
if (args[0] === "get") console.log(JSON.stringify({ address: "t8", labels: { "herdr.space": "sp9" } }));
else if (args[0] === "run") console.log(JSON.stringify({ address: "t99", name: args[args.indexOf("--name") + 1] }));
else console.log("{}");
`);
  await chmod(bin, 0o755);
  return bin;
}

async function hcCalls(dir) {
  return (await readFile(join(dir, "hc-calls.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
}

test("run starts the engine in its own Herdr terminal, in the caller's space, and returns", async () => {
  const dir = await home();
  const hc = await fakeHc(dir);
  const repo = join(dir, "app");
  await mkdir(repo);
  const { stdout } = await run("node", [CLI, "run", "--repo", repo, "--difficulty", "easy", "Add CSV export"], {
    env: { ...process.env, WHETSTONE_HOME: dir, WHETSTONE_HC: hc, HC_TERMINAL_ID: "t8" }
  });
  const launch = (await hcCalls(dir)).find((c) => c[0] === "run");
  assert.ok(launch, "launched through hc");
  assert.match(launch[launch.indexOf("--name") + 1], /^ws-[a-z0-9]{6}-engine$/);
  assert.ok(launch.includes("--no-parent"), "outlives the shell that started it");
  assert.ok(launch.includes("herdr.space=sp9"), "opens where the caller is");
  const argv = launch.slice(launch.indexOf("--") + 1);
  assert.equal(argv[0], "/usr/bin/env");
  assert.ok(argv.some((a) => a.startsWith("PATH=")) && argv.includes("__engine"));
  const id = argv[argv.length - 1];
  assert.match(id, /^add-csv-export-/);
  const state = JSON.parse(await readFile(join(dir, "runs", id, "state.json"), "utf8"));
  assert.equal(state.args.task, "Add CSV export");
  assert.equal(state.args.difficulty, "easy");
  assert.equal(state.engineTerminal, "t99");
  assert.equal(state.space, "sp9");
  assert.match(stdout, new RegExp(id));
});

test("a run with headless pi lanes still runs in the foreground", async () => {
  const dir = await home();
  const { writeFile: write } = await import("node:fs/promises");
  await write(join(dir, "config.json"), JSON.stringify({ lanes: [{ id: "claude", harness: "pi" }, { id: "codex", harness: "pi" }], tiers: Object.fromEntries(["easy", "medium", "hard"].map((t) => [t, { claude: "m", codex: "m" }])), triage: { lane: "codex", model: "m" }, reporter: { lane: "claude", model: "m" } }));
  const hc = await fakeHc(dir);
  // No real pi here, and the repo doesn't exist: the foreground engine fails fast, which is enough to show it ran in place.
  await assert.rejects(run("node", [CLI, "run", "--repo", join(dir, "missing"), "--difficulty", "easy", "x"], {
    env: { ...process.env, WHETSTONE_HOME: dir, WHETSTONE_HC: hc, PATH: "/usr/bin:/bin:" + dirname(process.execPath) }
  }));
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(join(dir, "hc-calls.jsonl")) || !(await hcCalls(dir)).some((c) => c[0] === "run"), "no engine terminal");
});
