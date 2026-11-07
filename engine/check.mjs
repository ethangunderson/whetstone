// "Can I start a run here?" as a list of { ok, what, detail } plus the models
// each difficulty tier would use, for the pane's start form. Pure over its
// inputs: the CLI passes in git, the runs on disk, the config and harnesses.

export const ACTIVE_STATUSES = ["running", "paused", "waiting", "blocked"];

const message = (error) => String((error && error.message) || error).split("\n")[0];

export async function harnessChecks(lanes, adapters) {
  return Promise.all(lanes.map(async (lane) => {
    const what = lane.name + " harness";
    const adapter = adapters[lane.harness];
    if (!adapter) return { ok: false, what, detail: lane.harness + " has no adapter yet" };
    try {
      const found = await adapter.detect();
      if (!found.installed) return { ok: false, what, detail: lane.harness + " not installed" };
      return { ok: true, what, detail: (lane.harness + " " + (found.version || "")).trim() };
    } catch (error) {
      return { ok: false, what, detail: lane.harness + ": " + message(error) };
    }
  }));
}

export async function preflight({ repo, baseRef = "HEAD", git, runs, loadConfig, adapters }) {
  const checks = [];
  let root = null;
  try {
    root = await git.root(repo);
    checks.push({ ok: true, what: "git repo", detail: root });
  } catch (error) {
    checks.push({ ok: false, what: "git repo", detail: message(error) });
  }

  if (root) {
    try {
      checks.push({ ok: true, what: "base ref", detail: baseRef + " at " + await git.commit(root, baseRef) });
    } catch {
      checks.push({ ok: false, what: "base ref", detail: baseRef + " not found" });
    }
  } else {
    checks.push({ ok: false, what: "base ref", detail: "needs a git repo" });
  }

  const busy = (await runs()).filter((r) => r.repo === (root || repo) && ACTIVE_STATUSES.includes(r.status));
  checks.push(busy.length
    ? { ok: false, what: "no active run", detail: busy.map((r) => r.id + " is " + r.status).join(", ") }
    : { ok: true, what: "no active run", detail: "" });

  let tiers = null;
  try {
    const config = await loadConfig();
    checks.push({ ok: true, what: "config", detail: "" });
    checks.push(...await harnessChecks(config.lanes, adapters));
    tiers = config.tiers;
  } catch (error) {
    checks.push({ ok: false, what: "config", detail: message(error) });
  }

  return { ok: checks.every((c) => c.ok), repo: root || repo, baseRef, checks, tiers };
}
