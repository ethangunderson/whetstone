# whetstone — plan

Claude and Codex each build the same task, debate a middle road, one
integrates, a Claude+Codex reviewer pair attacks it, and the writers respond.
Today this is a pi-subagents workflow (`~/.pi/agent/workflows/dual-pr.js`,
`/dual-pr` prompt). Whetstone replaces it with:

- an **engine** that owns the run and talks only to `pi`, and
- a **native Herdr pane** that shows the run and controls it.

## Decisions so far

- **Every lane runs through `pi`**, with the model passed on the command line
  (`--model claude-bridge/claude-opus-5-5:high`, `openai-codex/gpt-6-sol:high`).
  This keeps pi's logins and model routing; no Codex or Claude Code CLI needed.
  The lane functions are the only place that knows about `pi`, so another
  runner could be added later.
- **The engine is not the mod.** Saving a mod file or switching layouts
  restarts mods, and a run lasts hours. The engine is a plain Node CLI that
  runs in its own Herdr terminal and checkpoints to disk. The mod only reads
  state and writes control requests.
- **No pi-subagents dependency.** The engine does its own sequencing and
  checkpointing.
- **The pane looks native.** Visual reference: `assets/reference-review-loop.png`
  (a different mod; borrow its look, not its names or content).
  Idiom: `~/.config/herdr-app/mods/linear/look.js`. Use `theme()` colors only,
  color only for state, and surfaces stay neutral.
- **Step mode**: runs advance on their own by default; an optional "wait for
  me between steps" toggle shows a "Start <next step>" button instead.
- **New repo** shaped like a shareable Herdr mod: `mods/whetstone/` with
  `RECIPE.md` and `preview.png`, plus `engine/`.

## How a lane maps to pi

| Need | pi |
|---|---|
| Model + thinking | `--model <provider/id>:<level>` (same strings as `TIERS` today) |
| Context across stages | `--session-id whetstone-<run>-<lane>`, reused stage to stage |
| Role | `--system-prompt` from `agents/dual-*.md` (moved into this repo) |
| Read-only reviewers | `--tools read,grep,find,ls,bash` |
| Parseable output | `-p --mode json` (or `--mode rpc` for a lane that can be aborted mid-turn) |
| Visible in Herdr | started with `hc run --bg`, labeled `whetstone=<run> lane=<who>` |

