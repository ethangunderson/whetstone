import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, resolveConfig, splitModel } from "../config.mjs";

test("splitModel separates a trailing effort level", () => {
  assert.deepEqual(splitModel("claude-bridge/claude-opus-5-5:high"), { model: "claude-bridge/claude-opus-5-5", effort: "high" });
  assert.deepEqual(splitModel("gpt-6-sol"), { model: "gpt-6-sol", effort: undefined });
  assert.deepEqual(splitModel("weird:model:low"), { model: "weird:model", effort: "low" });
});

test("defaults run both lanes through pi with today's tiers", () => {
  const config = resolveConfig();
  assert.deepEqual(config.lanes.map((l) => [l.id, l.harness, l.prefix]), [["claude", "pi", "CL"], ["codex", "pi", "CX"]]);
  assert.equal(config.tiers.hard.claude, "claude-bridge/claude-fable-5-1:high");
  assert.equal(config.tiers.hard.fallback.claude, "claude-bridge/claude-opus-5-5:high");
  assert.equal(config.triage.lane, "codex");
});

test("a user config can swap harnesses and models per lane", () => {
  const config = resolveConfig({
    lanes: [
      { id: "claude", name: "Claude", harness: "claude-code" },
      { id: "codex", name: "Codex", harness: "codex" }
    ],
    tiers: {
      easy: { claude: "claude-sonnet-5-5:medium", codex: "gpt-6-luna:medium" },
      medium: { claude: "claude-opus-5-5:medium", codex: "gpt-6-sol:medium" },
      hard: { claude: "claude-opus-5-5:high", codex: "gpt-6.1-sol:high" }
    },
    triage: { lane: "codex", model: "gpt-6-luna:low" },
    reporter: { lane: "claude", model: "claude-sonnet-5-5:medium" }
  });
  assert.equal(config.lanes[0].harness, "claude-code");
  assert.equal(config.arbiter.lane, "codex", "arbiter defaults to the second lane");
});

test("lane prefixes default to distinct initials", () => {
  const config = resolveConfig({
    lanes: [{ id: "alpha", harness: "pi" }, { id: "alto", harness: "pi" }],
    tiers: Object.fromEntries(["easy", "medium", "hard"].map((t) => [t, { alpha: "m", alto: "m" }])),
    triage: { lane: "alpha", model: "m" },
    reporter: { lane: "alpha", model: "m" }
  });
  const [a, b] = config.lanes.map((l) => l.prefix);
  assert.notEqual(a, b);
  assert.equal(config.lanes[0].name, "Alpha");
});

test("invalid configs fail loudly", () => {
  assert.throws(() => resolveConfig({ ...DEFAULT_CONFIG, lanes: [DEFAULT_CONFIG.lanes[0]] }), /exactly two lanes/);
  assert.throws(() => resolveConfig({ ...DEFAULT_CONFIG, tiers: { ...DEFAULT_CONFIG.tiers, easy: { claude: "x" } } }), /tiers\.easy.*codex/);
  assert.throws(() => resolveConfig({ ...DEFAULT_CONFIG, triage: { lane: "nobody", model: "m" } }), /triage\.lane/);
});
