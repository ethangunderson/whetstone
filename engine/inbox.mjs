// Lines typed into the engine's terminal: `hc send <engine> "done …"` from the
// lanes, and hc's own notes. Waiters take the first line they match; other
// lines stay for other waiters.
import { createInterface } from "node:readline";

/** @param {{ stream?: NodeJS.ReadableStream }} [options] */
export function createInbox({ stream } = {}) {
  const lines = [];
  const waiters = [];

  function push(raw) {
    const line = String(raw).trim();
    if (!line) return;
    const i = waiters.findIndex((w) => w.match(line));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(line);
    } else {
      lines.push(line);
    }
  }

  function next(match, timeoutMs) {
    const i = lines.findIndex(match);
    if (i >= 0) return Promise.resolve(lines.splice(i, 1)[0]);
    return new Promise((resolve) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        resolve(null);
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  if (stream) createInterface({ input: stream }).on("line", push);
  return { push, next, pending: () => lines.slice() };
}
