// This file imports nothing. The Bun module and the GJS widget both import it by value.

export type ProviderId = string & { readonly __brand: "ProviderId" };

export type Glyph = number & { readonly __brand: "Glyph" };

export const ICON_FONT_FAMILY = "usage-plugin-icons";

export type Percent = number & { readonly __brand: "Percent" };

/** Milliseconds since the Unix epoch. */
export type Instant = number & { readonly __brand: "Instant" };

const FIRST_GLYPH = 0xe900;
const LAST_PRIVATE_USE = 0xf8ff;
const MAX_DATE_MS = 8.64e15;

export function isGlyph(value: number): value is Glyph {
  return Number.isInteger(value) && value >= FIRST_GLYPH && value <= LAST_PRIVATE_USE;
}

export function isPercent(value: unknown): value is Percent {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isInstant(value: unknown): value is Instant {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS;
}

export function instant(epochMs: number): Instant {
  if (!isInstant(epochMs)) throw new RangeError(`not a time: ${epochMs}`);
  return epochMs;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** The shape is checked first, because `Date.parse` alone reads "-5" and "soon 1" as dates in 2001. */
export function parseInstant(iso: unknown): Instant | null {
  if (typeof iso !== "string" || !ISO_DATE_TIME.test(iso)) return null;
  const epochMs = Date.parse(iso);
  return isInstant(epochMs) ? epochMs : null;
}

export function wholePercent(used: Percent): Percent {
  return percent(Math.round(used));
}

/** What every surface shows for a window. Rounded as T3 Code rounds it, so the two read the same. */
export function percentLeft(used: Percent): Percent {
  return percent(Math.round(100 - Math.min(used, 100)));
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** Fixed for the provider's life and never reused. */
  readonly glyph: Glyph;
  /**
   * The command that renews the stored login. We never renew it ourselves. Null for a
   * provider read only through T3 Code, where the login lives in T3.
   */
  readonly loginCommand: string | null;
}

export interface WindowDetail {
  readonly label: string;
  readonly usedPercent: Percent;
}

export interface Window {
  /** Unique within a reading and the same from one reading to the next, so it can key stored state. */
  readonly label: string;
  readonly usedPercent: Percent;
  readonly resetsAt: Instant | null;
  readonly detail: readonly WindowDetail[];
  /** How long the window runs, when the source says. */
  readonly minutes?: number;
}

const LEADING_LENGTH = /^(session|weekly|week|5\s*-?\s*h(?:ours?|rs?)?|7\s*-?\s*d(?:ays?)?)(?![a-z])\s*/i;

/** What a source puts between the length and the rest, as in "Weekly · Fable", "7 day - Opus" or "Weekly (Fable)". */
const JOINER = /^[\s·•:|/,–—-]+|^\((.*)\)$/;

/**
 * The name a window shows: its length, then whatever the label adds, as in "Weekly · Fable".
 * Sources name the same window differently ("Session", "5h", "5 hour"), and the label itself
 * stays as it is because it keys alert state.
 */
export function shownLabel({ label, minutes }: Pick<Window, "label" | "minutes">): string {
  const lead = LEADING_LENGTH.exec(label);
  const rest = lead === null ? label : label.slice(lead[0].length).trim().replace(JOINER, "$1").trim();
  const length = minutes !== undefined ? lengthName(minutes) : lead === null ? null : /^(session|5)/i.test(lead[1] ?? "") ? "5-hour" : "Weekly";
  if (length === null) return label;
  return rest === "" ? length : `${length} · ${rest}`;
}

function lengthName(minutes: number): string {
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export type Windows = readonly [Window, ...Window[]];

/**
 * Where a reading came from. `unsupportedT3` names a running T3 Code whose version the plugin does
 * not read, which is why the reading is direct.
 */
export type Via = { readonly kind: "t3" } | { readonly kind: "direct"; readonly unsupportedT3: string | null };

export const DIRECT: Via = { kind: "direct", unsupportedT3: null };

export interface Reading {
  readonly provider: ProviderId;
  readonly plan: string | null;
  readonly windows: Windows;
  readonly takenAt: Instant;
  readonly via: Via;
}

/** On a tie, the earliest window in the reading's order. */
export function tightestWindow(reading: Pick<Reading, "windows">): Window {
  return reading.windows.reduce((tightest, window) => (window.usedPercent > tightest.usedPercent ? window : tightest));
}

/**
 * `detail` says what was expected, such as "five_hour.utilization is not a number". It never
 * quotes a reply, a header or a login file, because it is written to the cache and the debug log.
 */
export type Miss =
  | { readonly kind: "signedOut" }
  /** The login's own expiry time has passed, or the provider answered 401. */
  | { readonly kind: "loginExpired" }
  | { readonly kind: "rateLimited"; readonly retryAfterSeconds: number | null }
  /** Trying again later may work. `loginFile` is a login file caught mid-rewrite by the provider's CLI. */
  | {
      readonly kind: "unreachable";
      readonly cause: "network" | "timeout" | "server" | "loginFile";
      readonly detail: string;
    }
  | { readonly kind: "unreadable"; readonly detail: string }
  /** T3 Code is the only way to read this provider and it is closed, or runs a version we do not read. */
  | { readonly kind: "noT3"; readonly why: NoT3 }
  /** T3 Code reports that its own last check of this provider failed. */
  | { readonly kind: "probeFailed" };

/** Why T3 Code gave nothing for a provider only T3 can read. */
export type NoT3 =
  | { readonly kind: "closed" }
  | { readonly kind: "unsupported"; readonly version: string }
  | { readonly kind: "failing"; readonly detail: string };

export function noT3Text(why: NoT3): string {
  switch (why.kind) {
    case "closed":
      return "open T3 Code";
    case "unsupported":
      return `T3 Code ${why.version} is not supported`;
    case "failing":
      return why.detail;
  }
}

export type Outcome = { readonly kind: "reading"; readonly reading: Reading } | Miss;

export type Level = "ok" | "warning" | "critical";

export interface Thresholds {
  readonly warning: Percent;
  readonly critical: Percent;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warning: percent(75), critical: percent(90) };

export function levelOf(usedPercent: Percent, thresholds: Thresholds): Level {
  if (usedPercent >= thresholds.critical) return "critical";
  if (usedPercent >= thresholds.warning) return "warning";
  return "ok";
}

/** The level of the percent used that a shown percent left stands for, so the colour agrees with the number. */
export function levelOfLeft(left: Percent, thresholds: Thresholds): Level {
  return levelOf(percent(100 - left), thresholds);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "46m", "2h 14m", "3d 6h", "<1m" inside the last minute, and "now" once the time has passed. */
export function formatCountdown(resetsAt: Instant, now: Instant): string {
  const left = resetsAt - now;
  if (left <= 0) return "now";
  if (left < MINUTE_MS) return "<1m";
  const days = Math.floor(left / DAY_MS);
  const hours = Math.floor((left % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((left % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function percent(value: number): Percent {
  if (!isPercent(value)) throw new RangeError(`not a percent: ${value}`);
  return value;
}
