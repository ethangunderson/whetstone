import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createPiHarness, parsePiOutput, piActivity, piArgs } from "../harness/pi.mjs";

const line = (e) => JSON.stringify(e);
const assistant = (text, extra = {}) =>
  line({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text },
      ],
      stopReason: "stop",
      ...extra,
    },
  });

test("piArgs starts a new session in the run's session folder", () => {
  const argv = piArgs(
    {
      model: "claude-bridge/claude-opus-5-5",
      effort: "high",
      system: "ROLE",
      readOnly: false,
      prompt: "do it",
      session: "abc",
      resume: false,
    },
    { sessionDir: "/runs/x/sessions" },
  );
  assert.deepEqual(argv, [
    "-p",
    "--mode",
    "json",
    "--model",
    "claude-bridge/claude-opus-5-5",
    "--thinking",
    "high",
    "--tools",
    "read,grep,find,ls,bash,edit,write",
    "--no-skills",
    "--append-system-prompt",
    "ROLE",
    "--session-dir",
    "/runs/x/sessions",
    "--session-id",
    "abc",
    "--",
    "do it",
  ]);
});

test("piArgs continues from the session file and limits reviewers to read-only tools", () => {
  const argv = piArgs(
    {
      model: "openai-codex/gpt-6-sol",
      effort: undefined,
      system: "ROLE",
      readOnly: true,
      prompt: "-starts with a dash",
      session: "abc",
      resume: true,
    },
    { sessionDir: "/s", sessionFile: "/s/2026_abc.jsonl" },
  );
  assert.ok(!argv.includes("--thinking"));
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,bash");
  assert.deepEqual(argv.slice(argv.indexOf("--session"), argv.indexOf("--session") + 2), [
    "--session",
    "/s/2026_abc.jsonl",
  ]);
  assert.ok(!argv.includes("--session-id"));
  assert.deepEqual(argv.slice(-2), ["--", "-starts with a dash"]);
});

test("parsePiOutput returns the last assistant text and the session id", () => {
  const out = [
    line({ type: "session", id: "abc", cwd: "/w" }),
    assistant("first"),
    assistant("final answer\nINTEGRATOR: codex"),
    line({ type: "agent_settled", aborted: false }),
  ].join("\n");
  assert.deepEqual(parsePiOutput(out), {
    ok: true,
    text: "final answer\nINTEGRATOR: codex",
    sessionId: "abc",
    error: null,
  });
});

test("parsePiOutput reports model errors even though pi exits 0", () => {
  const out = [
    line({ type: "session", id: "abc" }),
    assistant("", { stopReason: "error", errorMessage: "There's an issue with the selected model" }),
  ].join("\n");
  const r = parsePiOutput(out);
  assert.equal(r.ok, false);
  assert.match(r.error, /issue with the selected model/);
});

test("parsePiOutput treats an aborted or empty run as a failure and skips junk lines", () => {
  assert.equal(
    parsePiOutput([assistant("partial"), line({ type: "agent_settled", aborted: true })].join("\n")).ok,
    false,
  );
  const empty = parsePiOutput("not json\n" + line({ type: "session", id: "abc" }));
  assert.equal(empty.ok, false);
  assert.match(empty.error, /no assistant reply/);
});

test("piActivity turns pi events into a readable activity stream", () => {
  assert.deepEqual(
    piActivity({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } }),
    { kind: "tool", id: "t1", tool: "bash", text: "npm test" },
  );
  assert.deepEqual(
    piActivity({
      type: "tool_execution_start",
      toolCallId: "t2",
      toolName: "edit",
      args: { path: "src/a.js", oldText: "x", newText: "y" },
    }),
    { kind: "tool", id: "t2", tool: "edit", text: "src/a.js" },
  );
  assert.deepEqual(
    piActivity({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "ok 1\nok 2\n" }] },
      isError: false,
      durationMs: 1200,
    }),
    { kind: "tool_end", id: "t1", ok: true, text: "ok 1\nok 2", ms: 1200 },
  );
  const long = piActivity({
    type: "tool_execution_end",
    toolCallId: "t3",
    toolName: "bash",
    result: { content: [{ type: "text", text: "x".repeat(5000) }] },
    isError: true,
  });
  assert.equal(long.ok, false);
  assert.ok(long.text.length <= 801);
  assert.deepEqual(
    piActivity({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", content: "Looking at the parser." },
    }),
    { kind: "text", text: "Looking at the parser." },
  );
  assert.deepEqual(
    piActivity({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "overloaded" },
    }),
    { kind: "error", text: "overloaded" },
  );
  assert.equal(
    piActivity({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Lo" } }),
    null,
  );
  assert.equal(
    piActivity({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "  " } }),
    null,
  );
  assert.equal(piActivity({ type: "agent_start" }), null);
});

// A stand-in `pi` that records its argv and prints a scripted reply.
async function fakePi(dir, script) {
  const bin = join(dir, "fake-pi.mjs");
  await writeFile(bin, "#!/usr/bin/env node\n" + script);
  await chmod(bin, 0o755);
  return bin;
}

