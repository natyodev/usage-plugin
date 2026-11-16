import { forgetAlerts, journalTail, readCache, readOrFetch } from "../cache.ts";
import type { ProviderState, Run } from "../cache.ts";
import { loadConfig, policyOf } from "../config.ts";
import type { Config, ConfigProblem, HexColor } from "../config.ts";
import { formatCountdown, ICON_FONT_FAMILY, levelOfLeft, noT3Text, percentLeft, shownLabel, tightestWindow } from "../domain.ts";
import type { Instant, Level, NoT3, Percent, Provider, ProviderId, Reading, Thresholds } from "../domain.ts";
import { healthOf } from "../health.ts";
import { sendAlert } from "../notify.ts";
import type { Health, Holdup } from "../health.ts";
import { deadlineIn, loginHome, providers as registered } from "../providers/index.ts";
import type { Listed } from "../providers/index.ts";
import { sourcedProviders } from "../sources/index.ts";
import { describeTheme, peekTheme, themeOf } from "../theme/profile.ts";
import type { T3Profile } from "../theme/profile.ts";
import type { Levels, ResolvedTheme } from "../theme/t3.ts";

/**
 * stacked puts the logo above the percent, for a vertical bar. inline puts it beside, for a
 * horizontal one. The user chooses with `--layout`, because Waybar tells a module nothing about
 * the bar it sits in.
 */
export type Layout = "stacked" | "inline";

export interface ModuleRequest {
  readonly only: ProviderId | null;
  readonly layout: Layout;
}

/** One update of a Waybar custom module with `"return-type": "json"`. */
export interface WaybarOutput {
  /** Pango markup. Empty hides the module. */
  readonly text: string;
  /** Pango markup. */
  readonly tooltip: string;
  readonly class: readonly string[];
  /** Percent left, the lowest the text shows, so `format-icons` runs from empty to full like the tooltip's bars. */
  readonly percentage: number;
}

/** The line `usage-plugin module` prints: one JSON object with no newline inside it. */
export async function moduleLine(
  request: ModuleRequest,
  run: Run,
  enabled: readonly Listed[] = registered,
  t3: T3Profile | null = null,
): Promise<string> {
  const config = loadConfig(run.configPath);
  const theme = themeOf(run.runtimeDir, config.settings.theme, t3, run.log);
  const adapters = sourcedProviders(config.settings.source, run, enabled).filter(
    (adapter) => !config.settings.disabled.has(adapter.id),
  );
  const shown = adapters.filter((adapter) => request.only === null || adapter.id === request.only).map((adapter) => adapter.id);
  const { states, raised } = await readOrFetch(run, { adapters, policy: policyOf(config.settings), shown });
  const sending = { now: run.now, deadline: deadlineIn(performance.now() + SEND_BUDGET_MS) };
  const attempts = await Promise.all(raised.map(async (alert) => ({ alert, result: await sendAlert(alert, sending) })));
  for (const { alert, result } of attempts) {
    run.log({ event: "alert", provider: alert.provider.id, window: alert.window.label, ...result });
  }
  const unsent = attempts.flatMap(({ alert, result }) => (result.sent ? [] : [alert]));
  await forgetAlerts({ ...run, deadline: deadlineIn(performance.now() + FORGET_BUDGET_MS) }, unsent);
  return lineFor(request, states, run.now(), config, theme);
}

/** Alerts get budgets of their own, because a provider that hangs spends the whole fetch budget. */
const SEND_BUDGET_MS = 500;
const FORGET_BUDGET_MS = 1000;

const DEBUG_LOG_LINES = 40;

export function moduleDebug(request: ModuleRequest, run: Run, t3: T3Profile | null = null): string {
  const now = run.now();
  const config = loadConfig(run.configPath);
  const all = readCache(run, sourcedProviders(config.settings.source, run));
  const theme = peekTheme(run.runtimeDir, config.settings.theme, t3);
  return [
    `runtime dir  ${run.runtimeDir}`,
    `logins       ${loginHome(run)}`,
    `fixtures     ${run.fixtures ?? "none"}`,
    `config       ${config.path}`,
    ...noticesOf(config.problems).map((notice) => `             ${notice}`),
    `theme        ${describeTheme(theme)}`,
    "",
    ...all.map((state) => `${state.provider.id}  ${describeEntry(state, now)}`),
    "",
    "module line",
    lineFor(request, all, now, config, theme),
    "",
    `debug.log, last ${DEBUG_LOG_LINES} lines`,
    ...journalTail(run.runtimeDir, DEBUG_LOG_LINES),
  ].join("\n");
}

