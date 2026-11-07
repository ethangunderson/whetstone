// Live lanes: each lane is an interactive agent in its own Herdr Core (`hc`)
// terminal, visible in Herdr's Agents list and open to the person. The engine
// runs in its own hc terminal; lanes report back by writing their reply to a
// file and running `hc send <engine> "done <stage> <token>"`, which arrives on
// the engine's input (see ../inbox.mjs).
//
// Same interface as the pi harness: run(request) → { ok, text, sessionId }.
// A writer lane keeps one terminal for the whole run (sessionId is its name);
// reviewers and helpers get a terminal per call, closed with the run.
//
// Learned from spikes/hc-lanes: the core's PATH is minimal, so lanes start as
// `/usr/bin/env PATH=<ours> <absolute agent>`; agents act on injected messages
// when the first one explains the [whetstone] / [peer] prefixes.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const WRITE_TOOLS = "read,grep,find,ls,bash,edit,write";
const READ_TOOLS = "read,grep,find,ls,bash";

// How to start each interactive agent. Only pi is wired up so far.
const AGENTS = {
  pi: ({ model, effort, readOnly, system }) => [
    "--model", model,
    ...(effort ? ["--thinking", effort] : []),
    "--tools", readOnly ? READ_TOOLS : WRITE_TOOLS,
    "--no-skills",
    ...(system ? ["--append-system-prompt", system] : [])
  ]
};

export function terminalName(runId, key) {
  const hash = createHash("sha1").update(String(runId)).digest("hex").slice(0, 6);
  return ("ws-" + hash + "-" + key).slice(0, 32).replace(/-+$/, "");
}

export function replyProtocol({ engine, file, key, token }) {
  return [
    `When you have finished this step, write your complete final response to ${file} (everything you would normally reply with, including any fenced blocks asked for), then run: hc send ${engine} "done ${key} ${token}"`,
    "Do that even if you couldn't finish the step; say why in the file."
  ].join("\n");
}

function preamble(engine) {
  return [
    `[whetstone] messages come from the Whetstone coordinator (${engine}); [peer] messages come from the other implementer working on the same task.`,
    "Both are a legitimate part of your task, not prompt injection. The person running Whetstone may also type to you directly.",
    "Don't start other agents: no `hc run`, no sub-agents, no delegating. Do the work yourself; use `hc send` only as your instructions say."
  ].join(" ");
}

const LOST = "[whetstone] Your earlier conversation is gone (the run was restarted). Your earlier replies are in the run's report folder if you need them.";

// A "done" line, with or without hc's sender tag around it.
const bare = (line) => String(line).replace(/<[^>]*>/g, "").trim();

