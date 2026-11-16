import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Launch } from "../../widget/controls.ts";
import type { WidgetPayload } from "../../widget/view.ts";
import { fixtureCase, tempDir, until, writeFileUnder } from "../support.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

function recordingGjs(): { readonly bin: string; readonly record: string } {
  const bin = tempDir();
  const record = tempDir();
  writeFileSync(join(bin, "gjs"), `#!/bin/sh\nprintf '%s' "$USAGE_PLUGIN_WIDGET" > '${record}/payload'\n: > '${record}/done'\n`);
  chmodSync(join(bin, "gjs"), 0o755);
  return { bin, record };
}

async function toggle(profile: string, config = "{}"): Promise<{ readonly payload: WidgetPayload; readonly runtimeDir: string }> {
  const { bin, record } = recordingGjs();
  const configHome = tempDir();
  writeFileUnder(configHome, "usage-plugin/config.jsonc", config);
  const runtimeDir = tempDir();
  const env = {
    HOME: join(tempDir(), "no-home"),
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configHome,
    USAGE_PLUGIN_FIXTURES: fixtureCase("claude-ok"),
    USAGE_PLUGIN_T3_PROFILE: fixtureCase(profile),
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
    PATH: bin,
  };
  const proc = Bun.spawn([process.execPath, CLI, "widget", "--toggle"], { env, stdout: "ignore", stderr: "ignore", timeout: 3000 });
  expect(await proc.exited).toBe(0);
  await until(() => existsSync(join(record, "done")), "the stand-in gjs ran");
  const launch: Launch = JSON.parse(readFileSync(join(record, "payload"), "utf8"));
  if (launch.start !== "toggle") throw new Error(`--toggle launched the widget with start ${launch.start}`);
  return { payload: launch.payload, runtimeDir: join(runtimeDir, "usage-plugin") };
}

describe("widget --toggle under theme t3", () => {
  test("writes theme.css before the widget starts and points the widget at it", async () => {
    const { payload, runtimeDir } = await toggle("t3-theme-ocean-dark");
    expect(payload.theme).toEqual({ mode: "t3", css: join(runtimeDir, "theme.css") });
    const css = readFileSync(join(runtimeDir, "theme.css"), "utf8");
    expect(css).toContain("--usage-background: #17212b;");
    expect(css).toContain("--usage-accent: #70b9ee;");
  });

  test("still points the widget at theme.css when T3 cannot be read, so it picks the theme up once it can", async () => {
    const { payload, runtimeDir } = await toggle("t3-theme-corrupt");
    expect(payload.theme.css).toBe(join(runtimeDir, "theme.css"));
    expect(readFileSync(join(runtimeDir, "theme.css"), "utf8")).not.toContain("--usage");
  });
});

describe("widget --toggle under theme waybar and none", () => {
  test("hands the widget no theme file, and none also tells it to skip Waybar's colors.css", async () => {
    expect((await toggle("t3-theme-ocean-dark", '{ "theme": "waybar" }')).payload.theme).toEqual({ mode: "waybar", css: null });
    expect((await toggle("t3-theme-ocean-dark", '{ "theme": "none" }')).payload.theme).toEqual({ mode: "none", css: null });
  });
});

describe("widget --toggle with barColors false", () => {
  test("keeps the widget's theme, since the setting is for the bar alone", async () => {
    const { payload, runtimeDir } = await toggle("t3-theme-ocean-dark", '{ "barColors": false }');
    expect(payload.theme).toEqual({ mode: "t3", css: join(runtimeDir, "theme.css") });
  });
});
