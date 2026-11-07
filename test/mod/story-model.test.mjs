import assert from "node:assert/strict";
import { test } from "node:test";
import { activityItems, laneStages, rounds, storySections } from "../../mods/whetstone/model.js";

const lanes = {
  claude: { name: "Claude", role: "writer", status: "done" },
  codex: { name: "Codex", role: "writer", status: "working", stage: "critique-codex" },
};

test("storySections is empty before any draft is done", () => {
  assert.deepEqual(storySections({ lanes, story: { drafts: {}, critiques: {}, converge: {} } }), []);
  assert.deepEqual(storySections({ lanes }), []);
});

test("approaches show each lane's draft summary", () => {
  const [s] = storySections({
    lanes,
    story: {
      drafts: { claude: { approach: "Stream rows.", choices: ["no lib"], weakSpots: ["memory"] } },
      critiques: {},
      converge: {},
    },
  });
  assert.deepEqual(s, {
    kind: "approaches",
    title: "Approaches",
    lanes: [
      { id: "claude", name: "Claude", approach: "Stream rows.", choices: ["no lib"], weakSpots: ["memory"] },
      { id: "codex", name: "Codex", approach: null, choices: [], weakSpots: [] },
    ],
  });
});

test("the debate shows what each lane conceded and defended, and its base vote", () => {
  const sections = storySections({
    lanes,
    story: {
      drafts: {
        claude: { approach: "a", choices: [], weakSpots: [] },
        codex: { approach: "b", choices: [], weakSpots: [] },
      },
      critiques: {
        claude: {
          peerBetter: ["their tests"],
          mineBetter: ["streaming"],
          middleRoad: "Stream with tests.",
          base: "codex",
        },
      },
      converge: {},
    },
  });
  assert.equal(sections[1].kind, "debate");
  assert.deepEqual(sections[1].lanes[0], {
    id: "claude",
    name: "Claude",
    peerBetter: ["their tests"],
    mineBetter: ["streaming"],
    middleRoad: "Stream with tests.",
    base: "Codex",
  });
  assert.equal(sections[1].lanes[1].middleRoad, null, "a lane still critiquing has nothing yet");
});

test("the agreement explains the integrator choice, concessions, holdouts and the plan's sources", () => {
  const sections = storySections({
    lanes,
    story: {
      drafts: { claude: { approach: "a", choices: [], weakSpots: [] } },
      critiques: {},
      converge: {
        claude: { vote: "codex", why: "Smaller diff.", concessions: ["their tests"], holding: [], items: [] },
        codex: { vote: "codex", why: "Has tests.", concessions: ["streaming"], holding: ["header casing"], items: [] },
      },
      plan: {
        from: "codex",
        items: [
          { item: "stream rows", source: "claude" },
          { item: "tests", source: "codex" },
          { item: "BOM", source: "both" },
          { item: "docs", source: "new" },
        ],
      },
      selection: {
        integrator: "codex",
        decidedBy: "consensus",
        reasons: { claude: "Smaller diff.", codex: "Has tests." },
        arbiter: null,
      },
    },
  });
  const a = sections.find((s) => s.kind === "agreement");
  assert.equal(a.integrator, "Codex");
  assert.equal(a.how, "Both chose Codex");
  assert.deepEqual(a.reasons, [
    { name: "Claude", vote: "Codex", why: "Smaller diff." },
    { name: "Codex", vote: "Codex", why: "Has tests." },
  ]);
  assert.deepEqual(a.concessions, [
    { name: "Claude", conceded: ["their tests"], holding: [] },
    { name: "Codex", conceded: ["streaming"], holding: ["header casing"] },
  ]);
  assert.deepEqual(a.plan, [
    { item: "stream rows", source: "Claude" },
    { item: "tests", source: "Codex" },
    { item: "BOM", source: "Both" },
    { item: "docs", source: "New" },
  ]);
  assert.equal(a.arbiter, null);
});

