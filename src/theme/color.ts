/**
 * The colour math T3 Code paints its themes with, ported from its `themePalette.ts` (MIT, pingdotgg/t3code)
 * so the plugin lands on the same 8-bit colours T3 shows.
 */

import type { HexColor } from "../config.ts";

/** sRGB channels from 0 to 255, unrounded while a solve is still moving them. */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

interface Oklch {
  readonly L: number;
  readonly C: number;
  /** Degrees. */
  readonly h: number;
}

export interface CssColor {
  readonly color: Oklch;
  /** From 0 to 1. */
  readonly alpha: number;
}

/** The colour forms T3 writes and its theme files take: `oklch()`, `#hex` and `rgb()`. Null for anything else. */
export function parseCssColor(text: string): CssColor | null {
  const input = text.trim().toLowerCase();
  const parsed = input.startsWith("#") ? parseHex(input) : parseFunction(input);
  if (parsed === null) return null;
  const { color, alpha } = parsed;
  if (![color.L, color.C, color.h, alpha].every(Number.isFinite)) return null;
  return {
    color: { L: clamp(color.L, 0, 1), C: Math.max(0, color.C), h: ((color.h % 360) + 360) % 360 },
    alpha: clamp(alpha, 0, 1),
  };
}

function parseHex(input: string): CssColor | null {
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(input)) return null;
  const digits = input.slice(1);
  const wide = digits.length > 4 ? digits : [...digits].map((digit) => digit + digit).join("");
  const channel = (index: number) => Number.parseInt(wide.slice(index * 2, index * 2 + 2), 16);
  return { color: rgbToOklch({ r: channel(0), g: channel(1), b: channel(2) }), alpha: wide.length === 8 ? channel(3) / 255 : 1 };
}

function parseFunction(input: string): CssColor | null {
  const call = /^(oklch|rgba?)\(\s*([^)]*?)\s*\)$/.exec(input);
  if (call === null) return null;
  const [, name, body = ""] = call;
  const [channels = "", alphaPart] = body.includes("/") ? body.split("/") : [body.replaceAll(",", " "), undefined];
  const parts = channels.trim().split(/[\s,]+/);
  const commaAlpha = alphaPart === undefined && parts.length === 4 ? parts.pop() : undefined;
  if (parts.length !== 3) return null;
  const alpha = component(alphaPart ?? commaAlpha ?? "1", 1);
  if (name === "oklch") {
    const [L, C, h] = parts as [string, string, string];
    return { color: { L: component(L, 1), C: component(C, 0.4), h: component(h.replace(/deg$/, ""), 360) }, alpha };
  }
  const [r, g, b] = parts.map((part) => clamp(component(part, 255), 0, 255)) as [number, number, number];
  return { color: rgbToOklch({ r, g, b }), alpha };
}

/** `none` is zero, as in CSS. A percent is of `hundredPercent`. */
function component(text: string, hundredPercent: number): number {
  const value = text.trim();
  if (value === "none") return 0;
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/.test(value)) return Number.NaN;
  return value.endsWith("%") ? (Number(value.slice(0, -1)) / 100) * hundredPercent : Number(value);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function hexOf(color: Rgb): HexColor {
  const hex = `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0"))
    .join("")}`;
  return hex as HexColor;
}

function luminance(color: Rgb): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

const DARK_LUMINANCE = 0.179;

export function isDark(color: Rgb): boolean {
  return luminance(color) < DARK_LUMINANCE;
}

export function contrast(first: Rgb, second: Rgb): number {
  const [darker, lighter] = [luminance(first), luminance(second)].sort((a, b) => a - b) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Straight in sRGB, as T3 mixes. */
export function mix(base: Rgb, overlay: Rgb, amount: number): Rgb {
  return {
    r: base.r + (overlay.r - base.r) * amount,
    g: base.g + (overlay.g - base.g) * amount,
    b: base.b + (overlay.b - base.b) * amount,
  };
}

function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(channel: number, round: boolean): number {
  const c = channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
  const srgb = clamp(c, 0, 1) * 255;
  return round ? Math.round(srgb) : srgb;
}

function rgbToOklab(color: Rgb): readonly [L: number, a: number, b: number] {
  const r = toLinear(color.r);
  const g = toLinear(color.g);
  const b = toLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function rgbToOklch(color: Rgb): Oklch {
  const [L, a, b] = rgbToOklab(color);
  return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180) / Math.PI };
}

/** OKLab distance. CSS Color 4 takes 0.02 as about the smallest difference people notice. */
export function deltaE(first: Rgb, second: Rgb): number {
  const [L1, a1, b1] = rgbToOklab(first);
  const [L2, a2, b2] = rgbToOklab(second);
  return Math.hypot(L1 - L2, a1 - a2, b1 - b2);
}