test("run spawns pi in the lane's cwd, logs raw output and parses the reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-pi-"));
  const cwd = join(dir, "lane");
  await mkdir(cwd);
  const bin = await fakePi(
    dir,
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "session", id: "s1" }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } }));
`,
  );
  const harness = createPiHarness({ bin });
  const logFile = join(dir, "logs", "draft-claude.jsonl");
  const r = await harness.run({
    model: "m",
    effort: "low",
    system: "S",
    readOnly: false,
    prompt: "p",
    session: "s1",
    resume: false,
    cwd,
    sessionDir: join(dir, "sessions"),
    logFile,
  });
  assert.deepEqual(r, { ok: true, text: "done", sessionId: "s1", error: null });
  const seen = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
  assert.equal(await realpath(seen.cwd), await realpath(cwd));
  assert.ok(seen.argv.includes("--session-id"));
  assert.match(await readFile(logFile, "utf8"), /"type":"session"/);
});

test("run writes the activity stream as it goes, one JSON line per item with a timestamp", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-pi-"));
  const bin = await fakePi(
    dir,
    `
const out = (e) => console.log(JSON.stringify(e));
out({ type: "session", id: "s1" });
out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [{ type: "text", text: "pass 3" }] }, isError: false, durationMs: 40 });
out({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "All green." } });
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All green." }], stopReason: "stop" } });
`,
  );
  const activityFile = join(dir, "activity", "draft-claude.jsonl");
  const r = await createPiHarness({ bin }).run({
    model: "m",
    prompt: "p",
    session: "s1",
    resume: false,
    cwd: dir,
    sessionDir: join(dir, "s"),
    activityFile,
  });
  assert.equal(r.ok, true);
  const items = (await readFile(activityFile, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    items.map((i) => i.kind),
    ["tool", "tool_end", "text"],
  );
  assert.equal(items[0].text, "npm test");
  assert.ok(items.every((i) => typeof i.at === "string"));
});

test("run resumes from the session file pi wrote, wherever the new cwd is", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-pi-"));
  const sessionDir = join(dir, "sessions");
  await mkdir(sessionDir);
  await writeFile(join(sessionDir, "2026-11-05T22-03-01-050Z_s1.jsonl"), "");
  const bin = await fakePi(
    dir,
    `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "again" }], stopReason: "stop" } }));
`,
  );
  const r = await createPiHarness({ bin }).run({
    model: "m",
    system: "S",
    readOnly: true,
    prompt: "p",
    session: "s1",
    resume: true,
    cwd: dir,
    sessionDir,
  });
  assert.equal(r.text, "again");
  const argv = JSON.parse(await readFile(join(dir, "argv.json"), "utf8"));
  assert.equal(argv[argv.indexOf("--session") + 1], join(sessionDir, "2026-11-05T22-03-01-050Z_s1.jsonl"));
});

test("run fails clearly when there is no session to resume or pi cannot start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-pi-"));
  const missing = await createPiHarness({ bin: "true" }).run({
    model: "m",
    prompt: "p",
    session: "nope",
    resume: true,
    cwd: dir,
    sessionDir: dir,
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /no pi session file for nope/);
  const broken = await createPiHarness({ bin: join(dir, "no-such-pi") }).run({
    model: "m",
    prompt: "p",
    session: "s",
    resume: false,
    cwd: dir,
    sessionDir: dir,
  });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /could not start pi/);
});

test("run reports a nonzero exit with stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-pi-"));
  const bin = await fakePi(dir, `console.error("auth expired"); process.exit(3);`);
  const r = await createPiHarness({ bin }).run({
    model: "m",
    prompt: "p",
    session: "s",
    resume: false,
    cwd: dir,
    sessionDir: dir,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /exited with code 3.*auth expired/s);
});

async function realpath(p) {
  const { realpath: rp } = await import("node:fs/promises");
  return rp(p);
}

// Opt-in: WHETSTONE_SMOKE=pi node --test engine/test/harness-pi.test.mjs
test("smoke: a real pi session keeps context across stages and directories", {
  skip: process.env.WHETSTONE_SMOKE !== "pi",
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-smoke-"));
  await mkdir(join(dir, "a"));
  await mkdir(join(dir, "b"));
  const harness = createPiHarness();
  const base = {
    model: process.env.WHETSTONE_SMOKE_MODEL || "claude-bridge/claude-sonnet-5-5",
    effort: "low",
    system: "Be terse.",
    readOnly: true,
    session: crypto.randomUUID(),
    sessionDir: join(dir, "sessions"),
  };
  const first = await harness.run({
    ...base,
    resume: false,
    cwd: join(dir, "a"),
    prompt: "Remember the word SAFFRON. Reply with exactly: OK",
  });
  assert.ok(first.ok, first.error);
  const second = await harness.run({
    ...base,
    resume: true,
    cwd: join(dir, "b"),
    prompt: "What word did I ask you to remember? Reply with just the word.",
  });
  assert.ok(second.ok, second.error);
  assert.match(second.text, /SAFFRON/);
});
