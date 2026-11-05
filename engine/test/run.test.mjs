// Full runs against a fake harness and a fake workspace. Ported from
// ~/.pi/agent/workflows/dual-pr.test.mjs, plus checkpoint/resume, pause,
// stop, step mode and operator questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openStore } from "../store.mjs";
import { resolveConfig } from "../config.mjs";
import { runWhetstone } from "../run.mjs";

const clean = { verdict: "OK", summary: "fine", findings: [] };
const p1 = { verdict: "BLOCK", summary: "bug", findings: [{ severity: "P1", title: "t", location: "a.ex:1", evidence: "e", suggestedFix: "f" }] };
const p2 = { verdict: "OK_WITH_NOTES", summary: "nit", findings: [{ severity: "P2", title: "n", location: "b.ex:2", evidence: "e", suggestedFix: "f" }] };
const fence = (obj) => "```json\n" + JSON.stringify(obj) + "\n```";

// The fake answers by stage key, the way the real agents would.
function scriptFor(o) {
  return (req) => {
    const { key } = req;
    if (o.override && o.override[key]) return o.override[key](req);
    if (key.startsWith("probe-") || key.startsWith("fallback-")) {
      const outcome = (key.startsWith("probe-") ? o.probe : o.fallback)?.[key.split("-")[1]] ?? "ok";
      if (outcome === "throw") throw new Error("model not available on this plan");
      return outcome === "ok" ? { text: "OK" } : { ok: false, text: "", error: "403: model not available" };
    }
    if (key === "triage") return { text: "Rated.\n" + fence({ difficulty: o.triage ?? "hard", reasoning: "because", risks: [] }) };
    if (key.startsWith("converge-")) {
      const who = key.slice(9);
      const items = (o.sources && o.sources[who]) || [];
      return { text: "plan\n" + fence({ integrator: o.votes[who], items: items.map((source, i) => ({ item: "i" + i, source })) }) + "\nINTEGRATOR: " + o.votes[who] };
    }
    if (key === "arbiter") return { text: fence({ integrator: "codex", reasoning: "smaller diff", mergedPlan: "p" }) };
    const m = key.match(/^r(\d)-review-(\w+)$/);
    if (m) return { text: "Reviewed.\n" + fence(o.reviews[+m[1] - 1][m[2]]) };
    if (/^r\d-fix$/.test(key) && o.dispositions) return { text: "fixed\n" + fence({ dispositions: o.dispositions }) };
    if (key === "signoff") return { text: "Looks right.\nSIGNOFF: approve" };
    return { text: "ok " + key };
  };
}

function fakeHarness(script, delays = {}) {
  const calls = [];
  return {
    calls,
    harness: {
      name: "fake",
      async run(req) {
        calls.push(req);
        const lane = req.lane || "helper";
        await sleep(delays[lane] ?? 1);
        const out = await script(req);
        return { ok: true, sessionId: req.session, ...out };
      }
    }
  };
}

function fakeWorkspace() {
  const added = [];
  return { added, workspace: { async addWorktree(w) { added.push(w); } } };
}

const pi = resolveConfig();

async function setup(o = {}) {
  const base = await mkdtemp(join(tmpdir(), "whetstone-run-"));
  const store = o.store || await openStore(join(base, "run"));
  const fake = fakeHarness(scriptFor(o), o.delays ?? { claude: 30, codex: 5 });
  const ws = fakeWorkspace();
  const args = { task: "Add CSV export", repo: join(base, "peepmetrics"), slug: "csv-export", ...o.args };
  const run = () => runWhetstone({ args, config: o.config || pi, harnesses: { pi: fake.harness }, store, workspace: ws.workspace, pollMs: 5 });
  return { base, store, fake, ws, args, run };
}

async function simulate(o) {
  const s = await setup(o);
  const result = await s.run();
  const calls = s.fake.calls;
  return { ...s, result, calls, keys: calls.map((c) => c.key), events: await events(s.store), state: s.store.state };
}

async function events(store) {
  if (!existsSync(join(store.dir, "events.jsonl"))) return [];
  return (await readFile(join(store.dir, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).text);
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(5); }
  throw new Error("timed out waiting");
}

const control = (store, value) => writeFile(join(store.dir, "control.json"), JSON.stringify(value));
const agree = { votes: { claude: "claude", codex: "claude" } };

// ---- Ported behavior -------------------------------------------------------

test("agreement and clean review skips arbiter, fixes and sign-off", async () => {
  const { result, keys } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  assert.equal(result.integrator, "claude");
  assert.ok(!keys.includes("arbiter") && !keys.includes("r1-fix") && !keys.includes("signoff"));
});

