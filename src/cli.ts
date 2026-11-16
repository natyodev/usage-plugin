import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { version } from "../package.json";
import { isEdge, parseCursor, parseMonitors, sceneOf } from "../widget/placement.ts";
import type { Edge } from "../widget/placement.ts";
import { buildView } from "../widget/view.ts";
import type { WidgetPayload, WidgetView } from "../widget/view.ts";
import type { Launch } from "../widget/controls.ts";
import { journal, readCache } from "./cache.ts";
import type { Run } from "./cache.ts";
import { loadConfig } from "./config.ts";
import { instant, isRecord } from "./domain.ts";
import type { ProviderId } from "./domain.ts";
import { sendNotice } from "./notify.ts";
import { sourcedProviders } from "./sources/index.ts";
import { adapters, deadlineIn, isProviderId, providers } from "./providers/index.ts";
import { moduleDebug, moduleLine, noticesOf, renderProblem } from "./render/module.ts";
import type { Layout, ModuleRequest } from "./render/module.ts";
import { t3ProfileFrom, widgetTheme } from "./theme/profile.ts";

/**
 * How long one run may take, from process start to the printed line. Waybar keeps the old label
 * up while we run and has no timeout of its own, so this is the only bound there is.
 */
const RUN_BUDGET_MS = 750;

const USAGE =
  "usage: usage-plugin --version | usage-plugin module [--provider <id>] [--layout stacked|inline] [--debug] | usage-plugin widget --toggle | usage-plugin widget --serve | usage-plugin widget --view | usage-plugin widget --payload";

type Command =
  | { readonly kind: "version" }
  | { readonly kind: "module"; readonly request: ModuleRequest }
  | { readonly kind: "moduleDebug"; readonly request: ModuleRequest }
  | { readonly kind: "widgetToggle" }
  | { readonly kind: "widgetServe" }
  | { readonly kind: "widgetView" }
  | { readonly kind: "widgetPayload" }
  | { readonly kind: "usageError"; readonly message: string; readonly forWaybar: boolean };

const WIDGET_COMMANDS: Readonly<Record<string, Command>> = {
  "--toggle": { kind: "widgetToggle" },
  "--serve": { kind: "widgetServe" },
  "--view": { kind: "widgetView" },
  "--payload": { kind: "widgetPayload" },
};

