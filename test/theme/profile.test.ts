import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { DebugEvent } from "../../src/cache.ts";
import { describeTheme, peekTheme, readLevelDb, t3ProfileFrom, themeCss, themeOf, widgetTheme } from "../../src/theme/profile.ts";
import type { T3Profile } from "../../src/theme/profile.ts";
import { fixtureCase, makeFifo, tempDir } from "../support.ts";
import { FIXTURE_PROFILES, profileFiles } from "./fixtures.ts";
import { log, storageKey } from "./leveldb-writer.ts";

function profileOf(name: string): T3Profile {
  return t3ProfileFrom({ USAGE_PLUGIN_T3_PROFILE: fixtureCase(name) });
}

function editableProfile(name: string): { readonly dir: string; readonly profile: T3Profile } {
  const dir = join(tempDir(), name);
  cpSync(fixtureCase(name), dir, { recursive: true });
  return { dir, profile: t3ProfileFrom({ USAGE_PLUGIN_T3_PROFILE: dir }) };
}

function runtime(): string {
  return join(tempDir(), "usage-plugin");
}

function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      const found = statSync(path);
      return `${relative(dir, path)} ${found.mtimeMs} ${found.size} ${found.mode}`;
    })
    .sort();
}

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

async function moduleText(profileDir: string, xdgRuntimeDir: string): Promise<{ readonly exitCode: number; readonly text: string }> {
  const env = {
    HOME: join(tempDir(), "no-home"),
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    USAGE_PLUGIN_FIXTURES: fixtureCase("claude-ok"),
    USAGE_PLUGIN_T3_PROFILE: profileDir,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "",
  };
  const proc = Bun.spawn([process.execPath, CLI, "module"], { env, stdout: "pipe", stderr: "ignore", timeout: 4000 });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, text: stdout === "" ? "" : JSON.parse(stdout).text };
}

describe("the fixture profiles", () => {
  test("are exactly what test/theme/fixtures.ts writes, so none can carry anything else", () => {
    for (const profile of FIXTURE_PROFILES) {
      const dir = fixtureCase(profile.name);
      const committed = readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
        .sort();
      const generated = profileFiles(profile);
      expect(committed).toEqual([...generated.keys()].sort());
      for (const [path, content] of generated) expect(readFileSync(join(dir, path))).toEqual(Buffer.from(content));
    }
  });

  test("resolve to the theme each is named for", () => {
    const cases: readonly [string, string, string, string][] = [
      ["t3-theme-grove-dark", "grove", "dark", "#1b2821"],
      ["t3-theme-ocean-dark", "ocean", "dark", "#17212b"],
      ["t3-theme-ember-light", "ember", "light", "#f9f7f5"],
      ["t3-theme-iris-dark", "iris", "dark", "#1d1929"],
      ["t3-theme-custom", "harbour-night", "dark", "#081d28"],
      ["t3-theme-custom-file", "sunset", "light", "#fff4e6"],
    ];
    for (const [name, themeId, appearance, background] of cases) {
      const theme = themeOf(runtime(), "t3", profileOf(name));
      expect(theme).toMatchObject({ kind: "t3", themeId, appearance, t3Version: "0.1.9", app: join(fixtureCase(name), "app.asar") });
      expect(theme.kind === "t3" && theme.palette.background).toBe(background as never);
    }
  });

  test("give the module colours that read on Waybar's own colours, so a light theme suits a dark bar", () => {
    const { dir, profile } = editableProfile("t3-theme-ember-light");
    mkdirSync(join(dir, "waybar"));
    writeFileSync(join(dir, "waybar", "colors.css"), "@define-color background #0b1612;\n@define-color surface_container #172a22;\n");
    const theme = themeOf(runtime(), "t3", profile);
    if (theme.kind !== "t3") throw new Error(`no T3 theme: ${describeTheme(theme)}`);
    expect<string>(theme.palette.accent).toBe("#ae552a");
    expect(theme.palette.bar.accent).not.toBe(theme.palette.accent);
    expect(theme.palette.bar.warning).toBe("#fe9a00" as never);
  });

  test("take T3's contrast and glass settings from client-settings.json", () => {
    const theme = themeOf(runtime(), "t3", profileOf("t3-theme-custom"));
    expect(theme.kind === "t3" && theme.palette.panelAlpha).toBe(0.964);
  });
});

