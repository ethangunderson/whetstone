// The git hooks in .githooks, run by real git against throwaway repos. Biome,
// shellcheck and npm's check are stubs that log their calls, so these tests pin
// down which copy a hook finds and what it hands over, not the tools themselves.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const HOOKS = resolve(import.meta.dirname, "../../.githooks");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

// Without the GIT_ variables this process may have inherited (from a hook, say),
// so git here only ever sees the temp repo it runs in.
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

function sh(cwd, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...BASE_ENV, ...GIT_ENV, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
}

const git = (cwd, ...args) => sh(cwd, "git", args);

async function stub(path, log, exitCode = 0) {
  await writeFile(path, `#!/bin/sh\necho "${path} $*" >> "${log}"\nexit ${exitCode}\n`);
  await chmod(path, 0o755);
}

async function stubBiome(checkout, log, exitCode = 0) {
  await mkdir(join(checkout, "node_modules/.bin"), { recursive: true });
  await stub(join(checkout, "node_modules/.bin/biome"), log, exitCode);
}

const logged = async (log) => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);

// A repo with the hooks installed the way `npm install` installs them, a stub
// shellcheck on PATH, and one commit so worktrees can branch from it.
async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "whetstone-hooks-")));
  const main = join(dir, "main");
  const log = join(dir, "calls.log");
  const bin = join(dir, "bin");
  await mkdir(main);
  await mkdir(bin);
  await stub(join(bin, "shellcheck"), log);
  await cp(HOOKS, join(main, ".githooks"), { recursive: true });
  await writeFile(join(main, ".gitignore"), "node_modules/\n");
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "core.hooksPath", ".githooks");
  git(main, "add", ".");
  git(main, "commit", "-q", "--no-verify", "-m", "init");
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const commit = (cwd, file = "a.js") =>
    writeFile(join(cwd, file), `${Math.random()}\n`).then(() => {
      git(cwd, "add", file);
      return sh(cwd, "git", ["commit", "-q", "-m", `change ${file}`], env);
    });
  const worktree = (name) => {
    const path = join(dir, name);
    git(main, "worktree", "add", "-q", "-b", name, path);
    return path;
  };
  return { dir, main, log, bin, env, commit, worktree };
}

test("pre-commit runs Biome from the checkout's own node_modules", async () => {
  const { main, log, commit } = await setup();
  await stubBiome(main, log);
  const r = await commit(main);
  assert.equal(r.code, 0, r.out);
  const calls = await logged(log);
  assert.equal(calls.length, 1);
  assert.match(calls[0], new RegExp(`^${join(main, "node_modules/.bin/biome")} check --staged`));
});

test("pre-commit in a worktree with no node_modules uses the main checkout's Biome", async () => {
  const { main, log, commit, worktree } = await setup();
  await stubBiome(main, log);
  const lane = worktree("lane");
  const r = await commit(lane);
  assert.equal(r.code, 0, r.out);
  assert.match((await logged(log))[0], new RegExp(`^${join(main, "node_modules/.bin/biome")} `));
});

test("pre-commit in a worktree with its own node_modules uses that Biome", async () => {
  const { main, log, commit, worktree } = await setup();
  await stubBiome(main, log);
  const lane = worktree("lane");
  await stubBiome(lane, log);
  const r = await commit(lane);
  assert.equal(r.code, 0, r.out);
  assert.match((await logged(log))[0], new RegExp(`^${join(lane, "node_modules/.bin/biome")} `));
});

test("pre-commit with no Biome anywhere rejects the commit and says where to run npm ci", async () => {
  const { main, commit, worktree } = await setup();
  const lane = worktree("lane");
  const r = await commit(lane);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /npm ci/);
  assert.ok(r.out.includes(main), r.out);
});

test("pre-commit rejects the commit when Biome finds a problem", async () => {
  const { main, log, commit } = await setup();
  await stubBiome(main, log, 1);
  const r = await commit(main);
  assert.notEqual(r.code, 0);
  assert.equal(git(main, "rev-list", "--count", "HEAD").out.trim(), "1");
});

