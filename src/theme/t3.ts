/**
 * Which palette T3 Code paints, from what it keeps on disk. Ported from T3's `useTheme.ts` and
 * `themePalette.ts` (MIT, pingdotgg/t3code), version 0.1.9. Pure: the profile's contents in, colours out.
 */

import type { HexColor } from "../config.ts";
import { isRecord } from "../domain.ts";
import { apartOn, hexOf, isDark, mix, mutedText, oklchToRgb, opaqueOver, parseCssColor, readableOn, rgbToOklch, solveLightness } from "./color.ts";
import type { CssColor, Rgb } from "./color.ts";
import { isAppearance } from "./palettes.ts";
import type { Appearance, PinnedPalettes, ThemeColors, ThemeDefinition } from "./palettes.ts";

/**
 * The colours that mark a reading, solved for what they are drawn on. The accent paints logos and
 * usage bars and reads at 3:1. Warning and critical paint text and read at 4.5:1, and each stands
 * apart from the accent and from the other.
 */
export interface Levels {
  readonly accent: HexColor;
  readonly warning: HexColor;
  /** T3's error. */
  readonly critical: HexColor;
}

/** The plugin's colours, each a role T3 paints. The levels at the top are the widget's. */
export interface Palette extends Levels {
  /** T3's canvas. The widget's panel. */
  readonly background: HexColor;
  /** T3's surface, or its raised surface where the surface is the canvas. The widget's cards. */
  readonly card: HexColor;
  readonly text: HexColor;
  readonly muted: HexColor;
  /** How opaque the widget's panel is, from 0 to 1. */
  readonly panelAlpha: number;
  /** The module's levels, on the bar's colours, or on T3's canvas when those are not known. */
  readonly bar: Levels;
}

/** The config's `theme`: follow T3 Code, use the user's Waybar colours, or paint nothing. */
export const THEME_MODES = ["t3", "waybar", "none"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export function isThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some((mode) => mode === value);
}

export type ResolvedTheme =
  | {
      readonly kind: "t3";
      /** A built-in, custom or theme-file id, or `standard` when T3 paints its stock palette. */
      readonly themeId: string;
      readonly appearance: Appearance;
      readonly t3Version: string;
      /** The app.asar the version came from. Null when none is installed and the newest pinned palettes stand in. */
      readonly app: string | null;
      readonly palette: Palette;
    }
  /** The user's Waybar colours. `reason` says why, naming the T3 version when it is the cause. */
  | { readonly kind: "waybar"; readonly reason: string }
  | { readonly kind: "none" };

/** What T3 keeps that decides its colours, read off disk but not yet understood. */
export interface T3State {
  /** The theme keys of T3's localStorage. */
  readonly storage: ReadonlyMap<string, string>;
  /** Parsed JSON of each `~/.t3/userdata/themes/<id>.json`, by id. */
  readonly themeFiles: ReadonlyMap<string, unknown>;
  /** Parsed `~/.t3/userdata/client-settings.json`, or null. */
  readonly clientSettings: unknown;
}

export const STORAGE_KEYS = {
  theme: "t3code:theme",
  appearanceMode: "t3code:theme-appearance-mode",
  followSystem: "t3code:theme-follow-system",
  halves: "t3code:theme-halves:v1",
  customThemes: "t3code:themes:v1",
} as const;

const STANDARD_THEME_ID = "standard";

/** `bar` is what the module is drawn on, empty when that is not known. */
export function resolveT3(
  state: T3State,
  palettes: PinnedPalettes,
  systemDark: () => boolean,
  bar: readonly Rgb[] = [],
): { readonly themeId: string; readonly appearance: Appearance; readonly palette: Palette } {
  const library = themeLibrary(state, palettes);
  const theme = preferenceOf(state.storage.get(STORAGE_KEYS.theme), library);
  const mode = appearanceModeOf(state.storage, theme, library);
  const halves = halvesOf(state.storage.get(STORAGE_KEYS.halves), library);
  const appearance = appearanceOf(theme, mode === "system" ? (systemDark() ? "dark" : "light") : mode, halves, library);
  const definition = library.find(halves[appearance] ?? theme);
  const colors = definition === null ? palettes.standard[appearance] : (colorsForMode(definition, appearance) ?? definition.colors);
  return {
    themeId: definition?.id ?? STANDARD_THEME_ID,
    appearance,
    palette: paletteOf(colors, defaultColors(palettes, appearance), state.clientSettings, appearance, bar),
  };
}