describe("themeOf falls back to Waybar's colours and says why", () => {
  test("for a T3 version with no pinned palette, naming the version", () => {
    const theme = themeOf(runtime(), "t3", profileOf("t3-theme-unknown-version"));
    expect(theme).toEqual({ kind: "waybar", reason: "T3 Code 0.2.0 has no pinned palette" });
    expect(describeTheme(theme)).toContain("0.2.0");
  });

  test("for a corrupt database, without throwing", () => {
    const theme = themeOf(runtime(), "t3", profileOf("t3-theme-corrupt"));
    expect(theme.kind).toBe("waybar");
    expect(theme.kind === "waybar" && theme.reason).toMatch(/damaged/);
  });

  test("when T3 Code has never run, or no profile is given", () => {
    expect(themeOf(runtime(), "t3", { ...profileOf("t3-theme-grove-dark"), localStorage: join(tempDir(), "absent") }).kind).toBe("waybar");
    expect(themeOf(runtime(), "t3", null)).toEqual({ kind: "waybar", reason: "no T3 Code profile was given" });
  });

  test("when the app.asar is not an archive", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    writeFileSync(join(dir, "app.asar"), "not an archive");
    expect(themeOf(runtime(), "t3", profile).kind).toBe("waybar");
  });

  test("and with no installed app, as from an AppImage, the newest pinned palettes stand in", () => {
    const theme = themeOf(runtime(), "t3", { ...profileOf("t3-theme-grove-dark"), apps: [join(tempDir(), "no.asar")] });
    expect(theme).toMatchObject({ kind: "t3", themeId: "grove", t3Version: "0.1.9", app: null });
    expect(describeTheme(theme)).toContain("no installed app found");
  });
});

describe("theme waybar and none", () => {
  test("read nothing and write nothing", () => {
    const dir = runtime();
    expect(themeOf(dir, "waybar", profileOf("t3-theme-grove-dark"))).toEqual({ kind: "waybar", reason: "the config sets theme to waybar" });
    expect(themeOf(dir, "none", profileOf("t3-theme-grove-dark"))).toEqual({ kind: "none" });
    expect(statSync(dir, { throwIfNoEntry: false })).toBeUndefined();
    expect(widgetTheme(dir, "none", profileOf("t3-theme-grove-dark"))).toEqual({ mode: "none", css: null });
    expect(widgetTheme(dir, "waybar", profileOf("t3-theme-grove-dark"))).toEqual({ mode: "waybar", css: null });
  });
});

