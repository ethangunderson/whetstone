// Which harness each lane runs on and which model each difficulty tier uses.
// Model strings are written the way the lane's harness spells them, with an
// optional `:low|medium|high` effort suffix.

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TIERS = ["easy", "medium", "hard"];

export const DEFAULT_CONFIG = {
  lanes: [
    // Live pi agents in Herdr terminals. Use harness "pi" to run headless without Herdr.
    { id: "claude", name: "Claude", harness: "herdr", agent: "pi", prefix: "CL" },
    { id: "codex", name: "Codex", harness: "herdr", agent: "pi", prefix: "CX" },
  ],
  tiers: {
    easy: { claude: "claude-bridge/claude-sonnet-5-5:medium", codex: "openai-codex/gpt-6-luna:medium" },
    medium: { claude: "claude-bridge/claude-opus-5-5:medium", codex: "openai-codex/gpt-6-sol:medium" },
    // Without Fable, Opus 5.5 is Claude's ceiling. Pair it with the Codex model it
    // matches at medium and give both more thinking, so the lanes stay even.
    hard: {
      claude: "claude-bridge/claude-fable-5-1:high",
      codex: "openai-codex/gpt-6.1-sol:high",
      fallback: { claude: "claude-bridge/claude-opus-5-5:high", codex: "openai-codex/gpt-6-sol:high" },
    },
  },
  triage: { lane: "codex", model: "openai-codex/gpt-6-luna:low" },
  reporter: { lane: "claude", model: "claude-bridge/claude-sonnet-5-5:medium" },
  arbiter: { lane: "codex" },
};

export function splitModel(spec) {
  const text = String(spec);
  const at = text.lastIndexOf(":");
  if (at > 0 && EFFORTS.includes(text.slice(at + 1))) return { model: text.slice(0, at), effort: text.slice(at + 1) };
  return { model: text, effort: undefined };
}

function titleCase(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** @param {Record<string, any>} [user] parsed config JSON */
export function resolveConfig(user = DEFAULT_CONFIG) {
  const lanes = (user.lanes || []).map((lane) => ({ ...lane, name: lane.name || titleCase(lane.id) }));
  if (lanes.length !== 2) throw new Error(`config needs exactly two lanes, got ${lanes.length}`);
  const ids = lanes.map((l) => l.id);
  if (ids[0] === ids[1]) throw new Error("config lanes need distinct ids");
  lanes.forEach((lane) => {
    if (!lane.harness) throw new Error(`config lane ${lane.id} needs a harness`);
  });
  const [a, b] = lanes;
  if (!a.prefix || !b.prefix || a.prefix === b.prefix) {
    let pa = a.prefix || a.id.slice(0, 2).toUpperCase();
    let pb = b.prefix || b.id.slice(0, 2).toUpperCase();
    if (pa === pb) {
      pa = "A";
      pb = "B";
    }
    a.prefix = pa;
    b.prefix = pb;
  }

  const tiers = {};
  for (const tier of TIERS) {
    const t = user.tiers?.[tier];
    for (const id of ids) {
      if (!t?.[id]) throw new Error(`config tiers.${tier} needs a model for lane ${id}`);
      if (t.fallback && !t.fallback[id]) throw new Error(`config tiers.${tier}.fallback needs a model for lane ${id}`);
    }
    tiers[tier] = t;
  }

  const helper = (name, needsModel) => {
    const h = { ...(DEFAULT_CONFIG[name] || {}), ...(user[name] || {}) };
    if (!user[name] && name === "arbiter") h.lane = ids[1];
    if (!ids.includes(h.lane)) throw new Error(`config ${name}.lane must be one of ${ids.join(", ")}`);
    if (needsModel && !h.model) throw new Error(`config ${name}.model is required`);
    return h;
  };

  return {
    lanes,
    tiers,
    triage: helper("triage", true),
    reporter: helper("reporter", true),
    arbiter: helper("arbiter", false),
  };
}
