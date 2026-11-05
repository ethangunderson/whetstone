// Reading decisions out of agent replies. Every harness returns plain text,
// so decisions travel as a fenced ```json block, `TAG: value` lines, or a
// fenced ```question block, and are checked here.

const SEVERITIES = ["P0", "P1", "P2"];
const VERDICTS = ["BLOCK", "OK_WITH_NOTES", "OK"];

// Last ```json fenced block in a reply, parsed; undefined when absent or invalid.
export function lastJson(text) {
  const blocks = [...String(text || "").matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(blocks[i][1]); } catch { /* try an earlier block */ }
  }
  return undefined;
}

// Value of the last `TAG: value` line, lowercased, when it is one of `allowed`.
export function lastTag(text, tag, allowed) {
  const re = new RegExp("^\\s*" + tag + ":\\s*([a-z-]+)", "gim");
  let match;
  let found;
  while ((match = re.exec(String(text || ""))) !== null) found = match[1].toLowerCase();
  return allowed.includes(found) ? found : undefined;
}

// Body of the last ```question fenced block; undefined when absent or empty.
export function parseQuestion(text) {
  const blocks = [...String(text || "").matchAll(/```question\s*([\s\S]*?)```/g)];
  const body = blocks.length ? blocks[blocks.length - 1][1].trim() : "";
  return body || undefined;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string";

export function isTriage(v) {
  return isObject(v) && ["easy", "medium", "hard"].includes(v.difficulty) && isText(v.reasoning) && Array.isArray(v.risks);
}

export function isReview(v) {
  return isObject(v) && VERDICTS.includes(v.verdict) && isText(v.summary) && Array.isArray(v.findings) &&
    v.findings.every((f) => isObject(f) && SEVERITIES.includes(f.severity) &&
      ["title", "location", "evidence", "suggestedFix"].every((k) => isText(f[k])));
}

export function isArbiter(v, laneIds) {
  return isObject(v) && laneIds.includes(v.integrator) && isText(v.reasoning) && isText(v.mergedPlan);
}
