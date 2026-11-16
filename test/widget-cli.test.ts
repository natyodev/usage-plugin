import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "../src/cli.ts";
import type { Launch } from "../widget/controls.ts";
import type { WidgetPayload } from "../widget/view.ts";
import { fixtureCase, tempDir, until, writeFileUnder } from "./support.ts";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

describe("parseArgs", () => {
  test("widget --toggle", () => {
    expect(parseArgs(["widget", "--toggle"])).toEqual({ kind: "widgetToggle" });
  });

  test("widget --serve and widget --payload", () => {
    expect(parseArgs(["widget", "--serve"])).toEqual({ kind: "widgetServe" });
    expect(parseArgs(["widget", "--payload"])).toEqual({ kind: "widgetPayload" });
  });

  test.each([
    [["widget"]],
    [["widget", "--toggle", "--toggle"]],
    [["widget", "--serve", "--toggle"]],
    [["widget", "--open"]],
    [["widget", "--provider", "claude"]],
    [["widget", "--layout", "stacked"]],
  ])("%p is a usage error for the terminal, not a Waybar line", (argv) => {
    expect(parseArgs(argv)).toMatchObject({ kind: "usageError", forWaybar: false });
  });
});

function binWith(scripts: Readonly<Record<string, string>>): { readonly bin: string; readonly record: string } {
  const bin = tempDir();
  const record = tempDir();
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body.replaceAll("$RECORD", record)}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return { bin, record };
}

const RECORDING_GJS = `printf '%s' "$USAGE_PLUGIN_WIDGET" > '$RECORD/payload'
printf '%s' "$LD_PRELOAD" > '$RECORD/preload'
printf '%s' "$GSK_RENDERER" > '$RECORD/renderer'
printf '%s\\n' "$@" > '$RECORD/args'
: > '$RECORD/done'`;

const RECORDING_GDBUS = `printf '%s\\n' "$@" >> '$RECORD/gdbus'
echo call >> '$RECORD/calls'`;

function laneEnv(bin: string, configHome: string = tempDir()) {
  return {
    HOME: join(tempDir(), "no-home"),
    XDG_RUNTIME_DIR: tempDir(),
    XDG_CONFIG_HOME: configHome,
    USAGE_PLUGIN_FIXTURES: fixtureCase("claude-ok"),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
    PATH: bin,
  };
}

async function cli(args: readonly string[], env: Readonly<Record<string, string>>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 3000 });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function started(how: "--toggle" | "--serve", env: Readonly<Record<string, string>>, record: string) {
  const result = await cli(["widget", how], env);
  await until(() => existsSync(join(record, "done")), "the stand-in gjs ran");
  const launch: Launch = JSON.parse(readFileSync(join(record, "payload"), "utf8"));
  return { result, launch };
}

async function toggled(env: Readonly<Record<string, string>>, record: string) {
  const { result, launch } = await started("--toggle", env, record);
  if (launch.start !== "toggle") throw new Error(`--toggle launched the widget with start ${launch.start}`);
  return {
    result,
    payload: launch.payload,
    args: readFileSync(join(record, "args"), "utf8").trimEnd().split("\n"),
    preload: readFileSync(join(record, "preload"), "utf8"),
    renderer: readFileSync(join(record, "renderer"), "utf8"),
  };
}