type Preference = string;
type AppearanceMode = Appearance | "system";
type Halves = Readonly<Partial<Record<Appearance, string>>>;

interface Identified extends ThemeDefinition {
  readonly id: string;
}

interface ThemeLibrary {
  /** T3's `getThemeDefinition`: built-in first, then custom, then theme files. */
  find(preference: Preference): Identified | null;
}

const LEGACY_T3_CHAT_DARK = "t3-chat-dark";
const LEGACY_ALIASES: Readonly<Record<string, string>> = {
  [LEGACY_T3_CHAT_DARK]: "t3-chat",
  "t3-grove": "grove",
  "t3-ocean": "ocean",
  "t3-ember": "ember",
  "t3-iris": "iris",
};

function normalizeId(id: string): string {
  return Object.hasOwn(LEGACY_ALIASES, id) ? (LEGACY_ALIASES[id] as string) : id;
}

function themeLibrary(state: T3State, palettes: PinnedPalettes): ThemeLibrary {
  const reserved = new Set(["system", "light", "dark", ...Object.keys(palettes.themes), ...Object.keys(LEGACY_ALIASES)]);
  const builtIn = Object.entries(palettes.themes).map(([id, theme]) => ({ id, ...theme }));
  const custom = storedThemes(state.storage.get(STORAGE_KEYS.customThemes), palettes, reserved);
  const files = [...state.themeFiles].flatMap(([id, file]) => {
    const theme = reserved.has(id) ? null : fileTheme(id, file, palettes);
    return theme === null ? [] : [theme];
  });
  const all = [...builtIn, ...custom, ...files];
  return { find: (preference) => all.find((theme) => theme.id === normalizeId(preference)) ?? null };
}

function colorsForMode(theme: ThemeDefinition, mode: Appearance): ThemeColors | null {
  return mode === theme.appearance ? theme.colors : (theme.variants?.[mode] ?? null);
}

/** T3's `getDefaultThemeColors`: what a custom theme's missing roles take. T3 Chat's palette, not the standard one. */
function defaultColors(palettes: PinnedPalettes, appearance: Appearance): ThemeColors {
  const t3Chat = palettes.themes["t3-chat"];
  return (t3Chat === undefined ? null : colorsForMode(t3Chat, appearance)) ?? palettes.standard[appearance];
}

/** T3's `lenientThemeColorOverrides`: known roles with colours it can read, and nothing else. */
function knownColors(value: unknown, palettes: PinnedPalettes): ThemeColors {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        palettes.roles.includes(entry[0]) && typeof entry[1] === "string" && parseCssColor(entry[1]) !== null,
    ),
  );
}

const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,47})$/;

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 48;
}

/** T3's `parseStoredThemes`: an entry it cannot read is skipped, and the first of an id wins. */
function storedThemes(raw: string | undefined, palettes: PinnedPalettes, reserved: ReadonlySet<string>): Identified[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const themes: Identified[] = [];
  for (const value of parsed) {
    const theme = storedTheme(value, palettes, reserved);
    if (theme !== null && !themes.some((existing) => existing.id === theme.id)) themes.push(theme);
  }
  return themes;
}

function storedTheme(value: unknown, palettes: PinnedPalettes, reserved: ReadonlySet<string>): Identified | null {
  if (!isRecord(value) || typeof value.id !== "string" || !THEME_ID.test(value.id) || reserved.has(value.id)) return null;
  const { appearance } = value;
  if (!isLabel(value.label) || !isAppearance(appearance) || !isRecord(value.colors)) return null;
  const variants: Partial<Record<Appearance, ThemeColors>> = {};
  if (value.variants !== undefined) {
    if (!isRecord(value.variants)) return null;
    for (const [mode, colors] of Object.entries(value.variants)) {
      if (!isAppearance(mode) || !isRecord(colors)) return null;
      if (mode !== appearance) variants[mode] = { ...defaultColors(palettes, mode), ...knownColors(colors, palettes) };
    }
  }
  return { id: value.id, appearance, colors: { ...defaultColors(palettes, appearance), ...knownColors(value.colors, palettes) }, variants };
}

const FILE_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * A theme file as T3's server takes it, then as its client builds it: from `canvas` and `accent`
 * through T3's generator when both are there, else from the defaults, with `colors` laid over.
 */
