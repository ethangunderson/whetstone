# Spike: live lanes over hc (2026-11-05)

Question: can a code engine coordinate two **interactive** agent lanes in
Herdr Core terminals, collect structured results, and let the lanes talk to
each other directly?

Setup: `spike.mjs` ran as the engine in its own `hc` terminal. It started
two interactive pi lanes (Sonnet 5.5 and gpt-6-luna through pi) as its
children, labeled into the mudroom space. Each lane drafted `wordCount`,
wrote a JSON result file, and ran `hc send ws-spike-engine "done draft <lane>"`.
Then the engine sent a debate step: each lane `hc send`s its critique
straight to the other, waits for the other's, writes a debate file, and
reports done.

## Result: it works

The full run (two drafts, a direct critique exchange, four valid result
files) took 44 seconds with no fix-ups needed. Timeline in
`/tmp/ws-spike-run/timeline.jsonl` (not kept).

| Question                                     | Finding                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Can a plain program receive `hc send`?       | Yes: each message is one stdin line. Messages to a plain program arrive **untagged** (`done draft claude`), so lanes name themselves.                                                             |
| Do messages between agents carry the sender? | Yes: `<hc from="t15 ws-spike-codex">[peer] …</hc>`.                                                                                                                                               |
| Do agents act on engine and peer messages?   | Yes, when the first task says which prefixes to expect (`[whetstone]`, `[peer]`). Claude checked the message's origin before trusting it, so the up-front explanation matters.                    |
| Can lanes run `hc` from their shell?         | Yes, once they have the right PATH (below).                                                                                                                                                       |
| Results as files plus a "done" message       | Both lanes wrote valid JSON on the first try; the validate-and-ask-to-fix path never triggered.                                                                                                   |
| Status                                       | `hc get` reports `app: pi` with live `working` / `idle` / `done` and turn counts, even under an `env` wrapper.                                                                                    |
| Sending to a busy lane                       | `hc send` returns immediately; pi queues the message and delivers it with the next turn.                                                                                                          |
| Pause now                                    | `hc interrupt` presses Esc: the running command aborts, the lane goes `idle` with its context intact. A later "continue" message resumed correctly and had the queued note too.                   |
| `hc send --wait`                             | Returns when that turn ends (`reason: status`). Note a turn can end before the stage is done (e.g. a lane waiting for its peer's message), so the "done" message, not the turn, marks completion. |
| Visibility                                   | The lanes appear in the Agents sidebar nested under the engine; clicking one shows its real pi session.                                                                                           |

## Gotchas

- **PATH:** commands started through the core get its minimal PATH, so
  `hc run pi` failed (`spawn_failed`). Launch lanes as
  `/usr/bin/env PATH=<the user's PATH> /abs/path/to/pi …` so pi, node, npm and
  hc all resolve inside the lane.
- **Parentage:** lanes are children of the engine terminal and end with it
  unless started with `--outlive-parent`. A crashed engine kills its lanes,
  which suits "the run died"; resuming needs new lanes (or `--outlive-parent`
  plus reattaching by name).
- **Tabs:** each `herdr.space`-labeled terminal gets its own tab with a
  numeric name; set `herdr.tab` or name the tabs.
- **Prompt-injection caution:** models may distrust text that appears in their
  input. Keep the prefix explanation in the first task.

## What it means for Whetstone

The hybrid holds up: the engine stays code (stages, turn caps, checkpoints,
schema checks), lanes are live agents in Herdr, results come back as files
with a "done" message, and the debate can be a direct exchange with a cap.
Not tested yet: long stages (10+ minutes), claude-code / codex lanes, crash
recovery, and more than one exchange round.
