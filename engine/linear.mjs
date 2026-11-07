// Reading a Linear issue as a run's task, through herdr-linear (installed by
// the Herdr Linear mod). The only code that knows about herdr-linear: a reader
// with the same read(ref) could talk to Linear's API instead. Read only.
//
//   herdr-linear app '{"op":"status"}'               signed-in workspaces (id, urlKey)
//   herdr-linear issues --force '["WHE-5"]'          which workspace has the key
//   herdr-linear app '{"op":"detail","issue":"WHE-5","workspace":"<id>"}'
//
// `app` answers errors as {"error","signedOut"} on stdout. Every `app` request
// needs the workspace id: without it the default workspace is asked.
import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { slugify } from "./run.mjs";

const OVERRIDE = "WHETSTONE_HERDR_LINEAR";
const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const URL_RE = /^https?:\/\/linear\.app\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:[/?#].*)?$/;

// "WHE-5" or "https://linear.app/<urlKey>/issue/WHE-5/<slug>".
export function parseIssueRef(text) {
  const ref = String(text || "").trim();
  if (KEY.test(ref)) return { key: ref.toUpperCase() };
  const m = ref.match(URL_RE);
  if (m) return { key: m[2].toUpperCase(), urlKey: m[1] };
  throw new Error(
    JSON.stringify(ref) +
      " is not a Linear issue key or URL (like WHE-5 or https://linear.app/<workspace>/issue/WHE-5)",
  );
}

// The override, else the newest version the Herdr Linear mod installed whose
// binary can run (a half-finished update leaves a folder without one); null if none.
export function findHerdrLinear({ env = process.env, home = homedir() } = {}) {
  if (env[OVERRIDE]) return env[OVERRIDE];
  const dir = join(home, ".local/share/herdr-linear/app");
  let versions;
  try {
    versions = readdirSync(dir).filter((v) => /^\d+(\.\d+)*$/.test(v));
  } catch {
    return null;
  }
  const parts = (v) => v.split(".").map(Number);
  versions.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i += 1)
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  });
  for (const v of versions.reverse()) {
    try {
      accessSync(join(dir, v, "herdr-linear"), constants.X_OK);
      return join(dir, v, "herdr-linear");
    } catch {
      /* an older one */
    }
  }
  return null;
}

const missing = (bin) =>
  new Error(
    "herdr-linear not found" +
      (bin ? ` at ${bin}` : "") +
      ": install the Herdr Linear mod, or set " +
      OVERRIDE +
      " to its path",
  );
const signedOut = (urlKey) =>
  new Error(
    urlKey
      ? `herdr-linear is not signed in to the Linear workspace ${urlKey}: sign in with \`herdr-linear login\``
      : "herdr-linear is not signed in to Linear: sign in with `herdr-linear login`",
  );

const isJson = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// run(args) → stdout; tests pass their own. herdr-linear may print its JSON
// answer and still exit non-zero, so a JSON stdout wins over the exit code;
// anything else on a failure means stderr has the reason. Each call gets
// timeoutMs: Linear is behind it, and a stall would hang the start.
export function createLinearReader({ bin = findHerdrLinear(), run, timeoutMs = 30_000 } = {}) {
  const exec =
    run ||
    (async (args) => {
      if (!bin) throw missing(bin);
      try {
        return (await promisify(execFile)(bin, args, { maxBuffer: 8 << 20, timeout: timeoutMs })).stdout;
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "EACCES") throw missing(bin);
        if (error.killed) throw new Error(`herdr-linear didn't answer within ${timeoutMs / 1000}s (${args[0]})`);
        if (isJson(error.stdout)) return error.stdout;
        throw new Error(
          "herdr-linear failed: " +
            String(error.stderr || error.stdout || error.message)
              .trim()
              .slice(0, 500),
        );
      }
    });

  const call = async (args) => {
    const out = await exec(args);
    try {
      return JSON.parse(out);
    } catch {
      throw new Error(`herdr-linear gave an answer whetstone can't read: ${String(out).slice(0, 200)}`);
    }
  };
  const app = async (req, what) => {
    const answer = await call(["app", JSON.stringify(req)]);
    if (answer && answer.error) {
      if (answer.signedOut) throw signedOut(answer.urlKey || what.urlKey);
      throw new Error(`herdr-linear couldn't read ${what.key || "Linear"}: ${answer.error}`);
    }
    return answer;
  };

  return {
    async read(text) {
      const ref = parseIssueRef(text);
      const { workspaces = [] } = await app({ op: "status" }, {});
      if (!workspaces.length) throw signedOut();
      let urlKey = ref.urlKey;
      if (!urlKey) {
        const answer = await call(["issues", "--force", JSON.stringify([ref.key])]);
        if (answer && answer.error) {
          if (answer.signedOut) throw signedOut();
          throw new Error(`herdr-linear couldn't look up ${ref.key}: ${answer.error}`);
        }
        if (!Array.isArray(answer))
          throw new Error(`herdr-linear gave an answer whetstone can't read: ${JSON.stringify(answer).slice(0, 200)}`);
        const found = answer.find((r) => String(r && r.key).toUpperCase() === ref.key);
        if (found && found.error && found.signedOut) throw signedOut();
        if (found && found.error) throw new Error(`herdr-linear couldn't look up ${ref.key}: ${found.error}`);
        if (!found || !found.issue) {
          throw new Error(
            "Linear issue " +
              ref.key +
              " not found in your signed-in workspaces (" +
              workspaces.map((w) => w.urlKey).join(", ") +
              ")",
          );
        }
        urlKey = found.issue.workspace;
      }
      const workspace = workspaces.find((w) => w.urlKey === urlKey);
      if (!workspace) throw signedOut(urlKey);
      const detail = await app({ op: "detail", issue: ref.key, workspace: workspace.id }, { key: ref.key, urlKey });
      const issue = detail && detail.issue;
      if (!issue) throw new Error(`Linear issue ${ref.key} not found in ${urlKey}`);
      return {
        key: issue.identifier || ref.key,
        title: issue.title || "",
        url: issue.url || "",
        description: detail.description || "",
        state: issue.state?.name ?? null,
        workspace: urlKey,
      };
    },
  };
}

// What the lanes get as the task.
export function issueTask(issue, notes) {
  const parts = [`${issue.key}: ${issue.title}${issue.url ? `\n${issue.url}` : ""}`];
  if (String(issue.description || "").trim()) parts.push(issue.description.trim());
  if (String(notes || "").trim()) parts.push(`Notes from the operator:\n${notes.trim()}`);
  return parts.join("\n\n");
}

export const issueSlug = (issue) => slugify(`${issue.key} ${issue.title}`);