function fileTheme(id: string, file: unknown, palettes: PinnedPalettes): Identified | null {
  if (!THEME_ID.test(id) || !isRecord(file)) return null;
  const { appearance, canvas, accent, colors, variants } = file;
  if (!isLabel(file.name) || !isAppearance(appearance)) return null;
  if (file.version !== undefined && file.version !== 1) return null;
  if ((canvas !== undefined && !(typeof canvas === "string" && FILE_COLOR.test(canvas))) || (accent !== undefined && !(typeof accent === "string" && FILE_COLOR.test(accent)))) {
    return null;
  }
  if ((colors !== undefined && !isRecord(colors)) || (variants !== undefined && !isRecord(variants))) return null;
  const seeded = typeof canvas === "string" && typeof accent === "string" ? { canvas, accent } : null;
  const other: Appearance = appearance === "dark" ? "light" : "dark";
  const otherColors = isRecord(variants) ? variants[other] : undefined;
  const hasColors = [colors, otherColors].some((each) => Object.keys(knownColors(each, palettes)).length > 0);
  if (seeded === null && !hasColors) return null;
  const build = (mode: Appearance, overrides: unknown): ThemeColors => ({
    ...(mode === appearance && seeded !== null ? vividColors(mode, seeded.canvas, seeded.accent, palettes) : defaultColors(palettes, mode)),
    ...knownColors(overrides ?? {}, palettes),
  });
  return {
    id,
    appearance,
    colors: build(appearance, colors),
    variants: isRecord(variants) && variants[other] !== undefined ? { [other]: build(other, variants[other]) } : {},
  };
}

/** The roles the plugin paints, from T3's `createVividThemeColors` (MIT, pingdotgg/t3code). Every other role keeps its default. */
function vividColors(appearance: Appearance, canvasValue: string, accentValue: string, palettes: PinnedPalettes): ThemeColors {
  const rgbOf = (value: string, fallback: Rgb): Rgb => {
    const parsed = parseCssColor(value);
    return parsed === null ? fallback : oklchToRgb(parsed.color);
  };
  const canvasRgb = rgbOf(canvasValue, appearance === "dark" ? { r: 24, g: 15, b: 27 } : { r: 250, g: 245, b: 250 });
  const accentRgb = rgbOf(accentValue, { r: 168, g: 67, b: 112 });
  const canvas = rgbToOklch(canvasRgb);
  const accent = rgbToOklch(accentRgb);
  const dark = isDark(canvasRgb);
  const hue = accent.C < 0.02 ? canvas.h : accent.h;
  const tint = Math.min(0.045, Math.max(0.008, accent.C * 0.22));
  const surface = { L: Math.min(0.98, Math.max(0.05, canvas.L + (dark ? 1 : -1) * 0.015)), C: tint, h: hue };
  const textBase = { L: dark ? 0.95 : 0.2, C: Math.min(0.035, accent.C * 0.25), h: hue };
  const text = oklchToRgb(solveLightness(textBase, [canvasRgb], 7, dark ? "lighter" : "darker"));
  const status = dark ? { error: "#fb414a", warning: "#fe9a00" } : { error: "#fb2c36", warning: "#fe9a00" };
  return {
    ...defaultColors(palettes, appearance),
    ...status,
    canvas: hexOf(canvasRgb),
    surface: hexOf(oklchToRgb(surface)),
    text: hexOf(text),
    textMuted: hexOf(mutedText(canvasRgb, text)),
    accent: hexOf(accentRgb),
  };
}

function preferenceOf(raw: string | undefined, library: ThemeLibrary): Preference {
  if (raw === undefined) return "system";
  const known = raw === "light" || raw === "dark" || raw === "system" || library.find(raw) !== null;
  if (!known) return "system";
  return raw === LEGACY_T3_CHAT_DARK ? raw : normalizeId(raw);
}

/** T3's `getThemePreferenceMode`. */
function preferenceMode(theme: Preference, library: ThemeLibrary): Appearance | null {
  if (theme === "system") return null;
  if (theme === "light" || theme === "dark") return theme;
  if (theme === LEGACY_T3_CHAT_DARK) return "dark";
  return library.find(theme)?.appearance ?? null;
}

/** T3's `readAppearanceModePreference`, with the legacy follow-system key. */
function appearanceModeOf(storage: ReadonlyMap<string, string>, theme: Preference, library: ThemeLibrary): AppearanceMode {
  const stored = storage.get(STORAGE_KEYS.appearanceMode);
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  const follow = storage.get(STORAGE_KEYS.followSystem);
  if (follow === "true" || (follow !== "false" && theme === "system")) return "system";
  return preferenceMode(theme, library) ?? "light";
}

