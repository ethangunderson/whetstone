import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWorkspace } from "../workspace.mjs";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "whetstone-ws-"));
  const dir = join(root, "app");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  await writeFile(join(dir, "README"), "hi\n");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);
  return { root, dir };
}

test("addWorktree creates the branch and checkout", async () => {
  const { root, dir } = await repo();
  const path = join(root, ".whetstone", "app-x", "claude");
  await gitWorkspace.addWorktree({ repo: dir, path, branch: "whetstone/x-claude", from: "HEAD" });
  assert.ok(existsSync(join(path, "README")));
  assert.equal(execFileSync("git", ["-C", path, "branch", "--show-current"], { encoding: "utf8" }).trim(), "whetstone/x-claude");
});

test("addWorktree refuses an existing branch or path instead of overwriting", async () => {
  const { root, dir } = await repo();
  const path = join(root, ".whetstone", "app-y", "claude");
  await gitWorkspace.addWorktree({ repo: dir, path, branch: "whetstone/y-claude", from: "HEAD" });
  await assert.rejects(gitWorkspace.addWorktree({ repo: dir, path: path + "2", branch: "whetstone/y-claude", from: "HEAD" }), /already exists/);
  await assert.rejects(gitWorkspace.addWorktree({ repo: dir, path, branch: "whetstone/y-other", from: "HEAD" }), /already exists/);
});