test("disagreement goes to arbiter; P1 then clean runs two rounds", async () => {
  const { result, keys } = await simulate({ votes: { claude: "claude", codex: "codex" }, reviews: [{ claude: p1, codex: clean }, { claude: clean, codex: clean }] });
  assert.equal(result.integrator, "codex");
  assert.ok(keys.includes("arbiter") && keys.includes("r2-review-claude"));
  assert.equal(result.unreviewedFixes, false);
});

test("two blocking rounds hit the cap and trigger peer sign-off", async () => {
  const { result, keys, state } = await simulate({ votes: { claude: "codex", codex: "codex" }, reviews: [{ claude: p1, codex: p1 }, { claude: p1, codex: clean }] });
  assert.equal(result.rounds.length, 2);
  assert.ok(keys.includes("signoff") && !keys.includes("r3-review-claude"));
  assert.equal(state.signoff, "approve");
});

test("P2-only round fixes without a second review", async () => {
  const { keys } = await simulate({ votes: { claude: "codex", codex: "codex" }, reviews: [{ claude: p2, codex: clean }] });
  assert.ok(keys.includes("r1-fix") && keys.includes("signoff") && !keys.includes("r2-review-claude"));
});

test("easy and medium use each tier's models and effort for writers and reviewers", async () => {
  for (const difficulty of ["easy", "medium"]) {
    const { result, calls } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty } });
    assert.deepEqual(result.models, { claude: pi.tiers[difficulty].claude, codex: pi.tiers[difficulty].codex });
    for (const who of ["claude", "codex"]) {
      const draft = calls.find((c) => c.key === "draft-" + who);
      const review = calls.find((c) => c.key === "r1-review-" + who);
      assert.equal(draft.model + ":" + draft.effort, pi.tiers[difficulty][who]);
      assert.equal(review.model + ":" + review.effort, pi.tiers[difficulty][who]);
    }
  }
});

test("hard + every lane reachable uses the primary pair and never probes fallbacks", async () => {
  const { result, keys } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  assert.equal(result.models.claude, "claude-bridge/claude-fable-5-1:high");
  assert.equal(result.models.codex, "openai-codex/gpt-6.1-sol:high");
  assert.equal(result.fallback, "primary");
  assert.ok(keys.includes("probe-claude") && !keys.some((k) => k.startsWith("fallback-")));
});

test("hard + one lane unreachable switches both lanes to the fallback pair", async () => {
  for (const outcome of ["fail", "throw"]) {
    const { result, calls, events } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], probe: { claude: outcome } });
    assert.equal(result.models.claude, "claude-bridge/claude-opus-5-5:high", outcome);
    assert.equal(result.models.codex, "openai-codex/gpt-6-sol:high", outcome);
    assert.equal(result.fallback, "fallback");
    assert.ok(calls.every((c) => !String(c.model).includes("fable") || c.key === "probe-claude"));
    assert.ok(events.some((e) => /Claude can't reach claude-fable-5-1/.test(e) && /opus-5-5/.test(e)), events.join("\n"));
  }
});

test("primary and fallback both unreachable stops the run instead of downgrading", async () => {
  for (const outcome of ["fail", "throw"]) {
    const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], probe: { claude: "fail" }, fallback: { claude: outcome } });
    await assert.rejects(s.run(), /Claude lane is unreachable/, outcome);
    assert.equal(s.store.state.status, "failed");
  }
});

test("non-hard tasks never probe", async () => {
  const { keys } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], triage: "medium" });
  assert.ok(!keys.some((k) => k.startsWith("probe-")));
});

test("args.fallback forces either pair without probing", async () => {
  const forced = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { fallback: true } });
  assert.ok(!forced.keys.some((k) => k.startsWith("probe-")));
  assert.equal(forced.result.models.claude, "claude-bridge/claude-opus-5-5:high");
  const primary = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { fallback: false } });
  assert.ok(!primary.keys.some((k) => k.startsWith("probe-")));
  assert.equal(primary.result.models.claude, "claude-bridge/claude-fable-5-1:high");
});

