/** What the GJS widget decides, kept free of GTK so the tests can load it. */

import type { WidgetPayload } from "./view.ts";

/** The X keysym, which GDK passes through as `Gdk.KEY_Escape`. */
export const ESCAPE_KEYVAL = 0xff1b;

export const DEBOUNCE_MICROSECONDS = 300_000;

/** A click this soon after the last one that counted is the same burst, and a burst counts once. */
export function sameBurst(lastClickAt: number | null, now: number): boolean {
  return lastClickAt !== null && now - lastClickAt < DEBOUNCE_MICROSECONDS;
}

export function closesOnKey(keyval: number): boolean {
  return keyval === ESCAPE_KEYVAL;
}

/**
 * Where the widget is between hidden and shown.
 *
 * `opening` and `closing` each wait on one timer: the pointer has to rest on the module before
 * the widget opens, and it gets a moment to cross the gap between the module and the panel before
 * the widget closes. `hover` closes when the pointer leaves. `pinned` stays until it is dismissed.
 */
export type Lifecycle = "hidden" | "opening" | "hover" | "closing" | "pinned";

/** How long the two waits last. The Waybar module sends its own with every pointer crossing. */
export interface Timing {
  readonly openDelayMs: number;
  readonly closeGraceMs: number;
}

export type LifecycleEvent =
  | { readonly kind: "moduleEnter"; readonly timing: Timing }
  | { readonly kind: "moduleLeave"; readonly timing: Timing }
  | { readonly kind: "moduleClick" }
  | { readonly kind: "panelEnter" }
  | { readonly kind: "panelLeave" }
  /** `usage-plugin widget --toggle`, which says nothing about where the pointer is. */
  | { readonly kind: "toggle" }
  /** Escape, a click outside the panel, or the keyboard going elsewhere. */
  | { readonly kind: "dismiss" }
  /** The wait of `opening` or `closing` ran out. */
  | { readonly kind: "timeout" };

export interface Hover {
  readonly state: Lifecycle;
  readonly timing: Timing;
}

/** Used only until the module sends its own timing. */
export const INITIAL: Hover = { state: "hidden", timing: { openDelayMs: 150, closeGraceMs: 300 } };

/**
 * An event a state does not list leaves it as it is. A click on the module unpins to `hover` and
 * not to `hidden`, because the pointer is on the module and leaving it closes the widget. Only
 * `pinned` takes the keyboard, so only `pinned` can be dismissed.
 */
const NEXT: Readonly<Record<Lifecycle, Partial<Record<LifecycleEvent["kind"], Lifecycle>>>> = {
  hidden: { moduleEnter: "opening", moduleClick: "pinned", toggle: "pinned" },
  opening: { timeout: "hover", moduleLeave: "hidden", moduleClick: "pinned", toggle: "pinned" },
  hover: { moduleLeave: "closing", panelLeave: "closing", moduleClick: "pinned", toggle: "pinned" },
  closing: { timeout: "hidden", moduleEnter: "hover", panelEnter: "hover", moduleClick: "pinned", toggle: "pinned" },
  pinned: { moduleClick: "hover", toggle: "hidden", dismiss: "hidden" },
};

export function step(hover: Hover, event: LifecycleEvent): Hover {
  return {
    state: NEXT[hover.state][event.kind] ?? hover.state,
    timing: "timing" in event ? event.timing : hover.timing,
  };
}

/** How long the state waits before its `timeout`, or null when it waits on nothing. */
export function waitOf({ state, timing }: Hover): number | null {
  if (state === "opening") return timing.openDelayMs;
  if (state === "closing") return timing.closeGraceMs;
  return null;
}

/**
 * How the panel is on screen. A `hover` panel takes no keyboard and lets clicks through around
 * it. A `pinned` one takes the keyboard and closes on a click outside.
 */
export type Face = "hover" | "pinned";

const FACES: Readonly<Record<Lifecycle, Face | null>> = {
  hidden: null,
  opening: null,
  hover: "hover",
  closing: "hover",
  pinned: "pinned",
};

export function faceOf(state: Lifecycle): Face | null {
  return FACES[state];
}

/**
 * What `usage-plugin widget` hands a new widget process. `serve` starts it hidden and keeps it
 * running, so a hover never waits for GJS to start. `toggle` brings the payload read when the
 * user asked, and a widget started that way exits when it closes.
 */
export type Launch =
  | { readonly start: "serve"; readonly reopen: readonly string[] }
  | { readonly start: "toggle"; readonly reopen: readonly string[]; readonly payload: WidgetPayload };

/**
 * Properties for a `Gtk.Label` that shows `text` as it is. The markup switches come last, so
 * nothing passed in can turn them on for text from a provider.
 */
export function plainLabel(
  text: string,
  classes: readonly string[],
  properties: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return { xalign: 0, ...properties, label: text, css_classes: classes, use_markup: false, use_underline: false };
}
