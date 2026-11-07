import assert from "node:assert/strict";
import { test } from "node:test";
import { convergeSummary, critiqueSummary, dispositionsOf, draftSummary, positionsOf } from "../story.mjs";

const fence = (obj) => `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
const ids = ["claude", "codex"];

test("draftSummary reads the approach block", () => {
  const text =
    "## Approach\nlong prose\n" +
    fence({
      approach: "Stream rows to the response.",
      choices: ["no CSV library", "chunked"],
      weakSpots: ["memory on huge exports"],
    });
  assert.deepEqual(draftSummary(text), {
    approach: "Stream rows to the response.",
    choices: ["no CSV library", "chunked"],
    weakSpots: ["memory on huge exports"],
  });
});

test("draftSummary falls back to the first line of prose when the block is missing", () => {
  assert.deepEqual(draftSummary("\n## 1. Approach: build it in memory, then send.\nMore."), {
    approach: "1. Approach: build it in memory, then send.",
    choices: [],
    weakSpots: [],
  });
  assert.deepEqual(draftSummary(""), { approach: "", choices: [], weakSpots: [] });
});

test("summaries drop non-string list entries and clip long text", () => {
  const s = draftSummary(fence({ approach: "x".repeat(2000), choices: ["ok", 3, null], weakSpots: "not a list" }));
  assert.ok(s.approach.length <= 601);
  assert.deepEqual(s.choices, ["ok"]);
  assert.deepEqual(s.weakSpots, []);
});

test("critiqueSummary reads what each side did better, the middle road and the base vote", () => {
  const text =
    "prose\n" +
    fence({ peerBetter: ["their tests"], mineBetter: ["streaming"], middleRoad: "My streaming with their tests." }) +
    "\nBASE: codex";
  assert.deepEqual(critiqueSummary(text, ids), {
    peerBetter: ["their tests"],
    mineBetter: ["streaming"],
    middleRoad: "My streaming with their tests.",
    base: "codex",
  });
  assert.deepEqual(critiqueSummary("no block", ids), { peerBetter: [], mineBetter: [], middleRoad: "", base: null });
});

test("convergeSummary reads the vote, why, concessions, holdouts and plan items", () => {
  const text = `${fence({
    integrator: "codex",
    why: "Less to change.",
    concessions: ["their error type"],
    holding: ["header casing"],
    items: [
      { item: "stream rows", source: "claude" },
      { item: "error type", source: "codex" },
      { item: "bad", source: "martian" },
      "junk",
    ],
  })}\nINTEGRATOR: codex`;
  assert.deepEqual(convergeSummary(text, ids), {
    vote: "codex",
    why: "Less to change.",
    concessions: ["their error type"],
    holding: ["header casing"],
    items: [
      { item: "stream rows", source: "claude" },
      { item: "error type", source: "codex" },
    ],
  });
  assert.equal(convergeSummary("INTEGRATOR: claude", ids).vote, "claude", "the tag line alone is enough for the vote");
});

test("positionsOf maps finding ids to a writer's position", () => {
  const text = fence({
    positions: [
      { id: "CL1-1", position: "ACCEPT", why: "Real crash." },
      { id: "CX1-1", position: "reject", why: "By design." },
      { id: "CX1-2", position: "SHRUG" },
    ],
  });
  assert.deepEqual(positionsOf(text), {
    "CL1-1": { position: "ACCEPT", why: "Real crash." },
    "CX1-1": { position: "REJECT", why: "By design." },
  });
  assert.deepEqual(positionsOf("nothing"), {});
});

test("dispositionsOf maps finding ids to the integrator's resolution", () => {
  const text = fence({
    dispositions: [
      { id: "CL1-1", status: "FIXED", why: "Guarded empty input." },
      { id: "CX1-1", status: "REJECTED" },
      { id: "X", status: "MAYBE" },
    ],
  });
  assert.deepEqual(dispositionsOf(text), {
    "CL1-1": { status: "FIXED", why: "Guarded empty input." },
    "CX1-1": { status: "REJECTED", why: "" },
  });
});