test("findings from the two reviewers get distinct ids", async () => {
  const { calls } = await simulate({ ...agree, reviews: [{ claude: p1, codex: p1 }, { claude: clean, codex: clean }] });
  const respond = calls.find((c) => c.key === "r1-respond-claude");
  const ids = [...respond.prompt.matchAll(/\[([A-Z0-9-]+)\]/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["CL1-1", "CX1-1"]);
});

test("metrics keep today's schema: timings, votes, plan sources, findings, dispositions", async () => {
  const { state } = await simulate({
    votes: { claude: "codex", codex: "codex" },
    reviews: [{ claude: p1, codex: p2 }, { claude: clean, codex: clean }],
    sources: { claude: ["codex", "codex", "claude", "both"], codex: ["codex", "claude", "new"] },
    dispositions: [{ id: "CL1-1", status: "FIXED" }, { id: "CX1-1", status: "REJECTED" }]
  });
  const m = state.metrics;
  assert.equal(m.schema, 1);
  assert.equal(m.integrator, "codex");
  assert.equal(m.decidedBy, "consensus");
  assert.deepEqual(m.votes, { claude: "codex", codex: "codex" });
  assert.ok(m.lanes.claude.draftMs > m.lanes.codex.draftMs, "claude draft slower in fake");
  assert.ok(m.lanes.claude.writerMs >= m.lanes.claude.draftMs);
  assert.ok(m.lanes.claude.discussMs > m.lanes.codex.discussMs);
  assert.deepEqual(m.plan.claude, { claude: 1, codex: 2, both: 1, new: 0 });
  assert.deepEqual(m.plan.codex, { claude: 1, codex: 1, both: 0, new: 1 });
  const r1 = m.reviews.filter((r) => r.round === 1);
  assert.equal(r1.find((r) => r.reviewer === "claude").findings[0].disposition, "FIXED");
  assert.equal(r1.find((r) => r.reviewer === "codex").findings[0].disposition, "REJECTED");
  assert.ok(m.stages.every((s) => typeof s.ms === "number" && s.model && s.stage));
  assert.ok(typeof m.totalMs === "number" && m.id && m.startedAt);
});

test("arbiter decisions are marked", async () => {
  const { state } = await simulate({ votes: { claude: "claude", codex: "codex" }, reviews: [{ claude: clean, codex: clean }] });
  assert.equal(state.metrics.decidedBy, "arbiter");
  assert.equal(state.decidedBy, "arbiter");
});

test("history reads as plain sentences through the whole run", async () => {
  const { events } = await simulate({ ...agree, reviews: [{ claude: p1, codex: clean }, { claude: clean, codex: clean }] });
  assert.ok(events.length > 10);
  assert.ok(events.some((e) => /drafting/i.test(e) && /Codex done in/.test(e) && /Claude still working/.test(e)), events.join("\n"));
  assert.ok(events.some((e) => /both drafts done/i.test(e)));
  assert.ok(events.some((e) => /middle road/i.test(e)));
  assert.ok(events.some((e) => /Integrator: Claude/.test(e) && /both agreed/i.test(e)));
  assert.ok(events.some((e) => /review round 1\/2/i.test(e) && /1 finding/.test(e) && /P0\/P1/.test(e)));
  assert.ok(events.some((e) => /applying fixes/i.test(e)));
  assert.ok(events.some((e) => /round 2.*clean/i.test(e)));
  assert.match(events.at(-1), /^Done · whetstone\/csv-export · total \d+s$/, "paths stay in the report, not the history");
});

// ---- New in the engine -----------------------------------------------------

test("state keeps the args and pid so a crashed run can be resumed", async () => {
  const { state, args } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  assert.deepEqual(state.args, args);
  assert.equal(state.pid, process.pid);
});

test("the engine creates the lane and final worktrees itself", async () => {
  const { ws, args } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  const root = join(args.repo, "..", ".whetstone", "peepmetrics-csv-export");
  assert.deepEqual(ws.added.map((w) => [w.path, w.branch, w.from]), [
    [join(root, "claude"), "whetstone/csv-export-claude", "HEAD"],
    [join(root, "codex"), "whetstone/csv-export-codex", "HEAD"],
    [join(root, "final"), "whetstone/csv-export", "whetstone/csv-export-claude"]
  ]);
});

test("writers keep one session per lane; reviewers and helpers get fresh ones", async () => {
  const { calls } = await simulate({ ...agree, reviews: [{ claude: p1, codex: clean }, { claude: clean, codex: clean }] });
  for (const who of ["claude", "codex"]) {
    const draft = calls.find((c) => c.key === "draft-" + who);
    assert.equal(draft.resume, false);
    const later = calls.filter((c) => c.lane === who && c.role === "writer" && c !== draft);
    assert.ok(later.length >= 3);
    assert.ok(later.every((c) => c.resume === true && c.session === draft.session), who);
  }
  const reviews = calls.filter((c) => c.role === "reviewer");
  assert.ok(reviews.every((c) => c.resume === false && c.readOnly === true));
  assert.equal(new Set(reviews.map((c) => c.session)).size, reviews.length);
});

test("each call runs on its lane's harness with the role's system prompt", async () => {
  const { calls } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  const draft = calls.find((c) => c.key === "draft-claude");
  assert.match(draft.system, /independent implementers/);
  assert.equal(draft.readOnly, false);
  assert.match(calls.find((c) => c.key === "triage").system, /rate how hard/i);
  assert.equal(calls.find((c) => c.key === "triage").model, "openai-codex/gpt-6-luna");
  assert.match(calls.find((c) => c.key === "report").system, /final report/i);
});

test("harness calls get the run's session folder and a raw log per stage", async () => {
  const { calls, store } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  const draft = calls.find((c) => c.key === "draft-claude");
  assert.equal(draft.sessionDir, join(store.dir, "sessions"));
  assert.equal(draft.logFile, join(store.dir, "logs", "draft-claude.jsonl"));
  assert.ok(calls.every((c) => c.sessionDir === draft.sessionDir && c.logFile.startsWith(join(store.dir, "logs"))));
});

test("resumed stages that move directories say where to work", async () => {
  const { calls, store } = await simulate({ ...agree, reviews: [{ claude: p2, codex: clean }] });
  const finalPath = store.state.finalPath;
  for (const key of ["integrate", "r1-fix"]) {
    assert.match(calls.find((c) => c.key === key).prompt, new RegExp("cd " + finalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), key);
  }
});

test("stage outputs are saved as numbered files in the report folder", async () => {
  const { state } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }] });
  const file = state.results["draft-claude"].file;
  assert.match(file, /\/report\/\d\d-draft-claude\.md$/);
  assert.equal(await readFile(file, "utf8"), "ok draft-claude");
});

