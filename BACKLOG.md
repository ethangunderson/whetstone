# Whetstone backlog (draft, to file in Linear)

Each `##` is one issue. Priority: 1 urgent, 2 high, 3 medium, 4 low.
Delete this file once the issues are filed; Linear becomes the tracker.

## Herdr guideline audit

### Lanes must not start agents of their own
Priority 2. hc's guide: "Do not let children start more agents unless you
explicitly assign that." Lanes know `hc` (they `hc send`), and no prompt tells
them not to `hc run`. Add it to the writer and reviewer role prompts and the
herdr harness preamble. Test: the first message to a lane says so.

### Panel: gentler refresh, no work in render, Restart without a split
Priority 3. The panel rereads every run's state.json and runs `kill -0` every
5 s even while hidden ("timers keep running while hidden, so poll gently");
it already watches the runs folder, so the timer only needs to tick the
Active clock, about every 30 s. The lane viewer starts a reload from inside
`render` when the shared target changes; move that to where the value is set.
Restart opens a split running `whetstone resume`, which now returns at once
(the engine gets its own tab), so the split flashes; run it as a command.

### Engine reports its own agent status (OSC 7501)
Priority 3. The engine isn't an agent, so its tab never shows "needs you" or
"done", and its lanes (sub-agents) don't appear in the Agents list at all.
Have the engine report working / blocked (a step waits for approval, a lane
is blocked, a question) / done. Check that lanes then nest under it.

### Engine tab stays open after the run
Priority 4. `tab.new` runs the engine inside a login shell that stays, so the
tab remains with a prompt. Decide: close it at the end, or keep it on purpose
as the run's record (it shows the report path).

### Role prompts as hc templates
Priority 4. Herdr's place for agent roles is
`~/.config/herdr-core/templates/*.md`. Today roles go in through pi's
`--append-system-prompt`. Worth it once more than one agent kind is wired up.

### Shareable mod: RECIPE.md, preview.png, disclosures
Priority 4. Needed to publish at herdr.dev/mods: a RECIPE.md written from the
real files, a preview, and saying up front that it runs programs (node, kill,
open) and reads ~/.whetstone.

## Features

### New run dialog in the pane
Priority 2. Task, repo (folder picker), difficulty, rounds, step mode; starts
`whetstone run` in the chosen repo. Today runs start from a shell.

### Switch /dual-pr to Whetstone
Priority 2. `/dual-pr` (pi prompt) starts `whetstone run`; keep
`~/.pi/agent/workflows/dual-pr.js` until a few real runs on real repos pass.
Check `dual-pr-metrics.mjs` reads Whetstone's metrics (same schema 1; it
looks in pi's mission state today, so it needs a source for
~/.whetstone/runs/*/state.json).

### Claude Code and Codex as live agents
Priority 2. The herdr harness only knows how to start pi. Add the start
arguments for `claude` and `codex` (Codex needs `--no-daemon` under hc, per
its guide), and confirm each reports OSC 7501 status. Verify Codex flags
before writing them.

### Recover a run after the engine dies
Priority 3. Lanes are the engine's children and end with it; a restart starts
new lanes and tells them their conversation is gone. Options: start lanes
`--outlive-parent` and reattach by name on resume.

### Debate rounds until agreement
Priority 3. The direct converge exchange is capped at 2 messages each. Option
to repeat converge until both lanes vote the same base and plan, with a cap.

### Real-repo trial
Priority 2. Every real run so far was an easy task in a scratch repo. Run a
medium and a hard task on a real project (peepmetrics?) and record what
breaks: long stages, test isolation between lanes, report quality, cost.

## Known gaps to verify

### Blocked and error handling under real conditions
Priority 3. Tested against a fake hc only; no real run produced a blocked or
erroring lane. Force one (a tool needing permission, an invalid model) and
check the card, the history line, and the retry.

### Pause now in a real run
Priority 3. `hc interrupt` + "continue" was proven in the spike, not through
the engine and pane. Pause mid-draft from the pane, resume, check the result.
