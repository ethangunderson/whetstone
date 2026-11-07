// Shared look for the Whetstone panel and lane viewer: theme colours by role,
// and the small pieces both draw. Colour is spent on state only.

import { h_flex, v_flex } from "gpui-base";
import { div, svg } from "gpui-kit";

export const ICONS = "mods/whetstone/icons";
export const MONO = "JetBrains Mono";

// A colour at an alpha: the theme's colours are #rrggbb.
export const tint = (color, alpha) =>
  /^#[0-9a-f]{6}$/i.test(color ?? "")
    ? color +
      Math.round(alpha * 255)
        .toString(16)
        .padStart(2, "0")
    : color;

export function json(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// attention: it's your turn (waiting, paused, a question). Not an error, so the accent.
export function tones(t) {
  return {
    working: t.working ?? t.ansi3,
    attention: t.accent ?? t.ansi4,
    done: t.done ?? t.ansi2,
    failed: t.ansi1,
    idle: t.idle ?? t.dim,
  };
}

export function icon(name, color, size = 14) {
  return svg(`${ICONS}/${name}.svg`).w(size).h(size).flex_none().text_color(color);
}

export function spinner(color, size = 13) {
  return icon("ring", color, size).spin(900);
}

export function dot(color, size = 7) {
  return div().w(size).h(size).flex_none().rounded_full().bg(color);
}

export function label(t, text) {
  return div().text_size(10.5).font_medium().text_color(t.dim).child(text.toUpperCase());
}

export function card(t, id) {
  return v_flex().id(id).flex_none().p(12).gap(8).rounded(10).border_1().border_color(t.border);
}

export function pill(t, id, text, { strong = false, color = null } = {}) {
  return div()
    .id(id)
    .flex_none()
    .h(20)
    .px(7)
    .flex()
    .items_center()
    .rounded(5)
    .bg(color ? tint(color, 0.14) : t.raised)
    .text_size(11)
    .font_medium()
    .text_color(color ?? (strong ? t.foreground : t.muted))
    .child(text);
}

export function ghost(t, id, text, onClick, color) {
  return h_flex()
    .id(id)
    .h(26)
    .px(8)
    .flex_none()
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(12)
    .font_medium()
    .text_color(color ?? t.muted)
    .hover((s) => s.bg(t.hover).text_color(color ?? t.foreground))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .child(text);
}

export function solid(t, id, text, onClick) {
  return h_flex()
    .id(id)
    .h(30)
    .px(12)
    .flex_none()
    .items_center()
    .rounded(8)
    .cursor_pointer()
    .bg(t.solid)
    .text_color(t.solid_foreground)
    .text_size(12.5)
    .font_medium()
    .hover((s) => s.opacity(0.88))
    .on_click((_e, cx) => {
      cx.stop_propagation();
      onClick(cx);
    })
    .child(text);
}

// "· item" lines, muted, for a short list of points.
export function points(t, id, items, color) {
  return v_flex()
    .gap(3)
    .children(
      items.map((text, i) =>
        h_flex()
          .id(`${id}-${i}`)
          .gap(6)
          .items_start()
          .text_size(12)
          .text_color(color ?? t.muted)
          .child(div().flex_none().text_color(t.dim).child("·"))
          .child(div().flex_1().min_w(0).child(text)),
      ),
    );
}
