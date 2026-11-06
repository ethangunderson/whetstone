// Whetstone: two lanes implement the same task independently, compare and
// converge on a middle road, one integrates, a reviewer pair (one per lane)
// attacks it, and the writers respond. At most `maxRounds` review cycles. Ends
// with a local branch and a decision-support report; nothing is pushed.
//
// Ported from ~/.pi/agent/workflows/dual-pr.js. Differences:
// - every agent call goes through a harness adapter (pi, claude-code, codex…);
// - the engine creates worktrees itself;
// - every finished call is checkpointed in the store, so rerunning a failed
//   or interrupted run reuses finished stages and continues the same sessions;
// - between stages the engine honors control.json: pause, stop, step approval
//   and answers to writers' questions.
//
// args:
//   task, repo   required
//   slug         short kebab-case name; derived from task when omitted
//   baseRef      branch/ref to start from (default "HEAD")
//   difficulty   "easy" | "medium" | "hard" to skip triage
//   maxRounds    review cycles, 1-2 (default 2)
//   fallback     true | false: force a tier's fallback or primary pair without probing
//   isolation    extra text about isolating concurrent test runs
//   stepMode     wait for approval (control.approved >= step) before each step

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { lastJson, lastTag, parseQuestion, isTriage, isReview, isArbiter } from "./parse.mjs";
import { splitModel } from "./config.mjs";
import { draftSummary, critiqueSummary, convergeSummary, positionsOf, dispositionsOf } from "./story.mjs";

export const STEPS = ["Triage", "Draft", "Debate", "Integrate", "Review", "Report"];
const TIER_NAMES = ["easy", "medium", "hard"];
const REASK = "Your reply did not end with a valid ```json block in the format the task asked for. Reply again with only that block.";

export class Stopped extends Error {
  constructor() {
    super("Run stopped by the operator");
    this.name = "Stopped";
  }
}

const roles = {};
async function rolePrompt(role) {
  roles[role] ??= await readFile(new URL("./agents/" + role + ".md", import.meta.url), "utf8");
  return roles[role];
}

function dur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(s / 60);
  return m < 60 ? m + "m" : Math.floor(m / 60) + "h" + String(m % 60).padStart(2, "0") + "m";
}

function short(spec) {
  return splitModel(spec).model.split("/").pop();
}

function plural(n, word) {
  return n + " " + word + (n === 1 ? "" : "s");
}

// Short kebab-case name used for branches, worktrees and run ids.
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "") || "task";
}

