// What the Whetstone pane shows, worked out from a run's state.json,
// control.json and events.jsonl. Pure functions, no Herdr imports, so they
// run under `node --test` too (test/mod/model.test.mjs).

const ACTIVE = ["running", "paused", "waiting", "blocked"];
const SEVERITIES = ["P0", "P1", "P2"];

export const isActive = (state) => ACTIVE.includes(state?.status);

export function shortModel(spec) {
  if (!spec) return "";
  const text = String(spec).split("/").pop();
  const at = text.lastIndexOf(":");
  return at > 0 ? `${text.slice(0, at)} · ${text.slice(at + 1)}` : text;
}

export function elapsed(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

const titleCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

// alive: whether the engine process is still there (checked by the caller).
export function runHeader(state, control, alive) {
  // A run from a Linear issue shows its title, linked; the task text carries the whole description.
  const base = state.issue
    ? { slug: state.slug, task: state.issue.title, issue: state.issue }
    : { slug: state.slug, task: state.task };
  if (isActive(state) && !alive) return { ...base, status: "Interrupted", tone: "failed" };
  switch (state.status) {
    case "running":
      return control?.pause
        ? { ...base, status: "Pausing after this stage", tone: "attention" }
        : { ...base, status: "Running", tone: "working" };
    case "paused":
      return { ...base, status: "Paused", tone: "attention" };
    case "waiting":
      return { ...base, status: "Waiting for you", tone: "attention" };
    case "blocked":
      return { ...base, status: "Needs you", tone: "attention" };
    case "done":
      return { ...base, status: "Done", tone: "done" };
    case "failed":
      return { ...base, status: "Failed", tone: "failed" };
    case "stopped":
      return { ...base, status: "Stopped", tone: "idle" };
    default:
      return { ...base, status: titleCase(state.status || "starting"), tone: "idle" };
  }
}

// The status word plus what's happening, but only while the run is moving:
// otherwise the latest event just repeats the status.
export function statusLine(state, control, alive) {
  const { status, tone } = runHeader(state, control, alive);
  const moving = state.status === "running" && alive && !control?.pause;
  return { status, tone, detail: moving ? String(state.latest || "").replace(/^Step \d+\/\d+ · /, "") : "" };
}

// How the pane runs the CLI: the node and cli.mjs paths recorded at install
// time (Herdr's exec doesn't see a login shell's PATH), else `whetstone`.
export function cliCommand(config, args) {
  if (config?.node && config.cli) return [config.node, [config.cli, ...args]];
  return ["whetstone", args];
}

export function steps(state) {
  const names = state.steps || ["Triage", "Draft", "Debate", "Integrate", "Review", "Report"];
  const current = state.step || 0;
  return names.map((name, i) => {
    const n = i + 1;
    let s = "todo";
    if (state.status === "done" || n < current) s = "done";
    else if (n === current) s = state.status === "failed" ? "failed" : "current";
    return { n, name, state: s };
  });
}

function roleLabel(lane, id, state) {
  if (state.status === "done" && state.integrator) return id === state.integrator ? "Integrator" : "Writer";
  if (lane.role === "reviewer") return "Reviewer";
  if (lane.role === "writer") return /^(integrate|r\d+-fix)$/.test(lane.stage || "") ? "Integrator" : "Writer";
  return "Idle";
}

export function laneCards(state, now) {
  return Object.entries(state.lanes || {}).map(([id, lane]) => {
    let status = "idle";
    if (lane.status === "working") status = "working";
    else if (lane.status === "blocked") status = "needs you";
    else if (lane.status === "failed") status = "failed";
    else if (lane.status === "error") status = "error";
    else if (state.status === "done") status = "done";
    const working = ["working", "blocked", "error"].includes(lane.status);
    return {
      id,
      name: lane.name,
      role: roleLabel(lane, id, state),
      status,
      detail: working && lane.since ? elapsed(now - Date.parse(lane.since)) : "",
      model: shortModel(lane.model),
      harness: lane.harness,
      terminal: lane.terminal || null,
    };
  });
}

export function decision(state) {
  if (!state.integrator) return null;
  const lanes = state.lanes || {};
  const name = (id) => lanes[id]?.name || titleCase(id);
  const votes = state.votes?.integrator || {};
  const plan = state.plan?.[state.integrator] || {};
  const share = Object.keys(lanes).map((id) => [name(id), plan[id] || 0]);
  share.push(["Both", plan.both || 0], ["New", plan.new || 0]);
  return {
    integrator: name(state.integrator),
    how: state.decidedBy === "arbiter" ? "arbiter decided" : "both agreed",
    votes: Object.keys(lanes)
      .filter((id) => votes[id])
      .map((id) => [name(id), name(votes[id])]),
    share,
  };
}

const isOpen = (f) => f.disposition !== "FIXED" && f.disposition !== "REJECTED";

export function stats(state, now) {
  const rs = state.rounds || [];
  const findings = rs.flatMap((r) => r.findings || []);
  const difficulty = state.difficulty
    ? titleCase(state.difficulty) + (state.fallback === "fallback" ? " · fallback" : "")
    : "–";
  // Active time: wall time minus the time spent waiting for the operator.
  const end = state.endedAt ? Date.parse(state.endedAt) : now;
  const waiting = state.waitingSince ? now - Date.parse(state.waitingSince) : 0;
  const total = end - Date.parse(state.startedAt) - (state.waitedMs || 0) - waiting;
  return [
    ["Difficulty", difficulty],
    ["Rounds", String(rs.length)],
    ["Open findings", rs.length ? String(findings.filter(isOpen).length) : "–"],
    ["Active", state.startedAt ? elapsed(total) : "–"],
  ];
}

export function rounds(state) {
  const lanes = state.lanes || {};
  return (state.rounds || []).map((r) => {
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    (r.findings || []).forEach((f) => {
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
    });
    return {
      round: r.round,
      counts,
      findings: (r.findings || []).map((f) => ({
        id: f.id,
        severity: f.severity,
        reviewer: (lanes[f.reviewer] && lanes[f.reviewer].name) || f.reviewer,
        title: f.title,
        disposition: f.disposition ? f.disposition.toLowerCase() : "open",
        positions: Object.entries(f.positions || {}).map(([id, p]) => ({
          name: lanes[id]?.name || id,
          position: String(p.position).toLowerCase(),
          why: p.why || "",
        })),
        why: f.why || "",
      })),
    };
  });
}

export function parseEvents(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.text) out.push(e);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

export function history(events, limit) {
  return events
    .slice(-limit)
    .reverse()
    .map((e) => {
      const d = new Date(e.at);
      return {
        time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
        text: String(e.text).replace(/^Step \d+\/\d+ · /, ""),
      };
    });
}

export function actions(state, control, alive) {
  if (isActive(state) && !alive) return ["restart"];
  switch (state.status) {
    case "running":
      return [control?.pause ? "resume" : "pause", "stop"];
    case "paused":
      return ["resume", "stop"];
    case "waiting":
      return ["approve", "stop"];
    case "blocked":
      return ["stop"];
    case "done":
      return state.report ? ["report"] : [];
    case "failed":
      return ["restart"];
    default:
      return [];
  }
}

// pin: { id, at } from clicking through runs; it holds until a run starts after it.
export function pickRun(runs, pin) {
  if (!runs.length) return null;
  if (pin && runs.some((r) => r.id === pin.id) && !runs.some((r) => String(r.state.startedAt || "") > String(pin.at)))
    return pin.id;
  const newest = (list) =>
    list.slice().sort((a, b) => String(b.state.startedAt || "").localeCompare(String(a.state.startedAt || "")))[0];
  const active = runs.filter((r) => isActive(r.state));
  return (active.length ? newest(active) : newest(runs)).id;
}

// ---- The story: what was proposed, argued and agreed ----------------------

const laneName = (state, id) => state.lanes?.[id]?.name || (id ? titleCase(id) : null);
const SOURCE_NAMES = { both: "Both", new: "New" };

export function storySections(state) {
  const story = state.story;
  if (!story) return [];
  const ids = Object.keys(state.lanes || {});
  const out = [];
  const drafts = story.drafts || {};
  if (Object.keys(drafts).length) {
    out.push({
      kind: "approaches",
      title: "Approaches",
      lanes: ids.map((id) => ({
        id,
        name: laneName(state, id),
        approach: drafts[id] ? drafts[id].approach || null : null,
        choices: drafts[id] ? drafts[id].choices || [] : [],
        weakSpots: drafts[id] ? drafts[id].weakSpots || [] : [],
      })),
    });
  }
  const critiques = story.critiques || {};
  if (Object.keys(critiques).length) {
    out.push({
      kind: "debate",
      title: "Debate",
      lanes: ids.map((id) => {
        const c = critiques[id];
        return {
          id,
          name: laneName(state, id),
          peerBetter: c ? c.peerBetter || [] : [],
          mineBetter: c ? c.mineBetter || [] : [],
          middleRoad: c ? c.middleRoad || null : null,
          base: c?.base ? laneName(state, c.base) : null,
        };
      }),
    });
  }
  const sel = story.selection;
  if (sel) {
    const integrator = laneName(state, sel.integrator);
    const converge = story.converge || {};
    out.push({
      kind: "agreement",
      title: "Agreement",
      integrator,
      how: sel.decidedBy === "arbiter" ? `They disagreed; the arbiter chose ${integrator}` : `Both chose ${integrator}`,
      reasons: ids
        .filter((id) => sel.reasons?.[id])
        .map((id) => ({
          name: laneName(state, id),
          vote: converge[id]?.vote ? laneName(state, converge[id].vote) : null,
          why: sel.reasons[id],
        })),
      arbiter: sel.arbiter || null,
      concessions: ids
        .filter((id) => converge[id])
        .map((id) => ({
          name: laneName(state, id),
          conceded: converge[id].concessions || [],
          holding: converge[id].holding || [],
        })),
      plan: (story.plan?.items || []).map((i) => ({
        item: i.item,
        source: SOURCE_NAMES[i.source] || laneName(state, i.source),
      })),
    });
  }
  return out;
}

// ---- The lane viewer --------------------------------------------------------

const REVIEW_TURN = /^r(\d+)-(review|respond)-/;
const FIX_ROUND = /^r(\d+)-fix$/;

function stageRank(key) {
  if (key.startsWith("draft-")) return 1;
  if (key.startsWith("critique-")) return 2;
  if (key.startsWith("converge-")) return 3;
  if (key === "integrate") return 4;
  const turn = REVIEW_TURN.exec(key);
  if (turn) return 10 * Number(turn[1]) + (turn[2] === "review" ? 1 : 2);
  const fix = FIX_ROUND.exec(key);
  if (fix) return 10 * Number(fix[1]) + 3;
  if (key === "signoff") return 100;
  return null;
}

function stageLabel(key) {
  if (key.startsWith("draft-")) return "Draft";
  if (key.startsWith("critique-")) return "Critique";
  if (key.startsWith("converge-")) return "Converge";
  if (key === "integrate") return "Integrate";
  const turn = REVIEW_TURN.exec(key);
  if (turn) return (turn[2] === "review" ? "Review " : "Respond ") + turn[1];
  const fix = FIX_ROUND.exec(key);
  if (fix) return `Fix ${fix[1]}`;
  return "Sign-off";
}

export function laneStages(state, laneId) {
  const out = [];
  for (const [key, r] of Object.entries(state.results || {})) {
    if (r.lane === laneId && stageRank(key) !== null)
      out.push({ key, label: stageLabel(key), state: r.ok ? "done" : "failed", file: r.file || null });
  }
  for (const [key, r] of Object.entries(state.running || {})) {
    if (r.lane === laneId && stageRank(key) !== null && !out.some((s) => s.key === key))
      out.push({ key, label: stageLabel(key), state: "running", file: null });
  }
  return out.sort((a, b) => stageRank(a.key) - stageRank(b.key));
}

export function activityItems(text) {
  const out = [];
  const tools = {};
  for (const line of String(text || "").split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    if (e.kind === "tool") {
      const item = { kind: "tool", tool: e.tool, text: e.text, status: "running", output: "", ms: null };
      tools[e.id] = item;
      out.push(item);
    } else if (e.kind === "tool_end" && tools[e.id]) {
      Object.assign(tools[e.id], {
        status: e.ok ? "ok" : "failed",
        output: e.text || "",
        ms: typeof e.ms === "number" ? e.ms : null,
      });
    } else if (e.kind === "text" || e.kind === "error") {
      out.push({ kind: e.kind, text: e.text });
    }
  }
  return out;
}
