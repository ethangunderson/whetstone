// Short summaries of what each stage decided, for the pane's story: each
// lane's approach, what it conceded, the agreed plan, positions on review
// findings. Agents give them as a fenced ```json block; anything missing or
// malformed degrades to empty values rather than failing the run.
import { lastJson, lastTag } from "./parse.mjs";

const clip = (text, n) => {
  const t = String(text || "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const text = (v, n = 600) => (typeof v === "string" ? clip(v, n) : "");
const list = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => clip(x, 300)) : [];
const block = (reply) => {
  const v = lastJson(reply);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

function firstLine(reply) {
  const line = String(reply || "")
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find(Boolean);
  return clip(line || "", 600);
}

export function draftSummary(reply) {
  const b = block(reply);
  return { approach: text(b.approach) || firstLine(reply), choices: list(b.choices), weakSpots: list(b.weakSpots) };
}

export function critiqueSummary(reply, laneIds) {
  const b = block(reply);
  return {
    peerBetter: list(b.peerBetter),
    mineBetter: list(b.mineBetter),
    middleRoad: text(b.middleRoad),
    base: lastTag(reply, "BASE", laneIds) || null,
  };
}

export function convergeSummary(reply, laneIds) {
  const b = block(reply);
  const sources = [...laneIds, "both", "new"];
  return {
    vote: lastTag(reply, "INTEGRATOR", laneIds) || (laneIds.includes(b.integrator) ? b.integrator : null),
    why: text(b.why),
    concessions: list(b.concessions),
    holding: list(b.holding),
    items: (Array.isArray(b.items) ? b.items : [])
      .filter((i) => i && typeof i.item === "string" && sources.includes(i.source))
      .map((i) => ({ item: clip(i.item, 300), source: i.source })),
  };
}

const POSITIONS = ["ACCEPT", "REJECT", "MODIFY"];
export function positionsOf(reply) {
  const out = {};
  for (const p of Array.isArray(block(reply).positions) ? block(reply).positions : []) {
    const position = p && String(p.position || "").toUpperCase();
    if (p && typeof p.id === "string" && POSITIONS.includes(position)) out[p.id] = { position, why: text(p.why, 400) };
  }
  return out;
}

const STATUSES = ["FIXED", "REJECTED", "DEFERRED"];
export function dispositionsOf(reply) {
  const out = {};
  for (const d of Array.isArray(block(reply).dispositions) ? block(reply).dispositions : []) {
    if (d && typeof d.id === "string" && STATUSES.includes(d.status))
      out[d.id] = { status: d.status, why: text(d.why, 400) };
  }
  return out;
}