/** T3's `parseThemeHalves`: a half counts only when its theme exists and has colours for that appearance. */
function halvesOf(raw: string | undefined, library: ThemeLibrary): Halves {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const halves: Partial<Record<Appearance, string>> = {};
  for (const appearance of ["light", "dark"] as const) {
    const id = parsed[appearance];
    const theme = typeof id === "string" ? library.find(id) : null;
    if (theme !== null && colorsForMode(theme, appearance) !== null) halves[appearance] = theme.id;
  }
  return halves;
}

/** T3's `resolveThemeAppearance`: the asked appearance, unless the theme has no palette for it and no half covers it. */
function appearanceOf(theme: Preference, asked: Appearance, halves: Halves, library: ThemeLibrary): Appearance {
  if (halves[asked] !== undefined) return asked;
  const definition = library.find(theme);
  return definition !== null && colorsForMode(definition, asked) === null ? definition.appearance : asked;
}

const DEFAULT_CONTRAST = 100;
const DEFAULT_GLASS_OPACITY = 80;

function settingIn(settings: unknown, name: string, low: number, high: number, fallback: number): number {
  const value = isRecord(settings) ? settings[name] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

/**
 * T3's roles as the plugin's. Two of T3's settings are approximated, because T3 applies them with
 * CSS the plugin does not run: contrast above 100 moves muted text toward text and below 100
 * toward the canvas, and glass opacity sets how opaque the panel is, from 0.88 to 1, since the
 * widget has no blur behind it.
 */
function paletteOf(colors: ThemeColors, fallback: ThemeColors, settings: unknown, appearance: Appearance, bar: readonly Rgb[]): Palette {
  const read = (role: string): CssColor | null => parseCssColor(colors[role] ?? "") ?? parseCssColor(fallback[role] ?? "");
  const behind = appearance === "dark" ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
  const canvasColor = read("canvas");
  const background = canvasColor === null ? behind : opaqueOver(canvasColor, behind);
  const solid = (role: string): Rgb => {
    const color = read(role);
    return color === null ? background : opaqueOver(color, background);
  };

  const text = solid("text");
  const appearanceContrast = settingIn(settings, "appearanceContrast", 50, 200, DEFAULT_CONTRAST);
  const muted =
    appearanceContrast >= DEFAULT_CONTRAST
      ? mix(solid("textMuted"), text, (appearanceContrast - DEFAULT_CONTRAST) / 100)
      : mix(solid("textMuted"), background, (DEFAULT_CONTRAST - appearanceContrast) / 200);
  const glassOpacity = settingIn(settings, "glassOpacity", 0, 100, DEFAULT_GLASS_OPACITY);
  const card = solid(colors.surface === colors.canvas ? "surfaceRaised" : "surface");
  const marks = { accent: solid("accent"), warning: solid("warning"), critical: solid("error") };
  const [barSurface = background, ...barSurfaces] = bar;
  return {
    background: hexOf(background),
    card: hexOf(card),
    text: hexOf(text),
    muted: hexOf(muted),
    ...levelsOn(marks, [background, card]),
    panelAlpha: Math.round((0.88 + (0.12 * glassOpacity) / 100) * 1000) / 1000,
    bar: levelsOn(marks, [barSurface, ...barSurfaces]),
  };
}

const GRAPHIC_CONTRAST = 3;
const TEXT_CONTRAST = 4.5;
/** Five times the smallest OKLab difference people notice, so two levels never pass for one at a glance. */
const LEVELS_APART = 0.1;
const WARNING_HUES = [55, 95] as const;
const CRITICAL_HUES = [15, 35] as const;

/** Critical moves first, then warning, and the accent never moves: it is the theme's own colour. */
function levelsOn(marks: { readonly [Level in keyof Levels]: Rgb }, surfaces: readonly [Rgb, ...Rgb[]]): Levels {
  const accent = readableOn(rgbToOklch(marks.accent), surfaces, GRAPHIC_CONTRAST);
  const apart = (avoid: readonly Rgb[], hues: readonly [number, number]) => ({ surfaces, minimum: TEXT_CONTRAST, avoid, distance: LEVELS_APART, hues });
  const critical = apartOn(rgbToOklch(marks.critical), apart([accent], CRITICAL_HUES));
  const warning = apartOn(rgbToOklch(marks.warning), apart([accent, critical], WARNING_HUES));
  return { accent: hexOf(accent), warning: hexOf(warning), critical: hexOf(critical) };
}
