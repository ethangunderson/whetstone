// Reading a Linear issue through herdr-linear, with herdr-linear faked: a
// function that answers by command, the way 0.14.3 does.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLinearReader, findHerdrLinear, issueSlug, issueTask, parseIssueRef } from "../linear.mjs";

const WS = { id: "1a1a0f1a-ws", name: "whetstone", urlKey: "eg-whetstone" };
const URL = "https://linear.app/eg-whetstone/issue/WHE-5/lanes-must-not-start";
const DETAIL = {
  description: "Lanes start before the engine is ready.",
  issue: {
    id: "uuid-5",
    identifier: "WHE-5",
    title: "Lanes must not start",
    url: URL,
    branch: "ethan/whe-5",
    state: { name: "In Progress", type: "started" },
    project: { name: "Live lanes: features" },
  },
  labels: [{ name: "Bug" }],
  priorityLabel: "High",
};

// o.workspaces, o.issue (null: not found), o.detail (an object, or { error, signedOut })
function fake(o = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "issues") {
      if (o.issuesAnswer !== undefined) return JSON.stringify(o.issuesAnswer);
      const [key] = JSON.parse(args[args.length - 1]);
      const issue =
        o.issue === undefined
          ? {
              identifier: key,
              title: DETAIL.issue.title,
              url: URL,
              state: "In Progress",
              state_type: "started",
              workspace: "eg-whetstone",
            }
          : o.issue;
      return JSON.stringify([
        { key: "WHE-1", issue: null },
        { key, issue, ...(o.issuesError ? { error: o.issuesError } : {}) },
      ]);
    }
    const req = JSON.parse(args[1]);
    if (req.op === "status") return JSON.stringify({ version: "0.14.3", workspaces: o.workspaces ?? [WS] });
    if (req.op === "detail") {
      if (req.workspace !== WS.id)
        return JSON.stringify({ error: `not signed in to that workspace any more: ${req.workspace}`, signedOut: true });
      return JSON.stringify(o.detail ?? DETAIL);
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  return { calls, reader: createLinearReader({ bin: "/fake/herdr-linear", run }) };
}

test("parseIssueRef takes a key or a Linear URL", () => {
  assert.deepEqual(parseIssueRef("WHE-5"), { key: "WHE-5" });
  assert.deepEqual(parseIssueRef("whe-5"), { key: "WHE-5" }, "keys are case-insensitive");
  assert.deepEqual(parseIssueRef(URL), { key: "WHE-5", urlKey: "eg-whetstone" });
  assert.deepEqual(parseIssueRef("https://linear.app/eg-whetstone/issue/WHE-5"), {
    key: "WHE-5",
    urlKey: "eg-whetstone",
  });
  assert.throws(() => parseIssueRef("fix the thing"), /not a Linear issue key or URL/);
  assert.throws(() => parseIssueRef("https://example.com/eg/issue/WHE-5"), /not a Linear issue key or URL/);
});

test("a key is looked up across workspaces, then read in its own workspace", async () => {
  const { calls, reader } = fake();
  const issue = await reader.read("WHE-5");
  assert.deepEqual(calls[0], ["app", JSON.stringify({ op: "status" })]);
  assert.deepEqual(calls[1], ["issues", "--force", '["WHE-5"]'], "fresh, not a minute-old cached answer");
  assert.deepEqual(
    JSON.parse(calls[2][1]),
    { op: "detail", issue: "WHE-5", workspace: WS.id },
    "the workspace id, not its URL key",
  );
  assert.deepEqual(
    issue,
    {
      key: "WHE-5",
      title: "Lanes must not start",
      url: URL,
      description: "Lanes start before the engine is ready.",
      state: "In Progress",
      workspace: "eg-whetstone",
    },
    "only what a run and the start form's preview use",
  );
});

test("a URL skips the search: it already names the workspace", async () => {
  const { calls, reader } = fake();
  const issue = await reader.read(URL);
  assert.ok(!calls.some((c) => c[0] === "issues"));
  assert.equal(issue.key, "WHE-5");
  assert.equal(issue.title, "Lanes must not start");
});

test("an issue that can't be found says so", async () => {
  await assert.rejects(
    fake({ issue: null }).reader.read("WHE-999"),
    /Linear issue WHE-999 not found in your signed-in workspaces \(eg-whetstone\)/,
  );
  await assert.rejects(
    fake({ issuesError: "rate limited" }).reader.read("WHE-5"),
    /herdr-linear couldn't look up WHE-5: rate limited/,
  );
  await assert.rejects(
    fake({ issuesAnswer: [{ key: "WHE-5", issue: null, error: "token revoked", signedOut: true }] }).reader.read(
      "WHE-5",
    ),
    /herdr-linear is not signed in to Linear/,
    "signedOut on the entry itself",
  );
  await assert.rejects(
    fake({ detail: { error: "Entity not found", signedOut: false } }).reader.read(URL),
    /herdr-linear couldn't read WHE-5: Entity not found/,
  );
});

