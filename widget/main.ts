/**
 * The fixed application id makes GApplication unique on the session bus, and puts the actions at
 * the end of this file on it at /dev/natyo/UsagePlugin/Widget. The Waybar module
 * (cffi/usage-cffi.c) and a second `usage-plugin widget --toggle` reach the running widget
 * through them.
 */

import cairo from "cairo";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import LayerShell from "gi://Gtk4LayerShell";
import Pango from "gi://Pango";
import { closesOnKey, faceOf, INITIAL, plainLabel, sameBurst, step, waitOf } from "./controls.ts";
import type { Face, Hover, Launch, LifecycleEvent, Timing } from "./controls.ts";
import { place } from "./placement.ts";
import type { Edge, Scene } from "./placement.ts";
import style from "./style.css" with { type: "text" };
import { followTheme } from "./theme.ts";
import type { CardView, RowView, WidgetPayload, WidgetView } from "./view.ts";

const APPLICATION_ID = "dev.natyo.UsagePlugin.Widget";
const LAUNCH_ENV = "USAGE_PLUGIN_WIDGET";
const NAMESPACE = "usage-plugin";
const PANEL_WIDTH = 358;
const REFRESH_SECONDS = 5;

const EDGES: Readonly<Record<Edge, unknown>> = {
  left: LayerShell.Edge.LEFT,
  right: LayerShell.Edge.RIGHT,
  top: LayerShell.Edge.TOP,
  bottom: LayerShell.Edge.BOTTOM,
};

function readLaunch(): Launch | null {
  try {
    return JSON.parse(GLib.getenv(LAUNCH_ENV) ?? "");
  } catch {
    console.error(
      `usage-plugin widget: ${LAUNCH_ENV} does not hold the widget's JSON. Open it with usage-plugin widget --toggle`,
    );
    return null;
  }
}

/** What is on screen while the widget is not hidden. */
interface Panel {
  readonly window: any;
  /** Under the window. It takes the clicks around a pinned panel, and none around a hover one. */
  readonly backdrop: any;
  readonly styles: readonly unknown[];
  readonly refreshing: number;
}

function present({ view, scene, refresh, theme }: WidgetPayload, face: Face): Panel {
  const display = Gdk.Display.get_default();
  const styles = [...addStyles(display, view.cards, theme.mode !== "none"), ...followTheme(display, theme)];
  const monitor = monitorNamed(display, scene.monitor);
  const backdrop = presentBackdrop(monitor);

  const window = layerWindow(monitor, NAMESPACE);
  window.set_default_size(PANEL_WIDTH, -1);
  show(window, scene, view);
  dismissOnEscapeOrFocusLoss(window);
  followPointer(window);
  const refreshing = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECONDS, () => {
    read<WidgetView>(refresh, (newer) => {
      if (newer !== null && onScreen?.window === window) show(window, scene, newer);
    });
    return GLib.SOURCE_CONTINUE;
  });
  const shown = { window, backdrop, styles, refreshing };
  wear(shown, face);
  window.present();
  return shown;
}

/** Safe to repeat: the layer shell and GDK both send nothing for a value they already hold. */
function wear(shown: Panel, face: Face): void {
  const pinned = face === "pinned";
  LayerShell.set_keyboard_mode(shown.window, pinned ? LayerShell.KeyboardMode.ON_DEMAND : LayerShell.KeyboardMode.NONE);
  shown.backdrop.get_surface().set_input_region(pinned ? null : new cairo.Region());
  // GDK sends the region with the next frame, and a backdrop that never changes draws none.
  shown.backdrop.queue_draw();
}

function close(shown: Panel): void {
  GLib.source_remove(shown.refreshing);
  const display = Gdk.Display.get_default();
  for (const provider of shown.styles) Gtk.StyleContext.remove_provider_for_display(display, provider);
  shown.window.destroy();
  shown.backdrop.destroy();
}

