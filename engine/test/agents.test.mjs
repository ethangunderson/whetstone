import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const role = (name) => readFile(new URL(`../agents/${name}.md`, import.meta.url), "utf8");

test("writer and reviewer role prompts forbid starting agents of their own", async () => {
  const roles = ["writer", "reviewer"];
  const texts = await Promise.all(roles.map(role));
  const forbidding = roles.filter((_, i) => /don't start other agents/i.test(texts[i]) && /no `hc run`/.test(texts[i]));
  assert.deepEqual(forbidding, roles);
});
