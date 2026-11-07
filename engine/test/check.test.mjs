import { test } from "node:test";
import assert from "node:assert/strict";
import { harnessChecks, preflight } from "../check.mjs";

const TIERS = {
  easy: { claude: "c-easy", codex: "x-easy" },
  medium: { claude: "c-med", codex: "x-med" },
  hard: { claude: "c-hard", codex: "x-hard", fallback: { claude: "c-fb", codex: "x-fb" } }
};
const CONFIG = {
  lanes: [{ id: "claude", name: "Claude", harness: "herdr" }, { id: "codex", name: "Codex", harness: "pi" }],
  tiers: TIERS
};
const installed = (version) => ({ detect: async () => ({ installed: true, version }) });
const missing = { detect: async () => ({ installed: false }) };

function deps(over = {}) {
  return {
    repo: "/r/app",
    git: {
      root: async (dir) => { if (dir !== "/r/app") throw new Error("not a git repository"); return "/r/app"; },
      commit: async (_root, ref) => { if (ref !== "HEAD" && ref !== "main") throw new Error("unknown ref"); return "abc1234"; }
    },
    runs: async () => [],
    loadConfig: async () => CONFIG,
    adapters: { herdr: installed(""), pi: installed("0.9.1") },
    ...over
  };
}

const byWhat = (result) => Object.fromEntries(result.checks.map((c) => [c.what, c]));

test("a ready repo passes every check and lists the tier models", async () => {
  const result = await preflight(deps());
  assert.equal(result.ok, true);
  assert.equal(result.repo, "/r/app");
  assert.equal(result.baseRef, "HEAD");
  assert.deepEqual(result.checks.map((c) => [c.ok, c.what]), [
    [true, "git repo"],
    [true, "base ref"],
    [true, "no active run"],
    [true, "config"],
    [true, "Claude harness"],
    [true, "Codex harness"]
  ]);
  assert.equal(byWhat(result)["base ref"].detail, "HEAD at abc1234");
  assert.deepEqual(result.tiers, TIERS);
  for (const c of result.checks) assert.deepEqual(Object.keys(c).sort(), ["detail", "ok", "what"]);
});

test("a folder that is not a git repo fails, and so does its base ref", async () => {
  const result = await preflight(deps({ repo: "/r/plain" }));
  assert.equal(result.ok, false);
  const c = byWhat(result);
  assert.equal(c["git repo"].ok, false);
  assert.match(c["git repo"].detail, /not a git repository/);
  assert.equal(c["base ref"].ok, false);
  assert.equal(result.repo, "/r/plain");
});

test("a missing base ref fails with the ref named", async () => {
  const result = await preflight(deps({ baseRef: "nope" }));
  assert.equal(result.ok, false);
  assert.equal(byWhat(result)["base ref"].ok, false);
  assert.match(byWhat(result)["base ref"].detail, /nope/);
});

test("only an active run on the same repo blocks a start", async () => {
  const runs = [
    { id: "other-repo-1", repo: "/r/other", status: "running" },
    { id: "finished-1", repo: "/r/app", status: "done" },
    { id: "dead-1", repo: "/r/app", status: "interrupted" },
    { id: "failed-1", repo: "/r/app", status: "failed" }
  ];
  assert.equal(byWhat(await preflight(deps({ runs: async () => runs })))["no active run"].ok, true);

  for (const status of ["running", "paused", "waiting", "blocked"]) {
    const busy = [...runs, { id: "busy-1", repo: "/r/app", status }];
    const c = byWhat(await preflight(deps({ runs: async () => busy })))["no active run"];
    assert.equal(c.ok, false, status + " blocks");
    assert.match(c.detail, /busy-1/);
  }
});

test("a config that does not load fails, and harnesses and tiers are left out", async () => {
  const result = await preflight(deps({ loadConfig: async () => { throw new Error("config needs exactly two lanes, got 1"); } }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map((c) => c.what), ["git repo", "base ref", "no active run", "config"]);
  assert.match(byWhat(result).config.detail, /two lanes/);
  assert.equal(result.tiers, null);
});

test("harnessChecks reports each lane: ready with version, not installed, or no adapter", async () => {
  const lanes = [
    { id: "a", name: "Alpha", harness: "pi" },
    { id: "b", name: "Beta", harness: "herdr" },
    { id: "c", name: "Gamma", harness: "codex" }
  ];
  assert.deepEqual(await harnessChecks(lanes, { pi: installed("0.9.1"), herdr: missing }), [
    { ok: true, what: "Alpha harness", detail: "pi 0.9.1" },
    { ok: false, what: "Beta harness", detail: "herdr not installed" },
    { ok: false, what: "Gamma harness", detail: "codex has no adapter yet" }
  ]);
});

test("a harness whose detect throws counts as not ready", async () => {
  const [c] = await harnessChecks([{ id: "a", name: "Alpha", harness: "pi" }], { pi: { detect: async () => { throw new Error("boom"); } } });
  assert.equal(c.ok, false);
  assert.match(c.detail, /boom/);
});