test("state.json stays small: stage replies live in the report files", async () => {
  const big = "x".repeat(200_000);
  const { store } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }], override: { "draft-claude": () => ({ text: big }), "draft-codex": () => ({ text: big }) } });
  const onDisk = await readFile(join(store.dir, "state.json"), "utf8");
  assert.ok(onDisk.length < 100_000, "state.json is " + onDisk.length + " bytes");
  assert.equal(JSON.parse(onDisk).results["draft-claude"].text, undefined);
  assert.equal((await readFile(store.state.results["draft-claude"].file, "utf8")).length, big.length);
});

test("an invalid structured reply is re-asked once in the same session", async () => {
  let n = 0;
  const { calls, result } = await simulate({
    ...agree, reviews: [{ claude: clean, codex: clean }],
    override: { triage: (req) => (++n === 1 ? { text: "it's medium I think" } : { text: fence({ difficulty: "easy", reasoning: "small", risks: [] }) }) }
  });
  const triage = calls.filter((c) => c.key === "triage");
  assert.equal(triage.length, 2);
  assert.equal(triage[1].resume, true);
  assert.equal(triage[1].session, triage[0].session);
  assert.equal(result.difficulty, "easy");
});

test("a reviewer that never returns valid JSON counts as an UNKNOWN verdict and triggers responses", async () => {
  const { keys, result } = await simulate({ ...agree, reviews: [{ claude: clean, codex: clean }, { claude: clean, codex: clean }], override: { "r1-review-codex": () => ({ text: "looks fine" }) } });
  assert.equal(result.rounds[0].verdicts.codex, "UNKNOWN");
  assert.ok(keys.includes("r1-respond-claude"));
});

test("a failed writer stage fails the run and records why", async () => {
  const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], override: { "draft-codex": () => ({ ok: false, text: "", error: "rate limited" }) } });
  await assert.rejects(s.run(), /Codex draft failed: rate limited/);
  assert.equal(s.store.state.status, "failed");
  assert.match(s.store.state.error, /rate limited/);
});

test("rerunning after a crash reuses finished stages and continues the same sessions", async () => {
  let crash = true;
  const first = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], override: { integrate: () => (crash ? { ok: false, text: "", error: "process died" } : { text: "integrated" }) } });
  await assert.rejects(first.run(), /process died/);
  const draftSession = first.fake.calls.find((c) => c.key === "draft-claude").session;
  crash = false;
  const before = first.fake.calls.length;
  const result = await first.run();
  const again = first.fake.calls.slice(before).map((c) => c.key);
  assert.equal(again[0], "integrate");
  assert.match(first.fake.calls.slice(before)[0].prompt, /INTEGRATOR: claude/, "the peer's converge text is read back for the prompt");
  assert.ok(!again.some((k) => /^(triage|probe-|draft-|critique-|converge-)/.test(k)));
  assert.equal(first.fake.calls.slice(before)[0].session, draftSession);
  assert.equal(first.ws.added.filter((w) => w.path.endsWith("/final")).length, 1, "final worktree created once");
  assert.equal(result.integrator, "claude");
  assert.equal(first.store.state.status, "done");
});

