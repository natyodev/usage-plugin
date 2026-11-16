import type { ProviderState } from "../src/cache.ts";
import type { HexColor, Settings } from "../src/config.ts";
import { levelOfLeft, percentLeft, shownLabel, tightestWindow, wholePercent } from "../src/domain.ts";
import type { Instant, Level, Provider, ProviderId, Thresholds, Window } from "../src/domain.ts";
import { healthOf } from "../src/health.ts";
import type { Health } from "../src/health.ts";
import { ago, healthNote, t3Hint, viaLine, waitingForT3, when } from "../src/render/module.ts";
import type { WidgetTheme } from "../src/theme/profile.ts";
import type { Scene } from "./placement.ts";

/** What `usage-plugin widget --toggle` hands the GJS widget, as JSON in USAGE_PLUGIN_WIDGET. */
export interface WidgetPayload {
  readonly view: WidgetView;
  readonly scene: Scene;
  /** The command that prints a newer `WidgetView` from the cache. */
  readonly refresh: readonly string[];
  readonly theme: WidgetTheme;
}

export interface WidgetView {
  /** "updated 3m ago", from the newest reading shown. Null when no card has a reading. */
  readonly updated: string | null;
  /** Problems with the config file, one line each. */
  readonly notices: readonly string[];
  readonly cards: readonly CardView[];
  /** What to do when there is no card: open T3 Code, or wait for a first reading. */
  readonly empty: string;
}

export type CardState = Exclude<Health["kind"], "signedOut">;

export interface CardView {
  /** Safe as a CSS class. */
  readonly id: ProviderId;
  readonly name: string;
  /** One character of the usage-plugin-icons font. */
  readonly glyph: string;
  /** `#RGB` or `#RRGGBB` from the config. Null leaves the logo the theme's colour. */
  readonly color: HexColor | null;
  readonly plan: string | null;
  readonly state: CardState;
  /** The module's mark, in percent left: "34%", "~34%" when stale, "–" waiting, "?" expired, "!" broken. */
  readonly headline: { readonly text: string; readonly level: Level | null };
  /** One per window of the reading shown. None without a reading. */
  readonly rows: readonly RowView[];
  /** Why the reading is not fresh, in the module's words. Null when it is. */
  readonly note: string | null;
  /** "via T3 Code" or "direct", as the module's tooltip says it. Null when the source is fixed to direct. */
  readonly source: string | null;
}

export interface RowView {
  readonly label: string;
  /** "34% left". */
  readonly percent: string;
  readonly level: Level;
  /** The share left, from 0 to 1, so the bar agrees with the number. */
  readonly fraction: number;
  /** "resets in 46m". */
  readonly resets: string | null;
  /** What each part of the window spent, such as "Chat 44% used". A part has no limit of its own. */
  readonly chips: readonly string[];
}

/** Every provider that has an entry, is on, and is signed in, in registry order. */
export function buildView(
  states: readonly ProviderState[],
  settings: Settings,
  problems: readonly string[],
  now: Instant,
): WidgetView {
  const shown = states.flatMap(({ provider, entry }) => {
    if (entry === null || settings.disabled.has(provider.id)) return [];
    const health = healthOf(entry);
    if (health.kind === "signedOut") return [];
    const unrefreshed = health.kind === "fresh" && now > entry.dueAt + settings.pollIntervalSeconds * 1000;
    return [{ provider, health, unrefreshed }];
  });
  const newest = shown.reduce<Instant | null>(
    (top, { health }) =>
      "reading" in health && (top === null || health.reading.takenAt > top) ? health.reading.takenAt : top,
    null,
  );
  return {
    updated: newest === null ? null : `updated ${ago(newest, now)}`,
    notices: problems,
    cards: shown.map(({ provider, health, unrefreshed }) => cardOf(provider, health, unrefreshed, settings, now)),
    empty: emptyText(states),
  };
}

/**
 * The widget reads the cache and never fetches, so a reading can sit there long past its due time
 * when nothing polls. A whole poll interval past due, it shows like a stale one.
 */
function cardOf(
  provider: Provider,
  health: Exclude<Health, { kind: "signedOut" }>,
  unrefreshed: boolean,
  settings: Settings,
  now: Instant,
): CardView {
  const card = {
    id: provider.id,
    name: provider.name,
    glyph: String.fromCodePoint(provider.glyph),
    color: settings.colors.get(provider.id) ?? null,
    state: unrefreshed ? "stale" : health.kind,
  };
  const { thresholds } = settings;
  switch (health.kind) {
    case "fresh":
    case "stale": {
      const left = percentLeft(tightestWindow(health.reading).usedPercent);
      const note =
        health.kind === "stale"
          ? healthNote(provider, health, now)
          : unrefreshed
            ? `read ${ago(health.reading.takenAt, now)}, nothing has read ${provider.name} since`
            : null;
      return {
        ...card,
        plan: health.reading.plan,
        headline: { text: note === null ? `${left}%` : `~${left}%`, level: levelOfLeft(left, thresholds) },
        rows: health.reading.windows.map((window) => rowOf(window, thresholds, now)),
        note,
        source: settings.source === "direct" ? null : viaLine(health.reading),
      };
    }
    case "waiting":
    case "expired":
    case "broken":
      return {
        ...card,
        plan: null,
        headline: { text: MARKS[health.kind], level: null },
        rows: [],
        note: healthNote(provider, health, now),
        source: null,
      };
  }
}

const MARKS = { waiting: "–", expired: "?", broken: "!" } as const;

function rowOf(window: Window, thresholds: Thresholds, now: Instant): RowView {
  const left = percentLeft(window.usedPercent);
  return {
    label: shownLabel(window),
    percent: `${left}% left`,
    level: levelOfLeft(left, thresholds),
    fraction: left / 100,
    resets: resetText(window.resetsAt, now),
    chips: window.detail.map((part) => `${part.label} ${wholePercent(part.usedPercent)}% used`),
  };
}

function resetText(resetsAt: Instant | null, now: Instant): string | null {
  if (resetsAt === null) return null;
  return resetsAt <= now ? "reset, waiting for a new reading" : `resets ${when(resetsAt, now)}`;
}

function emptyText(states: readonly ProviderState[]): string {
  const t3 = waitingForT3(states);
  return t3 === null ? "No provider has a reading yet." : t3Hint(t3);
}
