import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import type { WidgetTheme } from "../src/theme/profile.ts";

// GJS collects a monitor nothing refers to, and a collected monitor stops watching.
let monitor: any = null;

/** Returns the provider it added, so a widget that stays running can take it off when the panel closes. */
export function followTheme(display: unknown, { css }: WidgetTheme): readonly unknown[] {
  monitor?.cancel();
  monitor = null;
  if (css === null) return [];
  const provider = new Gtk.CssProvider();
  const load = () => {
    if (GLib.file_test(css, GLib.FileTest.IS_REGULAR)) provider.load_from_path(css);
    else provider.load_from_string("");
  };
  load();
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 2);
  const watcher = Gio.File.new_for_path(css).monitor_file(Gio.FileMonitorFlags.NONE, null);
  watcher.connect("changed", load);
  monitor = watcher;
  return [provider];
}