describe("usage-plugin widget --toggle", () => {
  test("starts gjs on the bundled widget with layer shell preloaded, and prints nothing", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const { result, args, preload } = await toggled(laneEnv(bin), record);
    const ownStderr = result.stderr.split("\n").filter((line) => line !== "" && !line.includes("ld.so:"));
    expect({ ...result, stderr: ownStderr }).toEqual({ stdout: "", stderr: [], exitCode: 0 });
    expect(args[0]).toBe("-m");
    expect(args[1]).toEndWith("/widget.js");
    expect(preload).toBe("libgtk4-layer-shell.so.0");
  });

  test("hands the widget what the module last read", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const env = laneEnv(bin);
    expect((await cli(["module"], env)).exitCode).toBe(0);

    const { payload } = await toggled(env, record);
    expect(
      payload.view.cards.map((card) => [card.name, card.headline.text, card.rows.map((row) => row.percent)]),
    ).toEqual([["Claude", "34%", ["34% left", "88% left"]]]);
  });

  test("with an empty cache opens with no cards and fetches nothing", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const env = laneEnv(bin);
    const { payload } = await toggled(env, record);
    expect(payload.view).toEqual({ updated: null, notices: [], cards: [], empty: "No provider has a reading yet." });
    expect(existsSync(join(env.XDG_RUNTIME_DIR, "usage-plugin", "debug.log"))).toBe(false);
  });

  test("without hyprctl opens on the edge the Waybar config names", async () => {
    const configHome = tempDir();
    writeFileUnder(configHome, "waybar/config.jsonc", '// my bar\n{ "position": "right", "layer": "top", }\n');
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const { payload } = await toggled(laneEnv(bin, configHome), record);
    expect(payload.scene).toEqual({ monitor: null, size: null, edge: "right", pointer: null });
  });

  test("takes the first bar of a Waybar config that lists several", async () => {
    const configHome = tempDir();
    mkdirSync(join(configHome, "waybar"));
    writeFileSync(join(configHome, "waybar", "config"), '[{ "position": "bottom" }, { "position": "left" }]');
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    expect((await toggled(laneEnv(bin, configHome), record)).payload.scene.edge).toBe("bottom");
  });

  test("opens from the top when the Waybar config cannot be read", async () => {
    const configHome = tempDir();
    writeFileUnder(configHome, "waybar/config.jsonc", '{ "position": ');
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    expect((await toggled(laneEnv(bin, configHome), record)).payload.scene.edge).toBe("top");
  });

  test("without gjs sends one desktop notice saying what to install, and exits 0", async () => {
    const { bin, record } = binWith({ gdbus: RECORDING_GDBUS });
    const result = await cli(["widget", "--toggle"], laneEnv(bin));
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(readFileSync(join(record, "calls"), "utf8")).toBe("call\n");
    expect(readFileSync(join(record, "gdbus"), "utf8")).toContain("'Install gjs to open the usage widget'");
  });
});

describe("usage-plugin widget --serve", () => {
  test("starts the widget hidden, with the command it runs for a payload each time it opens", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const env = laneEnv(bin);
    expect((await cli(["module"], env)).exitCode).toBe(0);
    const { result, launch } = await started("--serve", env, record);
    expect(result.exitCode).toBe(0);
    expect(Object.keys(launch).sort()).toEqual(["reopen", "start"]);
    expect(launch.start).toBe("serve");

    const [command, ...args] = launch.reopen;
    const proc = Bun.spawn([command ?? "", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const payload: WidgetPayload = JSON.parse(stdout);
    expect(exitCode).toBe(0);
    expect(payload.view.cards.map((card) => [card.name, card.headline.text])).toEqual([["Claude", "34%"]]);
    expect(payload.scene).toEqual({ monitor: null, size: null, edge: "top", pointer: null });
    expect(payload.refresh.slice(-2)).toEqual(["widget", "--view"]);
  });

  test("without gjs says so on stderr and sends no desktop notice, because the bar runs it and not a person", async () => {
    const { bin, record } = binWith({ gdbus: RECORDING_GDBUS });
    const result = await cli(["widget", "--serve"], laneEnv(bin));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Install gjs to open the usage widget");
    expect(existsSync(join(record, "calls"))).toBe(false);
  });
});

describe("usage-plugin widget --toggle hands the widget the payload read when it was asked", () => {
  test("and the same command a served widget runs, for when it opens again", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const { launch } = await started("--toggle", laneEnv(bin), record);
    expect(launch.reopen.slice(-2)).toEqual(["widget", "--payload"]);
  });
});

describe("usage-plugin widget --toggle with USAGE_PLUGIN_FIXTURES naming a file", () => {
  test("names the path, exits 1, and starts no widget", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const file = join(fixtureCase("claude-ok"), "claude.json");
    const result = await cli(["widget", "--toggle"], { ...laneEnv(bin), USAGE_PLUGIN_FIXTURES: file });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`USAGE_PLUGIN_FIXTURES names "${file}", which is not a directory`);
    expect(existsSync(join(record, "done"))).toBe(false);
  });
});

