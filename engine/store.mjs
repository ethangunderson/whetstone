// A run's folder: state.json (engine-owned), events.jsonl (history) and
// control.json (written by the pane or CLI to pause, stop, approve or answer).
// state.json is replaced atomically so a reader never sees half a file.
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

export async function openStore(dir) {
  await mkdir(dir, { recursive: true });
  const statePath = join(dir, "state.json");
  const state = await readJson(statePath, {});
  let writes = Promise.resolve();

  // Writes are chained so concurrent updates never race on the rename.
  function save() {
    const snapshot = JSON.stringify(state, null, 2);
    writes = writes.then(async () => {
      const tmp = statePath + ".tmp";
      await writeFile(tmp, snapshot);
      await rename(tmp, statePath);
    });
    return writes;
  }

  return {
    dir,
    state,
    update(change) {
      change(state);
      return save();
    },
    async event(text) {
      const at = new Date().toISOString();
      state.latest = text;
      await appendFile(join(dir, "events.jsonl"), JSON.stringify({ at, text }) + "\n");
      return save();
    },
    readControl() {
      return readJson(join(dir, "control.json"), {});
    },
  };
}

// Merge a change into a run's control.json (pause, stop, approvals, answers).
export async function writeControl(dir, change) {
  const path = join(dir, "control.json");
  const control = await readJson(path, {});
  change(control);
  const tmp = path + "." + process.pid + ".tmp";
  await writeFile(tmp, JSON.stringify(control, null, 2));
  await rename(tmp, path);
  return control;
}
