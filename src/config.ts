import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { DEFAULT_POLICY } from "./cache.ts";
import type { Policy } from "./cache.ts";
import { DEFAULT_THRESHOLDS, isPercent } from "./domain.ts";
import type { Percent, Thresholds } from "./domain.ts";
import { logos } from "./providers/index.ts";
import { isThemeMode, THEME_MODES } from "./theme/t3.ts";
import type { ThemeMode } from "./theme/t3.ts";

/** `#RGB` or `#RRGGBB`. Pango rejects a whole label over a colour it cannot parse, such as a name it does not know. */
export type HexColor = string & { readonly __brand: "HexColor" };

export function isHexColor(value: unknown): value is HexColor {
  return typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

export type SourceSetting = "auto" | "t3" | "direct";

const SOURCES: readonly SourceSetting[] = ["auto", "t3", "direct"];

export interface Settings {
  readonly disabled: ReadonlySet<string>;
  /** By provider id. Paints that provider's logo and nothing else. */
  readonly colors: ReadonlyMap<string, HexColor>;
  readonly thresholds: Thresholds;
  readonly pollIntervalSeconds: number;
  readonly notifications: boolean;
  readonly source: SourceSetting;
  readonly theme: ThemeMode;
  /** False leaves every logo and percent in the bar in the bar's own CSS colour. The widget keeps its colours. */
  readonly barColors: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  disabled: new Set(),
  colors: new Map(),
  thresholds: DEFAULT_THRESHOLDS,
  pollIntervalSeconds: DEFAULT_POLICY.pollIntervalSeconds,
  notifications: true,
  source: "auto",
  theme: "t3",
  barColors: true,
};

/** Claude answers 429 after about eight calls in four minutes. */
const MIN_POLL_SECONDS = 60;
const MAX_POLL_SECONDS = 3600;

export interface ConfigProblem {
  /** From 1. Null when the file could not be read at all. */
  readonly line: number | null;
  /** Plain text. It says what is used instead. */
  readonly message: string;
}

export interface Config {
  readonly path: string;
  readonly settings: Settings;
  readonly problems: readonly ConfigProblem[];
}

export function loadConfig(path: string): Config {
  const file = readConfigFile(path);
  if (file.kind === "text") return { path, ...parseConfig(file.text, logos.map((logo) => logo.id)) };
  const problems = file.kind === "absent" ? [] : [{ line: null, message: `${file.why}. Using the defaults.` }];
  return { path, settings: DEFAULT_SETTINGS, problems };
}

const MAX_CONFIG_BYTES = 64 * 1024;

type ConfigFile =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "absent" }
  | { readonly kind: "unusable"; readonly why: string };

/** `O_NONBLOCK`, because opening a FIFO at that name would block until its other end opens. */
function readConfigFile(path: string): ConfigFile {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unusable", why: `the file cannot be read (${code})` };
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return { kind: "unusable", why: "the file is not a regular file" };
    if (stats.size > MAX_CONFIG_BYTES) return { kind: "unusable", why: `the file is larger than ${MAX_CONFIG_BYTES / 1024} KiB` };
    return { kind: "text", text: readFileSync(fd, "utf8") };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "unknown error";
    return { kind: "unusable", why: `the file cannot be read (${code})` };
  } finally {
    closeSync(fd);
  }
}

export function policyOf(settings: Settings): Policy {
  return {
    pollIntervalSeconds: settings.pollIntervalSeconds,
    alertAt: settings.notifications ? settings.thresholds.critical : null,
  };
}

