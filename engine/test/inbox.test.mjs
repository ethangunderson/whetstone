import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInbox } from "../inbox.mjs";

test("next returns a buffered line that matches and leaves the rest", async () => {
  const inbox = createInbox();
  inbox.push("noise");
  inbox.push("done draft-claude k1");
  assert.equal(await inbox.next((l) => l.startsWith("done "), 50), "done draft-claude k1");
  assert.equal(await inbox.next((l) => l === "noise", 50), "noise");
});

test("next waits for a line that arrives later", async () => {
  const inbox = createInbox();
  setTimeout(() => inbox.push("done x k"), 20);
  assert.equal(await inbox.next((l) => l === "done x k", 1000), "done x k");
});

test("next gives up with null after the timeout", async () => {
  const inbox = createInbox();
  assert.equal(await inbox.next(() => true, 20), null);
});

test("two waiters each get their own line", async () => {
  const inbox = createInbox();
  const a = inbox.next((l) => l === "a", 500);
  const b = inbox.next((l) => l === "b", 500);
  inbox.push("b");
  inbox.push("a");
  assert.deepEqual(await Promise.all([a, b]), ["a", "b"]);
});

test("lines are read from a stream, one per line, trimmed", async () => {
  const stream = new PassThrough();
  const inbox = createInbox({ stream });
  stream.write("done a k1\r\npartial");
  stream.write(" line\n");
  assert.equal(await inbox.next((l) => l === "done a k1", 200), "done a k1");
  assert.equal(await inbox.next((l) => l === "partial line", 200), "partial line");
});