function linearRgbOf({ L, C, h }: Oklch): Rgb {
  const radians = (h * Math.PI) / 180;
  const a = C * Math.cos(radians);
  const bb = C * Math.sin(radians);
  const l = (L + 0.3963377774 * a + 0.2158037573 * bb) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * bb) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * bb) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function intoGamut(color: Oklch): Oklch {
  const fits = (C: number) => {
    const linear = linearRgbOf({ ...color, C });
    return [linear.r, linear.g, linear.b].every((channel) => channel >= -0.0001 && channel <= 1.0001);
  };
  if (fits(color.C)) return color;
  const resolution = 0.000001;
  const steps = Math.max(1, Math.ceil(Math.log2(Math.max(color.C, resolution)) - Math.log2(resolution)));
  let low = 0;
  let high = color.C;
  for (let step = 0; step < steps; step += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return { ...color, C: low };
}

/** Rounded to whole channels unless `round` is false. */
export function oklchToRgb(color: Oklch, round = true): Rgb {
  const linear = linearRgbOf(intoGamut(color));
  return { r: fromLinear(linear.r, round), g: fromLinear(linear.g, round), b: fromLinear(linear.b, round) };
}

/** A colour with alpha, as it shows over `under`. */
export function opaqueOver(color: CssColor, under: Rgb): Rgb {
  const rgb = oklchToRgb(color.color);
  return color.alpha >= 1 ? rgb : mix(under, rgb, color.alpha);
}

/** Moves only the lightness, toward `direction`, until `color` has `minimum` contrast against every surface. */
export function solveLightness(
  color: Oklch,
  against: readonly Rgb[],
  minimum: number,
  direction: "lighter" | "darker",
): Oklch {
  const contrastOf = (candidate: Oklch) =>
    Math.min(...against.map((surface) => contrast(oklchToRgb(candidate), surface)));
  if (contrastOf(color) >= minimum) return color;
  let low = direction === "lighter" ? color.L : 0;
  let high = direction === "lighter" ? 1 : color.L;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    const passes = contrastOf({ ...color, L: middle }) >= minimum;
    if (passes === (direction === "lighter")) high = middle;
    else low = middle;
  }
  return { ...color, L: direction === "lighter" ? high : low };
}

function readsOn(color: Rgb, surfaces: readonly Rgb[], minimum: number): boolean {
  return surfaces.every((surface) => contrast(color, surface) >= minimum);
}

/**
 * T3's `readableThemeColorOn`: the colour itself when it reads on every surface, else its hue at a
 * lightness that does. The first surface decides whether that is lighter or darker.
 */
export function readableOn(color: Oklch, surfaces: readonly [Rgb, ...Rgb[]], minimum: number): Rgb {
  const rgb = oklchToRgb(color);
  if (readsOn(rgb, surfaces, minimum)) return rgb;
  return oklchToRgb(solveLightness(color, surfaces, minimum, isDark(surfaces[0]) ? "lighter" : "darker"));
}

export interface Apart {
  readonly surfaces: readonly [Rgb, ...Rgb[]];
  readonly minimum: number;
  /** Colours it must stand `distance` apart from, in OKLab. */
  readonly avoid: readonly Rgb[];
  readonly distance: number;
  /** The hues, in degrees, it may move to and keep its meaning, such as the reds for critical. */
  readonly hues: readonly [low: number, high: number];
}

const VIVID_CHROMA = 0.2;
const HUE_STEP = 5;
const LIGHTNESS_STEP = 0.02;

/**
 * `readableOn`, and where that lands near a colour in `avoid`, the nearest colour that reads and
 * stands apart: any lightness, a hue in `hues`, its own chroma or a vivid one. When nothing does,
 * as on a mid-grey surface, the readable colour.
 */
export function apartOn(color: Oklch, { surfaces, minimum, avoid, distance, hues }: Apart): Rgb {
  const readable = readableOn(color, surfaces, minimum);
  const fits = (candidate: Rgb) => readsOn(candidate, surfaces, minimum) && avoid.every((other) => deltaE(candidate, other) >= distance);
  if (fits(readable)) return readable;
  let nearest: { readonly rgb: Rgb; readonly away: number } | null = null;
  for (const h of steps(hues[0], hues[1], HUE_STEP)) {
    for (const C of [color.C, VIVID_CHROMA]) {
      for (const L of steps(0, 1, LIGHTNESS_STEP)) {
        const candidate = oklchToRgb({ L, C, h });
        const away = deltaE(candidate, readable);
        if ((nearest === null || away < nearest.away) && fits(candidate)) nearest = { rgb: candidate, away };
      }
    }
  }
  return nearest?.rgb ?? readable;
}

function steps(from: number, to: number, by: number): number[] {
  return Array.from({ length: Math.round((to - from) / by) + 1 }, (_, index) => from + index * by);
}

/** T3's `readableThemeText`: `foreground` softened toward `background` as far as `minimum` contrast allows. */
function softenedText(background: Rgb, foreground: Rgb, minimum: number): Rgb {
  const softest = mix(foreground, background, 1);
  if (contrast(softest, background) >= minimum) return softest;
  let readable = foreground;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 12; step += 1) {
    const amount = (low + high) / 2;
    const candidate = mix(foreground, background, amount);
    if (contrast(candidate, background) >= minimum) {
      readable = candidate;
      low = amount;
    } else high = amount;
  }
  return readable;
}

/** T3's `standardMutedThemeText`: the contrast its stock muted text has, on light or dark. */
export function mutedText(background: Rgb, foreground: Rgb): Rgb {
  return softenedText(background, foreground, isDark(background) ? 5.082 : 4.705);
}