export function parseConfig(text: string, logoIds: readonly string[]): Pick<Config, "settings" | "problems"> {
  const problems: ConfigProblem[] = [];
  const complain: Complain = (at, message) => problems.push({ line: at.line, message });

  let root: Located;
  try {
    root = readJsonc(text);
  } catch (error) {
    if (!(error instanceof JsoncError)) throw error;
    return { settings: DEFAULT_SETTINGS, problems: [{ line: error.line, message: `${error.message}. The whole file is ignored.` }] };
  }
  if (!(root.value instanceof Map)) {
    complain(root, "the settings must be one object in braces. The whole file is ignored.");
    return { settings: DEFAULT_SETTINGS, problems };
  }

  let { disabled, colors, thresholds, pollIntervalSeconds, notifications, source, theme, barColors } = DEFAULT_SETTINGS;
  const isKnown = (name: string, id: string, at: Located): boolean => {
    if (logoIds.includes(id)) return true;
    complain(at, `${name}.${id} names no provider. The providers are ${logoIds.join(", ")}.`);
    return false;
  };

  for (const [key, member] of root.value) {
    switch (key) {
      case "providers":
        disabled = new Set(
          membersOf(member, key, complain).flatMap(([id, on]) => {
            if (!isKnown(key, id, on)) return [];
            if (typeof on.value === "boolean") return on.value ? [] : [id];
            complain(on, `providers.${id} must be true or false. It stays on.`);
            return [];
          }),
        );
        break;
      case "colors":
        colors = new Map(
          membersOf(member, key, complain).flatMap(([id, color]): [string, HexColor][] => {
            if (!isKnown(key, id, color)) return [];
            if (isHexColor(color.value)) return [[id, color.value]];
            complain(color, `colors.${id} must be a colour such as "#D97757". The logo keeps the bar's colour.`);
            return [];
          }),
        );
        break;
      case "thresholds":
        thresholds = readThresholds(member, complain);
        break;
      case "pollIntervalSeconds":
        if (isPollInterval(member.value)) pollIntervalSeconds = member.value;
        else {
          complain(
            member,
            `pollIntervalSeconds must be a whole number from ${MIN_POLL_SECONDS} to ${MAX_POLL_SECONDS}. Using ${pollIntervalSeconds}.`,
          );
        }
        break;
      case "notifications":
        if (typeof member.value === "boolean") notifications = member.value;
        else complain(member, `notifications must be true or false. Using ${notifications}.`);
        break;
      case "source": {
        const named = SOURCES.find((candidate) => candidate === member.value);
        if (named === undefined) complain(member, `source must be "auto", "t3" or "direct". Using "${source}".`);
        else source = named;
        break;
      }
      case "theme":
        if (isThemeMode(member.value)) theme = member.value;
        else complain(member, `theme must be one of ${THEME_MODES.join(", ")}. Using ${theme}.`);
        break;
      case "barColors":
        if (typeof member.value === "boolean") barColors = member.value;
        else complain(member, `barColors must be true or false. Using ${barColors}.`);
        break;
      default:
        complain(
          member,
          `"${key}" is not a setting. The settings are providers, colors, thresholds, pollIntervalSeconds, notifications, source, theme and barColors.`,
        );
    }
  }
  return { settings: { disabled, colors, thresholds, pollIntervalSeconds, notifications, source, theme, barColors }, problems };
}

type Complain = (at: Located, message: string) => void;

function membersOf(at: Located, name: string, complain: Complain): [string, Located][] {
  if (at.value instanceof Map) return [...at.value];
  complain(at, `${name} must be an object in braces. It is ignored.`);
  return [];
}

function readThresholds(at: Located, complain: Complain): Thresholds {
  const members = new Map(membersOf(at, "thresholds", complain));
  for (const [name, member] of members) {
    if (name !== "warning" && name !== "critical") complain(member, `thresholds.${name} is not a setting. It is ignored.`);
  }
  const given = (name: keyof Thresholds): Percent | null => {
    const value = members.get(name)?.value;
    return isPercent(value) && value <= 100 ? value : null;
  };
  const warning = given("warning");
  const critical = given("critical");
  if (warning !== null && critical !== null && warning > critical) {
    complain(
      at,
      `thresholds.warning (${warning}) must not be above thresholds.critical (${critical}). ` +
        `Using ${DEFAULT_THRESHOLDS.warning} and ${DEFAULT_THRESHOLDS.critical}.`,
    );
    return DEFAULT_THRESHOLDS;
  }
  const thresholds = {
    critical: critical ?? higher(DEFAULT_THRESHOLDS.critical, warning ?? DEFAULT_THRESHOLDS.warning),
    warning: warning ?? lower(DEFAULT_THRESHOLDS.warning, critical ?? DEFAULT_THRESHOLDS.critical),
  };
  for (const name of ["warning", "critical"] as const) {
    const member = members.get(name);
    if (member !== undefined && given(name) === null) {
      complain(member, `thresholds.${name} must be a number from 0 to 100. Using ${thresholds[name]}.`);
    }
  }
  return { warning: thresholds.warning, critical: thresholds.critical };
}