Structured output: pi has no `--json-schema`. Keep the current approach
(last ```json block, `BASE:` / `INTEGRATOR:` / `SIGNOFF:` tags), validate in
the engine, and re-ask once on invalid output.

Questions from writers: `contact_supervisor` doesn't exist outside
pi-subagents. A writer that needs a decision ends its turn with a `QUESTION`
block; the engine marks the lane `blocked`, the pane shows the question, and
the answer is sent back into the same session.

## Files on disk

```
~/.whetstone/runs/<run-id>/
  state.json     engine-owned; written atomically after every change
  control.json   mod-owned requests: { pause: "after-step" | "now" | null, stop, answers: {...} }
  events.jsonl   history lines for the pane
  lanes/<key>.jsonl  raw pi --mode json output per stage
```

Worktrees and the report keep today's shape under a new name:
`<repo parent>/.whetstone/<repo>-<slug>/{claude,codex,final,report}`, branches
`whetstone/<slug>`, `whetstone/<slug>-claude`, `whetstone/<slug>-codex`.

`state.json` sketch:

```json
{
  "id": "add-rate-limiter-1793914877",
  "task": "…", "repo": "…", "slug": "…", "baseRef": "HEAD",
  "status": "running | paused | blocked | done | failed | stopped",
  "step": 5, "steps": ["triage","draft","debate","integrate","review","report"],
  "difficulty": "hard", "fable": "available",
  "models": { "claude": "…", "codex": "…" },
  "lanes": {
    "claude": { "role": "reviewer", "status": "working", "terminal": "t7", "since": "…" },
    "codex":  { "role": "integrator", "status": "idle", "terminal": "t8" }
  },
  "votes": { "base": {}, "integrator": { "claude": "codex", "codex": "codex" } },
  "integrator": "codex", "decidedBy": "consensus",
  "plan": { "claude": {"claude":3,"codex":5,"both":2,"new":1}, "codex": {} },
  "rounds": [{ "round": 1, "findings": [{ "id": "CL1-1", "severity": "P1", "reviewer": "claude", "title": "…", "disposition": "FIXED" }] }],
  "question": null,
  "stages": [{ "key": "draft-claude", "ok": true, "ms": 840000, "file": "…" }],
  "report": null
}
```

## Pause and stop

- **Pause after this step**: the engine finishes the running stage(s) and
  doesn't start the next. Nothing is lost.
- **Pause now**: the engine aborts the running lanes (rpc abort / `hc interrupt`).
  On resume it sends "continue where you left off" into the same sessions;
  worktree changes are still on disk.
- **Stop**: abort lanes and end the run as `stopped`. Worktrees and branches
  are kept.
- **Resume after a crash**: `whetstone resume <run-id>` reads `state.json` and
  restarts from the first unfinished stage.

## The pane

Styled like the reference (header with actions, stepper, side-by-side agent
cards, stat tiles, history), with Whetstone's own content. Top to bottom:

1. **Header**: icon, "Whetstone", slug chip (mono), task title (truncated),
   `Pause` / `Resume`, `Stop`.
2. **Stepper**: Triage – Draft – Debate – Integrate – Review – Report. Done
   steps show a check, the current one is filled, and later ones are outlined.
   In step mode, a "Start <next>" button under it.
3. **Lane cards**, side by side: Claude / Codex, role for this stage (Writer,
   Integrator, Reviewer, Idle), model (mono, dim), status word in the theme's
   `working` / `blocked` / `done` / `idle` colors, elapsed time. Click to
   focus that lane's terminal.
4. **Decision card**: integrator and how it was chosen (both agreed / arbiter),
   each lane's vote, plan item share.
5. **Question card** (only when a lane is blocked): lane, question, options,
   answer input.
6. **Stat tiles**: Difficulty, Rounds, Open findings, Elapsed.
7. **Findings per round**: severity dots (P0 red, P1 orange, P2 blue) and
   disposition (fixed / rejected / deferred).
8. **History**: timestamped lines from `events.jsonl`, newest first.
9. **Done**: Open report, Open final worktree, record outcome
   (merged / reworked / rejected → `dual-pr-metrics`).

Several runs: a small picker in the header when more than one run is active.

## Repo layout

```
engine/
  cli.mjs          whetstone run|resume|status|pause|stop
  run.mjs          stage sequence ported from dual-pr.js
  lane.mjs         pi invocation (the only pi-aware module)
  parse.mjs        lastJson, lastTag, schema checks
  state.mjs        atomic state.json, control.json, events.jsonl
  agents/          writer|reviewer|triage|reporter.md (from ~/.pi/agent/agents/dual-*.md)
  test/            node --test, pi stubbed
mods/whetstone/
  main.js mod.json look.js icons/ RECIPE.md preview.png
assets/reference-review-loop.png
```

No npm dependencies in the engine (Node built-ins only), so it runs anywhere
`pi` runs.

## Phases (TDD throughout)

1. **Engine core with pi stubbed.** Port the stage logic. Tests drive full
   runs through a fake lane: consensus, tie → arbiter, clean review, P2-only
   round, two rounds + sign-off, a lane failure. Assert `state.json` at each
   step.
2. **Real pi lanes.** `lane.mjs` with `-p --mode json` and `--session-id`;
   one smoke run on an easy task in a scratch repo. Confirm session reuse
   keeps context across stages.
3. **Control.** Pause after step, pause now, stop, resume after crash.
   Questions through `control.json`.
4. **Read-only pane.** Native layout from the reference, `watchFolder` on the
   run folder, `herdr-app check` + `herdr-app shot` against the reference.
5. **Pane controls.** Pause / Stop / answer / focus lane / New run dialog.
6. **Swap over.** `/dual-pr` starts the engine (and maybe becomes `/whetstone`); keep `dual-pr.js` until a
   few real runs pass. Metrics stay compatible with `dual-pr-metrics.mjs`.
7. **Share** (optional): `RECIPE.md`, `preview.png`, `herdr-mod` topic.

## Open questions

- Mod install for development: does Herdr follow a symlink
  `~/.config/herdr-app/mods/whetstone → this repo`? If not, copy on install.
- `--mode json` vs `--mode rpc` for lanes: rpc gives a true mid-turn abort;
  json is simpler. Decide in phase 2 after trying both.
- Isolation hints (`MIX_TEST_PARTITION` etc.) carry over unchanged; confirm
  pi lanes still see the partition env.