test("an arbiter decision says so and shows its reasoning", () => {
  const sections = storySections({
    lanes,
    story: {
      drafts: {},
      critiques: {},
      converge: {},
      plan: { from: "claude", items: [] },
      selection: {
        integrator: "claude",
        decidedBy: "arbiter",
        reasons: { claude: "", codex: "" },
        arbiter: "Cleaner seam.",
      },
    },
  });
  const a = sections.find((s) => s.kind === "agreement");
  assert.equal(a.how, "They disagreed; the arbiter chose Claude");
  assert.equal(a.arbiter, "Cleaner seam.");
  assert.deepEqual(a.reasons, [], "blank reasons are left out");
});

test("rounds carry each writer's position and why a finding was resolved", () => {
  const r = rounds({
    lanes,
    rounds: [
      {
        round: 1,
        findings: [
          {
            id: "CL1-1",
            severity: "P1",
            reviewer: "claude",
            title: "Crash",
            disposition: "FIXED",
            why: "Guarded.",
            positions: { claude: { position: "ACCEPT", why: "Real." }, codex: { position: "MODIFY", why: "Earlier." } },
          },
        ],
      },
    ],
  });
  assert.deepEqual(r[0].findings[0].positions, [
    { name: "Claude", position: "accept", why: "Real." },
    { name: "Codex", position: "modify", why: "Earlier." },
  ]);
  assert.equal(r[0].findings[0].why, "Guarded.");
});

test("laneStages lists a lane's stages in run order with their state", () => {
  const state = {
    lanes,
    running: { "critique-codex": { lane: "codex", role: "writer" } },
    results: {
      "draft-codex": { ok: true, lane: "codex", role: "writer", file: "/r/02-draft-codex.md" },
      "draft-claude": { ok: true, lane: "claude", role: "writer", file: "/r/01-draft-claude.md" },
      "r1-review-codex": { ok: true, lane: "codex", role: "reviewer", file: "/r/08-r1-review-codex.md" },
      triage: { ok: true, lane: "codex", role: "triage", file: "/r/00-triage.md" },
      integrate: { ok: false, lane: "codex", role: "writer", file: "/r/07-integrate.md" },
    },
  };
  assert.deepEqual(laneStages(state, "codex"), [
    { key: "draft-codex", label: "Draft", state: "done", file: "/r/02-draft-codex.md" },
    { key: "critique-codex", label: "Critique", state: "running", file: null },
    { key: "integrate", label: "Integrate", state: "failed", file: "/r/07-integrate.md" },
    { key: "r1-review-codex", label: "Review 1", state: "done", file: "/r/08-r1-review-codex.md" },
  ]);
});

test("activityItems pairs each tool call with its result and keeps text and errors", () => {
  const lines = `${[
    { at: "t", kind: "tool", id: "a", tool: "bash", text: "npm test" },
    { at: "t", kind: "text", text: "Tests pass." },
    { at: "t", kind: "tool_end", id: "a", ok: true, text: "pass 3", ms: 1200 },
    { at: "t", kind: "tool", id: "b", tool: "edit", text: "src/x.js" },
    { at: "t", kind: "error", text: "overloaded" },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n")}\nnot json\n`;
  assert.deepEqual(activityItems(lines), [
    { kind: "tool", tool: "bash", text: "npm test", status: "ok", output: "pass 3", ms: 1200 },
    { kind: "text", text: "Tests pass." },
    { kind: "tool", tool: "edit", text: "src/x.js", status: "running", output: "", ms: null },
    { kind: "error", text: "overloaded" },
  ]);
});

test("a tool that finishes with no output still counts as finished", () => {
  const lines = [
    { kind: "tool", id: "a", tool: "bash", text: "git add ." },
    { kind: "tool_end", id: "a", ok: true, text: "" },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  assert.equal(activityItems(lines)[0].status, "ok");
});