export function parseArgs(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  if (command === "--version" && rest.length === 0) return { kind: "version" };
  if (command === "widget") {
    const widget = rest.length === 1 ? WIDGET_COMMANDS[rest[0] ?? ""] : undefined;
    if (widget !== undefined) return widget;
    const flags = Object.keys(WIDGET_COMMANDS).join(", ");
    return { kind: "usageError", message: `widget needs one of ${flags} and nothing else`, forWaybar: false };
  }
  if (command !== "module") {
    const message = command === undefined ? "no command given" : `unknown command ${JSON.stringify(argv.join(" "))}`;
    return { kind: "usageError", message, forWaybar: false };
  }

  let only: ProviderId | null = null;
  let layout: Layout = "inline";
  let debug = false;
  const problem = (message: string): Command => ({ kind: "usageError", message, forWaybar: true });

  const tokens = rest.values();
  for (const flag of tokens) {
    switch (flag) {
      case "--debug":
        debug = true;
        break;
      case "--provider": {
        const id = tokens.next().value;
        if (id === undefined || !isProviderId(id)) {
          return problem(`--provider needs one of: ${adapters.map((adapter) => adapter.id).join(", ")}`);
        }
        only = id;
        break;
      }
      case "--layout": {
        const name = tokens.next().value;
        if (name !== "stacked" && name !== "inline") return problem("--layout needs stacked or inline");
        layout = name;
        break;
      }
      default:
        return problem(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  const request = { only, layout };
  return debug ? { kind: "moduleDebug", request } : { kind: "module", request };
}

function openRun(env: Readonly<Record<string, string | undefined>>): Run {
  const runtimeDir = env.XDG_RUNTIME_DIR
    ? `${env.XDG_RUNTIME_DIR}/usage-plugin`
    : `/tmp/usage-plugin-${process.getuid?.() ?? "user"}`;
  const fixtures = env.USAGE_PLUGIN_FIXTURES ?? null;
  if (fixtures !== null && !statSync(fixtures, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(
      `USAGE_PLUGIN_FIXTURES names ${JSON.stringify(fixtures)}, which is not a directory. Give it a case directory, or unset it to run live`,
    );
  }
  const home = env.HOME || homedir();
  return {
    home,
    fixtures,
    runtimeDir,
    configPath: `${env.XDG_CONFIG_HOME || `${home}/.config`}/usage-plugin/config.jsonc`,
    now: () => instant(Date.now()),
    deadline: deadlineIn(RUN_BUDGET_MS),
    log: journal(runtimeDir),
  };
}

async function main(argv: readonly string[]): Promise<never> {
  const command = parseArgs(argv);
  switch (command.kind) {
    case "version":
      return finish(version, 0);
    case "module":
    case "moduleDebug": {
      // Waybar hides a module that exits non-zero or prints nothing, which would hide the
      // explanation. So `module` always prints one JSON line and exits 0.
      const t3 = t3ProfileFrom(process.env);
      const answer = (run: Run) =>
        command.kind === "module" ? moduleLine(command.request, run, providers, t3) : moduleDebug(command.request, run, t3);
      const line = await Promise.resolve()
        .then(() => answer(openRun(process.env)))
        .catch((error: unknown) => problemLine(error instanceof Error ? error.message : String(error)));
      return finish(line, 0);
    }
    case "widgetToggle":
    case "widgetServe":
      try {
        await startWidget(command.kind === "widgetToggle" ? "toggle" : "serve", openRun(process.env), process.env);
      } catch (error) {
        writeSync(2, `usage-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
        return process.exit(1);
      }
      return process.exit(0);
    case "widgetView":
    case "widgetPayload":
      try {
        const run = openRun(process.env);
        return finish(JSON.stringify(command.kind === "widgetView" ? widgetState(run, process.env).view : payloadOf(run, process.env)), 0);
      } catch (error) {
        writeSync(2, `usage-plugin: ${error instanceof Error ? error.message : String(error)}\n`);
        return process.exit(1);
      }
    case "usageError":
      if (command.forWaybar) return finish(problemLine(`${command.message}. ${USAGE}`), 0);
      writeSync(2, `usage-plugin: ${command.message}\n${USAGE}\n`);
      return process.exit(2);
  }
}

const GJS_MISSING = {
  summary: "Install gjs to open the usage widget",
  body: "The widget runs on gjs with gtk4 and gtk4-layer-shell.",
  stackTag: "usage-plugin-widget",
};

/**
 * GTK's default renderer maps the widget in about 460 ms at 300 MiB here; cairo in about 210 ms at
 * 97 MiB, and a panel this small looks the same. The user's own GSK_RENDERER wins.
 */
const SMALL_PANEL_RENDERER = "cairo";

/** By soname, which the runtime package installs, where the bare .so comes only with a dev package. */
const LAYER_SHELL = "libgtk4-layer-shell.so.0";

/** From the cache only. The widget asks for this again while it is open, so it must never fetch. */
function widgetState(run: Run, env: Readonly<Record<string, string | undefined>>): Pick<WidgetPayload, "view" | "theme"> {
  const config = loadConfig(run.configPath);
  const states = readCache(run, sourcedProviders(config.settings.source, run));
  return {
    view: buildView(states, config.settings, noticesOf(config.problems), run.now()),
    theme: widgetTheme(run.runtimeDir, config.settings.theme, t3ProfileFrom(env), run.log),
  };
}

/** The compiled binary runs from Bun's embedded file system; from source, Bun needs the script. */
function selfArgv(): readonly string[] {
  return Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main];
}

/** What a panel needs to open: the view, the theme, and where the pointer and the bar are right now. */
function payloadOf(run: Run, env: Readonly<Record<string, string | undefined>>): WidgetPayload {
  return {
    ...widgetState(run, env),
    refresh: [...selfArgv(), "widget", "--view"],
    scene: sceneOf(
      { cursor: parseCursor(hyprctl("cursorpos")), monitors: parseMonitors(hyprctl("monitors")), layers: hyprctl("layers") },
      waybarEdge(env),
    ),
  };
}

/**
 * `serve` is what the Waybar module runs with the bar, so it only writes that gjs is missing. The
 * desktop notice is for `toggle`, which a person asked for.
 */
async function startWidget(
  start: Launch["start"],
  run: Run,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const gjs = Bun.which("gjs");
  if (gjs === null) {
    const sent = start === "toggle" ? await sendNotice(GJS_MISSING, run) : { sent: false, detail: "none is sent for --serve" };
    if (!sent.sent) writeSync(2, `usage-plugin: ${GJS_MISSING.summary}. The notice was not sent: ${sent.detail}\n`);
    return;
  }
  const reopen = [...selfArgv(), "widget", "--payload"];
  const launch: Launch = start === "serve" ? { start, reopen } : { start, reopen, payload: payloadOf(run, env) };
  const preload = [LAYER_SHELL, env.LD_PRELOAD].filter((library) => library !== undefined && library !== "").join(" ");
  spawn(gjs, ["-m", widgetScript()], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...env,
      LD_PRELOAD: preload,
      GSK_RENDERER: env.GSK_RENDERER || SMALL_PANEL_RENDERER,
      USAGE_PLUGIN_WIDGET: JSON.stringify(launch),
    },
  }).unref();
}

function widgetScript(): string {
  const beside = join(dirname(process.execPath), "widget.js");
  return existsSync(beside) ? beside : join(import.meta.dir, "..", "dist", "widget.js");
}

const HYPRCTL_TIMEOUT_MS = 500;

function hyprctl(command: "cursorpos" | "monitors" | "layers"): unknown {
  try {
    const result = Bun.spawnSync(["hyprctl", "-j", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: HYPRCTL_TIMEOUT_MS,
    });
    return result.exitCode === 0 ? JSON.parse(result.stdout.toString()) : null;
  } catch {
    return null;
  }
}

function waybarEdge(env: Readonly<Record<string, string | undefined>>): Edge | null {
  const dir = `${env.XDG_CONFIG_HOME || `${env.HOME || homedir()}/.config`}/waybar`;
  const path = ["config.jsonc", "config"].map((name) => join(dir, name)).find((candidate) => existsSync(candidate));
  if (path === undefined) return null;
  try {
    const parsed: unknown = Bun.JSONC.parse(readFileSync(path, "utf8"));
    const bar = Array.isArray(parsed) ? parsed[0] : parsed;
    const position = isRecord(bar) ? bar.position : undefined;
    return isEdge(position) ? position : null;
  } catch {
    return null;
  }
}

function problemLine(message: string): string {
  writeSync(2, `usage-plugin: ${message}\n`);
  return JSON.stringify(renderProblem(`usage-plugin: ${message}`));
}

// The write is synchronous so the line is out before the exit, and the exit is what ends a
// fetch that was abandoned at the deadline.
function finish(stdout: string, exitCode: number): never {
  writeSync(1, `${stdout}\n`);
  return process.exit(exitCode);
}

if (import.meta.main) await main(process.argv.slice(2));
