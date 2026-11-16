/**
 * Reads the user's T3 Code theme off disk and keeps the answer in the runtime directory:
 *
 *   theme.json  the resolved theme and the stat key of every file it came from
 *   theme.css   the widget's colours, which an open widget watches
 *
 * T3's LevelDB files are read where they are, each held open only while it is read. LevelDB's
 * lock is a file of its own, so it is never taken, and nothing of T3's is ever written. An
 * unchanged profile costs a directory listing and a stat per file.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import v0_1_9 from "../../assets/t3-themes/0.1.9.json";
import { isPrivateDirectory } from "../cache.ts";
import type { DebugEvent } from "../cache.ts";
import { isHexColor } from "../config.ts";
import { isRecord } from "../domain.ts";
import { NotAnAsar, asarVersion, openAsar } from "./asar.ts";
import { oklchToRgb, parseCssColor } from "./color.ts";
import type { Rgb } from "./color.ts";
import { Damaged, readLocalStorage } from "./leveldb.ts";
import type { LevelFile } from "./leveldb.ts";
import { isAppearance, parsePinned } from "./palettes.ts";
import type { PinnedPalettes } from "./palettes.ts";
import { resolveT3, STORAGE_KEYS } from "./t3.ts";
import type { Palette, ResolvedTheme, ThemeMode } from "./t3.ts";

const PINNED: readonly PinnedPalettes[] = [v0_1_9].map(parsePinned);

/** Where the files are that decide the colours: T3 Code's, the desktop's and Waybar's. */
export interface T3Profile {
  /** Chromium's localStorage LevelDB directory. */
  readonly localStorage: string;
  /** T3's userdata directory, which holds `themes/` and `client-settings.json`. */
  readonly userdata: string;
  /** Where an installed `app.asar` may be, first found wins. */
  readonly apps: readonly string[];
  /** The dconf database the desktop's colour scheme lives in. Null never asks the desktop, so `system` means light. */
  readonly dconf: string | null;
  /** Waybar's colors.css, whose `background` and `surface_container` the module is drawn on. */
  readonly bar: string;
}

const PROFILE_ENV = "USAGE_PLUGIN_T3_PROFILE";

const INSTALLED_APPS = ["/opt/t3code-bin/resources/app.asar", "/opt/T3 Code/resources/app.asar", "/usr/lib/t3code/resources/app.asar"];

/** `USAGE_PLUGIN_T3_PROFILE=<dir>` points every path into `<dir>`: `leveldb/`, `userdata/`, `app.asar` and `waybar/colors.css`. */
export function t3ProfileFrom(env: Readonly<Record<string, string | undefined>>): T3Profile {
  const override = env[PROFILE_ENV];
  if (override) {
    return {
      localStorage: join(override, "leveldb"),
      userdata: join(override, "userdata"),
      apps: [join(override, "app.asar")],
      dconf: null,
      bar: join(override, "waybar", "colors.css"),
    };
  }
  const home = env.HOME || homedir();
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  return {
    localStorage: join(configHome, "t3code-v2", "Local Storage", "leveldb"),
    userdata: join(home, ".t3", "userdata"),
    apps: INSTALLED_APPS,
    dconf: join(configHome, "dconf", "user"),
    bar: join(configHome, "waybar", "colors.css"),
  };
}

type Log = (event: DebugEvent) => void;

/**
 * Never throws: a theme that cannot be read is the user's Waybar colours, with the reason. Keeps
 * the answer in the runtime directory, and logs each answer it reads afresh.
 */
export function themeOf(runtimeDir: string, mode: ThemeMode, profile: T3Profile | null, log: Log = () => {}): ResolvedTheme {
  return settled(mode, profile, (found) => cachedTheme(privateDir(runtimeDir), found, log));
}

/** `themeOf` for `module --debug`, which writes nothing to the runtime directory: it reads a kept answer, or reads T3 afresh. */
export function peekTheme(runtimeDir: string, mode: ThemeMode, profile: T3Profile | null): ResolvedTheme {
  return settled(mode, profile, (t3) => {
    const found = lstatSync(runtimeDir, { throwIfNoEntry: false });
    const dir = found !== undefined && isPrivateDirectory(found, process.getuid?.()) ? runtimeDir : null;
    return cachedTheme(dir, t3, null);
  });
}

