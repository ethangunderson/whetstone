// The herdr harness runs each lane as a live, interactive agent in a Herdr
// Core terminal. These tests drive it with a fake `hc` and a fake inbox.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHerdrHarness, terminalName, replyProtocol } from "../harness/herdr.mjs";
import { createInbox } from "../inbox.mjs";

// What a well-behaved agent does with a message: write the reply file it was
// told to, then send the done line it was told to.
function parseAsk(message) {
  const file = /write your complete final response[^\n]*? to (\S+?)[,.]?\s/i.exec(message)?.[1];
  const done = /hc send \S+ "(done \S+ \S+)"/.exec(message)?.[1];
  return { file, done };
}

function fakeHc({ inbox, behave = {} } = {}) {
  const calls = [];
  const terms = {};
  let n = 20;
  const respond = async (term, message) => {
    const script = behave[term.name] || behave.default || "reply";
    const { file, done } = parseAsk(message);
    term.messages.push(message);
    if (typeof script === "function") return script({ term, message, file, done, inbox });
    if (script === "silent") { term.status = "idle"; return; }
    if (script === "exit") { term.state = "finished"; return; }
    await sleep(5);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "reply from " + term.name + " #" + term.messages.length);
    term.status = "done";
    inbox.push(done);
  };
  async function hc(args) {
    calls.push(args);
    const [cmd] = args;
    const nameArg = (flag) => args[args.indexOf(flag) + 1];
    if (cmd === "run") {
      const name = nameArg("--name");
      const term = { name, address: "t" + (++n), state: "live", status: "working", messages: [], argv: args.slice(args.indexOf("--") + 1) };
      terms[name] = term;
      respond(term, args[args.length - 1]);
      return JSON.stringify({ address: term.address, name, state: "live" });
    }
    const term = terms[args[args.length - 1]] || terms[args[args.indexOf("send") + (args.includes("--json") ? 2 : 1)]];
    if (cmd === "send") {
      const name = args[args.length - 2];
      const t = terms[name];
      if (!t || t.state !== "live") throw Object.assign(new Error("not found"), { code: 3 });
      t.status = "working";
      respond(t, args[args.length - 1]);
      return JSON.stringify({ started: true });
    }
    const t = terms[args[args.length - 1]] || term;
    if (cmd === "get") {
      if (!t) throw Object.assign(new Error("not found"), { code: 3 });
      return JSON.stringify({ address: t.address, name: t.name, state: t.state, status: { app: "pi", state: t.status } });
    }
    if (cmd === "interrupt") { t.status = "idle"; t.interrupted = (t.interrupted || 0) + 1; return JSON.stringify({ outcome: "stopped" }); }
    if (cmd === "kill") { t.state = "finished"; return "{}"; }
    if (cmd === "rm") { delete terms[t.name]; return "{}"; }
    throw new Error("unexpected hc " + cmd);
  }
  return { hc, calls, terms };
}

async function setup(opts = {}) {
  const runDir = await mkdtemp(join(tmpdir(), "whetstone-herdr-"));
  const inbox = createInbox();
  const fake = fakeHc({ inbox, behave: opts.behave });
  const harness = createHerdrHarness({
    hc: fake.hc, inbox, engine: "ws-abc123-engine", path: "/bin:/opt/pi/bin", bins: { pi: "/opt/pi/bin/pi" },
    labels: ["herdr.space=sp1"], pollMs: 5, nudgeAfterMs: 60, timeoutMs: 3000, ...opts.harness
  });
  const base = { runId: "csv-export-20261105-1", runDir, key: "draft-claude", lane: "claude", role: "writer", cwd: runDir, system: "ROLE", model: "claude-bridge/claude-sonnet-5-5", effort: "medium", readOnly: false, prompt: "Implement it." };
  return { runDir, inbox, fake, harness, base };
}