export async function runWhetstone({ args, config, harnesses, store, workspace, pollMs = 1000 }) {
  if (!args.task || !args.repo) throw new Error("whetstone needs args.task and args.repo");
  const st = store.state;
  try {
    return await body();
  } catch (error) {
    return failOrStop(error);
  } finally {
    // Live lanes end with the run: close each harness once.
    for (const h of new Set(config.lanes.map((l) => harnesses[l.harness]).filter(Boolean))) {
      if (h.close) await h.close();
    }
  }

  async function failOrStop(error) {
    if (error instanceof Stopped) {
      await store.update((s) => { s.status = "stopped"; s.running = {}; s.next = null; s.waitingSince = null; s.endedAt = new Date().toISOString(); });
      await store.event("Stopped by the operator");
    } else {
      await store.update((s) => { s.status = "failed"; s.error = String((error && error.message) || error); s.running = {}; s.waitingSince = null; s.endedAt = new Date().toISOString(); });
      await store.event("Failed · " + String((error && error.message) || error).split("\n")[0]);
    }
    throw error;
  }

  async function body() {
    // ---- Setup ---------------------------------------------------------------
    const repo = String(args.repo).replace(/\/+$/, "");
    const repoName = basename(repo);
    const slug = slugify(args.slug || args.task);
    const baseRef = args.baseRef || "HEAD";
    const maxRounds = Math.min(Math.max(Number(args.maxRounds) || 2, 1), 2);
    const root = join(dirname(repo), ".whetstone", repoName + "-" + slug);
    const reportDir = join(root, "report");
    const finalBranch = "whetstone/" + slug;
    const finalPath = join(root, "final");
    const FINAL_PARTITION = 3;
    const ids = config.lanes.map((l) => l.id);
    const byId = Object.fromEntries(config.lanes.map((l) => [l.id, l]));
    const other = { [ids[0]]: ids[1], [ids[1]]: ids[0] };
    const lane = Object.fromEntries(ids.map((id, i) => [id, { path: join(root, id), branch: finalBranch + "-" + id, partition: i + 1 }]));
    const reviewPartition = Object.fromEntries(ids.map((id, i) => [id, 4 + i]));
    const name = (id) => byId[id].name;
    const NAME = (id) => byId[id].name.toUpperCase();

    for (const l of config.lanes) {
      if (!harnesses[l.harness]) throw new Error("No harness named \"" + l.harness + "\" for lane " + l.name);
    }

    await store.update((s) => {
      s.id ??= slug + "-" + Date.now();
      s.startedAt ??= new Date().toISOString();
      s.args = args;
      s.pid = process.pid;
      Object.assign(s, {
        task: args.task, repo, slug, baseRef, root, reportDir, finalBranch, finalPath,
        steps: STEPS, stepMode: Boolean(args.stepMode), status: "running", error: null, next: null, question: null
      });
      s.step ??= 0;
      s.waitedMs ??= 0;
      s.waitingSince = null;
      s.endedAt = null;
      s.results ??= {};
      s.files ??= {};
      s.worktrees ??= {};
      s.sessions ??= {};
      s.story ??= { drafts: {}, critiques: {}, converge: {}, plan: null, selection: null };
      s.running = {};
      s.lanes ??= {};
      for (const l of config.lanes) {
        const prev = s.lanes[l.id] || {};
        s.lanes[l.id] = { name: l.name, harness: l.harness, model: prev.model ?? null, role: "idle", status: prev.status === "done" ? "done" : "idle", stage: prev.stage ?? null, since: null };
      }
    });
    const startedAt = Date.parse(st.startedAt);
    const log = [];

    // ---- Plumbing ------------------------------------------------------------

    // Time spent waiting for the operator, kept apart so "active time" means agent time.
    function endWait(s) {
      if (s.waitingSince) s.waitedMs = (s.waitedMs || 0) + (Date.now() - Date.parse(s.waitingSince));
      s.waitingSince = null;
    }

    function progress(text) {
      return store.event((st.step ? "Step " + st.step + "/" + STEPS.length + " · " : "") + text);
    }

    async function enterStep(step) {
      await store.update((s) => { s.step = step; });
      await gate();
    }

    // Holds while paused or waiting for step approval; throws Stopped on stop.
    async function gate() {
      for (;;) {
        const c = await store.readControl();
        if (c.stop) throw new Stopped();
        const pause = c.pause === "after-step" || c.pause === "now";
        const waiting = st.stepMode && st.step > 1 && (Number(c.approved) || 1) < st.step;
        if (!pause && !waiting) {
          if (st.status === "paused" || st.status === "waiting") {
            await store.update((s) => { s.status = "running"; s.next = null; endWait(s); });
            await store.event("Resumed");
          }
          return;
        }
        const status = pause ? "paused" : "waiting";
        if (st.status !== status) {
          await store.update((s) => { s.status = status; s.next = { step: st.step, name: STEPS[st.step - 1] }; s.waitingSince ??= new Date().toISOString(); });
          await store.event(pause
            ? "Paused · holding before the next stage"
            : "Waiting for you to start step " + st.step + "/" + STEPS.length + " · " + STEPS[st.step - 1]);
        }
        await sleep(pollMs);
      }
    }

    async function ask(key, laneId, text) {
      const id = key + "-" + Date.now().toString(36);
      await store.update((s) => {
        s.question = { id, lane: laneId, stage: key, text, at: new Date().toISOString() };
        s.lanes[laneId].status = "blocked";
        s.status = "blocked";
        s.waitingSince ??= new Date().toISOString();
      });
      await store.event(name(laneId) + " has a question for you");
      for (;;) {
        const c = await store.readControl();
        if (c.stop) throw new Stopped();
        const answer = c.answers && c.answers[id];
        if (typeof answer === "string" && answer.trim()) {
          await store.update((s) => {
            s.question = null;
            s.lanes[laneId].status = "working";
            s.status = "running";
            endWait(s);
          });
          await store.event("Answer sent to " + name(laneId));
          return answer.trim();
        }
        await sleep(pollMs);
      }
    }

    function fileFor(key) {
      if (!st.files[key]) {
        const n = Object.keys(st.files).length + 1;
        st.files[key] = join(reportDir, String(n).padStart(2, "0") + "-" + key + ".md");
      }
      return st.files[key];
    }

    async function invoke(req) {
      const { model, effort } = splitModel(req.spec);
      const harness = harnesses[byId[req.lane].harness];
      try {
        const r = await harness.run({
          key: req.key, lane: req.lane, role: req.role, session: req.session, resume: req.resume,
          cwd: req.cwd, system: req.system, model, effort, readOnly: req.readOnly, prompt: req.prompt,
          runId: st.id, runDir: store.dir, control: () => store.readControl(), onTerminal: req.onTerminal,
          sessionDir: join(store.dir, "sessions"), logFile: join(store.dir, "logs", req.key + ".jsonl"),
          activityFile: join(store.dir, "activity", req.key + ".jsonl")
        });
        return { ok: Boolean(r && r.ok), text: String((r && r.text) || ""), sessionId: (r && r.sessionId) || req.session, terminal: (r && r.terminal) || null, error: (r && r.error) || null };
      } catch (error) {
        return { ok: false, text: "", sessionId: req.session, error: String((error && error.message) || error) };
      }
    }

    function remember(result) {
      if (result.record) log.push(result);
      return result;
    }

    // One agent call, checkpointed by key. o: { lane, role, spec, prompt, cwd,
    // resume, structured, helper, file, stage, who, record }
    async function call(key, o) {
      const done = st.results[key];
      if (done && done.ok) return remember({ ...done, text: done.file ? await readFile(done.file, "utf8") : done.text });
      await gate();
      const system = await rolePrompt(o.role);
      const readOnly = o.role === "reviewer" || o.role === "triage";
      const session = o.resume ? st.sessions[o.lane] : randomUUID();
      const tracked = !o.helper;
      const t0 = Date.now();
      await store.update((s) => {
        s.running[key] = { lane: o.lane, role: o.role, model: o.spec, since: new Date(t0).toISOString() };
        if (tracked) Object.assign(s.lanes[o.lane], { role: o.role, status: "working", stage: key, model: o.spec, since: new Date(t0).toISOString() });
      });
      // Live lanes report their terminal as soon as it starts, so the pane can show it.
      const onTerminal = tracked ? (address) => store.update((s) => { s.lanes[o.lane].terminal = address; }) : undefined;
      const base = { key, lane: o.lane, role: o.role, spec: o.spec, cwd: o.cwd, system, readOnly, onTerminal };
      let res = await invoke({ ...base, session, resume: Boolean(o.resume), prompt: o.prompt });
      let sid = res.sessionId;
      let question;
      while (res.ok && o.role === "writer" && (question = parseQuestion(res.text))) {
        const answer = await ask(key, o.lane, question);
        res = await invoke({ ...base, session: sid, resume: true, prompt: "The operator answered your question:\n\n" + answer + "\n\nContinue the stage." });
        sid = res.sessionId || sid;
      }
      if (res.ok && o.structured && !o.structured(lastJson(res.text))) {
        const again = await invoke({ ...base, session: sid, resume: true, prompt: REASK });
        if (again.ok) {
          res = again;
          sid = again.sessionId || sid;
        }
      }
      // A stop that interrupted this call is a stop, not a failed stage.
      if (!res.ok && (await store.readControl()).stop) throw new Stopped();
      const result = {
        ok: res.ok, text: res.text, error: res.error, sessionId: sid, ms: Date.now() - t0,
        lane: o.lane, role: o.role, model: o.spec, stage: o.stage, who: o.who, record: o.record !== false,
        file: o.file === false ? null : fileFor(key)
      };
      if (result.file) {
        await mkdir(dirname(result.file), { recursive: true });
        await writeFile(result.file, res.ok ? res.text : "FAILED: " + (res.error || "no output") + "\n\n" + res.text);
      }
      // Replies with a report file stay out of state.json, which the pane reads.
      const kept = result.file ? { ...result, text: undefined } : result;
      await store.update((s) => {
        s.results[key] = kept;
        delete s.running[key];
        if (o.role === "writer") s.sessions[o.lane] = sid;
        if (tracked) Object.assign(s.lanes[o.lane], { status: res.ok ? "done" : "failed", since: null });
        if (tracked && res.terminal && o.role === "writer") s.lanes[o.lane].terminal = res.terminal;
      });
      return remember(result);
    }

    function requireOk(result, what) {
      if (!result.ok) throw new Error(what + " failed: " + String(result.error || result.text || "no output").slice(0, 2000));
      return result;
    }

    // Parallel calls; as each finishes, history says who is done and who is still working.
    async function parallel(items, phase, doneText) {
      const t0 = Date.now();
      const finished = {};
      return Promise.all(items.map(([key, o]) => call(key, o).then((result) => {
        finished[o.who] = result;
        if (Object.keys(finished).length < items.length) {
          const parts = items.map(([, i]) => finished[i.who]
            ? (doneText ? doneText(i.who, finished[i.who]) : name(i.who) + " done in " + dur(finished[i.who].ms))
            : name(i.who) + (doneText ? " reviewer" : "") + " still working (" + dur(Date.now() - t0) + " so far)");
          return progress(phase + " · " + parts.join(" · ")).then(() => result);
        }
        return result;
      })));
    }

    async function worktree(path, branch, from) {
      if (st.worktrees[path]) return;
      await workspace.addWorktree({ repo, path, branch, from });
      await store.update((s) => { s.worktrees[path] = { branch, from }; });
    }

    function isolationHint(partition) {
      return [
        "Isolation: another agent runs at the same time on this machine.",
        "Keep test state separate using partition number " + partition + " wherever the stack allows it,",
        "e.g. MIX_TEST_PARTITION=" + partition + " for Elixir/Ecto, a DB name suffix, a distinct port, or a separate cache dir.",
        "Fetch dependencies inside your worktree if needed; do not symlink into the primary checkout.",
        args.isolation ? "Project-specific isolation notes: " + args.isolation : ""
      ].filter(Boolean).join("\n");
    }

    // ---- 1. Difficulty and models --------------------------------------------

    await enterStep(1);
    let difficulty = args.difficulty;
    let triageReason = "Forced by caller.";
    if (!TIER_NAMES.includes(difficulty)) {
      await progress("Rating task difficulty");
      const triage = await call("triage", {
        lane: config.triage.lane, role: "triage", spec: config.triage.model, cwd: repo, helper: true,
        stage: "triage", who: "triage", structured: isTriage,
        prompt: [
          "Repository: " + repo + " (read-only).",
          "Rate the difficulty of this implementation task:",
          "",
          args.task,
          "",
          "End with a fenced ```json block: {\"difficulty\": \"easy\" | \"medium\" | \"hard\", \"reasoning\": \"...\", \"risks\": [\"...\"]}"
        ].join("\n")
      });
      const rated = lastJson(triage.text);
      difficulty = isTriage(rated) ? rated.difficulty : "medium";
      triageReason = isTriage(rated)
        ? rated.reasoning + (rated.risks.length ? "\nRisks: " + rated.risks.join("; ") : "")
        : "Triage returned no structured rating; defaulted to medium.";
    }

    const tier = config.tiers[difficulty];
    let pair = Object.fromEntries(ids.map((id) => [id, tier[id]]));
    let fallback = "not needed";
    let fallbackReason = "";
    if (tier.fallback) {
      if (args.fallback === true) {
        fallback = "fallback";
        fallbackReason = "Forced by caller (fallback=true).";
      } else if (args.fallback === false) {
        fallback = "primary";
        fallbackReason = "Forced by caller (fallback=false).";
      } else {
        const probe = (key, laneId, spec) => call(key, {
          lane: laneId, role: "triage", spec: splitModel(spec).model + ":low", cwd: repo, helper: true, file: false, record: false,
          stage: "probe", who: laneId, prompt: "Connectivity check. Do not use tools. Reply with exactly: OK"
        }).then((r) => ({ reachable: r.ok && /\bOK\b/.test(r.text), detail: String(r.error || r.text || "no output").slice(0, 300) }));
        const toProbe = ids.filter((id) => tier[id] !== tier.fallback[id]);
        await progress("Difficulty: " + difficulty + " · checking " + toProbe.map((id) => name(id) + " can reach " + short(tier[id])).join(" and "));
        const probes = await Promise.all(toProbe.map((id) => probe("probe-" + id, id, tier[id])));
        const failed = toProbe.filter((id, i) => !probes[i].reachable);
        if (!failed.length) {
          fallback = "primary";
          fallbackReason = "Live probe succeeded.";
        } else {
          for (const id of failed) {
            const backup = await probe("fallback-" + id, id, tier.fallback[id]);
            if (!backup.reachable) {
              const first = probes[toProbe.indexOf(id)];
              throw new Error(name(id) + " lane is unreachable: " + short(tier[id]) + " failed (" + first.detail + ") and fallback " +
                tier.fallback[id] + " also failed (" + backup.detail + "). Fix " + byId[id].harness + " access before running Whetstone.");
            }
          }
          fallback = "fallback";
          fallbackReason = failed.map((id) => name(id) + ": " + probes[toProbe.indexOf(id)].detail).join("; ");
          await progress(failed.map((id) => name(id) + " can't reach " + short(tier[id])).join(", ") +
            " → " + difficulty + " tier uses " + ids.map((id) => short(tier.fallback[id])).join(" vs "));
        }
      }
      if (fallback === "fallback") pair = Object.fromEntries(ids.map((id) => [id, tier.fallback[id]]));
    }
    const models = pair;
    await store.update((s) => {
      Object.assign(s, { difficulty, triageReason, fallback, fallbackReason, models });
      ids.forEach((id) => { s.lanes[id].model = models[id]; });
    });
    await progress("Difficulty: " + difficulty + " · " + ids.map((id) => name(id) + " = " + short(models[id])).join(" · "));

    // ---- 2. Independent implementations --------------------------------------

    function writeTask(id) {
      const l = lane[id];
      return [
        "You are the " + NAME(id) + " lane of a two-agent implementation. The peer lane is independent; do not coordinate yet.",
        "",
        "## Task",
        args.task,
        "",
        "## Where to work",
        "Primary repository: " + repo + " (do not modify it).",
        "Your worktree is " + l.path + " on branch " + l.branch + " (already created from " + baseRef + ").",
        "Do all work inside " + l.path + ".",
        "",
        isolationHint(l.partition),
        "",
        "## Deliverable",
        "Implement the task completely, with tests, following the repo's conventions. Run the relevant tests and quality checks. Commit on " + l.branch + ".",
        "",
        "## Final response (recorded verbatim for the operator)",
        "1. Approach: the design you chose and the alternatives you rejected, with reasons.",
        "2. Changes: files touched and why.",
        "3. Verification: exact commands run and results.",
        "4. Weak spots: what you are least sure about.",
        "5. Final commit SHA.",
        "Then a fenced ```json block summarizing it for the operator's dashboard:",
        "{\"approach\": \"one or two sentences\", \"choices\": [\"key design choices\"], \"weakSpots\": [\"what you are least sure about\"]}"
      ].join("\n");
    }

    await enterStep(2);
    for (const id of ids) await worktree(lane[id].path, lane[id].branch, baseRef);
    await progress("Both writers drafting independently (" + ids.map((id) => name(id) + ": " + short(models[id])).join(", ") + ")");
    const drafts = await parallel(ids.map((id) => ["draft-" + id, {
      lane: id, role: "writer", spec: models[id], cwd: lane[id].path, stage: "draft", who: id, prompt: writeTask(id)
    }]), "Drafting");
    const writer = {};
    ids.forEach((id, i) => { writer[id] = requireOk(drafts[i], name(id) + " draft"); });
    await store.update((s) => { ids.forEach((id) => { s.story.drafts[id] = draftSummary(writer[id].text); }); });
    await progress("Both drafts done (" + ids.map((id, i) => name(id) + " " + dur(drafts[i].ms)).join(", ") + ")");

    // ---- 3. Discussion: critique, then converge -------------------------------

    await enterStep(3);
    function critiqueTask(id) {
      const peer = other[id];
      return [
        "Your draft is done. Now compare it with the " + NAME(peer) + " lane's independent implementation.",
        "Peer branch: " + lane[peer].branch + " (worktree " + lane[peer].path + ", read-only for you).",
        "Inspect it with e.g. git -C " + repo + " diff " + baseRef + "..." + lane[peer].branch + " and by reading files. Run its tests if useful.",
        "",
        "The peer's own summary:",
        "<<<",
        writer[peer].text,
        ">>>",
        "",
        "Do not edit any files in this stage.",
        "",
        "Write a candid comparison:",
        "1. Where the peer's version is better than yours, and why.",
        "2. Where yours is better, and why.",
        "3. Bugs or gaps you see in either.",
        "4. The middle road: the concrete combined design you propose, naming which parts come from which branch.",
        "5. Which branch should be the base for integration (fewer changes needed to reach the middle road), and why.",
        "Then a fenced ```json block summarizing it for the operator's dashboard:",
        "{\"peerBetter\": [\"where the peer's version is better\"], \"mineBetter\": [\"where yours is better\"], \"middleRoad\": \"one or two sentences\"}",
        "End with exactly one line: BASE: " + ids.join(" or BASE: ")
      ].join("\n");
    }

    await progress("Both writers comparing drafts");
    const critiques = await parallel(ids.map((id) => ["critique-" + id, {
      lane: id, role: "writer", spec: models[id], cwd: lane[id].path, resume: true, stage: "critique", who: id, prompt: critiqueTask(id)
    }]), "Comparing drafts");
    const critique = {};
    ids.forEach((id, i) => { critique[id] = requireOk(critiques[i], name(id) + " critique").text; });
    await store.update((s) => { ids.forEach((id) => { s.story.critiques[id] = critiqueSummary(critique[id], ids); }); });

    // Live lanes can talk directly before converging; capped so it ends.
    function discussion(id) {
      const peerLane = other[id];
      const peerTerminal = st.sessions[peerLane];
      const live = harnesses[byId[id].harness].messaging && harnesses[byId[peerLane].harness].messaging;
      if (!live || !peerTerminal) return [];
      return [
        "Before you converge, discuss the open disagreements directly with the " + NAME(peerLane) + " lane.",
        "Send it messages with: hc send " + peerTerminal + " \"[peer] <message>\" (at most 2 messages from you, each under 1200 characters).",
        "Its messages arrive as [peer] messages. Answer what it asks, aim to agree on the base and the plan, and don't wait for more than 2 replies.",
        "Then write your converge response as below.",
        ""
      ];
    }

    function convergeTask(id) {
      const peer = other[id];
      return [
        "The " + NAME(peer) + " lane has written its comparison and proposed middle road:",
        "<<<",
        critique[peer],
        ">>>",
        "",
        "Do not edit any files in this stage.",
        "",
        ...discussion(id),
        "Converge. Respond point by point where you disagree, concede where the peer is right, and state the final middle-road plan you endorse as a concrete checklist the integrator can follow.",
        "Then decide who integrates: the author of the base branch builds the combined version.",
        "",
        "Then add a fenced ```json block listing every item of the final plan and where it comes from:",
        "{\"integrator\": " + ids.map((x) => "\"" + x + "\"").join(" | ") + ", \"why\": \"why that branch should be the base, one sentence\", " +
          "\"concessions\": [\"what you now accept from the peer\"], \"holding\": [\"where you still disagree\"], " +
          "\"items\": [{\"item\": \"short description\", \"source\": " + ids.map((x) => "\"" + x + "\"").join(" | ") + " | \"both\" | \"new\"}]}",
        "(source = whose draft the item comes from; both = both drafts already did it; new = neither did).",
        "End with exactly one line: INTEGRATOR: " + ids.join(" or INTEGRATOR: ")
      ].join("\n");
    }

    await progress("Both writers converging on a middle road");
    const converges = await parallel(ids.map((id) => ["converge-" + id, {
      lane: id, role: "writer", spec: models[id], cwd: lane[id].path, resume: true, stage: "converge", who: id, prompt: convergeTask(id)
    }]), "Converging on a middle road");
    const plan = {};
    const vote = {};
    const planSources = {};
    ids.forEach((id, i) => {
      plan[id] = requireOk(converges[i], name(id) + " converge").text;
      const parsed = lastJson(plan[id]) || {};
      vote[id] = lastTag(plan[id], "INTEGRATOR", ids) || (ids.includes(parsed.integrator) ? parsed.integrator : undefined);
      const counts = { [ids[0]]: 0, [ids[1]]: 0, both: 0, new: 0 };
      (Array.isArray(parsed.items) ? parsed.items : []).forEach((item) => {
        if (item && Object.prototype.hasOwnProperty.call(counts, item.source)) counts[item.source] += 1;
      });
      planSources[id] = counts;
    });

    let integrator;
    let integratorReason;
    let decidedBy = "consensus";
    let arbiterReasoning = null;
    if (vote[ids[0]] && vote[ids[0]] === vote[ids[1]]) {
      integrator = vote[ids[0]];
      integratorReason = "Both agents agreed on " + name(integrator) + ".";
    } else {
      await progress("Writers disagreed on the integrator (" + ids.map((id) => name(id) + " → " + (vote[id] ? name(vote[id]) : "?")).join(", ") + ") · arbiter deciding");
      const arbiterLane = config.arbiter.lane;
      const arbiter = await call("arbiter", {
        lane: arbiterLane, role: "reviewer", spec: models[arbiterLane], cwd: repo, helper: true, stage: "arbiter", who: "arbiter",
        structured: (v) => isArbiter(v, ids),
        prompt: [
          "Two agents implemented the same task on branches " + ids.map((id) => lane[id].branch).join(" and ") + " (base " + baseRef + ") and did not agree on which branch should be the integration base.",
          "Task:", args.task, "",
          ...ids.flatMap((id) => [name(id) + "'s final position:", "<<<", plan[id], ">>>", ""]),
          "Inspect both branches. Pick the base that needs the least change to reach the best combined design and state which parts of each plan to keep.",
          "End with a fenced ```json block: {\"integrator\": " + ids.map((x) => "\"" + x + "\"").join(" | ") + ", \"reasoning\": \"...\", \"mergedPlan\": \"...\"}"
        ].join("\n")
      });
      const ruling = lastJson(arbiter.text) || {};
      decidedBy = "arbiter";
      arbiterReasoning = typeof ruling.reasoning === "string" ? ruling.reasoning : null;
      integrator = ids.includes(ruling.integrator) ? ruling.integrator : ids[0];
      integratorReason = "Votes: " + ids.map((id) => id + "=" + (vote[id] || "none")).join(", ") +
        ". Arbiter chose " + integrator + ": " + (ruling.reasoning || "no reasoning returned") +
        (ruling.mergedPlan ? "\nArbiter's merged plan:\n" + ruling.mergedPlan : "");
    }
    const peer = other[integrator];
    const converged = Object.fromEntries(ids.map((id) => [id, convergeSummary(plan[id], ids)]));
    const planFrom = converged[integrator].items.length ? integrator : peer;
    await store.update((s) => {
      Object.assign(s, { votes: { integrator: { ...vote } }, integrator, integratorReason, decidedBy, plan: planSources });
      s.story.converge = converged;
      s.story.plan = { from: planFrom, items: converged[planFrom].items };
      s.story.selection = {
        integrator, decidedBy,
        reasons: Object.fromEntries(ids.map((id) => [id, converged[id].why])),
        arbiter: arbiterReasoning
      };
    });
    await progress("Integrator: " + name(integrator) + (decidedBy === "arbiter" ? " (arbiter decided)" : " (both agreed)"));

    // ---- 4. Integration --------------------------------------------------------

    await enterStep(4);
    await worktree(finalPath, finalBranch, lane[integrator].branch);
    await progress(name(integrator) + " integrating the middle road into " + finalBranch + " · " + name(peer) + " idle");
    const integrated = await call("integrate", {
      lane: integrator, role: "writer", spec: models[integrator], cwd: finalPath, resume: true, stage: "integrate", who: integrator,
      prompt: [
        "You are the integrator. " + integratorReason,
        "",
        "The " + NAME(peer) + " lane's final position:",
        "<<<",
        plan[peer],
        ">>>",
        "",
        "The final branch " + finalBranch + " is checked out at " + finalPath + ", created from your branch " + lane[integrator].branch + ".",
        "Your shell may start in your lane worktree; cd " + finalPath + " before running commands.",
        "Work only in " + finalPath + ". Bring in the agreed parts of " + lane[peer].branch + " (read its diff; cherry-pick or re-implement as appropriate).",
        isolationHint(FINAL_PARTITION),
        "",
        "Implement the agreed middle road. Where the two final positions still disagree, make the call and explain it. Run the full relevant test/quality suite and commit on " + finalBranch + ".",
        "",
        "Final response (recorded verbatim): what you took from each branch, every judgment call on unresolved disagreements with reasons, verification commands and results, final commit SHA."
      ].join("\n")
    });
    writer[integrator] = requireOk(integrated, "integration");

    // ---- 5. Adversarial review cycles ----------------------------------------

    await enterStep(5);
    const rounds = [];
    const reviewMetrics = [];
    let unreviewedFixes = false;
    let history = "";

    function publishRounds() {
      return store.update((s) => {
        s.rounds = rounds.map((r) => ({
          round: r.round,
          verdicts: Object.fromEntries(ids.map((id) => [id, r.reviews[id].verdict])),
          findings: r.findings.map((f) => ({
            id: f.id, severity: f.severity, reviewer: f.reviewer, title: f.title, location: f.location,
            positions: f.positions || {}, disposition: f.disposition || null, why: f.why || ""
          })),
          fixed: Boolean(r.fix)
        }));
      });
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      await progress("Review round " + round + "/" + maxRounds + " · both reviewers reviewing " + finalBranch);
      const reviews = await parallel(ids.map((id) => ["r" + round + "-review-" + id, {
        lane: id, role: "reviewer", spec: models[id], cwd: finalPath, stage: "review r" + round, who: id, structured: isReview,
        prompt: [
          "Adversarially review branch " + finalBranch + " in " + finalPath + " against base " + baseRef + ".",
          "Diff: git diff " + baseRef + "..." + finalBranch,
          "",
          "Task the branch is supposed to accomplish:",
          args.task,
          "",
          "Integrator's summary (claims to verify, not to trust):",
          "<<<",
          writer[integrator].text,
          ">>>",
          history ? "\nEarlier review rounds and how they were resolved (check the fixes; do not re-raise items that were rejected with sound reasoning unless you have new evidence):\n" + history : "",
          "",
          "Run the tests yourself. The other reviewer works in the same worktree concurrently.",
          isolationHint(reviewPartition[id]),
          "Report every substantiated P0/P1/P2 finding.",
          "",
          "End with a fenced ```json block: {\"verdict\": \"BLOCK\" | \"OK_WITH_NOTES\" | \"OK\", \"summary\": \"...\", \"findings\": [{\"severity\": \"P0\" | \"P1\" | \"P2\", \"title\": \"...\", \"location\": \"file:line\", \"evidence\": \"...\", \"suggestedFix\": \"...\"}]}"
        ].join("\n")
      }]), "Review round " + round + "/" + maxRounds, (id, r) => {
        const data = lastJson(r.text);
        const n = isReview(data) ? data.findings.length : 0;
        return name(id) + " reviewer done in " + dur(r.ms) + " (" + plural(n, "finding") + ")";
      });

      const roundInfo = { round, reviews: {}, responses: {}, fix: null, findings: [] };
      const roundMetrics = {};
      ids.forEach((id, i) => {
        const result = reviews[i];
        const parsed = lastJson(result.text);
        const data = !result.ok
          ? { verdict: "FAILED", summary: String(result.error || result.text || "").slice(0, 4000), findings: [] }
          : isReview(parsed) ? parsed : { verdict: "UNKNOWN", summary: String(result.text || "").slice(0, 4000), findings: [] };
        roundInfo.reviews[id] = data;
        roundMetrics[id] = { round, reviewer: id, model: models[id], ms: result.ms, verdict: data.verdict, findings: [] };
        reviewMetrics.push(roundMetrics[id]);
        data.findings.forEach((f, n) => roundInfo.findings.push({ id: byId[id].prefix + round + "-" + (n + 1), reviewer: id, ...f }));
      });
      const findings = roundInfo.findings;
      findings.forEach((f) => roundMetrics[f.reviewer].findings.push({ id: f.id, severity: f.severity, disposition: null }));
      const reviewFailed = ids.some((id) => ["FAILED", "UNKNOWN"].includes(roundInfo.reviews[id].verdict));
      const blocking = findings.filter((f) => f.severity !== "P2");
      roundInfo.blocking = blocking.length;
      roundInfo.total = findings.length;
      rounds.push(roundInfo);
      await publishRounds();

      const tally = plural(findings.length, "finding") + " (" + blocking.length + " P0/P1)";
      if (!reviewFailed && findings.length === 0) {
        await progress("Review round " + round + "/" + maxRounds + " · clean, no findings");
        unreviewedFixes = false;
        break;
      }

      const findingsText = findings.length
        ? findings.map((f) => "[" + f.id + "] " + f.severity + " " + f.title + " @ " + f.location + "\n  Evidence: " + f.evidence + "\n  Suggested fix: " + f.suggestedFix).join("\n\n")
        : "Reviewers returned no structured findings. Raw review notes:\n" + ids.map((id) => name(id) + ": " + roundInfo.reviews[id].summary).join("\n");

      // Both original writers take a position on every finding (no edits).
      await progress("Review round " + round + "/" + maxRounds + " · " + (reviewFailed ? "a reviewer failed; " : "") + tally + " → both writers responding");
      const responses = await parallel(ids.map((id) => ["r" + round + "-respond-" + id, {
        lane: id, role: "writer", spec: models[id], cwd: id === integrator ? finalPath : lane[id].path, resume: true, stage: "respond r" + round, who: id,
        prompt: [
          "Round " + round + " adversarial review of " + finalBranch + " (" + finalPath + ") is in.",
          id === integrator ? "You are the integrator; you will apply fixes in the next step." : "The integrator is " + name(integrator) + ". Your position will be passed to them.",
          "Do not edit any files in this stage.",
          "",
          findingsText,
          "",
          "For every finding give: ACCEPT / REJECT / MODIFY, your reasoning with evidence (read the code, run tests), and the fix you would make. Flag anything the reviewers missed.",
          "End with a fenced ```json block for the operator's dashboard: {\"positions\": [{\"id\": \"<finding id>\", \"position\": \"ACCEPT\" | \"REJECT\" | \"MODIFY\", \"why\": \"one line\"}]}"
        ].join("\n")
      }]), "Review round " + round + "/" + maxRounds + " · writers responding");
      ids.forEach((id, i) => { roundInfo.responses[id] = requireOk(responses[i], name(id) + " round " + round + " response").text; });
      ids.forEach((id) => {
        const taken = positionsOf(roundInfo.responses[id]);
        findings.forEach((f) => { if (taken[f.id]) f.positions = { ...(f.positions || {}), [id]: taken[f.id] }; });
      });
      await publishRounds();

      await progress("Review round " + round + "/" + maxRounds + " · " + name(integrator) + " applying fixes");
      const fixed = await call("r" + round + "-fix", {
        lane: integrator, role: "writer", spec: models[integrator], cwd: finalPath, resume: true, stage: "fix r" + round, who: integrator,
        prompt: [
          "Apply fixes for round " + round + " in " + finalPath + " on " + finalBranch + ".",
          "Your shell may start in another directory; cd " + finalPath + " before running commands.",
          "",
          "The " + NAME(peer) + " lane's position on each finding:",
          "<<<",
          roundInfo.responses[peer],
          ">>>",
          "",
          "Fix every finding either of you ACCEPTed or MODIFYed. Where you and the peer disagree, decide and justify. Use test-first fixes where the repo expects it. Rerun the relevant tests and commit.",
          "",
          "Final response (recorded verbatim): a table of finding id → FIXED / REJECTED / DEFERRED with one-line reasoning, verification commands and results, final commit SHA.",
          "Also include a fenced ```json block: {\"dispositions\": [{\"id\": \"<finding id>\", \"status\": \"FIXED\" | \"REJECTED\" | \"DEFERRED\", \"why\": \"one line\"}]} covering every finding id."
        ].join("\n")
      });
      writer[integrator] = requireOk(fixed, "round " + round + " fixes");
      roundInfo.fix = fixed.text;
      const disposed = dispositionsOf(fixed.text);
      findings.forEach((f) => {
        if (disposed[f.id]) Object.assign(f, { disposition: disposed[f.id].status, why: disposed[f.id].why });
      });
      ids.forEach((id) => roundMetrics[id].findings.forEach((f) => { if (disposed[f.id]) f.disposition = disposed[f.id].status; }));
      await publishRounds();
      unreviewedFixes = true;
      history += "\nRound " + round + " findings:\n" + findingsText + "\n\nResolution by integrator:\n" + fixed.text + "\n";
      // P2-only rounds are not worth another full review; the peer sign-off covers them.
      if (!reviewFailed && blocking.length === 0) {
        await progress("Review round " + round + " had only P2 findings · skipping another review round");
        break;
      }
    }

    // ---- Peer sign-off when the last fixes were never re-reviewed --------------

    let signoffVerdict = null;
    if (unreviewedFixes) {
      await progress("Last fixes were not re-reviewed · " + name(peer) + " checking them for sign-off");
      const signoff = await call("signoff", {
        lane: peer, role: "writer", spec: models[peer], cwd: lane[peer].path, resume: true, stage: "signoff", who: peer,
        prompt: [
          "The review cap has been reached; the integrator's last fixes will not be re-reviewed by the reviewer pair.",
          "Inspect the final state of " + finalBranch + " in " + finalPath + " (git log / git diff " + baseRef + "..." + finalBranch + "), rerun the tests, and do not edit files.",
          "",
          "Integrator's last fix report:",
          "<<<",
          writer[integrator].text,
          ">>>",
          "",
          "Report: whether each fix is correct, any regression it introduced, and remaining concerns the operator should weigh before merging.",
          "End with exactly one line: SIGNOFF: approve or SIGNOFF: concerns"
        ].join("\n")
      });
      signoffVerdict = lastTag(signoff.text, "SIGNOFF", ["approve", "concerns"]) || null;
    }
    await store.update((s) => { s.signoff = signoffVerdict; s.unreviewedFixes = unreviewedFixes; });

    // ---- Metrics (same schema as dual-pr-metrics.mjs) ---------------------------

    const writerStages = log.filter((e) => ids.includes(e.who) && e.role === "writer").map((e) => e.stage);
    const laneMs = (id, stages) => log.filter((e) => e.who === id && e.role === "writer" && stages.includes(e.stage)).reduce((sum, e) => sum + (e.ms || 0), 0);
    const metrics = {
      schema: 1,
      id: st.id,
      startedAt: st.startedAt,
      repo,
      slug,
      task: String(args.task).slice(0, 300),
      difficulty,
      fallback,
      maxRounds,
      models,
      harnesses: Object.fromEntries(ids.map((id) => [id, byId[id].harness])),
      lanes: Object.fromEntries(ids.map((id) => [id, {
        model: models[id], draftMs: laneMs(id, ["draft"]), discussMs: laneMs(id, ["critique", "converge"]), writerMs: laneMs(id, writerStages)
      }])),
      votes: Object.fromEntries(ids.map((id) => [id, vote[id] || null])),
      integrator,
      decidedBy,
      plan: planSources,
      reviews: reviewMetrics,
      unreviewedFixes,
      signoff: signoffVerdict,
      stages: log.map((e) => ({ stage: e.stage, who: e.who, model: e.model, ok: e.ok, ms: e.ms || 0 })),
      totalMs: Date.now() - startedAt
    };
    await store.update((s) => { s.metrics = metrics; });

    // ---- 6. Report --------------------------------------------------------------

    await enterStep(6);
    await progress("Writing the report");
    const reportPath = join(reportDir, "REPORT.md");
    const stageIndex = log.map((e, i) => (i + 1) + ". " + e.stage + " — " + e.who + " (" + e.model + ")" + (e.ok ? "" : " [FAILED]") + " → " + e.file).join("\n");
    const stageBodies = log.map((e) => "=== " + e.stage + " / " + e.who + " / " + e.model + " ===\n" + String(e.text || "").slice(0, 20000)).join("\n\n");
    const roundSummary = rounds.map((r) =>
      "Round " + r.round + ": " + r.total + " findings (" + r.blocking + " P0/P1). Verdicts: " + ids.map((id) => id + "=" + r.reviews[id].verdict).join(", ")
    ).join("\n");
    const report = await call("report", {
      lane: config.reporter.lane, role: "reporter", spec: config.reporter.model, cwd: repo, helper: true, file: false,
      stage: "report", who: "reporter",
      prompt: [
        "Write the final report to exactly: " + reportPath,
        "",
        "## Run facts",
        "Task: " + args.task,
        "Repository: " + repo + "  Base: " + baseRef,
        "Difficulty: " + difficulty + ". Why: " + triageReason,
        "Model tier: " + fallback + (fallbackReason ? ". " + fallbackReason : "") + (fallback === "fallback" ? " The tier fell back to its fallback pair; say so in the Setup section." : ""),
        "Lanes: " + ids.map((id) => name(id) + " via " + byId[id].harness + " (writer + reviewer) = " + models[id]).join("; ") +
          "; triage = " + config.triage.model + "; reporter = " + config.reporter.model,
        "Lane branches: " + ids.map((id) => lane[id].branch + " (" + lane[id].path + ")").join(", "),
        "Final branch: " + finalBranch + " (" + finalPath + ")",
        "Integrator: " + integrator + ". " + integratorReason,
        "Review rounds (max " + maxRounds + "):\n" + roundSummary,
        "Last fixes re-reviewed by reviewer pair: " + (unreviewedFixes ? "NO (peer sign-off only)" : "yes / no fixes needed"),
        "",
        "## Timing and acceptance metrics (JSON, also saved for cross-run analysis)",
        JSON.stringify({ lanes: metrics.lanes, votes: metrics.votes, integrator, decidedBy, plan: metrics.plan, reviews: metrics.reviews, signoff: signoffVerdict, totalMs: metrics.totalMs }),
        "Present this as a 'Time vs acceptance' section: each lane's draft and total writer time in minutes, whether its branch became the base, whether the peer voted for it, its share of the middle-road plan items, and each reviewer's finding count and how many were FIXED vs REJECTED. One run is anecdotal; say so.",
        "",
        "## Stage files (full verbatim outputs)",
        stageIndex,
        "",
        "## Required structure",
        "1. TL;DR: what shipped, merge recommendation, and the 1-3 things the operator must decide.",
        "2. Setup: difficulty rating and why, model table (role → harness → model → effort).",
        "3. The two independent approaches side by side: design, notable choices, tests, weak spots. Include `git diff --stat` for each lane branch vs base.",
        "4. The discussion: where each conceded, where they held firm, the agreed middle road, and how the integrator was chosen. Quote the key reasoning briefly.",
        "5. Integration: what came from which branch, judgment calls.",
        "6. Each review round: table of findings (id, severity, reviewer, title) with the writers' positions and the final disposition. Call out rejected findings and the reasoning so the operator can overrule.",
        "7. Final state: `git log --oneline " + baseRef + ".." + finalBranch + "`, test status as reported, peer sign-off if any.",
        "8. Decision points and residual risks.",
        "9. Appendix: links to every stage file above.",
        "",
        "## Stage outputs",
        stageBodies
      ].join("\n")
    });
    metrics.stages.push({ stage: "report", who: "reporter", model: config.reporter.model, ok: report.ok, ms: report.ms || 0 });
    metrics.totalMs = Date.now() - startedAt;
    await store.update((s) => {
      s.metrics = metrics;
      s.report = reportPath;
      s.reportOk = report.ok;
      s.status = "done";
      s.next = null;
      s.endedAt = new Date().toISOString();
    });
    await store.event("Done · " + finalBranch + " · total " + dur(metrics.totalMs));

    return {
      finalBranch,
      finalPath,
      report: reportPath,
      reportOk: report.ok,
      difficulty,
      fallback,
      models,
      integrator,
      integratorReason,
      rounds: rounds.map((r) => ({ round: r.round, findings: r.total, blocking: r.blocking, verdicts: Object.fromEntries(ids.map((id) => [id, r.reviews[id].verdict])) })),
      unreviewedFixes,
      metrics: { id: metrics.id, lanes: metrics.lanes, votes: metrics.votes, decidedBy, plan: metrics.plan, totalMs: metrics.totalMs },
      laneBranches: ids.map((id) => lane[id].branch),
      stageFiles: log.map((e) => e.file).filter(Boolean)
    };
  }
}
