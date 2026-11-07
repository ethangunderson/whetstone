// Git worktrees for the lanes and the final branch. The engine makes them
// before handing a lane its task, so agents never run setup commands.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);

async function branchExists(repo, branch) {
  try {
    await git("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export const gitWorkspace = {
  async addWorktree({ repo, path, branch, from }) {
    if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
    if (await branchExists(repo, branch)) throw new Error(`branch already exists: ${branch}`);
    await mkdir(dirname(path), { recursive: true });
    await git("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, path, from]);
  },
};
