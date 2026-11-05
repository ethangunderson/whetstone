import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store.mjs";

async function fresh() {
  return join(await mkdtemp(join(tmpdir(), "whetstone-store-")), "run");
}

test("update writes state.json and reopening reads it back", async () => {
  const dir = await fresh();
  const store = await openStore(dir);
  await store.update((s) => { s.status = "running"; s.step = 2; });
  const onDisk = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
  assert.equal(onDisk.status, "running");
  const again = await openStore(dir);
  assert.equal(again.state.step, 2);
});

test("concurrent updates all land", async () => {
  const store = await openStore(await fresh());
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update((s) => { s["k" + i] = i; })));
  const onDisk = JSON.parse(await readFile(join(store.dir, "state.json"), "utf8"));
  assert.equal(Object.keys(onDisk).filter((k) => k.startsWith("k")).length, 20);
});

test("event appends to events.jsonl and sets latest", async () => {
  const store = await openStore(await fresh());
  await store.event("Step 1/6 · Rating difficulty");
  await store.event("Step 2/6 · Drafting");
  const lines = (await readFile(join(store.dir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.text), ["Step 1/6 · Rating difficulty", "Step 2/6 · Drafting"]);
  assert.ok(lines.every((l) => typeof l.at === "string"));
  assert.equal(store.state.latest, "Step 2/6 · Drafting");
});

test("readControl is empty without a file and tolerates a half-written one", async () => {
  const store = await openStore(await fresh());
  assert.deepEqual(await store.readControl(), {});
  await writeFile(join(store.dir, "control.json"), "{\"pause\":");
  assert.deepEqual(await store.readControl(), {});
  await writeFile(join(store.dir, "control.json"), "{\"pause\":\"after-step\"}");
  assert.deepEqual(await store.readControl(), { pause: "after-step" });
});
