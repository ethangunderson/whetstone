import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parseRunArgs, laneLabels } from "../cli.mjs";
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

test("parseRunArgs takes an issue instead of task text, with optional notes", () => {
  assert.deepEqual(parseRunArgs(["--issue", "WHE-5"]), { issue: "WHE-5" });
  assert.deepEqual(parseRunArgs(["--issue", "WHE-5", "--notes", "keep it small"]), { issue: "WHE-5", notes: "keep it small" });
  assert.deepEqual(parseRunArgs(["--notes", "and add a test", "Fix", "it"]), { notes: "and add a test", task: "Fix it" });
  assert.throws(() => parseRunArgs(["--issue", "WHE-5", "Fix", "it"]), /either task text or --issue/);
  assert.throws(() => parseRunArgs(["--issue"]), /--issue needs a value/);
  assert.throws(() => parseRunArgs(["--notes", "x"]), /task/);
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

// A stand-in for herdr-app: records `do` calls, answers tab.new like the app.
async function fakeHerdrApp(dir, { fail = false } = {}) {
  const { writeFile: write, chmod } = await import("node:fs/promises");
  const bin = join(dir, "fake-herdr-app.mjs");
  await write(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(dir, "app-calls.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (${fail}) { console.error("no window"); process.exit(1); }
console.log(JSON.stringify({ space: "sp9", tab: "tb1", terminal: "t42" }));
`);
  await chmod(bin, 0o755);
  return bin;
}

async function startRun(dir, extraEnv) {
  const repo = join(dir, "app");
  await mkdir(repo, { recursive: true });
  const { stdout } = await run("node", [CLI, "run", "--repo", repo, "--difficulty", "easy", "Add CSV export"], {
    env: { ...process.env, WHETSTONE_HOME: dir, HC_TERMINAL_ID: "t8", ...extraEnv }
  });
  return { stdout, repo };
}

test("run starts the engine in one named Herdr tab, in the caller's space, and returns", async () => {
  const dir = await home();
  const hc = await fakeHc(dir);
  const app = await fakeHerdrApp(dir);
  const { stdout, repo } = await startRun(dir, { WHETSTONE_HC: hc, WHETSTONE_HERDR_APP: app });
  const [cmd, name, json] = (await readFile(join(dir, "app-calls.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l))[0];
  assert.deepEqual([cmd, name], ["do", "tab.new"]);
  const spec = JSON.parse(json);
  assert.equal(spec.name, "Whetstone · add-csv-export", "a useful tab name, not a number");
  assert.equal(spec.space, "sp9", "opens where the caller is");
  assert.equal(spec.folder, repo);
  assert.equal(spec.argv[0], "/usr/bin/env");
  assert.ok(spec.argv.some((a) => a.startsWith("PATH=")) && spec.argv.includes("__engine"));
  const id = spec.argv[spec.argv.length - 1];
  assert.match(id, /^add-csv-export-/);
  const state = JSON.parse(await readFile(join(dir, "runs", id, "state.json"), "utf8"));
  assert.equal(state.args.task, "Add CSV export");
  assert.equal(state.engineTerminal, "t42");
  assert.equal(state.space, "sp9");
  assert.ok(!(await hcCalls(dir)).some((c) => c[0] === "run"), "not a second, unnamed tab");
  assert.match(stdout, new RegExp(id));
});

test("without a Herdr window the engine still starts, as a hidden hc terminal", async () => {
  const dir = await home();
  const hc = await fakeHc(dir);
  const app = await fakeHerdrApp(dir, { fail: true });
  await startRun(dir, { WHETSTONE_HC: hc, WHETSTONE_HERDR_APP: app });
  const launch = (await hcCalls(dir)).find((c) => c[0] === "run");
  assert.ok(launch, "launched through hc");
  assert.ok(launch.includes("--no-parent"));
  assert.ok(!launch.some((a) => String(a).startsWith("herdr.")), "no herdr labels: a hidden worker");
});

test("lanes carry no herdr labels, so they nest under the engine instead of opening tabs", () => {
  assert.deepEqual(laneLabels({ id: "run-1", space: "sp9" }), ["whetstone=run-1"]);
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

// A stand-in for herdr-linear 0.14.3: WHE-5 exists in eg-whetstone; status
// lists the workspaces in $FAKE_LINEAR_WORKSPACES (default: eg-whetstone).
async function fakeHerdrLinear(dir) {
  const { writeFile: write, chmod } = await import("node:fs/promises");
  const bin = join(dir, "fake-herdr-linear.mjs");
  await write(bin, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(dir, "linear-calls.jsonl"))}, JSON.stringify(args) + "\\n");
const url = "https://linear.app/eg-whetstone/issue/WHE-5/lanes-must-not-start";
const workspaces = JSON.parse(process.env.FAKE_LINEAR_WORKSPACES || '[{"id":"ws-1","name":"whetstone","urlKey":"eg-whetstone"}]');
if (args[0] === "issues") {
  const keys = JSON.parse(args[args.length - 1]);
  console.log(JSON.stringify(keys.map((key) => ({ key, issue: key === "WHE-5" ? { identifier: key, title: "Lanes must not start", url, workspace: "eg-whetstone" } : null }))));
} else {
  const req = JSON.parse(args[1]);
  if (req.op === "status") console.log(JSON.stringify({ version: "0.14.3", workspaces }));
  else if (!workspaces.some((w) => w.id === req.workspace)) console.log(JSON.stringify({ error: "not signed in to that workspace any more: " + req.workspace, signedOut: true }));
  else console.log(JSON.stringify({ description: "Lanes start before the engine is ready.", issue: { identifier: "WHE-5", title: "Lanes must not start", url, state: { name: "Todo" } }, labels: [] }));
}
`);
  await chmod(bin, 0o755);
  return bin;
}

test("issue prints the issue without starting anything", async () => {
  const dir = await home();
  const linear = await fakeHerdrLinear(dir);
  const out = await run("node", [CLI, "issue", "WHE-5", "--json"], { env: { ...process.env, WHETSTONE_HOME: dir, WHETSTONE_HERDR_LINEAR: linear } });
  const issue = JSON.parse(out.stdout);
  assert.equal(issue.key, "WHE-5");
  assert.equal(issue.title, "Lanes must not start");
  assert.equal(issue.url, "https://linear.app/eg-whetstone/issue/WHE-5/lanes-must-not-start");
  assert.equal(issue.description, "Lanes start before the engine is ready.");
  assert.equal(issue.slug, "whe-5-lanes-must-not-start", "the preview shows the slug the run will use");
  const text = await run("node", [CLI, "issue", "WHE-5"], { env: { ...process.env, WHETSTONE_HOME: dir, WHETSTONE_HERDR_LINEAR: linear } });
  assert.match(text.stdout, /^WHE-5 · Lanes must not start\n/);
  const { existsSync } = await import("node:fs");
  assert.ok(!existsSync(join(dir, "runs")), "no run created");
});

test("run --issue gives the lanes the issue and records it on the run", async () => {
  const dir = await home();
  const hc = await fakeHc(dir);
  const app = await fakeHerdrApp(dir);
  const linear = await fakeHerdrLinear(dir);
  const repo = join(dir, "app");
  await mkdir(repo, { recursive: true });
  await run("node", [CLI, "run", "--repo", repo, "--issue", "WHE-5", "--notes", "Keep it small."], {
    env: { ...process.env, WHETSTONE_HOME: dir, HC_TERMINAL_ID: "t8", WHETSTONE_HC: hc, WHETSTONE_HERDR_APP: app, WHETSTONE_HERDR_LINEAR: linear }
  });
  const spec = JSON.parse((await readFile(join(dir, "app-calls.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l))[0][2]);
  assert.equal(spec.name, "Whetstone · whe-5-lanes-must-not-start");
  const id = spec.argv[spec.argv.length - 1];
  assert.match(id, /^whe-5-lanes-must-not-start-/);
  const { args } = JSON.parse(await readFile(join(dir, "runs", id, "state.json"), "utf8"));
  assert.equal(args.slug, "whe-5-lanes-must-not-start");
  assert.deepEqual(args.issue, { key: "WHE-5", title: "Lanes must not start", url: "https://linear.app/eg-whetstone/issue/WHE-5/lanes-must-not-start" });
  assert.match(args.task, /^WHE-5: Lanes must not start\n/);
  assert.match(args.task, /Lanes start before the engine is ready\./);
  assert.match(args.task, /Keep it small\.$/);
  assert.equal(args.notes, "Keep it small.");
  const calls = (await readFile(join(dir, "linear-calls.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.every((c) => c[0] === "issues" || ["status", "detail"].includes(JSON.parse(c[1]).op)), "read only");
});

test("run --issue fails before any terminal opens when the issue can't be read", async () => {
  const { existsSync } = await import("node:fs");
  const cases = [
    { issue: "WHE-999", env: {}, error: /Linear issue WHE-999 not found/ },
    { issue: "WHE-5", env: { FAKE_LINEAR_WORKSPACES: "[]" }, error: /herdr-linear is not signed in to Linear/ },
    { issue: "https://linear.app/eg-whetstone/issue/WHE-5/x", env: { FAKE_LINEAR_WORKSPACES: '[{"id":"o","name":"o","urlKey":"other"}]' }, error: /not signed in to the Linear workspace eg-whetstone/ },
    { issue: "WHE-5", env: { WHETSTONE_HERDR_LINEAR: "/nonexistent/herdr-linear" }, error: /herdr-linear not found at \/nonexistent\/herdr-linear/ }
  ];
  for (const c of cases) {
    const dir = await home();
    const hc = await fakeHc(dir);
    const app = await fakeHerdrApp(dir);
    const linear = await fakeHerdrLinear(dir);
    const repo = join(dir, "app");
    await mkdir(repo, { recursive: true });
    const failed = await run("node", [CLI, "run", "--repo", repo, "--issue", c.issue], {
      env: { ...process.env, WHETSTONE_HOME: dir, HC_TERMINAL_ID: "t8", WHETSTONE_HC: hc, WHETSTONE_HERDR_APP: app, WHETSTONE_HERDR_LINEAR: linear, ...c.env }
    }).then(() => null, (e) => e);
    assert.ok(failed, c.issue + " should fail");
    assert.match(failed.stderr, c.error);
    assert.ok(!existsSync(join(dir, "app-calls.jsonl")) && !existsSync(join(dir, "hc-calls.jsonl")), "no terminal");
    assert.ok(!existsSync(join(dir, "runs")), "no run folder");
  }
});