function lineFor(request: ModuleRequest, all: readonly ProviderState[], now: Instant, config: Config, theme: ResolvedTheme): string {
  const { settings } = config;
  const shown = all.filter(
    ({ provider }) => !settings.disabled.has(provider.id) && (request.only === null || provider.id === request.only),
  );
  return JSON.stringify(
    renderModule(shown, {
      layout: request.layout,
      now,
      thresholds: settings.thresholds,
      colors: settings.barColors ? settings.colors : new Map(),
      notices: noticesOf(config.problems),
      showVia: settings.source !== "direct",
      ...(theme.kind === "t3" && settings.barColors ? { levels: theme.palette.bar } : {}),
    }),
  );
}

const NOTICES_SHOWN = 5;
const NOTICE_CHARACTERS = 200;

export function noticesOf(problems: readonly ConfigProblem[]): readonly string[] {
  const more = problems.length - NOTICES_SHOWN;
  return [...problems.slice(0, NOTICES_SHOWN).map(noticeOf), ...(more > 0 ? [`and ${more} more config problems`] : [])];
}

function noticeOf({ line, message }: ConfigProblem): string {
  const characters = [...`config.jsonc${line === null ? "" : ` line ${line}`}: ${message}`];
  return characters.length > NOTICE_CHARACTERS ? `${characters.slice(0, NOTICE_CHARACTERS - 1).join("")}…` : characters.join("");
}

function describeEntry({ entry }: ProviderState, now: Instant): string {
  if (entry === null) return "never attempted";
  const seconds = (from: Instant, to: Instant) => `${Math.round((to - from) / 1000)}s`;
  const due = `due in ${seconds(now, entry.dueAt)}`;
  if (entry.status === "read") return `read ${seconds(entry.reading.takenAt, now)} ago, ${due}`;
  const kept = entry.reading === null ? "no reading kept" : `kept a reading from ${seconds(entry.reading.takenAt, now)} ago`;
  return `missed ${seconds(entry.missedAt, now)} ago (${entry.miss.kind}, ${entry.streak} in a row), ${kept}, ${due}`;
}

export interface RenderOptions {
  readonly layout: Layout;
  readonly now: Instant;
  readonly thresholds: Thresholds;
  /** By provider id. A provider that is not here takes the colour of the user's CSS. */
  readonly colors: ReadonlyMap<string, HexColor>;
  /** Plain text, one per line, above every provider in the tooltip. */
  readonly notices: readonly string[];
  readonly showVia: boolean;
  /** T3 Code's colours for the bar, when the module follows its theme. */
  readonly levels?: Levels;
}

const SEPARATORS: Readonly<Record<Layout, { readonly afterLogo: string; readonly betweenProviders: string }>> = {
  stacked: { afterLogo: "\n", betweenProviders: "\n<span size='5pt'> </span>\n" },
  inline: { afterLogo: " ", betweenProviders: "  " },
};

const HIDDEN: WaybarOutput = { text: "", tooltip: "", class: [], percentage: 0 };

type Shown = Exclude<Health["kind"], "signedOut">;

const STATE_CLASSES: readonly Shown[] = ["stale", "waiting", "expired", "broken"];

const CONFIG_PROBLEM = "config-problem";

/**
 * Dimming and a configured colour are in the markup and not only in a class, because one label
 * holds every provider and CSS styles the whole label. `fgalpha` changes no colour, so a dimmed
 * logo keeps its configured colour or the user's CSS colour. A config problem shows even when no
 * provider does, so a typo never hides the module silently.
 *
 * Waybar reads `text` and `tooltip` as Pango markup and does not escape them, so every string
 * that came from a provider or a file is escaped here.
 */