/** Places the panel again each time, because a card that gains a note grows taller. */
function show(window: any, scene: Scene, view: WidgetView): void {
  const panel = panelOf(view);
  panel.set_size_request(PANEL_WIDTH, -1);
  window.set_child(panel);
  const [, height] = panel.measure(Gtk.Orientation.VERTICAL, PANEL_WIDTH);
  const { anchors, margins } = place(scene, { width: PANEL_WIDTH, height });
  for (const edge of anchors) {
    LayerShell.set_anchor(window, EDGES[edge], true);
    LayerShell.set_margin(window, EDGES[edge], margins[edge] ?? 0);
  }
}

/**
 * Runs a `usage-plugin` command that prints JSON. `then` gets null when it did not.
 *
 * The command runs without the preload this process was started with. With it, the command and
 * each hyprctl it runs would load GTK, which took a payload from about 25 ms to about 110 ms.
 */
function read<T>(argv: readonly string[], then: (printed: T | null) => void): void {
  try {
    const launcher = new Gio.SubprocessLauncher({
      flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    });
    launcher.unsetenv("LD_PRELOAD");
    const child = launcher.spawnv(argv);
    child.communicate_utf8_async(null, null, (_source: unknown, result: unknown) => {
      let printed: T | null = null;
      try {
        const [, stdout] = child.communicate_utf8_finish(result);
        if (child.get_successful()) printed = JSON.parse(stdout);
      } catch (error) {
        console.error(`usage-plugin widget: cannot read what ${argv.join(" ")} printed: ${error}`);
      }
      then(printed);
    });
  } catch (error) {
    console.error(`usage-plugin widget: cannot run ${argv.join(" ")}: ${error}`);
    then(null);
  }
}

/**
 * While a pinned panel is up the pointer is never over a window, so Hyprland's default
 * focus-follows-mouse cannot take the keyboard from the widget when the pointer crosses the gap.
 * It covers the area the bars leave free and not the bars, so the module still gets its clicks.
 */
function presentBackdrop(monitor: unknown) {
  const backdrop = layerWindow(monitor, "usage-plugin-backdrop");
  for (const edge of Object.values(EDGES)) LayerShell.set_anchor(backdrop, edge, true);
  const click = new Gtk.GestureClick({ button: 0 });
  click.connect("released", () => dispatch({ kind: "dismiss" }));
  backdrop.add_controller(click);
  backdrop.present();
  return backdrop;
}

function layerWindow(monitor: unknown, cssClass: string) {
  const window = new Gtk.ApplicationWindow({ application: app, css_classes: [cssClass] });
  LayerShell.init_for_window(window);
  LayerShell.set_namespace(window, NAMESPACE);
  LayerShell.set_layer(window, LayerShell.Layer.OVERLAY);
  if (monitor !== null) LayerShell.set_monitor(window, monitor);
  return window;
}

/** Returns what it added, because a widget that stays running takes them off again when it closes. */
function addStyles(display: unknown, cards: readonly CardView[], waybarColors: boolean): readonly unknown[] {
  const application = Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION;
  return [
    addStyle(display, application, (provider) => provider.load_from_string(style)),
    addStyle(display, application, (provider) => provider.load_from_string(logoColors(cards))),
    ...(waybarColors ? addStyleFile(display, application + 1, `${GLib.get_user_config_dir()}/waybar/colors.css`) : []),
    ...addStyleFile(display, Gtk.STYLE_PROVIDER_PRIORITY_USER, `${GLib.get_user_config_dir()}/usage-plugin/style.css`),
  ];
}

function logoColors(cards: readonly CardView[]): string {
  return cards
    .flatMap((card) => (card.color === null ? [] : [`.card.${card.id} { --usage-logo: ${card.color}; }`]))
    .join("\n");
}

function addStyleFile(display: unknown, priority: number, path: string): readonly unknown[] {
  if (!GLib.file_test(path, GLib.FileTest.IS_REGULAR)) return [];
  return [addStyle(display, priority, (provider) => provider.load_from_path(path))];
}

