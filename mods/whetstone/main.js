// Whetstone: a run of two coding agents sharpening the same task, live.
// Reads ~/.whetstone/runs/<id>/{state,control}.json and events.jsonl, which
// the engine writes; every button runs the `whetstone` CLI, so the pane never
// writes engine files itself. What to show is worked out in ./model.js.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, appHome, theme, run, notify, readTextFile, watchFolder, nextCommand } from "herdr";
import * as fs from "fs/promises";
import {
  isActive, runHeader, statusLine, steps, laneCards, decision, stats, rounds, history, actions, pickRun, parseEvents, cliCommand
} from "./model.js";

const ICONS = "mods/whetstone/icons";
const MONO = "JetBrains Mono";
const MIN_RELOAD_MS = 800;
const HISTORY = 14;

// A colour at an alpha: the theme's colours are #rrggbb.
const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color + Math.round(alpha * 255).toString(16).padStart(2, "0") : color);

function json(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function tones(t) {
  // attention: it's your turn (waiting, paused, a question). Not an error, so the accent.
  return { working: t.working ?? t.ansi3, attention: t.accent ?? t.ansi4, done: t.done ?? t.ansi2, failed: t.ansi1, idle: t.idle ?? t.dim };
}

export default class Whetstone extends View {
  init(_props, cx) {
    this.root = `${home()}/.whetstone/runs`;
    this.runs = [];
    this.pinned = null;
    this.view = null;
    this.width = 400;
    this.busy = null;
    this.confirmStop = false;
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
        try { await watchFolder(this.root); } catch { return; }
        this.refresh(cx);
      }
    });
    // Keys and `herdr-app do whetstone.<command>`: the same actions as the buttons,
    // on the shown run, when the run's state offers them.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        const v = this.view;
        if (v && actions(v.state, v.control, v.alive).includes(command)) {
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
        cx.timer.after(Math.max(wait, 100), (cx) => { this.pending = false; this.refresh(cx); });
      }
      return;
    }
    this.loading = true;
    this.lastLoad = Date.now();
    cx.spawn(async (cx) => {
      try {
        await this.load();
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  async load() {
    let names = [];
    try { names = await fs.readdir(this.root); } catch { names = []; }
    const runs = [];
    for (const name of names) {
      const id = typeof name === "string" ? name : name.name;
      const state = json(await readTextFile(`${this.root}/${id}/state.json`));
      if (state) runs.push({ id, state });
    }
    runs.sort((a, b) => String(b.state.startedAt ?? "").localeCompare(String(a.state.startedAt ?? "")));
    this.runs = runs;
    const id = this.pinned && runs.some((r) => r.id === this.pinned) ? this.pinned : pickRun(runs);
    if (!id) { this.view = null; return; }
    const { state } = runs.find((r) => r.id === id);
    const dir = `${this.root}/${id}`;
    const control = json(await readTextFile(`${dir}/control.json`)) ?? {};
    const events = parseEvents((await readTextFile(`${dir}/events.jsonl`)) ?? "");
    let alive = false;
    if (isActive(state) && state.pid) {
      try { alive = (await exec("kill", ["-0", String(state.pid)])).code === 0; } catch { alive = false; }
    }
    this.view = { id, dir, state, control, events, alive };
  }

  nextRun(cx) {
    if (this.runs.length < 2 || !this.view) return;
    const i = this.runs.findIndex((r) => r.id === this.view.id);
    this.pinned = this.runs[(i + 1) % this.runs.length].id;
    this.lastLoad = 0;
    this.refresh(cx);
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
        notify({ title: "Whetstone", body: `Couldn't run ${command}: ${e?.message ?? e}. Rerun npm run install-mod in the whetstone repo.`, level: "error" });
      }
      this.busy = null;
      this.lastLoad = 0;
      this.refresh(cx);
      cx.notify();
    });
  }

  act(name, cx) {
    const v = this.view;
    if (!v || this.busy) return;
    switch (name) {
      case "restart":
        // The engine runs for a long time, so it gets a terminal of its own.
        const [command, argv] = cliCommand(this.cliConfig, ["resume", v.id]);
        run("pane.split", { direction: "right", argv: [command, ...argv] });
        return;
      case "report":
        exec("open", [v.state.report]);
        return;
      case "stop":
        if (!this.confirmStop) {
          this.confirmStop = true;
          cx.timer.after(3000, (cx) => { this.confirmStop = false; cx.notify(); });
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

  // ---- Pieces --------------------------------------------------------------

  ghost(t, id, label, onClick, color) {
    return h_flex().id(id).h(26).px(8).flex_none().items_center().rounded(6).cursor_pointer()
      .text_size(12).font_medium().text_color(color ?? t.muted)
      .hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  solid(t, id, label, onClick) {
    return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(8).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).text_size(12.5).font_medium()
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  card(t, id) {
    return v_flex().id(id).flex_none().p(12).gap(8).rounded(10).border_1().border_color(t.border);
  }

  label(t, text) {
    return div().text_size(10.5).font_medium().text_color(t.dim).child(text.toUpperCase());
  }

  header(t, v) {
    const h = v ? runHeader(v.state, v.control, v.alive) : null;
    const buttons = [];
    if (v) {
      for (const a of actions(v.state, v.control, v.alive)) {
        if (a === "approve" || a === "report") continue; // drawn in the steps card
        const text = { pause: "Pause", resume: "Resume", stop: this.confirmStop ? "Stop run?" : "Stop", restart: "Restart" }[a];
        const label = this.busy === a ? text + "…" : text;
        buttons.push(this.ghost(t, `ws-${a}`, label, (cx) => this.act(a, cx), a === "stop" && this.confirmStop ? t.ansi1 : null));
      }
    }
    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(`${ICONS}/whetstone.svg`).w(15).h(15).flex_none().text_color(t.muted))
      .child(div().flex_none().font_semibold().child("Whetstone"))
      .when(Boolean(h), (el) => el
        .child(div().id("ws-slug").flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border)
          .font_family(MONO).text_size(10).text_color(t.muted).child(h.slug)
          .when(this.runs.length > 1, (c) => c.cursor_pointer().hover((s) => s.text_color(t.foreground))
            .tooltip(`Next run (${this.runs.length} runs)`)
            .on_click((_e, cx) => this.nextRun(cx))))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(h.task)))
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
      const badge = div().w(18).h(18).flex_none().rounded_full().flex().items_center().justify_center()
        .text_size(10.5).font_medium()
        .when(done, (b) => b.bg(tint(o.done, 0.18)).text_color(o.done).child(svg(`${ICONS}/check.svg`).w(11).h(11).text_color(o.done)))
        .when(current, (b) => b.bg(t.accent).text_color(t.accent_foreground).child(String(s.n)))
        .when(failed, (b) => b.bg(tint(o.failed, 0.2)).text_color(o.failed).child("!"))
        .when(!done && !current && !failed, (b) => b.border_1().border_color(t.border).text_color(t.dim).child(String(s.n)));
      return h_flex().id(`ws-step-${s.n}`).h(30).px(9).gap(6).flex_none().items_center().rounded(8).border_1()
        .border_color(current ? tint(t.accent, 0.55) : failed ? tint(o.failed, 0.5) : t.border)
        .when(current, (c) => c.bg(tint(t.accent, 0.16)))
        .when(done, (c) => c.bg(t.raised))
        .text_size(12).font_medium().text_color(done || current ? t.foreground : t.dim)
        .child(badge).child(div().child(s.name));
    };
    return this.card(t, "ws-steps").gap(10)
      .child(h_flex().gap(6).flex_wrap().children(steps(v.state).map(chip)))
      .child(h_flex().gap(6).items_center().text_size(12)
        .child(div().flex_none().w(7).h(7).rounded_full().bg(o[h.tone]))
        .child(div().flex_none().font_medium().text_color(o[h.tone]).child(h.status))
        .when(Boolean(h.detail), (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(h.detail))))
      .when(acts.includes("approve"), (el) => el.child(h_flex().child(
        this.solid(t, "ws-approve", this.busy === "approve" ? "Starting…" : `Start ${v.state.next?.name ?? "next step"}`, (cx) => this.act("approve", cx)))))
      .when(acts.includes("report"), (el) => el.child(h_flex().child(
        this.solid(t, "ws-report", "Open report", (cx) => this.act("report", cx)))));
  }

  laneCard(t, lane) {
    const o = tones(t);
    const tone = { working: o.working, "needs you": o.attention, failed: o.failed, done: o.done, idle: o.idle }[lane.status];
    const active = lane.status === "working" || lane.status === "needs you";
    const marker = lane.status === "working"
      ? svg(`${ICONS}/ring.svg`).w(13).h(13).flex_none().text_color(tone).spin(900)
      : div().w(9).h(9).flex_none().rounded_full().bg(tone);
    return v_flex().id(`ws-lane-${lane.id}`).flex_1().min_w(0).p(12).gap(6).rounded(10).border_1()
      .border_color(active ? tint(tone, 0.55) : t.border)
      .when(active, (c) => c.bg(tint(tone, 0.05)))
      .child(div().text_size(11).text_color(t.dim).child(lane.role))
      .child(h_flex().gap(8).items_center()
        .child(marker)
        .child(div().flex_1().min_w(0).truncate().text_size(14).font_semibold().child(lane.name))
        .child(div().flex_none().text_size(12).text_color(tone).child(lane.status)))
      .child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim).font_family(MONO)
        .child(div().flex_1().min_w(0).truncate().child(lane.model))
        .when(Boolean(lane.detail), (el) => el.child(div().flex_none().child(lane.detail))));
  }

  questionCard(t, v) {
    const q = v.state.question;
    const o = tones(t);
    const who = v.state.lanes?.[q.lane]?.name ?? q.lane;
    return v_flex().id("ws-question").flex_none().p(12).gap(8).rounded(10).border_1()
      .border_color(tint(o.attention, 0.6)).bg(tint(o.attention, 0.05))
      .child(h_flex().gap(6).items_center()
        .child(div().w(7).h(7).rounded_full().bg(o.attention))
        .child(div().text_size(12).font_medium().text_color(o.attention).child(`${who} asks`)))
      .child(div().text_size(12.5).text_color(t.foreground).child(q.text))
      .child(h_flex().gap(8).items_center()
        .child(div().id("ws-answer").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(8).border_1().border_color(t.input)
          .bg(t.background).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.answer).h_full().text_size(12).text_color(t.foreground)))
        .child(this.solid(t, "ws-send", this.busy === "answer" ? "Sending…" : "Send", (cx) => this.sendAnswer(cx))));
  }

  decisionCard(t, d) {
    const pill = (id, text, strong) => div().id(id).flex_none().h(22).px(8).flex().items_center().rounded(6)
      .bg(t.raised).text_size(11.5).font_medium().text_color(strong ? t.foreground : t.muted).child(text);
    return h_flex().id("ws-decision").flex_none().p(12).gap(10).items_center().rounded(10).border_1().border_color(t.border)
      .child(v_flex().flex_none().gap(2)
        .child(div().text_size(11).text_color(t.dim).child("Integrator"))
        .child(div().text_size(14).font_semibold().child(d.integrator)))
      .child(v_flex().flex_1().min_w(0).gap(6)
        .child(div().text_size(11.5).text_color(t.muted).truncate()
          .child(d.how + (d.votes.length ? " · " + d.votes.map(([who, pick]) => `${who} → ${pick}`).join(", ") : "")))
        .child(h_flex().gap(4).flex_wrap().children(d.share.filter(([, n]) => n > 0)
          .map(([who, n], i) => pill(`ws-share-${i}`, `${who} ${n}`, who === d.integrator)))));
  }

  statTiles(t, v, now) {
    const tiles = stats(v.state, now).map(([label, value], i) =>
      v_flex().id(`ws-stat-${i}`).flex_1().min_w(0).p(12).gap(4).rounded(10).border_1().border_color(t.border)
        .child(div().text_size(11).text_color(t.dim).truncate().child(label))
        .child(div().text_size(20).font_semibold().truncate().child(value)));
    if (this.width >= 460) return h_flex().flex_none().gap(10).children(tiles);
    return v_flex().flex_none().gap(10)
      .child(h_flex().gap(10).children(tiles.slice(0, 2)))
      .child(h_flex().gap(10).children(tiles.slice(2)));
  }

  findingsCard(t, v) {
    const sev = { P0: t.ansi1, P1: t.ansi3, P2: t.ansi4 };
    const disp = { fixed: t.ansi2, rejected: t.dim, deferred: tones(t).attention, open: t.foreground };
    const legend = h_flex().gap(10).items_center().text_size(11).text_color(t.dim).children(
      [["P0", "must fix"], ["P1", "should fix"], ["P2", "minor"]].map(([s, word]) =>
        h_flex().gap(4).items_center().child(div().w(6).h(6).rounded_full().bg(sev[s])).child(div().child(word))));
    const rs = rounds(v.state);
    const body = rs.length === 0
      ? [div().text_size(12).text_color(t.dim).child(v.state.step >= 5 ? "Reviewers are working." : "No rounds yet.")]
      : rs.map((r) => {
        const total = r.findings.length;
        const bar = h_flex().flex_1().h(6).rounded(3).overflow_hidden().bg(t.raised).children(
          total ? ["P0", "P1", "P2"].filter((s) => r.counts[s]).map((s) => div().h_full().w(`${(100 * r.counts[s]) / total}%`).bg(sev[s])) : []);
        return v_flex().id(`ws-round-${r.round}`).gap(6)
          .child(h_flex().gap(10).items_center().text_size(12)
            .child(div().flex_none().w(56).text_color(t.muted).child(`Round ${r.round}`))
            .child(bar)
            .child(div().flex_none().text_color(t.dim).child(total ? `${total}` : "clean")))
          .children(r.findings.map((f) => h_flex().id(`ws-f-${f.id}`).gap(8).items_center().text_size(12)
            .child(div().flex_none().w(6).h(6).rounded_full().bg(sev[f.severity] ?? t.dim))
            .child(div().flex_none().w(46).font_family(MONO).text_size(11).text_color(t.dim).child(f.id))
            .child(div().flex_1().min_w(0).truncate().child(f.title))
            .child(div().flex_none().text_size(11).text_color(disp[f.disposition] ?? t.muted).child(f.disposition))));
      });
    return this.card(t, "ws-findings")
      .child(h_flex().items_center().child(div().flex_1().child(this.label(t, "Findings per round"))).child(legend))
      .children(body);
  }

  historyList(t, v) {
    const rows = history(v.events, HISTORY);
    return v_flex().id("ws-history").flex_none().gap(8).px(2).pt(4)
      .child(this.label(t, "History"))
      .children(rows.map((row, i) => h_flex().id(`ws-h-${i}`).gap(10).items_start().text_size(12.5)
        .child(div().flex_none().mt(6).w(6).h(6).rounded_full().bg(i === 0 ? t.foreground : t.border))
        .child(div().flex_none().w(38).font_family(MONO).text_size(11.5).text_color(t.dim).child(row.time))
        .child(div().flex_1().min_w(0).text_color(i === 0 ? t.foreground : t.muted).child(row.text))));
  }

  empty(t) {
    return v_flex().flex_1().items_center().justify_center().gap(8).p(24).text_color(t.dim)
      .child(svg(`${ICONS}/whetstone.svg`).w(28).h(28).text_color(t.border))
      .child(div().text_size(13).text_color(t.muted).child("No Whetstone runs yet"))
      .child(div().text_size(12).child("In a repo, run:"))
      .child(div().px(8).py(4).rounded(6).bg(t.raised).font_family(MONO).text_size(11.5).text_color(t.muted).child("whetstone run \"your task\""));
  }

  render(_cx) {
    const t = theme();
    const v = this.view;
    const now = Date.now();
    const root = v_flex().id("whetstone").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(this.header(t, v));
    if (!v) return root.child(this.empty(t));
    const d = decision(v.state);
    return root.child(v_flex().id("ws-body").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      .child(this.stepsCard(t, v))
      .child((this.width >= 340 ? h_flex() : v_flex()).flex_none().gap(10).children(laneCards(v.state, now).map((l) => this.laneCard(t, l))))
      .when(Boolean(v.state.question), (el) => el.child(this.questionCard(t, v)))
      .when(Boolean(d), (el) => el.child(this.decisionCard(t, d)))
      .child(this.statTiles(t, v, now))
      .child(this.findingsCard(t, v))
      .child(this.historyList(t, v))
      .when(Boolean(this.error), (el) => el.child(div().text_size(11).text_color(t.ansi1).child(this.error))));
  }
}