function settled(mode: ThemeMode, profile: T3Profile | null, read: (profile: T3Profile) => ResolvedTheme): ResolvedTheme {
  if (mode === "none") return { kind: "none" };
  if (mode === "waybar") return { kind: "waybar", reason: "the config sets theme to waybar" };
  if (profile === null) return { kind: "waybar", reason: "no T3 Code profile was given" };
  try {
    return read(profile);
  } catch (error) {
    return { kind: "waybar", reason: `the T3 Code theme could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What `widget --toggle` hands the widget: which colours to load, and the theme.css to watch when it follows T3. */
export interface WidgetTheme {
  readonly mode: ThemeMode;
  readonly css: string | null;
}

/** Never throws: without a private runtime directory the widget opens in Waybar's colours. */
export function widgetTheme(runtimeDir: string, mode: ThemeMode, profile: T3Profile | null, log: Log = () => {}): WidgetTheme {
  if (mode !== "t3") return { mode, css: null };
  const theme = themeOf(runtimeDir, mode, profile, log);
  try {
    const dir = privateDir(runtimeDir);
    if (dir === null) return { mode, css: null };
    writeThemeCss(dir, theme);
    return { mode, css: join(dir, CSS_FILE) };
  } catch {
    return { mode, css: null };
  }
}

/** One line for `module --debug`. */
export function describeTheme(theme: ResolvedTheme): string {
  switch (theme.kind) {
    case "t3": {
      const app = theme.app === null ? "no installed app found, so the newest pinned palettes" : theme.app;
      return `T3 Code ${theme.themeId} ${theme.appearance}, palettes of ${theme.t3Version} (${app})`;
    }
    case "waybar":
      return `Waybar colours, because ${theme.reason}`;
    case "none":
      return "none, the config sets theme to none";
  }
}

const CACHE_FILE = "theme.json";
const CSS_FILE = "theme.css";
const CACHE_FORMAT = 2;

function privateDir(path: string): string | null {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return isPrivateDirectory(lstatSync(path), process.getuid?.()) ? path : null;
}

/** `log` null only peeks: it writes nothing to the runtime directory and logs nothing. */
function cachedTheme(dir: string | null, profile: T3Profile, log: Log | null): ResolvedTheme {
  const keep = log !== null && dir !== null ? dir : null;
  const sources = statSources(profile);
  if (sources.kind === "missing") {
    const theme: ResolvedTheme = { kind: "waybar", reason: `T3 Code's settings are not at ${profile.localStorage}` };
    if (keep !== null) writeThemeCss(keep, theme);
    return theme;
  }
  const cached = dir === null ? null : readCached(dir);
  if (cached !== null && cached.key === sources.key) return cached.theme;
  const { theme, note } = coldTheme(profile, sources, cached?.theme ?? null);
  log?.({ event: "theme", theme: note });
  if (keep !== null) {
    writeAtomically(keep, CACHE_FILE, JSON.stringify({ key: sources.key, theme }));
    writeThemeCss(keep, theme);
  }
  return theme;
}

type Sources =
  | { readonly kind: "missing" }
  | { readonly kind: "found"; readonly key: string; readonly app: string | null; readonly levelFiles: readonly string[] };

/**
 * Every input's name, mtime and size. The key is taken before the read, so a file that a
 * compaction removes mid-read leaves a key that the next poll no longer matches.
 */
function statSources(profile: T3Profile): Sources {
  const entries = (dir: string): string[] | null => {
    try {
      return readdirSync(dir).sort();
    } catch {
      return null;
    }
  };
  const stamp = (path: string): string => {
    const found = statSync(path, { throwIfNoEntry: false });
    return found === undefined ? `${path}:-` : `${path}:${found.mtimeMs}:${found.size}`;
  };
  const levelFiles = entries(profile.localStorage);
  if (levelFiles === null) return { kind: "missing" };
  const themesDir = join(profile.userdata, "themes");
  const app = profile.apps.find((path) => statSync(path, { throwIfNoEntry: false })?.isFile()) ?? null;
  const key = [
    `format:${CACHE_FORMAT}`,
    `pinned:${PINNED.map((palettes) => palettes.version).join(",")}`,
    ...levelFiles.map((name) => stamp(join(profile.localStorage, name))),
    ...(entries(themesDir) ?? []).map((name) => stamp(join(themesDir, name))),
    stamp(join(profile.userdata, "client-settings.json")),
    app === null ? "app:-" : stamp(app),
    ...(profile.dconf === null ? [] : [stamp(profile.dconf)]),
    stamp(profile.bar),
  ].join("\n");
  return { kind: "found", key, app, levelFiles };
}

/**
 * Settings that cannot be read, as when T3 is in the middle of a compaction, keep the last theme
 * read. `note` says what was read, and why a theme was kept.
 */
function coldTheme(
  profile: T3Profile,
  { app, levelFiles }: Extract<Sources, { kind: "found" }>,
  last: ResolvedTheme | null,
): { readonly theme: ResolvedTheme; readonly note: string } {
  const answer = (theme: ResolvedTheme) => ({ theme, note: describeTheme(theme) });
  const pinned = palettesFor(app);
  if (pinned.kind === "unknown") return answer({ kind: "waybar", reason: pinned.reason });
  const settings = settingsIn(profile.localStorage, levelFiles);
  if (settings.kind === "unreadable") {
    if (last?.kind === "t3") return { theme: last, note: `${describeTheme(last)}, kept because ${settings.reason}` };
    return answer({ kind: "waybar", reason: settings.reason });
  }
  const { themeId, appearance, palette } = resolveT3(
    { storage: settings.storage, themeFiles: themeFiles(join(profile.userdata, "themes")), clientSettings: readJson(join(profile.userdata, "client-settings.json")) },
    pinned.palettes,
    () => profile.dconf !== null && desktopPrefersDark(),
    barColors(profile.bar),
  );
  return answer({ kind: "t3", themeId, appearance, t3Version: pinned.palettes.version, app, palette });
}

type Settings = { readonly kind: "read"; readonly storage: ReadonlyMap<string, string> } | { readonly kind: "unreadable"; readonly reason: string };

function settingsIn(dir: string, listed: readonly string[]): Settings {
  const read = readLevelDb(dir, listed);
  if (read.kind === "unreadable") return { kind: "unreadable", reason: `T3 Code's settings cannot be read: ${read.reason}` };
  try {
    return { kind: "read", storage: readLocalStorage(read.files, "t3code://app", Object.values(STORAGE_KEYS)) };
  } catch (error) {
    if (error instanceof Damaged) return { kind: "unreadable", reason: `T3 Code's settings are damaged: ${error.message}` };
    throw error;
  }
}

type PalettesFor = { readonly kind: "pinned"; readonly palettes: PinnedPalettes } | { readonly kind: "unknown"; readonly reason: string };

function palettesFor(app: string | null): PalettesFor {
  const newest = PINNED.at(-1) as PinnedPalettes;
  if (app === null) return { kind: "pinned", palettes: newest };
  let version: string | null;
  try {
    version = asarVersion(openAsar(app));
  } catch (error) {
    if (error instanceof NotAnAsar || error instanceof SyntaxError) return { kind: "unknown", reason: `${app} cannot be read: ${error.message}` };
    throw error;
  }
  const palettes = PINNED.find((candidate) => candidate.version === version);
  if (palettes !== undefined) return { kind: "pinned", palettes };
  return { kind: "unknown", reason: `T3 Code ${version ?? "of an unknown version"} has no pinned palette` };
}

const LEVELDB_FILE = /^\d+\.(?:ldb|log)$/;
const MAX_LEVELDB_FILE_BYTES = 8 * 1024 * 1024;

export type LevelDbRead = { readonly kind: "read"; readonly files: readonly LevelFile[] } | { readonly kind: "unreadable"; readonly reason: string };

/** The tables and logs among `listed`, the directory's names. Chromium's tables stay near 2 MB. */
export function readLevelDb(dir: string, listed: readonly string[]): LevelDbRead {
  const files: LevelFile[] = [];
  for (const name of listed.filter((each) => LEVELDB_FILE.test(each))) {
    const file = readRegularFile(join(dir, name), MAX_LEVELDB_FILE_BYTES);
    switch (file.kind) {
      case "read":
        files.push({ name, bytes: file.bytes });
        break;
      case "missing":
        return { kind: "unreadable", reason: `${name} was removed while it was read` };
      case "notAFile":
        return { kind: "unreadable", reason: `${name} is not a regular file` };
      case "tooLarge":
        return { kind: "unreadable", reason: `${name} is larger than ${MAX_LEVELDB_FILE_BYTES / 1024 / 1024} MB` };
    }
  }
  return { kind: "read", files };
}

const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;

type FileRead = { readonly kind: "read"; readonly bytes: Buffer } | { readonly kind: "missing" | "notAFile" | "tooLarge" };

/**
 * Holds the file open only while it reads it. `O_NONBLOCK`, because a FIFO at that name would
 * block the open until its other end opens. A symlink is followed only when `links` says so.
 */
function readRegularFile(path: string, maxBytes: number, links: "refuse" | "follow" = "refuse"): FileRead {
  let fd: number;
  try {
    fd = openSync(path, O_RDONLY | O_NONBLOCK | (links === "refuse" ? O_NOFOLLOW : 0));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code === "ENOENT") return { kind: "missing" };
    if (code === "ELOOP" || code === "ENXIO") return { kind: "notAFile" };
    throw error;
  }
  try {
    const found = fstatSync(fd);
    if (!found.isFile()) return { kind: "notAFile" };
    if (found.size > maxBytes) return { kind: "tooLarge" };
    return { kind: "read", bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function themeFiles(dir: string): ReadonlyMap<string, unknown> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return new Map();
  }
  return new Map(names.flatMap((name) => {
    const theme = readJson(join(dir, name));
    return theme === null ? [] : [[name.slice(0, -".json".length), theme] as const];
  }));
}

const MAX_JSON_BYTES = 256 * 1024;

const BAR_COLOR = /@define-color\s+(?:background|surface_container)\s+([^;]+);/g;

/** The names the widget also reads. Followed through a link, because colour generators such as pywal link this file. */
function barColors(path: string): Rgb[] {
  try {
    const file = readRegularFile(path, MAX_JSON_BYTES, "follow");
    if (file.kind !== "read") return [];
    return [...file.bytes.toString("utf8").matchAll(BAR_COLOR)].flatMap(([, value = ""]) => {
      const parsed = parseCssColor(value);
      return parsed === null ? [] : [oklchToRgb(parsed.color)];
    });
  } catch {
    return [];
  }
}

function readJson(path: string): unknown {
  try {
    const file = readRegularFile(path, MAX_JSON_BYTES);
    return file.kind === "read" ? JSON.parse(file.bytes.toString("utf8")) : null;
  } catch {
    return null;
  }
}

const GSETTINGS_TIMEOUT_MS = 300;

/** T3 follows Electron, which on Linux follows this setting. Unknown means light, T3's own default. */
function desktopPrefersDark(): boolean {
  try {
    const result = Bun.spawnSync(["gsettings", "get", "org.gnome.desktop.interface", "color-scheme"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: GSETTINGS_TIMEOUT_MS,
    });
    return result.exitCode === 0 && result.stdout.toString().trim() === "'prefer-dark'";
  } catch {
    return false;
  }
}

function readCached(dir: string): { readonly key: string; readonly theme: ResolvedTheme } | null {
  const stored = readJson(join(dir, CACHE_FILE));
  if (!isRecord(stored) || typeof stored.key !== "string") return null;
  const theme = decodeTheme(stored.theme);
  return theme === null ? null : { key: stored.key, theme };
}

function decodeTheme(stored: unknown): ResolvedTheme | null {
  if (!isRecord(stored)) return null;
  if (stored.kind === "waybar" && typeof stored.reason === "string") return { kind: "waybar", reason: stored.reason };
  if (stored.kind !== "t3") return null;
  const { themeId, appearance, t3Version, app, palette } = stored;
  if (typeof themeId !== "string" || !isAppearance(appearance) || typeof t3Version !== "string") return null;
  if (!(app === null || typeof app === "string") || !isRecord(palette)) return null;
  const { panelAlpha, bar, ...colors } = palette;
  if (typeof panelAlpha !== "number" || !(panelAlpha >= 0 && panelAlpha <= 1)) return null;
  const hexes = (record: unknown, roles: readonly string[]) =>
    isRecord(record) && Object.keys(record).length === roles.length && roles.every((role) => isHexColor(record[role]));
  const levels = ["accent", "warning", "critical"];
  if (!hexes(colors, ["background", "card", "text", "muted", ...levels]) || !hexes(bar, levels)) return null;
  return { kind: "t3", themeId, appearance, t3Version, app, palette: palette as unknown as Palette };
}

/** Every value is a checked hex colour or a number, so nothing from T3's files reaches the CSS as text. */
export function themeCss(theme: ResolvedTheme): string {
  if (theme.kind !== "t3") return "/* usage-plugin: no T3 Code theme, so Waybar's colours apply */\n";
  const { palette } = theme;
  return [
    `/* usage-plugin: T3 Code ${theme.themeId.replace(/[^a-z0-9-]/g, "")} ${theme.appearance} */`,
    "window.usage-plugin {",
    `  --usage-background: ${palette.background};`,
    `  --usage-card: ${palette.card};`,
    `  --usage-text: ${palette.text};`,
    `  --usage-muted: ${palette.muted};`,
    `  --usage-accent: ${palette.accent};`,
    `  --usage-ok: ${palette.accent};`,
    `  --usage-warning: ${palette.warning};`,
    `  --usage-critical: ${palette.critical};`,
    "}",
    `.panel { background: alpha(${palette.background}, ${palette.panelAlpha}); }`,
    "",
  ].join("\n");
}

function writeThemeCss(dir: string, theme: ResolvedTheme): void {
  const css = themeCss(theme);
  let current: string | null = null;
  try {
    const file = readRegularFile(join(dir, CSS_FILE), MAX_JSON_BYTES);
    if (file.kind === "read") current = file.bytes.toString("utf8");
  } catch {}
  if (current !== css) writeAtomically(dir, CSS_FILE, css);
}

/** `wx`, so a file or link already at the temporary name is never written through. */
function writeAtomically(dir: string, name: string, text: string): void {
  const temp = join(dir, `${name}.${process.pid}.tmp`);
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  renameSync(temp, join(dir, name));
}