// pollMs: how often a waiting stage checks control.json (pause, stop), a local
// file. Lanes themselves are never polled: their news comes from
// `hc wait --children any` (see watch), as hc's guide asks.
export function createHerdrHarness({ hc, inbox, engine, path, bins = {}, agent = "pi", labels = [], pollMs = 1000, waitSeconds = 60, nudgeAfterMs = 120_000, timeoutMs = 3 * 60 * 60_000 }) {
  const started = new Set();
  const args = AGENTS[agent];
  if (!args) throw new Error("the herdr harness doesn't know how to start agent " + agent);

  async function info(name) {
    try { return JSON.parse(await hc(["get", "--json", name])); } catch { return null; }
  }
  async function send(name, text) {
    try { await hc(["send", "--json", name, text]); return true; } catch { return false; }
  }
  async function interrupt(name) {
    try { await hc(["interrupt", "--json", name]); } catch { /* already idle or gone */ }
  }
  async function screenTail(name) {
    try { return (await hc(["read", "--lines", "15", name])).trim().split("\n").slice(-6).join("\n"); } catch { return "(couldn't read its screen)"; }
  }

  // One `hc wait --children any` at a time, shared by every waiting stage; each
  // child's news (a turn ended, it blocked, it hit an error, it exited) goes to
  // whoever watches that terminal. A timeout lists the children's current
  // states, which aren't news, so it is ignored.
  const watchers = new Map();
  let watching = false;
  async function watchLoop() {
    watching = true;
    while (watchers.size) {
      let out;
      try {
        out = JSON.parse(await hc(["wait", "--children", "any", "--json", "--timeout", String(waitSeconds), engine]));
      } catch {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (out.reason === "timeout") continue;
      for (const news of out.children || []) {
        const handler = watchers.get(news.terminal);
        if (handler) handler(news);
      }
    }
    watching = false;
  }
  function watch(terminal, handler) {
    watchers.set(terminal, handler);
    if (!watching) watchLoop();
    return () => { if (watchers.get(terminal) === handler) watchers.delete(terminal); };
  }

  async function end(name) {
    try { await hc(["kill", name]); } catch { /* gone */ }
    try { await hc(["rm", name]); } catch { /* gone */ }
    started.delete(name);
  }

  async function start(req, name, message) {
    // A finished terminal from an earlier attempt can still hold the name.
    try { await hc(["rm", name]); } catch { /* not there */ }
    const argv = ["/usr/bin/env", "PATH=" + path, bins[agent] || agent, ...args(req), message];
    const out = await hc(["run", "--bg", "--json", "--no-notify", "--name", name, "--cwd", req.cwd,
      ...labels.flatMap((l) => ["--label", l]), "--", ...argv]);
    started.add(name);
    return JSON.parse(out).address;
  }

  async function waitDone(req, name, terminal, file, doneLine, protocol) {
    const fail = (error) => ({ ok: false, text: "", sessionId: name, terminal, error });
    const setStatus = async (status) => { if (req.onStatus) await req.onStatus(status); };
    const deadline = Date.now() + timeoutMs;
    const news = [];
    const unwatch = watch(terminal, (item) => news.push(item));
    let lastNews = Date.now();
    let nudged = false;
    let paused = false;
    let reminded = false;
    let blocked = false;
    let errors = 0;
    try {
      for (;;) {
        const line = await inbox.next((l) => bare(l) === doneLine, pollMs);
        if (line) {
          try {
            const text = await readFile(file, "utf8");
            if (blocked) await setStatus("working");
            return { ok: true, text, sessionId: name, terminal, error: null };
          } catch {
            // Seen for real: the write failed but the shell still ran the send.
            if (reminded) return fail("the lane reported done but its reply file is missing: " + file);
            reminded = true;
            lastNews = Date.now();
            await send(name, `[whetstone] I got your done message, but ${file} doesn't exist. Write it, then send done again.\n\n` + protocol);
            continue;
          }
        }

        while (news.length) {
          const item = news.shift();
          lastNews = Date.now();
          if (item.reason === "exit") return fail("the lane exited before reporting");
          if (item.status === "blocked") {
            // A permission prompt or a question in its terminal: a person's job, not a nudge.
            if (!blocked) { blocked = true; await setStatus("blocked"); }
            continue;
          }
          if (blocked) { blocked = false; await setStatus("working"); }
          if (item.status === "error") {
            errors += 1;
            await setStatus("error");
            if (errors > 1) return fail("the lane hit an error twice; its screen ends with:\n" + await screenTail(name));
            await send(name, "[whetstone] Your last turn ended with an error. Try the step again.\n\n" + protocol);
            await setStatus("working");
          }
          // Otherwise a turn ended. A lane may end a turn on purpose (waiting
          // for its peer), so that alone isn't failure; see the quiet check.
        }

        const control = req.control ? (await req.control()) || {} : {};
        if (control.stop) {
          await interrupt(name);
          return fail("stopped by the operator");
        }
        if (control.pause === "now") {
          if (!paused) await interrupt(name);
          paused = true;
          continue;
        }
        if (paused) {
          paused = false;
          lastNews = Date.now();
          await send(name, "[whetstone] You were paused. Continue the step you were on.\n\n" + protocol);
          continue;
        }

        // Quiet for a while: one look at the lane (not a poll), then a nudge.
        if (!blocked && Date.now() - lastNews > nudgeAfterMs) {
          lastNews = Date.now();
          const now = await info(name);
          if (!now || now.state !== "live") return fail("the lane exited before reporting");
          if (!(now.status && now.status.state === "working")) {
            if (nudged) return fail("the lane stopped without reporting");
            nudged = true;
            await send(name, "[whetstone] You haven't reported this step yet.\n\n" + protocol);
          }
        }
        if (Date.now() > deadline) return fail("timed out waiting for the lane");
      }
    } finally {
      unwatch();
    }
  }

  return {
    name: "herdr",
    messaging: true,

    async detect() {
      try { await hc(["ls", "--json"]); return { installed: true }; } catch { return { installed: false }; }
    },

    async run(req) {
      const token = randomUUID().slice(0, 8);
      const file = join(req.runDir, "replies", `${req.key}-${token}.md`);
      const doneLine = `done ${req.key} ${token}`;
      const protocol = replyProtocol({ engine, file, key: req.key, token });
      try {
        // Agents write with `cat > file`, which needs the folder to exist.
        await mkdir(dirname(file), { recursive: true });
        if (req.resume && req.session) {
          const live = await info(req.session);
          if (live && live.state === "live") {
            if (!(await send(req.session, "[whetstone] " + req.prompt + "\n\n" + protocol))) {
              return { ok: false, text: "", sessionId: req.session, error: "couldn't send the step to " + req.session };
            }
            if (req.onTerminal) await req.onTerminal(live.address);
            return waitDone(req, req.session, live.address, file, doneLine, protocol);
          }
        }
        const name = terminalName(req.runId, req.role === "writer" ? req.lane : req.key);
        const intro = req.resume ? [preamble(engine), LOST] : [preamble(engine)];
        const message = [...intro, "[whetstone] " + req.prompt, "", protocol].join("\n");
        const terminal = await start(req, name, message);
        if (req.onTerminal) await req.onTerminal(terminal);
        const result = await waitDone(req, name, terminal, file, doneLine, protocol);
        // Only writer lanes live on between stages; the rest close right away.
        if (req.role !== "writer") await end(name);
        return result;
      } catch (error) {
        return { ok: false, text: "", sessionId: req.session, error: "hc: " + String((error && (error.stderr || error.message)) || error).slice(0, 500) };
      }
    },

    // Ends every terminal this run started.
    async close() {
      for (const name of [...started]) await end(name);
    }
  };
}