describe("usage-plugin widget --toggle reads the usage-plugin config", () => {
  const TIGHT = '{ "thresholds": { "warning": 50 } }';

  test("from XDG_CONFIG_HOME when it is set", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const env = laneEnv(bin);
    writeFileUnder(env.XDG_CONFIG_HOME, "usage-plugin/config.jsonc", TIGHT);
    writeFileUnder(env.HOME, ".config/usage-plugin/config.jsonc", '{ "thresholds": { "warning": 70 } }');
    expect((await cli(["module"], env)).exitCode).toBe(0);
    const { payload } = await toggled(env, record);
    expect(payload.view.cards[0]?.headline).toEqual({ text: "34%", level: "warning" });
  });

  test("from ~/.config when XDG_CONFIG_HOME is not set", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const { XDG_CONFIG_HOME: _unset, ...env } = laneEnv(bin);
    writeFileUnder(env.HOME, ".config/usage-plugin/config.jsonc", TIGHT);
    expect((await cli(["module"], env)).exitCode).toBe(0);
    const { payload } = await toggled(env, record);
    expect(payload.view.cards[0]?.headline).toEqual({ text: "34%", level: "warning" });
  });
});

describe("the refresh command the widget runs while open", () => {
  test("prints the view the module last left in the cache, and fetches nothing", async () => {
    const { bin, record } = binWith({ gjs: RECORDING_GJS });
    const env = laneEnv(bin);
    expect((await cli(["module"], env)).exitCode).toBe(0);
    const { payload } = await toggled(env, record);
    const log = join(env.XDG_RUNTIME_DIR, "usage-plugin", "debug.log");
    const logged = readFileSync(log, "utf8");

    const [command, ...args] = payload.refresh;
    const proc = Bun.spawn([command ?? "", ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual(payload.view);
    expect(readFileSync(log, "utf8")).toBe(logged);
  });

  test("is widget --view", () => {
    expect(parseArgs(["widget", "--view"])).toEqual({ kind: "widgetView" });
  });
});

describe("usage-plugin widget --toggle picks GTK's renderer", () => {
  test("cairo, unless the user set one", async () => {
    const first = binWith({ gjs: RECORDING_GJS });
    expect((await toggled(laneEnv(first.bin), first.record)).renderer).toBe("cairo");
    const second = binWith({ gjs: RECORDING_GJS });
    expect((await toggled({ ...laneEnv(second.bin), GSK_RENDERER: "ngl" }, second.record)).renderer).toBe("ngl");
  });
});

describe("the widget over T3 Code", () => {
  async function viewAfterModule(fixture: string) {
    const { bin } = binWith({});
    const env = { ...laneEnv(bin), USAGE_PLUGIN_FIXTURES: fixtureCase(fixture) };
    expect((await cli(["module"], env)).exitCode).toBe(0);
    const result = await cli(["widget", "--view"], env);
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout) as WidgetPayload["view"];
  }

  test("shows every provider T3 reports, each saying where its reading came from", async () => {
    const view = await viewAfterModule("t3-ok");
    expect(view.cards.map((card) => [card.name, card.source])).toContainEqual(["Codex", "via T3 Code"]);
    expect(view.cards.every((card) => card.source === "via T3 Code")).toBe(true);
  });

  test("names T3 Code when it could not check a provider", async () => {
    const view = await viewAfterModule("t3-probe-failed");
    expect(view.cards.find((card) => card.name === "Claude")).toMatchObject({
      state: "broken",
      note: "T3 Code could not check Claude's usage",
    });
  });

  test("with T3 Code closed and nothing else signed in says to open it", async () => {
    const view = await viewAfterModule("t3-closed-no-login");
    expect(view.cards).toEqual([]);
    expect(view.empty).toBe("T3 Code isn't running. Open T3 Code, or set up a provider.");
  });
});
