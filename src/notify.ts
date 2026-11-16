import type { Entry, Run } from "./cache.ts";
import { formatCountdown, percentLeft, wholePercent } from "./domain.ts";
import type { Instant, Percent, Provider, Reading, Window } from "./domain.ts";

/** By window label, the reset time of the period the window alerted for. */
export type AlertMarks = ReadonlyMap<string, Instant | null>;

export const NO_MARKS: AlertMarks = new Map();

/** Every window known starts its next period at least five hours after the last one ends. */
const RESET_DRIFT_MS = 60 * 60_000;

export function markAlerts(marks: AlertMarks, reading: Reading, alertAt: Percent): AlertMarks {
  const next = new Map<string, Instant | null>();
  for (const window of reading.windows) {
    const atOrAbove = wholePercent(window.usedPercent) >= alertAt;
    const mark = marks.get(window.label);
    if (mark === undefined) {
      if (atOrAbove) next.set(window.label, window.resetsAt);
      continue;
    }
    if (inSamePeriod(mark, window.resetsAt, atOrAbove)) next.set(window.label, mark);
    else if (atOrAbove) next.set(window.label, window.resetsAt);
  }
  return next;
}

function inSamePeriod(markedReset: Instant | null, resetsAt: Instant | null, atOrAbove: boolean): boolean {
  if (markedReset === null || resetsAt === null) return atOrAbove;
  return resetsAt <= markedReset + RESET_DRIFT_MS;
}

export interface Alert {
  readonly provider: Provider;
  readonly window: Window;
}

export function alertsRaised(provider: Provider, previous: Entry | undefined, next: Entry): readonly Alert[] {
  if (next.status !== "read") return [];
  const before = previous?.alerts ?? NO_MARKS;
  return next.reading.windows.flatMap((window) => {
    const gained = next.alerts.has(window.label) && before.get(window.label) !== next.alerts.get(window.label);
    return gained ? [{ provider, window }] : [];
  });
}

export type Sent = { readonly sent: true } | { readonly sent: false; readonly detail: string };

const STDERR_GRACE_MS = 50;

/** One desktop notification. A later one with the same `stackTag` replaces it. */
export interface Notice {
  readonly summary: string;
  readonly body: string;
  readonly stackTag: string;
}

export function sendAlert(alert: Alert, run: Pick<Run, "now" | "deadline">): Promise<Sent> {
  return sendNotice(alertNotice(alert, run.now()), run);
}

/**
 * One `org.freedesktop.Notifications.Notify` through `gdbus call`, so libnotify is not needed.
 * Resolves by `run.deadline` and never rejects.
 */
export async function sendNotice(notice: Notice, run: Pick<Run, "deadline">): Promise<Sent> {
  try {
    // Bun.spawn passes the environment the process started with unless it is given one, and the
    // session bus must come from process.env, which is where the test preload points it.
    const gdbus = Bun.spawn(noticeArgv(notice), {
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: run.deadline.signal,
    });
    const exitCode = await gdbus.exited;
    if (exitCode === 0) return { sent: true };
    if (run.deadline.signal.aborted) return { sent: false, detail: "gdbus did not finish in time" };
    // A child that gdbus left behind can hold stderr open long after gdbus exits.
    const stderr = await Promise.race([new Response(gdbus.stderr).text(), Bun.sleep(STDERR_GRACE_MS).then(() => "")]);
    const reason = stderr.split("\n")[0];
    return { sent: false, detail: reason ? `gdbus exited ${exitCode}: ${reason}` : `gdbus exited ${exitCode}` };
  } catch (error) {
    return { sent: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function notifyArgv(alert: Alert, now: Instant): string[] {
  return noticeArgv(alertNotice(alert, now));
}

/**
 * Every string is a GVariant text literal, because gdbus parses each argument as GVariant text and
 * would read a label such as "[1]" as an array.
 */
function noticeArgv({ summary, body, stackTag }: Notice): string[] {
  return [
    "gdbus",
    "call",
    "--session",
    "--timeout",
    "2",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
    "--method",
    "org.freedesktop.Notifications.Notify",
    gvariantString("usage-plugin"),
    "uint32 0",
    gvariantString(""),
    gvariantString(summary),
    gvariantString(escapeBody(body)),
    "@as []",
    `{'urgency': <byte 1>, 'x-dunst-stack-tag': <${gvariantString(stackTag)}>}`,
    "int32 -1",
  ];
}

function alertNotice({ provider, window }: Alert, now: Instant): Notice {
  const countdown = window.resetsAt === null ? null : formatCountdown(window.resetsAt, now);
  const reset = countdown === null ? "" : countdown === "now" ? ", resets now" : `, resets in ${countdown}`;
  return {
    summary: `${provider.name}: ${percentLeft(window.usedPercent)}% left`,
    body: `${window.label} window${reset}`,
    stackTag: `usage-plugin-${provider.id}-${window.label}`,
  };
}

function gvariantString(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** The body may be read as markup. Only the three XML entities are safe with every server. */
function escapeBody(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
