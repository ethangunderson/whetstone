import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