test("terminalName is short, stable per run and valid for hc", () => {
  const a = terminalName("csv-export-20261105-211111", "claude");
  assert.match(a, /^ws-[a-z0-9]{6}-claude$/);
  assert.equal(a, terminalName("csv-export-20261105-211111", "claude"));
  assert.notEqual(a, terminalName("csv-export-20261105-211112", "claude"));
  assert.ok(terminalName("x", "r12-review-claude-longname").length <= 32);
});

test("replyProtocol tells the agent where to write and what to send", () => {
  const text = replyProtocol({ engine: "ws-e", file: "/r/replies/draft-claude-k1.md", key: "draft-claude", token: "k1" });
  const { file, done } = parseAsk(text + "\n");
  assert.equal(file, "/r/replies/draft-claude-k1.md");
  assert.equal(done, "done draft-claude k1");
  assert.match(text, /hc send ws-e/);
});

test("a first call starts a live pi lane in Herdr and returns the reply file's text", async () => {
  const { harness, base, fake } = await setup();
  const r = await harness.run({ ...base, session: "ignored", resume: false });
  assert.equal(r.ok, true, r.error);
  assert.match(r.text, /^reply from ws-[a-z0-9]{6}-claude #1$/);
  assert.equal(r.sessionId, terminalName(base.runId, "claude"));
  assert.match(r.terminal, /^t\d+$/);
  const run = fake.calls.find((c) => c[0] === "run");
  assert.ok(run.includes("--bg") && run.includes("herdr.space=sp1"));
  assert.equal(run[run.indexOf("--cwd") + 1], base.cwd);
  const argv = run.slice(run.indexOf("--") + 1);
  assert.deepEqual(argv.slice(0, 3), ["/usr/bin/env", "PATH=/bin:/opt/pi/bin", "/opt/pi/bin/pi"]);
  assert.deepEqual(argv.slice(3, 7), ["--model", "claude-bridge/claude-sonnet-5-5", "--thinking", "medium"]);
  assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,bash,edit,write");
  assert.equal(argv[argv.indexOf("--append-system-prompt") + 1], "ROLE");
  const first = argv[argv.length - 1];
  assert.match(first, /\[whetstone\] messages come from the Whetstone coordinator/i);
  assert.match(first, /Implement it\./);
});

test("reviewers get read-only tools and a terminal named for their stage", async () => {
  const { harness, base, fake } = await setup();
  await harness.run({ ...base, key: "r1-review-codex", lane: "codex", role: "reviewer", readOnly: true, resume: false });
  const run = fake.calls.find((c) => c[0] === "run");
  assert.equal(run[run.indexOf("--name") + 1], terminalName(base.runId, "r1-review-codex"));
  assert.equal(run[run.indexOf("--tools") + 1], "read,grep,find,ls,bash");
});

test("a resumed call sends the next step into the same live lane", async () => {
  const { harness, base, fake } = await setup();
  const first = await harness.run({ ...base, resume: false });
  const second = await harness.run({ ...base, key: "critique-claude", resume: true, session: first.sessionId, prompt: "Compare." });
  assert.equal(second.ok, true, second.error);
  assert.match(second.text, /#2$/);
  const send = fake.calls.find((c) => c[0] === "send");
  assert.equal(send[send.length - 2], first.sessionId);
  assert.match(send[send.length - 1], /Compare\./);
  assert.equal(fake.calls.filter((c) => c[0] === "run").length, 1);
});

test("resuming a lane whose terminal is gone starts a new one and says context was lost", async () => {
  const { harness, base, fake } = await setup();
  const r = await harness.run({ ...base, key: "integrate", resume: true, session: "ws-gone00-claude", prompt: "Integrate." });
  assert.equal(r.ok, true, r.error);
  const run = fake.calls.find((c) => c[0] === "run");
  assert.match(run[run.length - 1], /earlier conversation is gone/i);
});

test("stale or foreign done lines don't complete the wrong step", async () => {
  const { harness, base, inbox } = await setup({
    behave: {
      default: async ({ file, done, inbox }) => {
        inbox.push("done draft-claude oldtoken");
        inbox.push("<hc from=\"t9\">chatter</hc>");
        await sleep(20);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "the real reply");
        inbox.push(done);
      }
    }
  });
  const r = await harness.run({ ...base, resume: false });
  assert.equal(r.text, "the real reply");
});

test("a lane that goes quiet without reporting is nudged once, then fails", async () => {
  const { harness, base, fake } = await setup({ behave: { default: "silent" } });
  const r = await harness.run({ ...base, resume: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped without reporting/);
  const nudges = fake.calls.filter((c) => c[0] === "send" && /haven't reported/.test(c[c.length - 1]));
  assert.equal(nudges.length, 1);
});

test("a nudged lane that then reports succeeds", async () => {
  let asks = 0;
  const { harness, base } = await setup({
    behave: {
      default: async ({ term, file, done, inbox }) => {
        asks += 1;
        if (asks === 1) { term.status = "idle"; return; }
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, "late but here");
        inbox.push(done);
      }
    }
  });
  const r = await harness.run({ ...base, resume: false });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text, "late but here");
});

test("a lane that exits fails the call", async () => {
  const { harness, base } = await setup({ behave: { default: "exit" } });
  const r = await harness.run({ ...base, resume: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /lane exited/);
});

test("a done line without the reply file fails clearly", async () => {
  const { harness, base } = await setup({ behave: { default: async ({ done, inbox }) => inbox.push(done) } });
  const r = await harness.run({ ...base, resume: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /reply file/);
});

test("pause now interrupts the lane, and lifting the pause tells it to continue", async () => {
  let control = {};
  const { harness, base, fake, inbox } = await setup({ harness: { nudgeAfterMs: 10_000 }, behave: { default: async () => {} } });
  const running = harness.run({ ...base, resume: false, control: async () => control });
  await sleep(30);
  control = { pause: "now" };
  await sleep(40);
  const term = Object.values(fake.terms)[0];
  assert.equal(term.interrupted, 1, "interrupted once, not on every poll");
  control = {};
  await sleep(40);
  const resumeMsg = term.messages.find((m) => /continue/i.test(m));
  assert.ok(resumeMsg, "told to continue");
  const { file, done } = parseAsk(resumeMsg);
  assert.ok(file && done, "the continue message repeats where to reply");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, "finished after the pause");
  inbox.push(done);
  const result = await running;
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, "finished after the pause");
});

test("stop interrupts the lane and fails the call as stopped", async () => {
  let control = {};
  const { harness, base, fake } = await setup({ harness: { nudgeAfterMs: 10_000 }, behave: { default: async () => {} } });
  const running = harness.run({ ...base, resume: false, control: async () => control });
  await sleep(20);
  control = { stop: true };
  const r = await running;
  assert.equal(r.ok, false);
  assert.match(r.error, /stopped/);
  assert.equal(Object.values(fake.terms)[0].interrupted, 1);
});

test("close ends the run's terminals", async () => {
  const { harness, base, fake } = await setup();
  await harness.run({ ...base, resume: false });
  await harness.close();
  assert.ok(fake.calls.some((c) => c[0] === "kill"));
  assert.equal(Object.keys(fake.terms).length, 0);
});

test("reviewer and helper terminals close as soon as their call ends; writer lanes stay", async () => {
  const { harness, base, fake } = await setup();
  const writer = await harness.run({ ...base, resume: false });
  await harness.run({ ...base, key: "r1-review-claude", role: "reviewer", readOnly: true, resume: false });
  assert.deepEqual(Object.keys(fake.terms), [writer.sessionId]);
});

test("the lane's terminal is reported as soon as it starts, before the step finishes", async () => {
  let reported = null;
  let finished = false;
  const { harness, base } = await setup({ behave: { default: async ({ file, done, inbox }) => {
    await sleep(40);
    assert.ok(reported, "reported before the reply");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "ok");
    finished = true;
    inbox.push(done);
  } } });
  const r = await harness.run({ ...base, resume: false, onTerminal: (t) => { reported = t; } });
  assert.ok(finished);
  assert.equal(reported, r.terminal);
});