test("an issues answer of the wrong shape fails with a Linear message, not a TypeError", async () => {
  await assert.rejects(
    fake({ issuesAnswer: { error: "rate limited" } }).reader.read("WHE-5"),
    /herdr-linear couldn't look up WHE-5: rate limited/,
  );
  await assert.rejects(
    fake({ issuesAnswer: { error: "token revoked", signedOut: true } }).reader.read("WHE-5"),
    /herdr-linear is not signed in to Linear/,
  );
  await assert.rejects(
    fake({ issuesAnswer: { issues: [] } }).reader.read("WHE-5"),
    /herdr-linear gave an answer whetstone can't read/,
  );
  await assert.rejects(
    fake({ issuesAnswer: [{ key: "WHE-6", issue: { identifier: "WHE-6", workspace: "eg-whetstone" } }] }).reader.read(
      "WHE-5",
    ),
    /Linear issue WHE-5 not found/,
    "matched by key, not position",
  );
});

test("signed out of Linear, or of the issue's workspace, says which", async () => {
  await assert.rejects(
    fake({ workspaces: [] }).reader.read("WHE-5"),
    /herdr-linear is not signed in to Linear.*herdr-linear login/,
  );
  await assert.rejects(
    fake({ workspaces: [{ id: "other", name: "x", urlKey: "other" }] }).reader.read(URL),
    /not signed in to the Linear workspace eg-whetstone/,
  );
  const stale = fake({ workspaces: [{ ...WS, id: "stale-id" }] });
  await assert.rejects(
    stale.reader.read("WHE-5"),
    /not signed in to the Linear workspace eg-whetstone/,
    "a signedOut answer from detail",
  );
});

test("a missing herdr-linear names the path and how to fix it", async () => {
  const reader = createLinearReader({ bin: join(tmpdir(), "no-such-herdr-linear") });
  await assert.rejects(
    reader.read("WHE-5"),
    /herdr-linear not found at .*no-such-herdr-linear.*Herdr Linear mod.*WHETSTONE_HERDR_LINEAR/,
  );
  await assert.rejects(createLinearReader({ bin: null }).read("WHE-5"), /herdr-linear not found/);
});

test("a real binary's stdout is read even when it exits non-zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-linear-"));
  const bin = join(dir, "herdr-linear");
  await writeFile(bin, '#!/bin/sh\necho \'{"error":"boom","signedOut":false}\'\nexit 1\n');
  await chmod(bin, 0o755);
  await assert.rejects(createLinearReader({ bin }).read("WHE-5"), /herdr-linear couldn't read Linear: boom/);
});

async function script(body) {
  const dir = await mkdtemp(join(tmpdir(), "whetstone-linear-"));
  const bin = join(dir, "herdr-linear");
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

test("a non-zero exit without a JSON answer reports herdr-linear's stderr", async () => {
  const bin = await script("echo 'Usage: herdr-linear ...'\necho 'real cause: token expired' >&2\nexit 1");
  await assert.rejects(createLinearReader({ bin }).read("WHE-5"), /herdr-linear failed: real cause: token expired/);
  const quiet = await script("echo 'real cause: no network' >&2\nexit 2");
  await assert.rejects(createLinearReader({ bin: quiet }).read("WHE-5"), /herdr-linear failed: real cause: no network/);
});

test("a herdr-linear that stalls is given up on, with the command named", async () => {
  const bin = await script("sleep 5");
  const started = Date.now();
  await assert.rejects(
    createLinearReader({ bin, timeoutMs: 200 }).read("WHE-5"),
    /herdr-linear didn't answer within 0\.2s \(app\)/,
  );
  assert.ok(Date.now() - started < 3000, "not the full sleep");
});

test("findHerdrLinear prefers the override, else the newest installed version that can run", async () => {
  const home = await mkdtemp(join(tmpdir(), "whetstone-linear-home-"));
  const app = join(home, ".local/share/herdr-linear/app");
  assert.equal(findHerdrLinear({ env: { WHETSTONE_HERDR_LINEAR: "/x/hl" }, home }), "/x/hl");
  assert.equal(findHerdrLinear({ env: {}, home }), null, "not installed");
  for (const v of ["0.9.1", "0.14.3", "0.14.10", "notes"]) {
    await mkdir(join(app, v), { recursive: true });
    await writeFile(join(app, v, "herdr-linear"), "#!/bin/sh\n");
    await chmod(join(app, v, "herdr-linear"), 0o755);
  }
  assert.equal(findHerdrLinear({ env: {}, home }), join(app, "0.14.10/herdr-linear"), "0.14.10 is newer than 0.14.3");
  await mkdir(join(app, "0.15.0"), { recursive: true });
  await mkdir(join(app, "0.16.0"), { recursive: true });
  await writeFile(join(app, "0.16.0", "herdr-linear"), "not executable");
  assert.equal(
    findHerdrLinear({ env: {}, home }),
    join(app, "0.14.10/herdr-linear"),
    "a half-installed newer version is skipped",
  );
});

test("the task names the issue, carries its description, then the operator's notes", () => {
  const issue = { key: "WHE-5", title: "Lanes must not start", url: URL, description: "Lanes start early." };
  assert.equal(issueTask(issue), `WHE-5: Lanes must not start\n${URL}\n\nLanes start early.`);
  assert.equal(
    issueTask(issue, "Keep it small."),
    `WHE-5: Lanes must not start\n${URL}\n\nLanes start early.\n\nNotes from the operator:\nKeep it small.`,
  );
  assert.equal(issueTask({ ...issue, description: "" }), `WHE-5: Lanes must not start\n${URL}`);
});

test("the slug comes from the key and title", () => {
  assert.equal(issueSlug({ key: "WHE-5", title: "Lanes must not start" }), "whe-5-lanes-must-not-start");
});
