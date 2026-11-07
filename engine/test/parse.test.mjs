import assert from "node:assert/strict";
import { test } from "node:test";
import { isArbiter, isReview, isTriage, lastJson, lastTag, parseQuestion } from "../parse.mjs";

test("lastJson returns the last valid fenced json block", () => {
  const text = 'a\n```json\n{"x":1}\n```\nb\n```json\n{bad\n```\n';
  assert.deepEqual(lastJson(text), { x: 1 });
  assert.equal(lastJson("no blocks"), undefined);
  assert.equal(lastJson(undefined), undefined);
});

test("lastTag returns the last allowed value of a tag line", () => {
  const text = "INTEGRATOR: claude\nthinking...\nintegrator: Codex\n";
  assert.equal(lastTag(text, "INTEGRATOR", ["claude", "codex"]), "codex");
  assert.equal(lastTag("INTEGRATOR: bob", "INTEGRATOR", ["claude", "codex"]), undefined);
});

test("parseQuestion reads the last fenced question block", () => {
  const text = "Working.\n```question\nShould exports include archived rows?\nA) yes B) no. I recommend B.\n```\n";
  assert.equal(parseQuestion(text), "Should exports include archived rows?\nA) yes B) no. I recommend B.");
  assert.equal(parseQuestion("done, no questions"), undefined);
  assert.equal(parseQuestion("```question\n   \n```"), undefined);
});

test("validators accept well-formed decisions and reject the rest", () => {
  assert.ok(isTriage({ difficulty: "hard", reasoning: "r", risks: [] }));
  assert.ok(!isTriage({ difficulty: "extreme", reasoning: "r", risks: [] }));
  assert.ok(isReview({ verdict: "OK", summary: "s", findings: [] }));
  assert.ok(
    isReview({
      verdict: "BLOCK",
      summary: "s",
      findings: [{ severity: "P1", title: "t", location: "l", evidence: "e", suggestedFix: "f" }],
    }),
  );
  assert.ok(!isReview({ verdict: "BLOCK", summary: "s", findings: [{ severity: "P9", title: "t" }] }));
  assert.ok(!isReview(undefined));
  assert.ok(isArbiter({ integrator: "codex", reasoning: "r", mergedPlan: "p" }, ["claude", "codex"]));
  assert.ok(!isArbiter({ integrator: "bob", reasoning: "r", mergedPlan: "p" }, ["claude", "codex"]));
});