export function renderModule(states: readonly ProviderState[], options: RenderOptions): WaybarOutput {
  const cells = states.flatMap(({ provider, entry }) => {
    const cell = entry === null ? null : cellFor(provider, healthOf(entry), options);
    return cell === null ? [] : [cell];
  });
  const notices = options.notices.map((notice) => `⚠ ${escapeMarkup(notice)}`);
  if (cells.length === 0) {
    const t3 = waitingForT3(states);
    const problem = notices.length === 0 ? [] : ["broken", CONFIG_PROBLEM];
    if (t3 !== null) {
      return {
        text: notices.length === 0 ? dimmed("–") : "⚠",
        tooltip: [...notices, escapeMarkup(t3Hint(t3))].join("\n"),
        class: ["waiting", `t3-${t3.kind}`, ...problem],
        percentage: 0,
      };
    }
    return notices.length === 0 ? HIDDEN : { text: "⚠", tooltip: notices.join("\n"), class: problem, percentage: 0 };
  }

  const lowest = cells.reduce<Percent | null>(
    (least, { left }) => (left !== null && (least === null || left < least) ? left : least),
    null,
  );
  return {
    text: cells.map((cell) => cell.text).join(SEPARATORS[options.layout].betweenProviders),
    tooltip: [...notices, ...cells.flatMap((cell) => cell.tooltip)].join("\n"),
    class: [
      ...(lowest === null ? [] : [levelOfLeft(lowest, options.thresholds)]),
      ...STATE_CLASSES.filter((state) => cells.some((cell) => cell.state === state)),
      ...(notices.length === 0 ? [] : [CONFIG_PROBLEM]),
      ...cells.map((cell) => cell.provider.id),
      ...cells.flatMap((cell) => cell.classes),
    ],
    percentage: lowest ?? 0,
  };
}

/**
 * Why T3 Code gave nothing, when T3 was to be read and nothing shows: one dimmed mark, so a cold
 * start before T3 opens still says what to do. The `t3-*` class lets CSS hide it.
 */
export function waitingForT3(states: readonly ProviderState[]): NoT3 | null {
  for (const { entry } of states) {
    if (entry?.status === "missed" && entry.miss.kind === "noT3") return entry.miss.why;
  }
  return null;
}

export function t3Hint(why: NoT3): string {
  switch (why.kind) {
    case "closed":
      return "T3 Code isn't running. Open T3 Code, or set up a provider.";
    case "unsupported":
      return `T3 Code ${why.version} is not supported. Update T3 Code, or set up a provider.`;
    case "failing":
      return `${why.detail}.`;
  }
}

export function renderProblem(message: string): WaybarOutput {
  return { text: "⚠", tooltip: escapeMarkup(message), class: ["broken"], percentage: 0 };
}

interface Cell {
  readonly provider: Provider;
  readonly state: Shown;
  readonly text: string;
  readonly tooltip: readonly string[];
  readonly classes: readonly string[];
  readonly left: Percent | null;
}

function cellFor(provider: Provider, health: Health, options: RenderOptions): Cell | null {
  const icon = logo(provider, options);
  switch (health.kind) {
    case "signedOut":
      return null;
    case "fresh":
    case "stale": {
      const left = percentLeft(tightestWindow(health.reading).usedPercent);
      const level = `${provider.id}-${levelOfLeft(left, options.thresholds)}`;
      const tooltip = [
        nameLine(provider),
        ...windowLines(health.reading, options.now),
        ...(options.showVia ? [escapeMarkup(viaLine(health.reading))] : []),
      ];
      if (health.kind === "fresh") {
        return { provider, state: "fresh", text: beside(icon, levelled(`${left}%`, left, options), options), tooltip, classes: [level], left };
      }
      return {
        provider,
        state: "stale",
        text: dimmed(beside(icon, levelled(`~${left}%`, left, options), options)),
        tooltip: [...tooltip, escapeMarkup(healthNote(provider, health, options.now))],
        classes: [level, `${provider.id}-stale`],
        left,
      };
    }
    case "waiting":
      return {
        provider,
        state: "waiting",
        text: dimmed(beside(icon, "–", options)),
        tooltip: [nameLine(provider), escapeMarkup(healthNote(provider, health, options.now))],
        classes: [`${provider.id}-waiting`],
        left: null,
      };
    case "expired":
      return {
        provider,
        state: "expired",
        text: beside(dimmed(icon), "<b>?</b>", options),
        tooltip: [nameLine(provider), escapeMarkup(healthNote(provider, health, options.now))],
        classes: [`${provider.id}-expired`],
        left: null,
      };
    case "broken":
      return {
        provider,
        state: "broken",
        text: beside(icon, `<span foreground='${BROKEN_RED}' weight='bold'>!</span>`, options),
        tooltip: [nameLine(provider), escapeMarkup(healthNote(provider, health, options.now))],
        classes: [`${provider.id}-broken`],
        left: null,
      };
  }
}

