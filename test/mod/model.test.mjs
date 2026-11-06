import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shortModel, elapsed, runHeader, statusLine, steps, laneCards, decision, stats, rounds, history, actions, pickRun, parseEvents, cliCommand
} from "../../mods/whetstone/model.js";

const NOW = Date.parse("2026-11-05T16:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

function state(extra = {}) {
  return {
    id: "csv-export-20261105-153000",
    slug: "csv-export",
    task: "Add CSV export to the reports page",
    status: "running",
    pid: 123,
    step: 2,
    steps: ["Triage", "Draft", "Debate", "Integrate", "Review", "Report"],
    startedAt: ago(12 * 60_000),
    difficulty: "hard",
    fallback: "primary",
    models: { claude: "claude-bridge/claude-fable-5-1:high", codex: "openai-codex/gpt-6.1-sol:high" },
    lanes: {
      claude: { name: "Claude", harness: "pi", model: "claude-bridge/claude-fable-5-1:high", role: "writer", status: "working", stage: "draft-claude", since: ago(4 * 60_000) },
      codex: { name: "Codex", harness: "pi", model: "openai-codex/gpt-6.1-sol:high", role: "writer", status: "done", stage: "draft-codex", since: null }
    },
    ...extra
  };
}

test("shortModel drops the provider and shows effort", () => {
  assert.equal(shortModel("claude-bridge/claude-opus-5-5:high"), "claude-opus-5-5 · high");
  assert.equal(shortModel("gpt-6-sol"), "gpt-6-sol");
  assert.equal(shortModel(null), "");
});

test("elapsed reads like the engine's history", () => {
  assert.equal(elapsed(42_000), "42s");
  assert.equal(elapsed(4 * 60_000), "4m");
  assert.equal(elapsed(65 * 60_000), "1h05m");
});

test("runHeader names the run and says what state it is in", () => {
  assert.deepEqual(runHeader(state(), {}, true), { slug: "csv-export", task: "Add CSV export to the reports page", status: "Running", tone: "working" });
  assert.equal(runHeader(state(), { pause: "after-step" }, true).status, "Pausing after this stage");
  assert.equal(runHeader(state({ status: "paused" }), { pause: "after-step" }, true).status, "Paused");
  assert.equal(runHeader(state({ status: "waiting", next: { step: 3, name: "Debate" } }), {}, true).status, "Waiting for you");
  assert.deepEqual(runHeader(state({ status: "blocked" }), {}, true).tone, "attention");
  assert.equal(runHeader(state({ status: "waiting" }), {}, true).tone, "attention", "your turn is not an error");
  assert.equal(runHeader(state({ status: "paused" }), {}, true).tone, "attention");
  assert.equal(runHeader(state(), {}, false).status, "Interrupted", "an active run without its process");
  assert.deepEqual(runHeader(state({ status: "done" }), {}, false), { slug: "csv-export", task: "Add CSV export to the reports page", status: "Done", tone: "done" });
  assert.equal(runHeader(state({ status: "failed" }), {}, false).tone, "failed");
});

test("statusLine adds the latest event only while the run is moving", () => {
  assert.deepEqual(statusLine(state({ latest: "Step 2/6 · Drafting" }), {}, true), { status: "Running", tone: "working", detail: "Drafting" });
  assert.equal(statusLine(state({ status: "waiting", latest: "Waiting for you to start step 3/6 · Debate" }), {}, true).detail, "");
  assert.equal(statusLine(state({ latest: "Step 2/6 · Drafting" }), { pause: "after-step" }, true).detail, "");
  assert.equal(statusLine(state({ status: "done", latest: "Done · x" }), {}, false).detail, "");
});

test("cliCommand uses the recorded node and CLI paths, else whetstone on PATH", () => {
  assert.deepEqual(cliCommand({ node: "/n/bin/node", cli: "/w/engine/cli.mjs" }, ["pause", "x"]), ["/n/bin/node", ["/w/engine/cli.mjs", "pause", "x"]]);
  assert.deepEqual(cliCommand(null, ["pause", "x"]), ["whetstone", ["pause", "x"]]);
  assert.deepEqual(cliCommand({ node: "/n/bin/node" }, ["stop", "x"]), ["whetstone", ["stop", "x"]]);
});

test("steps mark done, current and later", () => {
  assert.deepEqual(steps(state({ step: 3 })).map((s) => s.state), ["done", "done", "current", "todo", "todo", "todo"]);
  assert.deepEqual(steps(state({ step: 6, status: "done" })).map((s) => s.state), ["done", "done", "done", "done", "done", "done"]);
  assert.equal(steps(state({ step: 3 }))[2].name, "Debate");
  assert.equal(steps(state({ step: 3, status: "failed" }))[2].state, "failed");
});

test("lane cards show role, a plain status, model and how long it has been working", () => {
  const [claude, codex] = laneCards(state(), NOW);
  assert.deepEqual(claude, { id: "claude", name: "Claude", role: "Writer", status: "working", detail: "4m", model: "claude-fable-5-1 · high", harness: "pi" });
  assert.equal(codex.status, "idle", "a lane that finished its stage waits for the other");
  assert.equal(codex.detail, "");
  const integrating = laneCards(state({ step: 4, lanes: { ...state().lanes, claude: { ...state().lanes.claude, stage: "integrate" } } }), NOW)[0];
  assert.equal(integrating.role, "Integrator");
  const reviewing = laneCards(state({ lanes: { ...state().lanes, codex: { ...state().lanes.codex, role: "reviewer", status: "working", since: ago(30_000) } } }), NOW)[1];
  assert.equal(reviewing.role, "Reviewer");
  assert.equal(reviewing.detail, "30s");
  const blocked = laneCards(state({ lanes: { ...state().lanes, claude: { ...state().lanes.claude, status: "blocked" } } }), NOW)[0];
  assert.equal(blocked.status, "needs you");
  assert.equal(laneCards(state({ status: "done" }), NOW)[1].status, "done");
  const finished = laneCards(state({ status: "done", integrator: "codex", lanes: { claude: { ...state().lanes.claude, role: "reviewer", status: "done" }, codex: { ...state().lanes.codex, role: "reviewer" } } }), NOW);
  assert.deepEqual(finished.map((l) => l.role), ["Writer", "Integrator"], "a finished run shows who integrated, not the last stage");
  assert.equal(laneCards(state({ lanes: { ...state().lanes, codex: { ...state().lanes.codex, status: "failed" } } }), NOW)[1].status, "failed");
});

test("decision explains who integrates, how it was decided, and whose plan won out", () => {
  assert.equal(decision(state()), null);
  const d = decision(state({
    integrator: "codex", decidedBy: "consensus",
    votes: { integrator: { claude: "codex", codex: "codex" } },
    plan: { claude: { claude: 1, codex: 4, both: 2, new: 0 }, codex: { claude: 2, codex: 5, both: 2, new: 1 } }
  }));
  assert.deepEqual(d, {
    integrator: "Codex",
    how: "both agreed",
    votes: [["Claude", "Codex"], ["Codex", "Codex"]],
    share: [["Claude", 2], ["Codex", 5], ["Both", 2], ["New", 1]]
  });
  assert.equal(decision(state({ integrator: "claude", decidedBy: "arbiter", votes: { integrator: { claude: "claude" } }, plan: {} })).how, "arbiter decided");
});

test("stats: difficulty, rounds, open findings, elapsed", () => {
  assert.deepEqual(stats(state(), NOW), [["Difficulty", "Hard"], ["Rounds", "0"], ["Open findings", "–"], ["Active", "12m"]]);
  const reviewed = state({
    difficulty: "hard", fallback: "fallback", step: 5,
    rounds: [{ round: 1, findings: [
      { id: "CL1-1", severity: "P1", disposition: "FIXED" },
      { id: "CX1-1", severity: "P1", disposition: null },
      { id: "CX1-2", severity: "P2", disposition: "REJECTED" },
      { id: "CX1-3", severity: "P2", disposition: "DEFERRED" }
    ] }]
  });
  assert.deepEqual(stats(reviewed, NOW), [["Difficulty", "Hard · fallback"], ["Rounds", "1"], ["Open findings", "2"], ["Active", "12m"]]);
  assert.equal(stats(state({ status: "done", endedAt: ago(2 * 60_000) }), NOW)[3][1], "10m", "a finished run stops counting");
  assert.equal(stats(state({ waitedMs: 5 * 60_000 }), NOW)[3][1], "7m", "time spent waiting for you doesn't count");
  assert.equal(stats(state({ status: "waiting", waitedMs: 60_000, waitingSince: ago(3 * 60_000) }), NOW)[3][1], "8m", "nor does the wait in progress");
});

test("rounds count findings by severity and keep their dispositions", () => {
  const r = rounds(state({ rounds: [{ round: 1, verdicts: { claude: "BLOCK", codex: "OK" }, findings: [
    { id: "CL1-1", severity: "P0", reviewer: "claude", title: "Crash on empty", disposition: "FIXED" },
    { id: "CL1-2", severity: "P2", reviewer: "claude", title: "Naming", disposition: null }
  ] }] }));
  assert.deepEqual(r[0].counts, { P0: 1, P1: 0, P2: 1 });
  assert.deepEqual(r[0].findings[0], { id: "CL1-1", severity: "P0", reviewer: "Claude", title: "Crash on empty", disposition: "fixed", positions: [], why: "" });
  assert.equal(r[0].findings[1].disposition, "open");
  assert.deepEqual(rounds(state()), []);
});

test("history is newest first, local HH:MM, without the step prefix", () => {
  const events = parseEvents([
    JSON.stringify({ at: "2026-11-05T15:51:00Z", text: "Step 1/6 · Difficulty: hard" }),
    "garbage",
    JSON.stringify({ at: "2026-11-05T15:52:00Z", text: "Step 2/6 · Drafting · Codex done in 4m · Claude still working (5m so far)" }),
    ""
  ].join("\n"));
  const h = history(events, 10);
  assert.equal(h.length, 2);
  assert.equal(h[0].text, "Drafting · Codex done in 4m · Claude still working (5m so far)");
  assert.match(h[0].time, /^\d\d:\d\d$/);
  assert.equal(h[1].text, "Difficulty: hard");
  assert.equal(history(events, 1).length, 1);
});

test("actions offer what makes sense for the run's state", () => {
  assert.deepEqual(actions(state(), {}, true), ["pause", "stop"]);
  assert.deepEqual(actions(state(), { pause: "after-step" }, true), ["resume", "stop"]);
  assert.deepEqual(actions(state({ status: "paused" }), { pause: "after-step" }, true), ["resume", "stop"]);
  assert.deepEqual(actions(state({ status: "waiting", next: { step: 3, name: "Debate" } }), {}, true), ["approve", "stop"]);
  assert.deepEqual(actions(state({ status: "blocked" }), {}, true), ["stop"]);
  assert.deepEqual(actions(state(), {}, false), ["restart"]);
  assert.deepEqual(actions(state({ status: "done", report: "/r/REPORT.md" }), {}, false), ["report"]);
  assert.deepEqual(actions(state({ status: "failed" }), {}, false), ["restart"]);
  assert.deepEqual(actions(state({ status: "stopped" }), {}, false), []);
});

test("pickRun prefers the newest active run, else the newest", () => {
  const runs = [
    { id: "a", state: { status: "done", startedAt: "2026-11-05T15:00:00Z" } },
    { id: "b", state: { status: "running", startedAt: "2026-11-05T14:00:00Z" } },
    { id: "c", state: { status: "paused", startedAt: "2026-11-05T13:00:00Z" } }
  ];
  assert.equal(pickRun(runs), "b");
  assert.equal(pickRun(runs.filter((r) => r.id === "a")), "a");
  assert.equal(pickRun([]), null);
});