function addStyle(display: unknown, priority: number, load: (provider: any) => void): unknown {
  const provider = new Gtk.CssProvider();
  load(provider);
  Gtk.StyleContext.add_provider_for_display(display, provider, priority);
  return provider;
}

function monitorNamed(display: any, connector: string | null): unknown {
  const monitors = display.get_monitors();
  for (let index = 0; index < monitors.get_n_items(); index += 1) {
    const monitor = monitors.get_item(index);
    if (monitor.get_connector() === connector) return monitor;
  }
  return null;
}

/** A layer surface may map before the compositor gives it the keyboard. */
function dismissOnEscapeOrFocusLoss(window: any): void {
  const keys = new Gtk.EventControllerKey();
  keys.connect("key-pressed", (_controller: unknown, keyval: number) => {
    if (!closesOnKey(keyval)) return false;
    dispatch({ kind: "dismiss" });
    return true;
  });
  window.add_controller(keys);

  let focused = false;
  window.connect("notify::is-active", () => {
    if (window.is_active) focused = true;
    else if (focused) dispatch({ kind: "dismiss" });
  });
}

function followPointer(window: any): void {
  const pointer = new Gtk.EventControllerMotion();
  pointer.connect("enter", () => dispatch({ kind: "panelEnter" }));
  pointer.connect("leave", () => dispatch({ kind: "panelLeave" }));
  window.add_controller(pointer);
}

function panelOf(view: WidgetView) {
  const panel = column(10, ["panel"]);
  const header = row(0, []);
  header.append(label("USAGE LEFT", ["header"]));
  header.append(label(view.updated ?? "", ["updated"], { xalign: 1, hexpand: true }));
  panel.append(header);
  for (const notice of view.notices) panel.append(label(`⚠ ${notice}`, ["notice"], WRAPPED));
  if (view.cards.length === 0) panel.append(label(view.empty, ["note"], WRAPPED));
  for (const card of view.cards) panel.append(cardOf(card));
  return panel;
}

function cardOf(card: CardView) {
  const box = column(10, ["card", card.id, card.state]);

  const top = row(10, ["reading"]);
  top.append(label(card.glyph, ["logo"]));
  const names = column(0, [], { hexpand: true, valign: Gtk.Align.CENTER });
  names.append(label(card.name, ["name"], ELLIPSIZED));
  if (card.plan !== null) names.append(label(card.plan, ["plan"], ELLIPSIZED));
  top.append(names);
  top.append(
    label(card.headline.text, ["headline", ...(card.headline.level === null ? [] : [card.headline.level])], {
      xalign: 1,
    }),
  );
  box.append(top);

  for (const window of card.rows) box.append(windowOf(window));
  if (card.source !== null) box.append(label(card.source, ["source"]));
  if (card.note !== null) box.append(label(card.note, ["note"], WRAPPED));
  return box;
}

function windowOf(window: RowView) {
  const box = column(5, ["reading"]);
  const line = row(6, []);
  line.append(label(window.label, ["window"]));
  line.append(label(window.percent, ["percent", window.level]));
  line.append(
    label(window.resets ?? "", ["resets"], {
      wrap: true,
      max_width_chars: 1,
      justify: Gtk.Justification.RIGHT,
      xalign: 1,
      hexpand: true,
    }),
  );
  box.append(line);
  box.append(new Gtk.ProgressBar({ fraction: window.fraction, hexpand: true, css_classes: [window.level] }));
  if (window.chips.length > 0) {
    const chips = row(6, []);
    for (const chip of window.chips) chips.append(label(chip, ["chip"]));
    box.append(chips);
  }
  return box;
}

const WRAPPED = { wrap: true, max_width_chars: 40 };
const ELLIPSIZED = { ellipsize: Pango.EllipsizeMode.END, max_width_chars: 1 };

function label(text: string, classes: readonly string[], properties: Readonly<Record<string, unknown>> = {}) {
  return new Gtk.Label(plainLabel(text, classes, properties));
}

