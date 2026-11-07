// Whetstone: a run of two coding agents sharpening the same task, live.
//
// Two modes, by props:
// - the panel (no props): the run's steps, lanes, the story of what was
//   proposed, argued and agreed, review findings, and controls;
// - a lane viewer ({ viewer: true }), opened beside the terminals by clicking a
//   lane card: that lane's stages, what it is doing now, and its replies.
//   There is one viewer; clicking another lane card retargets it through the
//   shared "whetstone.viewer" value ({ run, lane }).
//
// Reads ~/.whetstone/runs/<id>/ (state.json, control.json, events.jsonl,
// activity/<stage>.jsonl, and the report files), which the engine writes.
// Every button runs the `whetstone` CLI; the pane never writes engine files.
// What to show is worked out in ./model.js, the look is in ./ui.js.

import * as fs from "fs/promises";
import { h_flex, Input, InputState, TextView, v_flex } from "gpui-base";
import { div, View } from "gpui-kit";
import {
  appHome,
  exec,
  home,
  nextCommand,
  notify,
  panes,
  props,
  readTextFile,
  run,
  setShared,
  shared,
  terminals,
  theme,
  watchFolder,
} from "herdr";
import {
  actions,
  activityItems,
  cliCommand,
  decision,
  history,
  isActive,
  laneCards,
  laneStages,
  parseEvents,
  pickRun,
  rounds,
  runHeader,
  stats,
  statusLine,
  steps,
  storySections,
} from "./model.js";
import { card, dot, ghost, icon, json, label, MONO, pill, points, solid, spinner, tint, tones } from "./ui.js";

const MIN_RELOAD_MS = 800;
const LOAD_LIMIT_MS = 15_000;
const LOG = 30;
const VIEWER = "whetstone.viewer";