describe("the theme cache", () => {
  test("an unchanged profile is answered from the cache, without reading T3's database", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    const cache = runtime();
    const first = themeOf(cache, "t3", profile);
    for (const name of readdirSync(join(dir, "leveldb"))) chmodSync(join(dir, "leveldb", name), 0);
    try {
      expect(themeOf(cache, "t3", profile)).toEqual(first);
    } finally {
      for (const name of readdirSync(join(dir, "leveldb"))) chmodSync(join(dir, "leveldb", name), 0o600);
    }
    expect(readdirSync(cache).sort()).toEqual(["theme.css", "theme.json"]);
  });

  test("a new write to T3's log is picked up on the next read", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    const cache = runtime();
    expect(themeOf(cache, "t3", profile)).toMatchObject({ themeId: "grove" });
    const switched = log([
      { sequence: 5, puts: [{ key: storageKey("t3code:theme-appearance-mode"), value: "dark" }] },
      { sequence: 9, puts: [{ key: storageKey("t3code:theme-halves:v1"), value: '{"light":"grove","dark":"iris"}' }] },
    ]);
    writeFileSync(join(dir, "leveldb", "000007.log"), switched);
    expect(themeOf(cache, "t3", profile)).toMatchObject({ themeId: "iris", appearance: "dark" });
  });

  test("a changed theme file is picked up even when its size stays the same", () => {
    const { dir, profile } = editableProfile("t3-theme-custom-file");
    const cache = runtime();
    const file = join(dir, "userdata", "themes", "sunset.json");
    expect(themeOf(cache, "t3", profile)).toMatchObject({ palette: { accent: "#c2410c" } });
    writeFileSync(file, readFileSync(file, "utf8").replace("#c2410c", "#0f766e"));
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(themeOf(cache, "t3", profile)).toMatchObject({ palette: { accent: "#0f766e" } });
  });

  test("a damaged cache file is read again from the profile", () => {
    const cache = runtime();
    themeOf(cache, "t3", profileOf("t3-theme-ocean-dark"));
    writeFileSync(join(cache, "theme.json"), '{"key":1');
    expect(themeOf(cache, "t3", profileOf("t3-theme-ocean-dark"))).toMatchObject({ themeId: "ocean" });
  });

  test("creates, changes and removes nothing under T3's profile", () => {
    const { dir, profile } = editableProfile("t3-theme-iris-dark");
    const before = snapshot(dir);
    themeOf(runtime(), "t3", profile);
    widgetTheme(runtime(), "t3", profile);
    peekTheme(join(tempDir(), "absent"), "t3", profile);
    expect(snapshot(dir)).toEqual(before);
  });

  test("a table torn mid-write keeps the last theme read, and says why", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    const cache = runtime();
    const events: DebugEvent[] = [];
    const first = themeOf(cache, "t3", profile, (event) => events.push(event));
    const table = join(dir, "leveldb", "000005.ldb");
    writeFileSync(table, readFileSync(table).subarray(0, 40));
    expect(themeOf(cache, "t3", profile, (event) => events.push(event))).toEqual(first);
    expect(events.at(-1)).toEqual({
      event: "theme",
      theme: `${describeTheme(first)}, kept because T3 Code's settings are damaged: 000005.ldb is not a LevelDB table`,
    });
  });
});

describe("reading T3's files", () => {
  test("a FIFO among the theme files, in the theme cache or among the settings never hangs the module", async () => {
    const themes = editableProfile("t3-theme-grove-dark");
    mkdirSync(join(themes.dir, "userdata", "themes"), { recursive: true });
    makeFifo(join(themes.dir, "userdata", "themes", "stuck.json"));
    expect(await moduleText(themes.dir, tempDir())).toMatchObject({ exitCode: 0, text: expect.stringContaining("#69d69a") });

    const xdgRuntimeDir = tempDir();
    mkdirSync(join(xdgRuntimeDir, "usage-plugin"), { mode: 0o700 });
    for (const name of ["theme.json", "theme.css"]) makeFifo(join(xdgRuntimeDir, "usage-plugin", name));
    expect(await moduleText(fixtureCase("t3-theme-grove-dark"), xdgRuntimeDir)).toMatchObject({ exitCode: 0, text: expect.stringContaining("#69d69a") });

    const settings = editableProfile("t3-theme-grove-dark");
    makeFifo(join(settings.dir, "leveldb", "000009.log"));
    expect(await moduleText(settings.dir, tempDir())).toMatchObject({ exitCode: 0, text: expect.not.stringContaining("foreground") });
  }, 15_000);

  test("a settings file over 8 MB is not read, and the theme falls back with the reason", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    writeFileSync(join(dir, "leveldb", "000009.ldb"), "");
    truncateSync(join(dir, "leveldb", "000009.ldb"), 9 * 1024 * 1024);
    expect(themeOf(runtime(), "t3", profile)).toEqual({ kind: "waybar", reason: "T3 Code's settings cannot be read: 000009.ldb is larger than 8 MB" });
  });

  test("a settings file that T3 removes between the listing and the read gives a reason, not a crash", () => {
    const { dir } = editableProfile("t3-theme-grove-dark");
    const leveldb = join(dir, "leveldb");
    const listed = readdirSync(leveldb);
    rmSync(join(leveldb, "000005.ldb"));
    expect(readLevelDb(leveldb, listed)).toEqual({ kind: "unreadable", reason: "000005.ldb was removed while it was read" });
  });

  test("module --debug reads T3 without a writable TMPDIR, because it copies nothing", () => {
    const readOnly = tempDir();
    const absent = join(tempDir(), "absent");
    chmodSync(readOnly, 0o500);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = readOnly;
    try {
      expect(peekTheme(absent, "t3", profileOf("t3-theme-ocean-dark"))).toMatchObject({ kind: "t3", themeId: "ocean" });
    } finally {
      process.env.TMPDIR = saved;
      chmodSync(readOnly, 0o700);
    }
    expect(readdirSync(readOnly)).toEqual([]);
  });
});