function column(spacing: number, classes: readonly string[], properties: Readonly<Record<string, unknown>> = {}) {
  return new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing, css_classes: classes, ...properties });
}

function row(spacing: number, classes: readonly string[]) {
  return new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing, css_classes: classes });
}

let hover: Hover = INITIAL;
/** The timer of `opening` or `closing`. */
let waiting: number | null = null;
let onScreen: Panel | null = null;
/** What the panel shows, read when the widget left `hidden`. */
let payload: WidgetPayload | null = null;
let reading = false;
let clickedAt: number | null = null;

/** A toggle brings the payload its launcher read. Any other event makes the widget read one. */
function dispatch(event: LifecycleEvent, brought: WidgetPayload | null = null): void {
  const before = hover.state;
  hover = step(hover, event);
  if (hover.state === before) return;

  if (waiting !== null) GLib.source_remove(waiting);
  const wait = waitOf(hover);
  waiting =
    wait === null
      ? null
      : GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
          waiting = null;
          dispatch({ kind: "timeout" });
          return GLib.SOURCE_REMOVE;
        });
  payload ??= brought;
  settle();
}

/**
 * Makes the screen match `hover`. The payload is read while `opening` waits, so the panel is
 * ready when the wait ends.
 */
function settle(): void {
  if (hover.state !== "hidden" && !LayerShell.is_supported()) {
    console.error("usage-plugin widget: the compositor or libgtk4-layer-shell does not support layer shell, so the widget stays closed");
    hover = { ...hover, state: "hidden" };
  }
  if (hover.state === "hidden") {
    if (onScreen !== null) close(onScreen);
    onScreen = null;
    payload = null;
    if (!resident) app.quit();
    return;
  }
  if (payload === null) return readPayload();
  const face = faceOf(hover.state);
  if (face === null) return;
  if (onScreen === null) onScreen = present(payload, face);
  else wear(onScreen, face);
}

function readPayload(): void {
  if (reading) return;
  reading = true;
  read<WidgetPayload>(reopen, (fresh) => {
    reading = false;
    if (fresh === null || hover.state === "hidden") return;
    payload ??= fresh;
    settle();
  });
}

function click(event: LifecycleEvent, brought: WidgetPayload | null = null): void {
  const now = GLib.get_monotonic_time();
  if (sameBurst(clickedAt, now)) return;
  clickedAt = now;
  dispatch(event, brought);
}

function timingOf(parameter: any): Timing {
  const [openDelayMs, closeGraceMs] = parameter.deepUnpack();
  return { openDelayMs, closeGraceMs };
}

function addAction(name: string, type: string | null, activate: (parameter: any) => void): void {
  const action = new Gio.SimpleAction({ name, parameter_type: type === null ? null : new GLib.VariantType(type) });
  action.connect("activate", (_action: unknown, parameter: unknown) => activate(parameter));
  app.add_action(action);
}

// Last, because `run` blocks until the widget exits, and the actions need everything above.
const launch = readLaunch();
const reopen = launch?.reopen ?? [];
const resident = launch?.start === "serve";
const app = new Gtk.Application({ application_id: APPLICATION_ID });

addAction("module-enter", "(uu)", (timing) => dispatch({ kind: "moduleEnter", timing: timingOf(timing) }));
addAction("module-leave", "(uu)", (timing) => dispatch({ kind: "moduleLeave", timing: timingOf(timing) }));
addAction("module-click", null, () => click({ kind: "moduleClick" }));
addAction("toggle", "s", (brought) => click({ kind: "toggle" }, JSON.parse(brought.unpack())));
// Everything arrives as an action, so a launch that reaches a running widget has nothing to do here.
app.connect("activate", () => {});

if (launch !== null) {
  app.register(null);
  if (launch.start === "toggle") app.activate_action("toggle", new GLib.Variant("s", JSON.stringify(launch.payload)));
  // A second launch must not hold, or `run` would never return to it.
  if (resident && !app.get_is_remote()) app.hold();
  app.run([]);
}