test("pre-commit shellchecks exactly the staged shell scripts", async () => {
  const { main, log, env } = await setup();
  await stubBiome(main, log);
  await mkdir(join(main, "scripts"));
  const files = ["scripts/a.sh", "scripts/b.sh", "engine.mjs", "notes.md", ".githooks/pre-commit", "data.json"];
  for (const f of files) await writeFile(join(main, f), `${f === ".githooks/pre-commit" ? "" : "x"}\n`, { flag: "a" });
  git(main, "add", ...files.filter((f) => f !== "scripts/b.sh"));
  const r = sh(main, "git", ["commit", "-q", "-m", "mixed"], env);
  assert.equal(r.code, 0, r.out);
  const checked = (await logged(log))
    .filter((l) => l.includes("/shellcheck "))
    .flatMap((l) =>
      l
        .split(" ")
        .slice(1)
        .filter((arg) => !arg.startsWith("-")),
    )
    .sort();
  assert.deepEqual(checked, [".githooks/pre-commit", "scripts/a.sh"]);
});

test("pre-commit skips shellcheck when no shell script is staged", async () => {
  const { main, log, commit } = await setup();
  await stubBiome(main, log);
  await commit(main, "only.js");
  assert.equal((await logged(log)).filter((l) => l.includes("/shellcheck ")).length, 0);
});

test("pre-commit rejects the commit when shellcheck finds a problem", async () => {
  const { main, log, bin, commit } = await setup();
  await stubBiome(main, log);
  await stub(join(bin, "shellcheck"), log, 1);
  const r = await commit(main, "bad.sh");
  assert.notEqual(r.code, 0);
});

// pre-push: a bare remote, and a package.json whose check script is a stub.
async function setupPush(checkExit) {
  const s = await setup();
  const remote = join(s.dir, "remote.git");
  git(s.dir, "init", "-q", "--bare", remote);
  git(s.main, "remote", "add", "origin", remote);
  await writeFile(
    join(s.main, "package.json"),
    JSON.stringify({ scripts: { check: `command -v biome >> "${s.log}"; exit ${checkExit}` } }),
  );
  git(s.main, "add", "package.json");
  git(s.main, "commit", "-q", "--no-verify", "-m", "package");
  await stubBiome(s.main, s.log);
  const push = (cwd, branch) => sh(cwd, "git", ["push", "-q", "origin", branch], s.env);
  return { ...s, remote, push };
}

test("pre-push lets the push through when npm run check passes", async () => {
  const { main, push } = await setupPush(0);
  const r = push(main, "main");
  assert.equal(r.code, 0, r.out);
});

test("pre-push stops the push when npm run check fails", async () => {
  const { main, remote, push } = await setupPush(1);
  const r = push(main, "main");
  assert.notEqual(r.code, 0);
  assert.notEqual(git(remote, "rev-parse", "--verify", "-q", "main").code, 0);
});

// Git exports GIT_DIR and friends to hooks; a test under check that runs git
// would then work on the repo being pushed instead of its own temp repo.
test("pre-push runs check without git's repository variables, from the main checkout or a worktree", async () => {
  const s = await setupPush(0);
  await writeFile(
    join(s.main, "package.json"),
    JSON.stringify({
      scripts: {
        check: `env | grep -E '^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY)=' >> "${s.log}"; exit 0`,
      },
    }),
  );
  git(s.main, "commit", "-q", "--no-verify", "-am", "env check");
  const lane = s.worktree("lane");
  assert.equal(s.push(s.main, "main").code, 0);
  assert.equal(s.push(lane, "lane").code, 0);
  assert.deepEqual(await logged(s.log), []);
});

test("pre-push in a worktree with no node_modules runs check with the main checkout's tools", async () => {
  const { main, log, push, worktree } = await setupPush(0);
  const lane = worktree("lane");
  const r = push(lane, "lane");
  assert.equal(r.code, 0, r.out);
  assert.ok((await logged(log)).includes(join(main, "node_modules/.bin/biome")), await readFile(log, "utf8"));
});

// Real shellcheck: a hook staged alone must still pass, since it sources a
// helper that isn't part of the same shellcheck call.
test("pre-commit passes this repo's own hooks when each is staged on its own", async () => {
  const { main, log } = await setup();
  await stubBiome(main, log);
  for (const hook of ["pre-commit", "pre-push", "find-tools.sh"]) {
    await writeFile(join(main, ".githooks", hook), "\n", { flag: "a" });
    git(main, "add", `.githooks/${hook}`);
    const r = sh(main, "git", ["commit", "-q", "-m", hook]);
    assert.equal(r.code, 0, `${hook}: ${r.out}`);
  }
});