const BROKEN_RED = "#E5484D";

function dimmed(markup: string): string {
  return `<span fgalpha='50%'>${markup}</span>`;
}

function logo(provider: Provider, options: RenderOptions): string {
  const color = options.colors.get(provider.id) ?? options.levels?.accent;
  const paint = color === undefined ? "" : ` foreground='${color}'`;
  return `<span font_family='${ICON_FONT_FAMILY}' size='x-large'${paint}>${String.fromCodePoint(provider.glyph)}</span>`;
}

function levelled(value: string, left: Percent, options: RenderOptions): string {
  const level: Level = levelOfLeft(left, options.thresholds);
  const color = level === "ok" ? undefined : options.levels?.[level];
  return color === undefined ? value : `<span foreground='${color}'>${value}</span>`;
}

function beside(logoMarkup: string, value: string, options: RenderOptions): string {
  return `${logoMarkup}${SEPARATORS[options.layout].afterLogo}${value}`;
}

function nameLine(provider: Provider): string {
  return `<b>${escapeMarkup(provider.name)}</b>`;
}

/** Why a provider shows no fresh reading, in plain text. */
export function healthNote(provider: Provider, health: Exclude<Health, { kind: "fresh" | "signedOut" }>, now: Instant): string {
  switch (health.kind) {
    case "stale":
      return `read ${ago(health.reading.takenAt, now)}. ${holdupText(provider, health.holdup, now)}`;
    case "waiting":
      return `no reading yet. ${holdupText(provider, health.holdup, now)}`;
    case "expired":
      return loginHint(provider);
    case "broken":
      return health.detail === null
        ? `T3 Code could not check ${provider.name}'s usage`
        : `cannot read ${provider.name}'s reply: ${health.detail}`;
  }
}

function holdupText(provider: Provider, holdup: Holdup, now: Instant): string {
  switch (holdup.kind) {
    case "loginExpired":
      return loginHint(provider);
    case "rateLimited":
      return `rate limited, next try ${when(holdup.retryAt, now)}`;
    case "unreachable":
      return {
        network: "no network",
        timeout: "no answer in time",
        server: `${provider.name} is having trouble`,
        loginFile: "login file busy",
      }[holdup.cause];
    case "noT3":
      return noT3Text(holdup.why);
  }
}

function loginHint(provider: Provider): string {
  return provider.loginCommand === null
    ? "login expired, sign in again in T3 Code"
    : `login expired, run \`${provider.loginCommand}\` to refresh login`;
}

export function viaLine({ via }: Reading): string {
  if (via.kind === "t3") return "via T3 Code";
  return via.unsupportedT3 === null ? "direct" : `direct, T3 Code ${via.unsupportedT3} is not supported`;
}

function windowLines({ windows }: Reading, now: Instant): readonly string[] {
  const labelWidth = Math.max(...windows.map((window) => shownLabel(window).length));
  return windows.map((window) => {
    const label = escapeMarkup(shownLabel(window).padEnd(labelWidth));
    const left = percentLeft(window.usedPercent);
    const reset = window.resetsAt === null ? "" : `  resets ${when(window.resetsAt, now)}`;
    return `<tt>${label} ${usageBar(left)} ${`${left}`.padStart(3)}% left</tt>${escapeMarkup(reset)}`;
  });
}

export function when(at: Instant, now: Instant): string {
  const countdown = formatCountdown(at, now);
  return countdown === "now" ? "now" : `in ${countdown}`;
}

export function ago(at: Instant, now: Instant): string {
  const age = formatCountdown(now, at);
  return age === "now" ? "just now" : `${age} ago`;
}

function escapeMarkup(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const BAR_CELLS = 10;

/** Full only when the number reads 100, and empty only when it reads 0. */
function usageBar(left: Percent): string {
  const filled =
    left >= 100 ? BAR_CELLS : left <= 0 ? 0 : Math.min(BAR_CELLS - 1, Math.max(1, Math.round(left / BAR_CELLS)));
  return "█".repeat(filled) + "░".repeat(BAR_CELLS - filled);
}