export default class Whetstone extends View {
  init(_props, cx) {
    this.root = `${home()}/.whetstone/runs`;
    // Layout blocks get no props; a viewer pane gets { viewer: true }.
    this.mode = props()?.viewer ? "lane" : "panel";
    this.target = this.mode === "lane" ? (shared(VIEWER) ?? null) : null;
    this.runs = [];
    this.pinned = null;
    this.view = null;
    this.lane = null;
    this.stageKey = null;
    this.tab = null;
    this.width = 400;
    this.busy = null;
    this.confirmStop = false;
    this.showLog = false;
    this.lastLoad = 0;
    this.answer = InputState.new({ placeholder: "Your answer…" });
    this.answer.on("submit", (_e, cx) => this.sendAnswer(cx));
    // Written by scripts/install-mod.sh: absolute node and cli.mjs paths.
    cx.spawn(async (cx) => {
      this.cliConfig = json(await readTextFile(`${appHome()}/mods/whetstone/cli.json`));
      cx.notify();
    });
    this.refresh(cx);
    // Catches up when the folder can't be watched yet, and keeps "4m" ticking.
    cx.timer.every(5000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await watchFolder(this.root);
        } catch {
          return;
        }
        this.refresh(cx);
      }
    });
    // Keys and `herdr-app do whetstone.<command>`: the same actions as the buttons,
    // on the shown run, when the run's state offers them.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const v = this.view;
        // Pane-level commands are answered by the panel only, so the viewer
        // (also a copy of this mod) doesn't act a second time.
        if (this.mode === "panel" && command === "close-viewers") {
          for (const p of panes().filter((p) => p.mod === "whetstone")) run("pane.close", { pane: p.pane });
          continue;
        }
        if (this.mode === "panel" && command.startsWith("view-")) {
          this.openLane(command.slice(5));
          continue;
        }
        if (this.mode === "panel" && v && actions(v.state, v.control, v.alive).includes(command)) {
          if (command === "stop") this.confirmStop = true;
          this.act(command, cx);
        }
        cx.notify();
      }
    });
  }

  // Reloads at most every MIN_RELOAD_MS; agents append to their logs constantly.
  refresh(cx) {
    const wait = MIN_RELOAD_MS - (Date.now() - this.lastLoad);
    if (this.loading || wait > 0) {
      if (!this.pending) {
        this.pending = true;
        cx.timer.after(Math.max(wait, 100), (cx) => {
          this.pending = false;
          this.refresh(cx);
        });
      }
      return;
    }
    this.loading = true;
    this.lastLoad = Date.now();
    cx.spawn(async (cx) => {
      // A load that never settles would leave `loading` set and freeze the
      // panel (seen once); give up after LOAD_LIMIT_MS and say where it was.
      this.step = "starting";
      let timer;
      const limit = new Promise((_, reject) => {
        timer = cx.timer.after(LOAD_LIMIT_MS, () => reject(new Error(`loading stalled at: ${this.step}`)));
      });
      try {
        await Promise.race([this.mode === "lane" ? this.loadLane() : this.load(), limit]);
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      timer?.cancel?.();
      this.loading = false;
      cx.notify();
    });
  }

  reloadNow(cx) {
    this.lastLoad = 0;
    this.refresh(cx);
  }

  async load() {
    let names = [];
    this.step = "listing runs";
    try {
      names = await fs.readdir(this.root);
    } catch {
      names = [];
    }
    const runs = [];
    for (const name of names) {
      const id = typeof name === "string" ? name : name.name;
      this.step = `reading ${id}`;
      const state = json(await readTextFile(`${this.root}/${id}/state.json`));
      if (state) runs.push({ id, state });
    }
    runs.sort((a, b) => String(b.state.startedAt ?? "").localeCompare(String(a.state.startedAt ?? "")));
    this.runs = runs;
    const id = pickRun(runs, this.pinned);
    if (!id) {
      this.view = null;
      return;
    }
    const { state } = runs.find((r) => r.id === id);
    const dir = `${this.root}/${id}`;
    const control = json(await readTextFile(`${dir}/control.json`)) ?? {};
    const events = parseEvents((await readTextFile(`${dir}/events.jsonl`)) ?? "");
    let alive = false;
    this.step = "checking the engine";
    if (isActive(state) && state.pid) {
      try {
        alive = (await exec("kill", ["-0", String(state.pid)])).code === 0;
      } catch {
        alive = false;
      }
    }
    this.view = { id, dir, state, control, events, alive };
  }

  async loadLane() {
    if (!this.target) {
      this.lane = null;
      return;
    }
    const { run: runId, lane: laneId } = this.target;
    const dir = `${this.root}/${runId}`;
    const state = json(await readTextFile(`${dir}/state.json`));
    if (!state) {
      this.lane = null;
      return;
    }
    const stages = laneStages(state, laneId);
    const auto = stages.find((s) => s.state === "running") ?? stages[stages.length - 1];
    const stage = stages.find((s) => s.key === this.stageKey) ?? auto ?? null;
    const activity = stage ? activityItems((await readTextFile(`${dir}/activity/${stage.key}.jsonl`)) ?? "") : [];
    const reply = stage && stage.file && stage.state !== "running" ? ((await readTextFile(stage.file)) ?? "") : "";
    const laneCard = laneCards(state, Date.now()).find((c) => c.id === laneId) ?? null;
    this.lane = { state, stages, stage, activity, reply, card: laneCard };
  }

  nextRun(cx) {
    if (this.runs.length < 2 || !this.view) return;
    const i = this.runs.findIndex((r) => r.id === this.view.id);
    this.pinned = { id: this.runs[(i + 1) % this.runs.length].id, at: new Date().toISOString() };
    this.reloadNow(cx);
  }

  // One viewer pane: retarget it if it's open, else open it beside the focused pane.
  openLane(laneId) {
    if (!this.view) return;
    setShared(VIEWER, { run: this.view.id, lane: laneId });
    const open = panes().find((p) => p.mod === "whetstone");
    if (open) run("pane.focus", { pane: open.pane });
    else run("pane.split", { direction: "right", mod: "whetstone", props: { viewer: true } });
  }

  cli(args, cx, busy) {
    this.busy = busy;
    cx.notify();
    cx.spawn(async (cx) => {
      const [command, argv] = cliCommand(this.cliConfig, args);
      try {
        const r = await exec(command, argv);
        if (r.code !== 0) notify({ title: "Whetstone", body: (r.stderr || r.stdout).trim(), level: "error" });
      } catch (e) {
        notify({
          title: "Whetstone",
          body: `Couldn't run ${command}: ${e?.message ?? e}. Rerun npm run install-mod in the whetstone repo.`,
          level: "error",
        });
      }
      this.busy = null;
      this.reloadNow(cx);
      cx.notify();
    });
  }

  act(name, cx) {
    const v = this.view;
    if (!v || this.busy) return;
    switch (name) {
      case "restart": {
        // The engine runs for a long time, so it gets a terminal of its own.
        const [command, argv] = cliCommand(this.cliConfig, ["resume", v.id]);
        run("pane.split", { direction: "right", argv: [command, ...argv] });
        return;
      }
      case "report":
        exec("open", [v.state.report]);
        return;
      case "stop":
        if (!this.confirmStop) {
          this.confirmStop = true;
          cx.timer.after(3000, (cx) => {
            this.confirmStop = false;
            cx.notify();
          });
          cx.notify();
          return;
        }
        this.confirmStop = false;
        this.cli(["stop", v.id], cx, name);
        return;
      default:
        this.cli([name, v.id], cx, name);
    }
  }

  sendAnswer(cx) {
    const text = this.answer.value().trim();
    if (!text || !this.view) return;
    this.answer.set_value("");
    this.cli(["answer", this.view.id, text], cx, "answer");
  }

  // ---- Panel ------------------------------------------------------------------

  header(t, v) {
    const h = v ? runHeader(v.state, v.control, v.alive) : null;
    const buttons = [];
    if (v) {
      for (const a of actions(v.state, v.control, v.alive)) {
        if (a === "approve" || a === "report") continue; // drawn in the steps card
        const text = {
          pause: "Pause",
          resume: "Resume",
          stop: this.confirmStop ? "Stop run?" : "Stop",
          restart: "Restart",
        }[a];
        buttons.push(
          ghost(
            t,
            `ws-${a}`,
            this.busy === a ? `${text}…` : text,
            (cx) => this.act(a, cx),
            a === "stop" && this.confirmStop ? t.ansi1 : null,
          ),
        );
      }
    }
    return h_flex()
      .h(42)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(icon("whetstone", t.muted, 15))
      .child(div().flex_none().font_semibold().child("Whetstone"))
      .when(Boolean(h), (el) =>
        el
          .child(
            div()
              .id("ws-slug")
              .flex_none()
              .px(5)
              .py(1)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .font_family(MONO)
              .text_size(10)
              .text_color(t.muted)
              .child(h.slug)
              .when(this.runs.length > 1, (c) =>
                c
                  .cursor_pointer()
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip(`Next run (${this.runs.length} runs)`)
                  .on_click((_e, cx) => this.nextRun(cx)),
              ),
          )
          .when(Boolean(h.issue && h.issue.url), (el) =>
            el.child(
              div()
                .id("ws-issue")
                .flex_none()
                .font_family(MONO)
                .text_size(11)
                .text_color(t.muted)
                .underline()
                .cursor_pointer()
                .hover((s) => s.text_color(t.foreground))
                .tooltip(`Open ${h.issue.key} in Linear`)
                .on_click((_e, cx) => cx.open_url(h.issue.url))
                .child(h.issue.key),
            ),
          )
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(h.task)),
      )
      .when(!h, (el) => el.child(div().flex_1()))
      .children(buttons);
  }

  stepsCard(t, v) {
    const o = tones(t);
    const h = statusLine(v.state, v.control, v.alive);
    const acts = actions(v.state, v.control, v.alive);
    const chip = (s) => {
      const done = s.state === "done";
      const current = s.state === "current";
      const failed = s.state === "failed";
      const badge = div()
        .w(18)
        .h(18)
        .flex_none()
        .rounded_full()
        .flex()
        .items_center()
        .justify_center()
        .text_size(10.5)
        .font_medium()
        .when(done, (b) => b.bg(tint(o.done, 0.18)).child(icon("check", o.done, 11)))
        .when(current, (b) => b.bg(t.accent).text_color(t.accent_foreground).child(String(s.n)))
        .when(failed, (b) => b.bg(tint(o.failed, 0.2)).text_color(o.failed).child("!"))
        .when(!done && !current && !failed, (b) =>
          b.border_1().border_color(t.border).text_color(t.dim).child(String(s.n)),
        );
      return h_flex()
        .id(`ws-step-${s.n}`)
        .h(30)
        .px(9)
        .gap(6)
        .flex_none()
        .items_center()
        .rounded(8)
        .border_1()
        .border_color(current ? tint(t.accent, 0.55) : failed ? tint(o.failed, 0.5) : t.border)
        .when(current, (c) => c.bg(tint(t.accent, 0.16)))
        .when(done, (c) => c.bg(t.raised))
        .text_size(12)
        .font_medium()
        .text_color(done || current ? t.foreground : t.dim)
        .child(badge)
        .child(div().child(s.name));
    };
    return card(t, "ws-steps")
      .gap(10)
      .child(h_flex().gap(6).flex_wrap().children(steps(v.state).map(chip)))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(12)
          .child(dot(o[h.tone]))
          .child(div().flex_none().font_medium().text_color(o[h.tone]).child(h.status))
          .when(Boolean(h.detail), (el) =>
            el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(h.detail)),
          ),
      )
      .when(acts.includes("approve"), (el) =>
        el.child(
          h_flex().child(
            solid(
              t,
              "ws-approve",
              this.busy === "approve" ? "Starting…" : `Start ${v.state.next?.name ?? "next step"}`,
              (cx) => this.act("approve", cx),
            ),
          ),
        ),
      )
      .when(acts.includes("report"), (el) =>
        el.child(h_flex().child(solid(t, "ws-report", "Open report", (cx) => this.act("report", cx)))),
      );
  }

  // A lane's terminal, if it is still running in Herdr.
  liveTerminal(address) {
    return address && terminals().some((x) => x.address === address && x.state === "live") ? address : null;
  }

  laneCard(t, lane) {
    const o = tones(t);
    const tone = {
      working: o.working,
      "needs you": o.attention,
      failed: o.failed,
      error: o.failed,
      done: o.done,
      idle: o.idle,
    }[lane.status];
    const active = lane.status === "working" || lane.status === "needs you";
    return v_flex()
      .id(`ws-lane-${lane.id}`)
      .flex_1()
      .min_w(0)
      .p(12)
      .gap(6)
      .rounded(10)
      .border_1()
      .border_color(active ? tint(tone, 0.55) : t.border)
      .when(active, (c) => c.bg(tint(tone, 0.05)))
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(this.liveTerminal(lane.terminal) ? `Peek at ${lane.name}'s terminal` : `Show ${lane.name}'s replies`)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const live = this.liveTerminal(lane.terminal);
        if (live) run("terminal.peek", { terminal: live });
        else this.openLane(lane.id);
      })
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child(lane.role))
          .child(
            h_flex()
              .id(`ws-lane-${lane.id}-replies`)
              .gap(2)
              .items_center()
              .px(4)
              .rounded(4)
              .cursor_pointer()
              .text_size(11)
              .text_color(t.dim)
              .hover((s) => s.text_color(t.foreground).bg(t.raised))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                this.openLane(lane.id);
              })
              .child(div().child("Replies"))
              .child(icon("chevron-right", t.dim, 11)),
          ),
      )
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(lane.status === "working" ? spinner(tone) : dot(tone, 9))
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(lane.name))
          .child(div().flex_none().text_size(12).text_color(tone).child(lane.status)),
      )
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .text_size(11)
          .text_color(t.dim)
          .font_family(MONO)
          .child(div().flex_1().min_w(0).truncate().child(lane.model))
          .when(Boolean(lane.detail), (el) => el.child(div().flex_none().child(lane.detail))),
      );
  }

  questionCard(t, v) {
    const q = v.state.question;
    const o = tones(t);
    const who = v.state.lanes?.[q.lane]?.name ?? q.lane;
    return v_flex()
      .id("ws-question")
      .flex_none()
      .p(12)
      .gap(8)
      .rounded(10)
      .border_1()
      .border_color(tint(o.attention, 0.6))
      .bg(tint(o.attention, 0.05))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(dot(o.attention))
          .child(div().text_size(12).font_medium().text_color(o.attention).child(`${who} asks`)),
      )
      .child(div().text_size(12.5).text_color(t.foreground).child(q.text))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(
            div()
              .id("ws-answer")
              .flex_1()
              .min_w(0)
              .h(30)
              .px(10)
              .flex()
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(t.input)
              .bg(t.background)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.answer).h_full().text_size(12).text_color(t.foreground)),
          )
          .child(solid(t, "ws-send", this.busy === "answer" ? "Sending…" : "Send", (cx) => this.sendAnswer(cx))),
      );
  }

  // One lane's part of a story card: its name, then what it said.
  laneBlock(t, id, name, children) {
    return v_flex().id(id).gap(5).child(div().text_size(12.5).font_semibold().child(name)).children(children);
  }

  sub(t, text) {
    return div().pt(2).text_size(11).text_color(t.dim).child(text);
  }

  approachesCard(t, s) {
    return card(t, "ws-approaches")
      .gap(12)
      .child(label(t, s.title))
      .children(
        s.lanes.map((l) =>
          this.laneBlock(
            t,
            `ws-ap-${l.id}`,
            l.name,
            l.approach === null
              ? [div().text_size(12).text_color(t.dim).child("Still drafting…")]
              : [
                  div().text_size(12.5).child(l.approach),
                  ...(l.choices.length ? [points(t, `ws-ap-${l.id}-c`, l.choices)] : []),
                  ...(l.weakSpots.length
                    ? [this.sub(t, "Least sure about"), points(t, `ws-ap-${l.id}-w`, l.weakSpots, t.dim)]
                    : []),
                ],
          ),
        ),
      );
  }

  debateCard(t, s) {
    return card(t, "ws-debate")
      .gap(12)
      .child(label(t, s.title))
      .children(
        s.lanes.map((l) => {
          const header = h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().text_size(12.5).font_semibold().child(l.name))
            .when(Boolean(l.base), (el) => el.child(pill(t, `ws-db-${l.id}-base`, `base: ${l.base}`)));
          const body =
            l.middleRoad === null && !l.peerBetter.length && !l.mineBetter.length
              ? [div().text_size(12).text_color(t.dim).child("Still comparing…")]
              : [
                  ...(l.peerBetter.length
                    ? [this.sub(t, "The other did better"), points(t, `ws-db-${l.id}-p`, l.peerBetter)]
                    : []),
                  ...(l.mineBetter.length ? [this.sub(t, "Defends"), points(t, `ws-db-${l.id}-m`, l.mineBetter)] : []),
                  ...(l.middleRoad ? [this.sub(t, "Middle road"), div().text_size(12.5).child(l.middleRoad)] : []),
                ];
          return v_flex().id(`ws-db-${l.id}`).gap(5).child(header).children(body);
        }),
      );
  }

  agreementCard(t, s, state) {
    const o = tones(t);
    const d = decision(state);
    return card(t, "ws-agreement")
      .gap(10)
      .child(label(t, s.title))
      .child(
        v_flex()
          .gap(2)
          .child(div().text_size(14).font_semibold().child(`${s.integrator} integrates`))
          .child(div().text_size(12).text_color(t.muted).child(s.how)),
      )
      .when(s.reasons.length > 0, (el) =>
        el.child(
          v_flex()
            .gap(4)
            .children(
              s.reasons.map((r, i) =>
                h_flex()
                  .id(`ws-ag-r-${i}`)
                  .gap(6)
                  .items_start()
                  .text_size(12)
                  .child(div().flex_none().font_medium().child(r.name))
                  .child(div().flex_1().min_w(0).text_color(t.muted).child(r.why)),
              ),
            ),
        ),
      )
      .when(Boolean(s.arbiter), (el) =>
        el.child(
          v_flex().gap(2).child(this.sub(t, "Arbiter")).child(div().text_size(12).text_color(t.muted).child(s.arbiter)),
        ),
      )
      .children(
        s.concessions
          .filter((c) => c.conceded.length || c.holding.length)
          .map((c, i) =>
            v_flex()
              .id(`ws-ag-c-${i}`)
              .gap(3)
              .when(c.conceded.length > 0, (el) =>
                el.child(this.sub(t, `${c.name} conceded`)).child(points(t, `ws-ag-c-${i}-y`, c.conceded)),
              )
              .when(c.holding.length > 0, (el) =>
                el
                  .child(this.sub(t, `${c.name} still disagrees`))
                  .child(points(t, `ws-ag-c-${i}-n`, c.holding, t.foreground)),
              ),
          ),
      )
      .when(s.plan.length > 0, (el) =>
        el
          .child(
            h_flex()
              .items_center()
              .pt(2)
              .child(div().flex_1().child(this.sub(t, "The plan")))
              .when(Boolean(d), (row) =>
                row.child(
                  h_flex()
                    .gap(4)
                    .children(
                      d.share
                        .filter(([, n]) => n > 0)
                        .map(([who, n], i) =>
                          pill(t, `ws-share-${i}`, `${who} ${n}`, { strong: who === s.integrator }),
                        ),
                    ),
                ),
              ),
          )
          .child(
            v_flex()
              .gap(4)
              .children(
                s.plan.map((p, i) =>
                  h_flex()
                    .id(`ws-plan-${i}`)
                    .gap(8)
                    .items_start()
                    .child(
                      div()
                        .flex_none()
                        .w(52)
                        .child(pill(t, `ws-plan-${i}-s`, p.source, { strong: p.source === s.integrator })),
                    )
                    .child(div().flex_1().min_w(0).pt(2).text_size(12).child(p.item)),
                ),
              ),
          ),
      );
  }

  statTiles(t, v, now) {
    const tiles = stats(v.state, now).map(([name, value], i) =>
      v_flex()
        .id(`ws-stat-${i}`)
        .flex_1()
        .min_w(0)
        .p(12)
        .gap(4)
        .rounded(10)
        .border_1()
        .border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).truncate().child(name))
        .child(div().text_size(20).font_semibold().truncate().child(value)),
    );
    if (this.width >= 460) return h_flex().flex_none().gap(10).children(tiles);
    return v_flex()
      .flex_none()
      .gap(10)
      .child(h_flex().gap(10).children(tiles.slice(0, 2)))
      .child(h_flex().gap(10).children(tiles.slice(2)));
  }

  findingsCard(t, v) {
    const sev = { P0: t.ansi1, P1: t.ansi3, P2: t.ansi4 };
    const disp = { fixed: t.ansi2, rejected: t.dim, deferred: tones(t).attention, open: t.foreground };
    const legend = h_flex()
      .gap(10)
      .items_center()
      .text_size(11)
      .text_color(t.dim)
      .children(
        [
          ["P0", "must fix"],
          ["P1", "should fix"],
          ["P2", "minor"],
        ].map(([s, word]) => h_flex().gap(4).items_center().child(dot(sev[s], 6)).child(div().child(word))),
      );
    const rs = rounds(v.state);
    const body =
      rs.length === 0
        ? [
            div()
              .text_size(12)
              .text_color(t.dim)
              .child(v.state.step >= 5 ? "Reviewers are working." : "No rounds yet."),
          ]
        : rs.map((r) => {
            const total = r.findings.length;
            const bar = h_flex()
              .flex_1()
              .h(6)
              .rounded(3)
              .overflow_hidden()
              .bg(t.raised)
              .children(
                total
                  ? ["P0", "P1", "P2"]
                      .filter((s) => r.counts[s])
                      .map((s) =>
                        div()
                          .h_full()
                          .w(`${(100 * r.counts[s]) / total}%`)
                          .bg(sev[s]),
                      )
                  : [],
              );
            return v_flex()
              .id(`ws-round-${r.round}`)
              .gap(8)
              .child(
                h_flex()
                  .gap(10)
                  .items_center()
                  .text_size(12)
                  .child(div().flex_none().w(56).text_color(t.muted).child(`Round ${r.round}`))
                  .child(bar)
                  .child(
                    div()
                      .flex_none()
                      .text_color(t.dim)
                      .child(total ? `${total}` : "clean"),
                  ),
              )
              .children(
                r.findings.map((f) =>
                  v_flex()
                    .id(`ws-f-${f.id}`)
                    .gap(3)
                    .child(
                      h_flex()
                        .gap(8)
                        .items_center()
                        .text_size(12)
                        .child(dot(sev[f.severity] ?? t.dim, 6))
                        .child(div().flex_none().w(46).font_family(MONO).text_size(11).text_color(t.dim).child(f.id))
                        .child(div().flex_1().min_w(0).truncate().child(f.title))
                        .child(
                          div()
                            .flex_none()
                            .text_size(11)
                            .text_color(disp[f.disposition] ?? t.muted)
                            .child(f.disposition),
                        ),
                    )
                    .when(f.positions.length > 0 || Boolean(f.why), (el) =>
                      el.child(
                        v_flex()
                          .pl(60)
                          .gap(2)
                          .text_size(11.5)
                          .text_color(t.muted)
                          .when(f.positions.length > 0, (c) =>
                            c.child(div().child(f.positions.map((p) => `${p.name} ${p.position}`).join(" · "))),
                          )
                          .when(Boolean(f.why), (c) => c.child(div().text_color(t.dim).child(f.why))),
                      ),
                    ),
                ),
              );
          });
    return card(t, "ws-findings")
      .child(
        h_flex()
          .items_center()
          .child(div().flex_1().child(label(t, "Findings per round")))
          .child(legend),
      )
      .children(body)
      .when(Boolean(v.state.signoff), (el) =>
        el.child(
          div()
            .text_size(12)
            .text_color(t.muted)
            .child(
              v.state.signoff === "approve"
                ? "Peer signed off on the last fixes."
                : "Peer raised concerns about the last fixes; see the report.",
            ),
        ),
      );
  }

  logList(t, v) {
    const rows = this.showLog ? history(v.events, LOG) : [];
    return v_flex()
      .id("ws-log")
      .flex_none()
      .gap(8)
      .px(2)
      .pt(4)
      .child(
        h_flex()
          .id("ws-log-toggle")
          .gap(4)
          .items_center()
          .cursor_pointer()
          .on_click((_e, cx) => {
            this.showLog = !this.showLog;
            cx.notify();
          })
          .child(label(t, "Log"))
          .child(
            div()
              .text_size(10.5)
              .text_color(t.dim)
              .child(this.showLog ? "hide" : `show ${Math.min(v.events.length, LOG)}`),
          ),
      )
      .children(
        rows.map((row, i) =>
          h_flex()
            .id(`ws-h-${i}`)
            .gap(10)
            .items_start()
            .text_size(12)
            .child(div().flex_none().w(38).font_family(MONO).text_size(11).text_color(t.dim).child(row.time))
            .child(div().flex_1().min_w(0).text_color(t.muted).child(row.text)),
        ),
      );
  }

  empty(t) {
    return v_flex()
      .flex_1()
      .items_center()
      .justify_center()
      .gap(8)
      .p(24)
      .text_color(t.dim)
      .child(icon("whetstone", t.border, 28))
      .child(div().text_size(13).text_color(t.muted).child("No Whetstone runs yet"))
      .child(div().text_size(12).child("In a repo, run:"))
      .child(
        div()
          .px(8)
          .py(4)
          .rounded(6)
          .bg(t.raised)
          .font_family(MONO)
          .text_size(11.5)
          .text_color(t.muted)
          .child('whetstone run "your task"'),
      );
  }

  renderPanel(t, root) {
    const v = this.view;
    const now = Date.now();
    root = root.child(this.header(t, v));
    if (!v) return root.child(this.empty(t));
    const story = storySections(v.state);
    const section = (kind) => story.find((s) => s.kind === kind);
    return root.child(
      v_flex()
        .id("ws-body")
        .flex_1()
        .min_h(0)
        .overflow_y_scrollbar()
        .p(12)
        .gap(10)
        .child(this.stepsCard(t, v))
        .child(
          (this.width >= 340 ? h_flex() : v_flex())
            .flex_none()
            .gap(10)
            .children(laneCards(v.state, now).map((l) => this.laneCard(t, l))),
        )
        .when(Boolean(v.state.question), (el) => el.child(this.questionCard(t, v)))
        .when(Boolean(section("agreement")), (el) => el.child(this.agreementCard(t, section("agreement"), v.state)))
        .when(Boolean(section("debate")), (el) => el.child(this.debateCard(t, section("debate"))))
        .when(Boolean(section("approaches")), (el) => el.child(this.approachesCard(t, section("approaches"))))
        .child(this.statTiles(t, v, now))
        .child(this.findingsCard(t, v))
        .child(this.logList(t, v))
        .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(this.error))),
    );
  }

  // ---- Lane viewer ------------------------------------------------------------

  laneHeader(t, l) {
    const o = tones(t);
    const c = l && l.card;
    const tone = c
      ? { working: o.working, "needs you": o.attention, failed: o.failed, error: o.failed, done: o.done, idle: o.idle }[
          c.status
        ]
      : t.dim;
    const tab = this.currentTab(l);
    const segment = (key, text) =>
      div()
        .id(`ln-tab-${key}`)
        .h(24)
        .px(10)
        .flex()
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .text_size(12)
        .font_medium()
        .when(tab === key, (s) => s.bg(t.selected ?? t.raised).text_color(t.foreground))
        .when(tab !== key, (s) => s.text_color(t.muted).hover((h) => h.text_color(t.foreground)))
        .on_click((_e, cx) => {
          this.tab = key;
          cx.notify();
        })
        .child(text);
    return h_flex()
      .h(42)
      .flex_none()
      .px(14)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(c && c.status === "working" ? spinner(tone) : dot(tone, 8))
      .child(
        div()
          .flex_none()
          .font_semibold()
          .child(c ? c.name : (this.target?.lane ?? "Whetstone")),
      )
      .when(Boolean(c), (el) =>
        el
          .child(div().flex_none().text_size(12).text_color(t.muted).child(`${c.role} · ${c.status}`))
          .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(11).text_color(t.dim).child(c.model)),
      )
      .when(!c, (el) => el.child(div().flex_1()))
      .when(Boolean(c && this.liveTerminal(c.terminal)), (el) =>
        el.child(ghost(t, "ln-terminal", "Terminal", () => run("terminal.peek", { terminal: c.terminal }))),
      )
      .child(
        h_flex()
          .flex_none()
          .p(2)
          .gap(2)
          .rounded(8)
          .bg(t.raised)
          .child(segment("reply", "Reply"))
          .child(segment("activity", "Activity")),
      );
  }

  currentTab(l) {
    if (this.tab) return this.tab;
    return l && l.stage && l.stage.state === "running" ? "activity" : "reply";
  }

  stageChips(t, l) {
    const o = tones(t);
    return h_flex()
      .flex_none()
      .px(12)
      .py(10)
      .gap(6)
      .flex_wrap()
      .border_b(1)
      .border_color(t.border)
      .children(
        l.stages.map((s) => {
          const on = l.stage && l.stage.key === s.key;
          const marker =
            s.state === "running"
              ? spinner(o.working, 11)
              : s.state === "failed"
                ? div().text_color(o.failed).child("!")
                : icon("check", o.done, 11);
          return h_flex()
            .id(`ln-stage-${s.key}`)
            .h(26)
            .px(8)
            .gap(6)
            .flex_none()
            .items_center()
            .rounded(7)
            .border_1()
            .cursor_pointer()
            .border_color(on ? tint(t.accent, 0.55) : t.border)
            .when(on, (c) => c.bg(tint(t.accent, 0.14)))
            .hover((c) => c.bg(t.hover))
            .text_size(12)
            .font_medium()
            .text_color(on ? t.foreground : t.muted)
            .on_click((_e, cx) => {
              this.stageKey = s.key;
              this.tab = null;
              this.reloadNow(cx);
            })
            .child(marker)
            .child(div().child(s.label));
        }),
      );
  }

  activityList(t, l) {
    const o = tones(t);
    if (!l.activity.length) {
      const live = l.card && this.liveTerminal(l.card.terminal);
      if (live) {
        return v_flex()
          .gap(8)
          .items_start()
          .child(
            div()
              .text_size(12.5)
              .text_color(t.dim)
              .child(`${l.card.name} runs live in Herdr; its terminal shows what it's doing.`),
          )
          .child(solid(t, "ln-go-terminal", "Go to terminal", () => run("terminal.peek", { terminal: live })));
      }
      return div()
        .text_size(12.5)
        .text_color(t.dim)
        .child(l.stage && l.stage.state === "running" ? "Starting…" : "No activity was recorded for this stage.");
    }
    return v_flex()
      .gap(10)
      .children(
        l.activity.map((a, i) => {
          if (a.kind === "text")
            return TextView.markdown(`ln-act-${l.stage.key}-${i}`, a.text)
              .selectable(true)
              .text_size(13)
              .text_color(t.foreground);
          if (a.kind === "error") return div().text_size(12.5).text_color(o.failed).child(a.text);
          const marker =
            a.status === "running"
              ? spinner(o.working, 12)
              : a.status === "ok"
                ? icon("check", o.done, 12)
                : div().w(12).text_size(12).text_color(o.failed).child("✗");
          return v_flex()
            .id(`ln-tool-${i}`)
            .gap(3)
            .child(
              h_flex()
                .gap(8)
                .items_start()
                .child(div().pt(2).child(marker))
                .child(div().flex_none().w(40).font_family(MONO).text_size(11).pt(1).text_color(t.dim).child(a.tool))
                .child(div().flex_1().min_w(0).font_family(MONO).text_size(12).text_color(t.foreground).child(a.text)),
            )
            .when(a.status === "failed" && Boolean(a.output), (el) =>
              el.child(div().pl(60).font_family(MONO).text_size(11).text_color(t.muted).child(a.output)),
            );
        }),
      );
  }

  renderLane(t, root) {
    const l = this.lane;
    root = root.child(this.laneHeader(t, l));
    if (!l) return root.child(div().p(16).text_size(12.5).text_color(t.dim).child("Loading…"));
    if (!l.stages.length)
      return root.child(div().p(16).text_size(12.5).text_color(t.dim).child("This lane hasn't started yet."));
    const tab = this.currentTab(l);
    const body =
      tab === "activity"
        ? this.activityList(t, l)
        : l.stage.state === "running"
          ? div()
              .text_size(12.5)
              .text_color(t.dim)
              .child("Still working. Its reply appears here when the stage ends; Activity shows what it is doing now.")
          : TextView.markdown(`ln-reply-${l.stage.key}`, l.reply || "*No reply recorded.*")
              .selectable(true)
              .text_size(13)
              .text_color(t.foreground);
    return root
      .child(this.stageChips(t, l))
      .child(v_flex().id("ln-body").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(14).child(body));
  }

  render(cx) {
    const t = theme();
    // A click on another lane card changes the shared target; render runs on
    // shared changes, so follow it here.
    if (this.mode === "lane") {
      const target = shared(VIEWER) ?? null;
      if (JSON.stringify(target) !== JSON.stringify(this.target)) {
        this.target = target;
        this.stageKey = null;
        this.tab = null;
        this.lane = null;
        this.reloadNow(cx);
      }
    }
    const root = v_flex()
      .id("whetstone")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      });
    return this.mode === "lane" ? this.renderLane(t, root) : this.renderPanel(t, root);
  }
}
