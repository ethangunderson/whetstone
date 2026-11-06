# whetstone — plan

Work is tracked in Linear: workspace **whetstone** (https://linear.app/eg-whetstone),
team `WHE`, projects "Herdr guideline audit", "Live lanes: features" and
"Real-run verification". This file keeps intent and design; don't duplicate
tasks here.

Claude and Codex each build the same task, debate a middle road, one
integrates, a Claude+Codex reviewer pair attacks it, and the writers respond.
Today this is a pi-subagents workflow (`~/.pi/agent/workflows/dual-pr.js`,
`/dual-pr` prompt). Whetstone replaces it with:

- an **engine** that owns the run and talks only to `pi`, and
- a **native Herdr pane** that shows the run and controls it.

## Decisions so far

- **Each lane picks its harness** (`pi`, `claude-code`, `codex`), with the
  model written the way that harness spells it. Ethan's setup runs both lanes
  through `pi` (`claude-bridge/...`, `openai-codex/...`), which keeps pi's
  logins and routing. Someone without pi can use Claude Code and Codex
  directly. Harness adapters are the only code that knows about a CLI.
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

## Harnesses

An adapter turns one request into one CLI call:

```js
// engine/harness/<name>.mjs
export default {
  name: "pi",
  detect(),   // installed? (logged in, where the CLI can tell)
  run({ session, resume, cwd, system, model, effort, readOnly, prompt }) // → { ok, text, sessionId, error }
}
```

| Need | pi | Claude Code | Codex (unverified) |
|---|---|---|---|
| Headless | `-p` | `-p` | `codex exec` |
| Model | `--model provider/id` | `--model` | `-m` |
| Effort | `--thinking` | `--effort` | `-c model_reasoning_effort=` |
| Same session across stages | `--session-id` | `--session-id <uuid>` then `--resume` | `codex exec resume <id>` |
| Role prompt | `--system-prompt` | `--append-system-prompt` | prepend to prompt |
| Read-only reviewer | `--tools read,grep,find,ls,bash` | `--tools` / `--disallowedTools` | `--sandbox read-only` |
| Edits without asking | default | `--permission-mode` | `--sandbox workspace-write` |
| Parseable output | `--mode json` | `--output-format stream-json` | `--json` |

Lanes run as visible Herdr terminals (`hc run --bg`, labeled
`whetstone=<run> lane=<id>`) once the pane exists; until then the engine
spawns them directly.

Effort is always `low | medium | high`; each adapter maps it. Decisions are
parsed from text the same way for every harness (last ```json block,
`INTEGRATOR:` / `SIGNOFF:` lines, `QUESTION` block), with one re-ask on
invalid output.

Writers ask the operator by ending their turn with a `QUESTION` block; the
engine marks the lane `blocked`, the pane shows the question, and the answer
goes back into the same session.

Config (`~/.whetstone/config.json`; Ethan's defaults shown):

```json
{
  "lanes": [
    { "id": "claude", "name": "Claude", "harness": "pi" },
    { "id": "codex",  "name": "Codex",  "harness": "pi" }
  ],
  "tiers": {
    "easy":   { "claude": "claude-bridge/claude-sonnet-5-5:medium", "codex": "openai-codex/gpt-6-luna:medium" },
    "medium": { "claude": "claude-bridge/claude-opus-5-5:medium",   "codex": "openai-codex/gpt-6-sol:medium" },
    "hard":   { "claude": "claude-bridge/claude-fable-5-1:high",    "codex": "openai-codex/gpt-6.1-sol:high",
                "fallback": { "claude": "claude-bridge/claude-opus-5-5:high", "codex": "openai-codex/gpt-6-sol:high" } }
  },
  "triage":   { "lane": "codex",  "model": "openai-codex/gpt-6-luna:low" },
  "reporter": { "lane": "claude", "model": "claude-bridge/claude-sonnet-5-5:medium" },
  "arbiter":  { "lane": "codex" }
}
```

A tier with `fallback` probes each lane's model with a tiny call; if any lane
can't reach its model, the whole tier switches to the fallback pair so the
lanes stay even (today's Fable check, generalized).

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
  harness/         pi.mjs, claude-code.mjs, codex.mjs (the only CLI-aware code)
  config.mjs       defaults, tiers, fallback
  workspace.mjs    git worktrees (the engine creates them, not the agents)
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

## Status (2026-11-05)

- Phase 1 done: `engine/run.mjs` ports `dual-pr.js` behind the harness
  interface; checkpointed stages, pause-after-step, stop, step mode and
  operator questions via `control.json`. 64 tests (`npm test`).
- Phase 2 partly done: pi adapter (`engine/harness/pi.mjs`) and the
  `whetstone` CLI. Real smoke test passes (`WHETSTONE_SMOKE=pi`), and one real
  easy run (Sonnet 5.5 vs gpt-6-luna) finished in 2 minutes with a correct
  branch and report. Still to do: Claude Code and Codex adapters.
- Learned from real pi: `--session-id` lookup is per cwd, so resumes pass the
  session file (`--session`); a resumed session's tools stay in its first cwd,
  so prompts say where to `cd`; pi exits 0 on model errors (check
  `stopReason`).

## Status update (2026-11-06): live lanes

- Default harness is now `herdr`: each lane is a live, interactive pi agent
  in its own Herdr Core terminal. `whetstone run` starts the engine in its own
  terminal (`ws-<hash>-engine`) and returns; lanes report by writing a reply
  file and `hc send <engine> "done <stage> <token>"`. Reviewers and helpers
  get a terminal per call; everything closes when the run ends.
- Pause now and stop use `hc interrupt`; a lane that goes quiet is nudged
  once; a done without its file gets one reminder.
- Converge includes a direct exchange (`hc send <peer> "[peer] …"`, at most
  2 messages each). Verified for real: lanes negotiated and both converged on
  the result (padstart run).
- Pane: lane cards jump to the lane's live terminal; "Replies" opens the
  viewer; the story cards replace the history.
- The headless `pi` harness stays for running without Herdr.
- Open: Claude Code / Codex as live agents; lanes end with the engine (no
  reattach after a crash, restart begins new lanes with a "context lost"
  note); tabs get numeric names; lanes aren't nested under the engine in the
  Agents list (the engine isn't an agent).

## Phases (TDD throughout)

1. **Engine core with pi stubbed.** Port the stage logic. Tests drive full
   runs through a fake lane: consensus, tie → arbiter, clean review, P2-only
   round, two rounds + sign-off, a lane failure. Assert `state.json` at each
   step.
2. **Harness adapters.** pi first, then Claude Code, then Codex (confirm its
   flags first). Unit-test each adapter's command line; opt-in smoke test
   (`WHETSTONE_SMOKE=<harness>`) proves a second turn keeps the session.
   Then a `whetstone run` CLI and one real run on an easy task.
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
- pi `--mode json` vs `--mode rpc` for lanes: rpc gives a true mid-turn abort;
  json is simpler. Decide in phase 2 after trying both.
- Codex CLI flags are from memory; verify before writing its adapter.
- Isolation hints (`MIX_TEST_PARTITION` etc.) carry over unchanged; confirm
  pi lanes still see the partition env.