describe("peekTheme, for module --debug", () => {
  test("gives themeOf's answer and writes nothing, whether or not the runtime directory exists", () => {
    const absent = runtime();
    expect(peekTheme(absent, "t3", profileOf("t3-theme-ocean-dark"))).toMatchObject({ kind: "t3", themeId: "ocean" });
    expect(statSync(absent, { throwIfNoEntry: false })).toBeUndefined();

    const kept = runtime();
    const theme = themeOf(kept, "t3", profileOf("t3-theme-ocean-dark"));
    const before = snapshot(kept);
    expect(peekTheme(kept, "t3", profileOf("t3-theme-ocean-dark"))).toEqual(theme);
    expect(peekTheme(kept, "t3", profileOf("t3-theme-ember-light"))).toMatchObject({ themeId: "ember" });
    expect(snapshot(kept)).toEqual(before);
  });
});

describe("theme.css", () => {
  test("carries the palette as the widget's variables and panel, and the widget is pointed at it", () => {
    const cache = runtime();
    const theme = widgetTheme(cache, "t3", profileOf("t3-theme-grove-dark"));
    expect(theme).toEqual({ mode: "t3", css: join(cache, "theme.css") });
    const css = readFileSync(join(cache, "theme.css"), "utf8");
    expect(css).toContain("--usage-background: #1b2821;");
    expect(css).toContain("--usage-accent: #69d69a;");
    expect(css).toContain("--usage-ok: #69d69a;");
    expect(css).toContain(".panel { background: alpha(#1b2821, 0.976); }");
  });

  test("turns into Waybar's colours when the theme can no longer be read, so an open widget follows", () => {
    const { dir, profile } = editableProfile("t3-theme-grove-dark");
    const cache = runtime();
    themeOf(cache, "t3", profile);
    writeFileSync(join(dir, "app.asar"), "gone bad");
    themeOf(cache, "t3", profile);
    expect(readFileSync(join(cache, "theme.css"), "utf8")).toBe(themeCss({ kind: "waybar", reason: "" }));
    expect(readFileSync(join(cache, "theme.css"), "utf8")).not.toContain("--usage");
  });

  test("is not rewritten when the theme is the same, so a watching widget does not reload", () => {
    const cache = runtime();
    themeOf(cache, "t3", profileOf("t3-theme-ember-light"));
    const written = statSync(join(cache, "theme.css")).mtimeMs;
    Bun.sleepSync(5);
    writeFileSync(join(cache, "theme.json"), "{}");
    themeOf(cache, "t3", profileOf("t3-theme-ember-light"));
    expect(statSync(join(cache, "theme.css")).mtimeMs).toBe(written);
  });
});

describe("t3ProfileFrom", () => {
  test("finds T3's settings under XDG_CONFIG_HOME and its userdata under HOME", () => {
    expect(t3ProfileFrom({ HOME: "/home/u", XDG_CONFIG_HOME: "/cfg" })).toMatchObject({
      localStorage: "/cfg/t3code-v2/Local Storage/leveldb",
      userdata: "/home/u/.t3/userdata",
      dconf: "/cfg/dconf/user",
    });
    expect(t3ProfileFrom({ HOME: "/home/u" }).localStorage).toBe("/home/u/.config/t3code-v2/Local Storage/leveldb");
  });

  test("USAGE_PLUGIN_T3_PROFILE points every path into one directory and never asks the desktop", () => {
    expect(t3ProfileFrom({ HOME: "/home/u", USAGE_PLUGIN_T3_PROFILE: "/p" })).toEqual({
      localStorage: "/p/leveldb",
      userdata: "/p/userdata",
      apps: ["/p/app.asar"],
      dconf: null,
      bar: "/p/waybar/colors.css",
    });
  });
});