function higher(a: Percent, b: Percent): Percent {
  return a > b ? a : b;
}

function lower(a: Percent, b: Percent): Percent {
  return a < b ? a : b;
}

function isPollInterval(value: Json): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= MIN_POLL_SECONDS && value <= MAX_POLL_SECONDS;
}

interface Located {
  readonly line: number;
  readonly value: Json;
}

type Json = null | boolean | number | string | readonly Located[] | ReadonlyMap<string, Located>;

class JsoncError extends Error {
  constructor(
    readonly line: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * JSON with `//` and block comments and trailing commas. Not `Bun.JSONC.parse`, because its errors
 * carry no line and it accepts text after the closing brace.
 *
 * Throws `JsoncError` on the first thing it cannot read, including a name that appears twice.
 */
const MAX_DEPTH = 32;

function readJsonc(text: string): Located {
  let at = text.startsWith("﻿") ? 1 : 0;
  let line = 1;
  const fail = (message: string): never => {
    throw new JsoncError(line, message);
  };

  const skip = (): void => {
    for (;;) {
      const char = text[at];
      if (char === "\n") line += 1;
      if (char === " " || char === "\t" || char === "\r" || char === "\n") at += 1;
      else if (char === "/" && text[at + 1] === "/") {
        while (at < text.length && text[at] !== "\n") at += 1;
      } else if (char === "/" && text[at + 1] === "*") {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) fail("a /* comment is never closed");
        for (let index = at; index < end; index += 1) if (text[index] === "\n") line += 1;
        at = end + 2;
      } else return;
    }
  };

  const quoted = (): string => {
    let end = at + 1;
    while (end < text.length && text[end] !== '"' && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
    if (text[end] !== '"') fail("a quote is never closed");
    const raw = text.slice(at, end + 1);
    at = end + 1;
    try {
      return JSON.parse(raw);
    } catch {
      return fail(`${raw} is not a valid string`);
    }
  };

  const value = (depth: number): Located => {
    if (depth > MAX_DEPTH) fail(`the settings are nested more than ${MAX_DEPTH} levels deep`);
    skip();
    const startedOn = line;
    const char = text[at];
    if (char === undefined) return fail("the file ends where a value should be");

    if (char === '"') return { line: startedOn, value: quoted() };

    if (char === "{") {
      at += 1;
      const members = new Map<string, Located>();
      for (;;) {
        skip();
        if (text[at] === "}") break;
        if (text[at] !== '"') fail("expected a setting name in double quotes");
        const nameLine = line;
        const name = quoted();
        if (members.has(name)) fail(`"${name}" appears twice`);
        skip();
        if (text[at] !== ":") fail(`expected a colon after "${name}"`);
        at += 1;
        members.set(name, { line: nameLine, value: value(depth + 1).value });
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "}") fail("expected a comma or a closing brace");
      }
      at += 1;
      return { line: startedOn, value: members };
    }

    if (char === "[") {
      at += 1;
      const items: Located[] = [];
      for (;;) {
        skip();
        if (text[at] === "]") break;
        items.push(value(depth + 1));
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== "]") fail("expected a comma or a closing bracket");
      }
      at += 1;
      return { line: startedOn, value: items };
    }

    const word = /[^\s,:\]}/]+/y;
    word.lastIndex = at;
    const token = word.exec(text)?.[0] ?? char;
    at += token.length;
    if (token === "true") return { line: startedOn, value: true };
    if (token === "false") return { line: startedOn, value: false };
    if (token === "null") return { line: startedOn, value: null };
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return { line: startedOn, value: Number(token) };
    return fail(`${token} is not a value. Text needs double quotes`);
  };

  const root = value(0);
  skip();
  if (at < text.length) fail("there is text after the end of the settings");
  return root;
}