test("pause after this step holds before the next stage and resumes when cleared", async () => {
  const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty: "easy" } });
  await control(s.store, { pause: "after-step" });
  const running = s.run();
  await until(() => s.store.state.status === "paused");
  await sleep(30);
  assert.equal(s.fake.calls.length, 0);
  await control(s.store, {});
  await running;
  assert.equal(s.store.state.status, "done");
  assert.ok((await events(s.store)).some((e) => /^Paused/.test(e)));
});

test("stop ends the run as stopped at the next boundary", async () => {
  const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty: "easy" }, override: { "draft-claude": async () => { await control(s.store, { stop: true }); return { text: "drafted" }; } } });
  await assert.rejects(s.run(), /stopped/i);
  assert.equal(s.store.state.status, "stopped");
  assert.ok(!s.fake.calls.some((c) => c.key.startsWith("critique-")));
});

test("step mode waits for approval before each new step", async () => {
  const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty: "easy", stepMode: true } });
  const running = s.run();
  await until(() => s.store.state.status === "waiting");
  assert.deepEqual(s.store.state.next, { step: 2, name: "Draft" });
  assert.equal(s.fake.calls.length, 0);
  await control(s.store, { approved: 2 });
  await until(() => s.store.state.status === "waiting" && s.store.state.next.step === 3);
  assert.ok(s.fake.calls.some((c) => c.key === "draft-claude") && !s.fake.calls.some((c) => c.key.startsWith("critique-")));
  await control(s.store, { approved: 6 });
  await running;
  assert.equal(s.store.state.status, "done");
});

test("a writer's question blocks its lane until the operator answers", async () => {
  let asked = false;
  const s = await setup({
    ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty: "easy" },
    override: {
      "draft-claude": (req) => {
        if (!asked) { asked = true; return { text: "Halfway.\n```question\nInclude archived rows? A) yes B) no. I recommend B.\n```" }; }
        return { text: "drafted with answer" };
      }
    }
  });
  const running = s.run();
  await until(() => s.store.state.question);
  const q = s.store.state.question;
  assert.equal(q.lane, "claude");
  assert.equal(q.stage, "draft-claude");
  assert.match(q.text, /archived rows/);
  assert.equal(s.store.state.lanes.claude.status, "blocked");
  await control(s.store, { answers: { [q.id]: "B, skip archived rows" } });
  await running;
  const drafts = s.fake.calls.filter((c) => c.key === "draft-claude");
  assert.equal(drafts.length, 2);
  assert.equal(drafts[1].resume, true);
  assert.equal(drafts[1].session, drafts[0].session);
  assert.match(drafts[1].prompt, /B, skip archived rows/);
  assert.equal(s.store.state.question, null);
  assert.match(await readFile(s.store.state.results["draft-claude"].file, "utf8"), /drafted with answer/);
});

test("state tells the pane what each lane is doing", async () => {
  const s = await setup({ ...agree, reviews: [{ claude: clean, codex: clean }], args: { difficulty: "easy" }, delays: { claude: 80, codex: 1 } });
  const running = s.run();
  await until(() => s.store.state.lanes?.claude?.status === "working" && s.store.state.lanes.codex.status === "done");
  const lanes = s.store.state.lanes;
  assert.equal(lanes.claude.role, "writer");
  assert.equal(lanes.claude.stage, "draft-claude");
  assert.equal(lanes.claude.name, "Claude");
  assert.equal(lanes.claude.harness, "pi");
  assert.equal(lanes.claude.model, pi.tiers.easy.claude);
  assert.equal(s.store.state.step, 2);
  await running;
  const st = s.store.state;
  assert.equal(st.status, "done");
  assert.equal(st.integrator, "claude");
  assert.deepEqual(st.steps, ["Triage", "Draft", "Debate", "Integrate", "Review", "Report"]);
  assert.equal(st.rounds[0].round, 1);
  assert.match(st.report, /REPORT\.md$/);
  assert.equal(st.finalBranch, "whetstone/csv-export");
});
